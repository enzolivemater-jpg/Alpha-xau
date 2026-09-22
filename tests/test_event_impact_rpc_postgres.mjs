// Real PostgreSQL 17 integration/concurrency proof in a disposable local DB.
// Uses psql only; no production credentials or npm runtime dependency.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.PGDATABASE, 'xau_ei_rpc_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');
const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}
assert.equal(sql('SHOW server_version_num;').slice(0,2), '17', 'PostgreSQL 17 required');
assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');"), '0', 'database must be empty');
for (const path of [
  'tests/fixtures/event_impact_rpc_bootstrap.sql',
  'database/migrations/0023_event_impact_schema.sql',
  'database/migrations/0024_event_impact_atomic_rpc.sql',
  'tests/test_event_impact_atomic_rpc.sql',
]) {
  const output = sql(readFileSync(new URL(path, root), 'utf8'));
  console.log(`PASS ${path}${output ? ': '+output : ''}`);
}
assert.equal(sql('SELECT count(*) FROM public.event_impact_assessments;'), '0');
assert.equal(sql('SELECT count(*) FROM public.event_impact_interpretations;'), '0');
assert.equal(sql("SELECT has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR p.prosecdef FROM pg_proc p WHERE p.oid='public.fn_event_impact_create_assessment(uuid,text,timestamptz,text,text,text,text,text,text,jsonb,uuid)'::regprocedure;"), 'f');

class Session {
  constructor(name) {
    this.name = name;
    this.buffer = '';
    this.stderr = '';
    this.lines = [];
    this.serial = 0;
    this.pending = null;
    this.process = spawn('psql', args, { env: { ...env, PGAPPNAME: name }, stdio: ['pipe','pipe','pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', text => { this.stderr += text; });
    this.process.stdout.on('data', text => {
      this.buffer += text;
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0,end).trim();
        this.buffer = this.buffer.slice(end+1);
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
    assert.equal(this.pending, null, 'one pending command per connection');
    return new Promise((resolve,reject) => {
      const marker = `ei_done_${++this.serial}`;
      const timer = setTimeout(() => {
        this.pending = null;
        this.process.kill('SIGTERM');
        reject(new Error('psql command timed out'));
      },20000);
      this.pending = { marker,resolve,reject,timer };
      this.process.stdin.write(`${query}\n\\echo ${marker}\n`);
    });
  }
  close() {
    if (this.process.exitCode === null && !this.process.stdin.destroyed) {
      this.process.stdin.end('ROLLBACK;\n\\q\n');
    }
  }
}

function call(key, actor='concurrency-probe', predecessor=null) {
  // Test constants only. No external input or credentials enter this SQL.
  assert.match(key,/^[0-9a-f]$/);
  assert.match(actor,/^[a-z-]+$/);
  if (predecessor) assert.match(predecessor,/^[0-9a-f-]{36}$/);
  return `SELECT row_to_json(r) FROM public.fn_event_impact_create_assessment(
    '00000000-0000-0000-0000-000000000001','ASSESSED','2026-09-22T00:00:00.123456Z',
    'DETERMINISTIC','${actor}','probe-v1',repeat('a',64),repeat('b',64),repeat('${key}',64),
    '[{"horizon":"H1","interpretation_key":"main","interpretation_role":"PRIMARY","direction":"UNKNOWN","magnitude_state":"UNASSESSED","confidence_state":"ESTIMATED","confidence_value":0.123456,"pricing_state":"UNASSESSED"}]'::jsonb,
    ${predecessor ? `'${predecessor}'::uuid` : 'NULL'}
  ) r;`;
}
async function waitForLock(name) {
  assert.match(name,/^[a-z0-9_]+$/);
  const deadline=Date.now()+6000;
  while (Date.now()<deadline) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock';`)==='1') return;
    await delay(50);
  }
  throw new Error('second connection never waited on the first transaction');
}
async function race(key, { rollback=false, conflict=false, predecessor=null }={}) {
  const a=new Session(`ei_a_${key}`), b=new Session(`ei_b_${key}`);
  try {
    const created=JSON.parse(await a.run('BEGIN; SET LOCAL ROLE service_role; '+call(key,'concurrency-probe',predecessor)));
    assert.equal(created.replayed,false);
    const pending=b.run('BEGIN; SET LOCAL ROLE service_role; '+call(key,conflict?'different-probe':'concurrency-probe',predecessor))
      .then(output=>({output}),error=>({error}));
    await waitForLock(b.name);
    await a.run(rollback?'ROLLBACK;':'COMMIT;');
    const resolved=await pending;
    if(conflict) {
      assert.match(resolved.error?.message??'',/EVENT_IMPACT_IDEMPOTENCY_CONFLICT/);
    } else {
      assert.ifError(resolved.error);
      const second=JSON.parse(resolved.output);
      assert.equal(second.replayed,!rollback);
      if(rollback) assert.notEqual(second.assessment_id,created.assessment_id);
      else assert.equal(second.assessment_id,created.assessment_id);
      await b.run('COMMIT;');
    }
    assert.equal(sql(`SELECT count(*) FROM public.event_impact_assessments WHERE idempotency_fingerprint=repeat('${key}',64);`),'1');
    console.log(`PASS concurrent ${rollback?'rollback recovery':conflict?'conflicting key':predecessor?'supersession replay':'identical replay'} (observed real lock wait)`);
    return created.assessment_id;
  } finally { a.close(); b.close(); }
}
const predecessor=await race('1');
await race('2',{rollback:true});
await race('3',{conflict:true});
await race('4',{predecessor});
const lostResponse=JSON.parse(sql('SET ROLE service_role; '+call('1')));
assert.equal(lostResponse.assessment_id,predecessor);
assert.equal(lostResponse.replayed,true);
console.log('PASS committed lost-response recovery from a fresh connection');
console.log('PASS PostgreSQL runtime, security and concurrency contract');
