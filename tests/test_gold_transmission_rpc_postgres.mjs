// PostgreSQL 17.6 transaction/concurrency contract for GT-2 migrations 0027/0028.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.PGDATABASE, 'xau_gold_transmission_rpc_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}
function quoteJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

const eventId = '10000000-0000-4000-8000-000000000001';
const dxyId = '40000000-0000-4000-8000-000000000001';
const vixId = '40000000-0000-4000-8000-000000000002';
const xauId = '40000000-0000-4000-8000-000000000003';
const tickTs = '2020-09-23T11:00:00Z';
const cutoff = '2020-09-23T12:00:00Z';

const paths = [
  {
    path_key: 'usd', transmission_channel: 'USD', market_variable: 'USD',
    variable_effect: 'DOWN', gold_effect: 'BULLISH', confidence_state: 'ESTIMATED',
    confidence_value: 0.723456, rationale: 'synthetic test',
    driver_evidence: [
      { market_tick_id: dxyId, market_tick_ts: tickTs, evidence_role: 'PRIMARY' },
      { market_tick_id: vixId, market_tick_ts: tickTs, evidence_role: 'SUPPORTING' },
    ],
  },
  {
    path_key: 'volatility', transmission_channel: 'VOLATILITY', market_variable: 'VOLATILITY',
    variable_effect: 'UP', gold_effect: 'UNKNOWN', confidence_state: 'UNKNOWN',
    driver_evidence: [],
  },
];

function call(key, { actor = 'gt-rpc-probe', requestPaths = paths, status = 'ASSESSED', reason = null, supersedes = null } = {}) {
  assert.match(key, /^[0-9a-f]$/);
  assert.match(actor, /^[a-z-]+$/);
  return `SELECT row_to_json(r) FROM public.fn_gold_transmission_create_assessment(
    '${eventId}', '${status}', ${reason === null ? 'NULL' : `'${reason}'`}, '${cutoff}',
    'DETERMINISTIC', '${actor}', 'gt-rpc-v1', repeat('a',64), repeat('b',64),
    repeat('${key}',64), ${quoteJson(requestPaths)}, ${supersedes ? `'${supersedes}'::uuid` : 'NULL'}
  ) AS r;`;
}

assert.match(sql('SHOW server_version;'), /^17\.6(?:\D|$)/, 'PostgreSQL 17.6 required');
sql(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.event_versions (id uuid PRIMARY KEY, knowledge_cutoff timestamptz NOT NULL);
  CREATE TABLE public.market_ticks (
    id uuid NOT NULL, symbol text NOT NULL, ts timestamptz NOT NULL,
    created_at timestamptz NOT NULL, PRIMARY KEY (id, ts)
  ) PARTITION BY RANGE (ts);
  CREATE TABLE public.market_ticks_2020_09 PARTITION OF public.market_ticks
    FOR VALUES FROM ('2020-09-01') TO ('2020-10-01');
  INSERT INTO public.event_versions VALUES ('${eventId}', '2020-09-23T10:00:00Z');
  INSERT INTO public.market_ticks VALUES
    ('${dxyId}','DXY','${tickTs}','2020-09-23T11:01:00Z'),
    ('${vixId}','VIX','${tickTs}','2020-09-23T11:01:00Z'),
    ('${xauId}','XAUUSD','${tickTs}','2020-09-23T11:01:00Z');
  GRANT USAGE ON SCHEMA public TO service_role;
  GRANT SELECT ON public.event_versions, public.market_ticks TO service_role;
`);
for (const path of [
  'database/migrations/0027_gold_transmission_schema.sql',
  'database/migrations/0028_gold_transmission_atomic_rpc.sql',
]) sql(readFileSync(new URL(path, root), 'utf8'));

assert.equal(sql(`SELECT p.prosecdef OR NOT EXISTS (
  SELECT 1 FROM unnest(p.proconfig) setting WHERE setting IN ('search_path=', 'search_path=""'))
  FROM pg_proc p WHERE p.oid='public.fn_gold_transmission_create_assessment(uuid,text,text,timestamptz,text,text,text,text,text,text,jsonb,uuid)'::regprocedure;`), 'f');
assert.equal(sql(`SELECT has_function_privilege('service_role',p.oid,'EXECUTE')
  AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
  AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
  FROM pg_proc p WHERE p.oid='public.fn_gold_transmission_create_assessment(uuid,text,text,timestamptz,text,text,text,text,text,text,jsonb,uuid)'::regprocedure;`), 't');
console.log('PASS RPC is SECURITY INVOKER, search-path hardened, and service-role only');

const first = JSON.parse(sql(`SET ROLE service_role; ${call('1')}`));
assert.equal(first.replayed, false);
assert.equal(first.path_count, 2);
assert.equal(first.evidence_count, 2);
assert.equal(sql(`SELECT confidence_value FROM public.gold_transmission_paths
  WHERE assessment_id='${first.assessment_id}' AND path_key='usd';`), '0.7235');
console.log('PASS parent, canonical paths, and evidence persist atomically at schema precision');

const reordered = paths.toReversed().map(path => ({
  confidence_value: null, rationale: null, ...path,
  driver_evidence: path.driver_evidence.toReversed(),
}));
const replay = JSON.parse(sql(`SET ROLE service_role; ${call('1', { requestPaths: reordered })}`));
assert.equal(replay.replayed, true);
assert.equal(replay.assessment_id, first.assessment_id);
assert.equal(replay.path_count, 2);
assert.equal(replay.evidence_count, 2);
console.log('PASS exact replay ignores input ordering and missing-vs-null nullable fields');

assert.throws(() => sql(`SET ROLE service_role; ${call('1', { actor: 'different-probe' })}`),
  /GOLD_TRANSMISSION_IDEMPOTENCY_CONFLICT/);
assert.throws(() => sql(`SET ROLE service_role; ${call('2', { requestPaths: [{ ...paths[0], typo: true }] })}`),
  /GOLD_TRANSMISSION_INVALID_PATHS/);
assert.throws(() => sql(`SET ROLE service_role; ${call('2', { requestPaths: [], status: 'ASSESSED' })}`),
  /GOLD_TRANSMISSION_STATUS_PATH_CONFLICT/);
console.log('PASS divergent replay, unknown keys, and status/path mismatch fail closed');

const unavailable = JSON.parse(sql(`SET ROLE service_role; ${call('3', {
  requestPaths: [], status: 'UNAVAILABLE', reason: 'typed facts unavailable',
})}`));
assert.equal(unavailable.path_count, 0);
assert.equal(unavailable.evidence_count, 0);
assert.equal(JSON.parse(sql(`SET ROLE service_role; ${call('3', {
  requestPaths: [], status: 'UNAVAILABLE', reason: 'typed facts unavailable',
})}`)).replayed, true);
console.log('PASS explicit unavailable outcome persists and replays with no children');

const badEvidencePaths = [{ ...paths[0], driver_evidence: [
  { market_tick_id: xauId, market_tick_ts: tickTs, evidence_role: 'PRIMARY' },
] }];
assert.throws(() => sql(`SET ROLE service_role; ${call('4', { requestPaths: badEvidencePaths })}`),
  /not canonical Gold Transmission driver evidence/);
assert.equal(sql("SELECT count(*) FROM public.gold_transmission_assessments WHERE idempotency_fingerprint=repeat('4',64);"), '0');
assert.equal(sql("SELECT count(*) FROM public.gold_transmission_paths WHERE path_key='usd' AND assessment_id NOT IN (SELECT id FROM public.gold_transmission_assessments);"), '0');
console.log('PASS invalid child evidence rolls back the whole assessment');

class Session {
  constructor(name) {
    this.name = name;
    this.buffer = '';
    this.stderr = '';
    this.lines = [];
    this.serial = 0;
    this.pending = null;
    this.process = spawn('psql', args, { env: { ...env, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', text => { this.stderr += text; });
    this.process.stdout.on('data', text => {
      this.buffer += text;
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (this.pending && line === this.pending.marker) {
          const { resolve, timer } = this.pending;
          clearTimeout(timer);
          this.pending = null;
          resolve(this.lines.filter(Boolean).join('\n'));
          this.lines = [];
        } else this.lines.push(line);
      }
    });
    const fail = error => {
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(error);
        this.pending = null;
      }
    };
    this.process.on('error', fail);
    this.process.on('exit', code => fail(new Error(`psql exit ${code}: ${this.stderr}`)));
  }
  run(query) {
    return new Promise((resolve, reject) => {
      const marker = `gt_done_${++this.serial}`;
      const timer = setTimeout(() => {
        this.pending = null;
        this.process.kill('SIGTERM');
        reject(new Error('psql command timed out'));
      }, 20000);
      this.pending = { marker, resolve, reject, timer };
      this.process.stdin.write(`${query}\n\\echo ${marker}\n`);
    });
  }
  close() {
    if (this.process.exitCode === null && !this.process.stdin.destroyed) this.process.stdin.end('ROLLBACK;\n\\q\n');
  }
}
async function waitForLock(name) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock';`) === '1') return;
    await delay(50);
  }
  throw new Error('second RPC connection never waited on the unique-index lock');
}

const a = new Session('gt_rpc_a');
const b = new Session('gt_rpc_b');
try {
  const created = JSON.parse(await a.run(`BEGIN; SET LOCAL ROLE service_role; ${call('5')}`));
  const pending = b.run(`BEGIN; SET LOCAL ROLE service_role; ${call('5')}`);
  await waitForLock(b.name);
  await a.run('COMMIT;');
  const concurrentReplay = JSON.parse(await pending);
  assert.equal(concurrentReplay.replayed, true);
  assert.equal(concurrentReplay.assessment_id, created.assessment_id);
  await b.run('COMMIT;');
  assert.equal(sql("SELECT count(*) FROM public.gold_transmission_assessments WHERE idempotency_fingerprint=repeat('5',64);"), '1');
  assert.equal(sql(`SELECT count(*) FROM public.gold_transmission_paths WHERE assessment_id='${created.assessment_id}';`), '2');
  console.log('PASS concurrent identical calls serialize to one assessment and one exact replay');
} finally {
  a.close();
  b.close();
}

assert.equal(sql(`SELECT
  (SELECT count(*) FROM public.gold_transmission_assessments) || ',' ||
  (SELECT count(*) FROM public.gold_transmission_paths) || ',' ||
  (SELECT count(*) FROM public.gold_transmission_driver_evidence);`), '3,4,4');
console.log('PASS exact final row counts contain no partial or duplicate writes');
