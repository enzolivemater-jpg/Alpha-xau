// PostgreSQL 17.6 proof for migration 20261026120000_market_latest_exact_staleness (A-C3) and its rollback.
// Runs in a scratch database of its own on the job's ephemeral server; it never touches an existing environment.
// The scratch name is unique to this run, must be absent before CREATE DATABASE, and is tagged with a token of
// this run: cleanup drops that database only, and only if it still carries the token. It never drops anything
// it did not create (a run killed outright leaves its own uniquely named database behind, never someone else's).
// Concurrency, failure and collision cases: tests/test_market_latest_exact_staleness_isolation_postgres.mjs.
// Values are synthetic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

// The server must be declared disposable explicitly, by naming its test database (set by the CI job step).
assert.equal(process.env.XAU_PG_DISPOSABLE, 'xau_market_rls_test', 'XAU_PG_DISPOSABLE=xau_market_rls_test required: disposable server only');
assert.equal(process.env.PGDATABASE, 'xau_market_rls_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const SCRATCH_PATTERN = /^xau_a_c3_[a-z0-9_]{1,40}$/;
// XAU_A_C3_SCRATCH_NAME / XAU_A_C3_FAIL_AT exist only for the isolation test (collision, mid-run failure, lost ownership).
const SCRATCH = process.env.XAU_A_C3_SCRATCH_NAME ?? `xau_a_c3_${process.pid}_${randomBytes(8).toString('hex')}`;
assert.match(SCRATCH, SCRATCH_PATTERN, 'scratch database name');
const TOKEN = `xau-a-c3-run ${randomBytes(16).toString('hex')}`;
const failAt = (step) => { if (process.env.XAU_A_C3_FAIL_AT === step) throw new Error(`injected failure at ${step}`); };
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const run = (database, query) => execFileSync('psql', args, { input: query, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PGDATABASE: database, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' } }).trim();
const admin = (query) => run(process.env.PGDATABASE, query);
const sql = (query) => run(SCRATCH, query);
const file = (name) => readFileSync(new URL(name, root), 'utf8');
const MIGRATION = file('database/migrations/20261026120000_market_latest_exact_staleness.sql');
const ROLLBACK = file('database/rollbacks/20261026120000_market_latest_exact_staleness.down.sql');

const context = await loadBackendModule('market_engine/context.ts');
const { SYMBOL_RULES } = await loadBackendModule('market_engine/validate.ts');

assert.match(admin('SHOW server_version;'), /^17\.6(?:\D|$)/, 'PostgreSQL 17.6 required');
// Never drop first: an existing database of that name is someone else's, and the run stops.
assert.equal(admin(`SELECT count(*) FROM pg_database WHERE datname = '${SCRATCH}';`), '0', `${SCRATCH} already exists; refusing to use it`);
admin(`CREATE DATABASE ${SCRATCH};`); // no IF NOT EXISTS: if another session took the name meanwhile, this fails
admin(`COMMENT ON DATABASE ${SCRATCH} IS '${TOKEN}';`);
// Ours: owned by this session's role and carrying this run's token. Checked again before the drop.
const ours = () => admin(`SELECT (datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user))::text || ' ' ||
  coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '${SCRATCH}';`) === `true ${TOKEN}`;
assert.ok(ours(), `${SCRATCH}: creation by this run not confirmed`);
console.log(`scratch database ${SCRATCH}`);
// Roles are cluster-wide and shared with concurrent runs: created if missing, tolerant of a concurrent creation,
// never dropped.
const ensureRoles = (...names) => sql(names.map((name) => `DO $role$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} NOLOGIN; END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $role$;`).join('\n'));
try {
  failAt('create');
  if (process.env.XAU_A_C3_FAIL_AT === 'ownership') { // the marker no longer matches: cleanup must leave the database
    admin(`COMMENT ON DATABASE ${SCRATCH} IS 'another owner';`);
    failAt('ownership');
  }
  ensureRoles('anon', 'authenticated', 'service_role', 'xau_a_c3_view_owner', 'xau_a_c3_reader');
  // --- Fixture: the market_ticks columns the view reads, the no-future CHECK, and the view as deployed today
  // (schema.sql section 9 before A-C3, security_invoker from 0033), with the grants the application relies on.
  sql(`
    CREATE TABLE public.market_ticks (
      symbol text NOT NULL, asset_type text NOT NULL DEFAULT 'commodity',
      bid numeric(14,5), ask numeric(14,5), spread numeric(14,5) GENERATED ALWAYS AS (ask - bid) STORED,
      close numeric(14,5) NOT NULL, volume numeric(20,4), timeframe text NOT NULL DEFAULT 'tick',
      dxy_value numeric(10,4), us10y_yield numeric(7,4), real_yield numeric(7,4), vix numeric(8,4), wti numeric(10,4),
      source text NOT NULL, ts timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_market_ticks_no_future CHECK (ts <= created_at + INTERVAL '5 minutes'));
    GRANT SELECT ON public.market_ticks TO anon, authenticated, service_role;
    CREATE VIEW public.v_market_latest WITH (security_invoker = true) AS
    SELECT DISTINCT ON (symbol)
      symbol, asset_type, bid, ask, spread, close, volume, timeframe,
      dxy_value, us10y_yield, real_yield, vix, wti, source, ts,
      EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS staleness_seconds
    FROM public.market_ticks
    ORDER BY symbol, ts DESC;
    COMMENT ON VIEW public.v_market_latest IS
      'Dernier tick par instrument + indicateur de fraîcheur pour le badge LIVE/STALE du terminal.';
    GRANT SELECT ON public.v_market_latest TO anon, authenticated, service_role;
  `);
  const state = () => JSON.parse(sql(`SELECT json_build_object(
      'oid_kind', c.relkind, 'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl::text, 'options', c.reloptions,
      'comment', obj_description(c.oid, 'pg_class'),
      'column_acl', (SELECT json_agg(json_build_array(a.attname, a.attacl::text) ORDER BY a.attnum)
                     FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL),
      'triggers', (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid),
      'rules', (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class = c.oid),
      'columns', (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                  FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
    FROM pg_class c WHERE c.oid = 'public.v_market_latest'::regclass;`));
  const before = state();
  const staleSecondsExpr = /EXTRACT\(epoch FROM \(now\(\) - (?:v_market_latest\.)?ts\)\)\)?::integer AS staleness_seconds/i;
  assert.match(sql(`SELECT pg_get_viewdef('public.v_market_latest'::regclass);`), staleSecondsExpr);

  // --- 1. Migration: additive, ACL / options / owner unchanged, staleness_seconds unchanged.
  sql(MIGRATION);
  failAt('migration');
  const after = state();
  assert.deepEqual(after.columns, [...before.columns, ['staleness_us', 'bigint']], 'one column appended, nothing else moves');
  assert.deepEqual([after.acl, after.options, after.owner, after.oid_kind], [before.acl, before.options, before.owner, before.oid_kind]);
  assert.match(after.comment, /staleness_us/);
  assert.match(sql(`SELECT pg_get_viewdef('public.v_market_latest'::regclass);`), staleSecondsExpr);
  sql(MIGRATION);
  assert.deepEqual(state(), after, 'the migration can be re-run');
  console.log('PASS migration appends staleness_us; columns, ACL, security_invoker and owner unchanged; re-runnable');

  // --- 2. Edge matrix in the database: now() is fixed inside a transaction, so the age is exact by construction.
  const FIELD = { XAUUSD: 'spot', US10Y: 'us10y', US10YR: 'realYield', VIX: 'vix', WTI: 'wti' };
  const CLOSE = { XAUUSD: 3900, US10Y: 4.1, US10YR: 1.7, VIX: 17.2, WTI: 66.4 };
  const rowsAt = (symbol, ageExpr) => JSON.parse(sql(`BEGIN;
    INSERT INTO public.market_ticks(symbol, close, source, ts) VALUES ('XAUUSD', 3900, 'synthetic', now())${symbol === 'XAUUSD' ? '' : `,
      ('${symbol}', ${CLOSE[symbol]}, 'synthetic', now() - ${ageExpr})`};
    ${symbol === 'XAUUSD' ? `UPDATE public.market_ticks SET ts = now() - ${ageExpr};` : ''}
    SELECT coalesce(json_agg(t), '[]')::jsonb FROM (SELECT symbol, bid, ask, close, dxy_value, us10y_yield, real_yield, vix, wti,
      source, ts, staleness_seconds, staleness_us FROM public.v_market_latest) t;
    ROLLBACK;`).split('\n').find((line) => line.startsWith('[')));
  let cells = 0;
  for (const symbol of Object.keys(FIELD)) {
    const rule = SYMBOL_RULES[symbol];
    for (const [threshold, below, above] of [[rule.liveMaxAgeS, 'LIVE', 'STALE'], [rule.staleMaxAgeS, 'STALE', 'UNAVAILABLE']]) {
      for (const offsetMs of [-1, 0, 1, 499, 500, 999]) {
        const ageMs = threshold * 1000 + offsetMs;
        const rows = rowsAt(symbol, `interval '${ageMs} milliseconds'`);
        const row = rows.find((r) => r.symbol === symbol);
        const where = `${symbol} ${threshold} s ${offsetMs} ms`;
        assert.equal(row.staleness_us, ageMs * 1000, `${where}: exact microseconds`);
        assert.equal(row.staleness_seconds, Math.round(ageMs / 1000), `${where}: the integer column still rounds`);
        assert.equal(context.buildSnapshot(rows)[FIELD[symbol]].status, offsetMs > 0 ? above : below, where);
        cells += 1;
      }
    }
    // One microsecond past the stale edge.
    const rows = rowsAt(symbol, `interval '${rule.staleMaxAgeS} seconds 1 microsecond'`);
    assert.equal(rows.find((r) => r.symbol === symbol).staleness_us, rule.staleMaxAgeS * 1_000_000 + 1);
    assert.equal(context.buildSnapshot(rows)[FIELD[symbol]].status, 'UNAVAILABLE', `${symbol} +1 µs`);
  }
  console.log(`PASS v_market_latest.staleness_us is exact and the runtime read classifies it at ${cells} edge cells (+1 µs too)`);

  // --- 3. Time zones: the session zone and the literal's offset never change the age of one instant.
  const ageIn = (zone, literal) => sql(`BEGIN; SET LOCAL TIME ZONE '${zone}';
    INSERT INTO public.market_ticks(symbol, close, source, ts, created_at) VALUES ('XAUUSD', 3900, 'synthetic', '${literal}', '2026-10-01T14:15:00Z');
    SELECT ((EXTRACT(EPOCH FROM '2026-10-01T14:15:00Z'::timestamptz) - EXTRACT(EPOCH FROM ts)) * 1000000)::BIGINT FROM public.market_ticks;
    ROLLBACK;`).split('\n').filter((line) => /^-?\d+$/.test(line)).at(-1);
  const ages = new Set();
  for (const zone of ['UTC', 'Europe/Paris', 'America/New_York', 'Asia/Tokyo']) {
    for (const literal of ['2026-10-01T14:08:59.999Z', '2026-10-01T16:08:59.999+02:00', '2026-10-01T09:08:59.999-05:00']) ages.add(ageIn(zone, literal));
  }
  assert.deepEqual([...ages], ['360001000']);
  console.log('PASS the same instant has the same exact age in every session time zone and literal offset');

  // --- 4. The SQL no-future CHECK is exact: 5 min accepted, 5 min + 1 µs refused; the view reports a negative age.
  const ahead = JSON.parse(sql(`BEGIN;
    INSERT INTO public.market_ticks(symbol, close, source, ts) VALUES ('XAUUSD', 3900, 'synthetic', now() + interval '5 minutes');
    SELECT json_agg(t)::jsonb FROM (SELECT staleness_us, staleness_seconds FROM public.v_market_latest) t; ROLLBACK;`).split('\n').find((l) => l.startsWith('[')));
  assert.deepEqual(ahead, [{ staleness_us: -300_000_000, staleness_seconds: -300 }]);
  assert.throws(() => sql(`INSERT INTO public.market_ticks(symbol, close, source, ts) VALUES ('XAUUSD', 3900, 'synthetic', now() + interval '5 minutes 1 microsecond');`),
    /chk_market_ticks_no_future/);
  assert.throws(() => sql(`INSERT INTO public.market_ticks(symbol, close, source, ts) VALUES ('XAUUSD', 3900, 'synthetic', NULL);`), /null value/);
  assert.throws(() => sql(`INSERT INTO public.market_ticks(symbol, close, source, ts) VALUES ('XAUUSD', 3900, 'synthetic', '2026-02-30T00:00:00Z');`), /out of range|invalid/);
  console.log('PASS the no-future CHECK is exact to the microsecond; NULL and impossible timestamps are refused');

  // --- 5. Rollback refusals. Anything that depends on the view, anything DROP VIEW would silently take with it,
  // and a runner who is not the owner abort the whole rollback: the migrated view is left exactly as it was.
  const viewdef = () => sql(`SELECT pg_get_viewdef('public.v_market_latest'::regclass);`);
  const migratedDef = viewdef();
  const refusals = [
    ['a dependent view', 'CREATE VIEW public.xau_probe AS SELECT symbol FROM public.v_market_latest;', 'DROP VIEW public.xau_probe;', /depend/],
    ['a dependent materialized view', 'CREATE MATERIALIZED VIEW public.xau_probe AS SELECT symbol FROM public.v_market_latest WITH NO DATA;',
      'DROP MATERIALIZED VIEW public.xau_probe;', /depend/],
    ['a function returning its row type', 'CREATE FUNCTION public.xau_probe() RETURNS SETOF public.v_market_latest LANGUAGE sql STABLE AS $$ SELECT * FROM public.v_market_latest $$;',
      'DROP FUNCTION public.xau_probe();', /depend/],
    ['a SQL-standard function body', 'CREATE FUNCTION public.xau_probe() RETURNS bigint LANGUAGE sql STABLE BEGIN ATOMIC SELECT count(*) FROM public.v_market_latest; END;',
      'DROP FUNCTION public.xau_probe();', /depend/],
    ['an INSTEAD OF trigger', `CREATE FUNCTION public.xau_probe_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER xau_probe INSTEAD OF INSERT ON public.v_market_latest FOR EACH ROW EXECUTE FUNCTION public.xau_probe_trg();`,
      'DROP TRIGGER xau_probe ON public.v_market_latest; DROP FUNCTION public.xau_probe_trg();', /has triggers/],
    ['a rule', 'CREATE RULE xau_probe AS ON DELETE TO public.v_market_latest DO INSTEAD NOTHING;', 'DROP RULE xau_probe ON public.v_market_latest;', /has rules/],
    ['a privilege on staleness_us', 'GRANT SELECT (staleness_us) ON public.v_market_latest TO xau_a_c3_reader;',
      'REVOKE SELECT (staleness_us) ON public.v_market_latest FROM xau_a_c3_reader;', /privileges are granted on v_market_latest.staleness_us/],
    ['a runner who is not the owner', null, null, /must be owner/, 'SET SESSION AUTHORIZATION xau_a_c3_reader;'],
  ];
  for (const [what, arm, disarm, refusal, prefix = ''] of refusals) {
    if (arm) sql(arm);
    const armed = state();
    assert.throws(() => sql(`${prefix}\n${ROLLBACK}`), refusal, what);
    assert.deepEqual(state(), armed, `${what}: nothing changed`);
    assert.equal(viewdef(), migratedDef, `${what}: definition unchanged`);
    if (disarm) sql(disarm);
    assert.deepEqual(state(), after, `${what}: back to the migrated state`);
  }
  console.log(`PASS rollback refused, nothing changed, for ${refusals.map(([what]) => what).join(', ')}`);

  // --- 6. Rollback run by a superuser who is not the owner: owner, grantors, grant options and column privileges come
  // back exactly, and a plpgsql function that reads the view by name keeps working.
  sql(`ALTER VIEW public.v_market_latest OWNER TO xau_a_c3_view_owner;
    GRANT SELECT ON public.v_market_latest TO authenticated WITH GRANT OPTION;
    SET ROLE authenticated; GRANT SELECT ON public.v_market_latest TO xau_a_c3_reader; RESET ROLE;
    GRANT SELECT (symbol, ts) ON public.v_market_latest TO PUBLIC;
    GRANT SELECT (staleness_seconds) ON public.v_market_latest TO xau_a_c3_reader WITH GRANT OPTION;
    CREATE FUNCTION public.xau_probe_reader() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
      BEGIN RETURN (SELECT count(*) FROM public.v_market_latest); END $$;`);
  const granted = state();
  assert.match(granted.acl, /xau_a_c3_reader=r\/authenticated/, 'a grant made by a non-owner grantor');
  assert.equal(granted.column_acl.length, 3);
  sql(ROLLBACK);
  const restored = state();
  assert.deepEqual(restored.columns, before.columns);
  assert.deepEqual(
    [restored.owner, restored.acl, restored.column_acl, restored.options, restored.comment],
    ['xau_a_c3_view_owner', granted.acl, granted.column_acl, before.options, before.comment]);
  assert.match(viewdef(), staleSecondsExpr);
  assert.equal(sql('SELECT public.xau_probe_reader();'), '0');
  sql(MIGRATION);
  assert.deepEqual([state().columns, state().acl, state().column_acl], [after.columns, granted.acl, granted.column_acl],
    'migration re-applies after a rollback, privileges untouched');
  console.log('PASS rollback by a non-owner superuser restores owner, grantors, grant options, column privileges, security_invoker, comment');

  // --- 7. Rollback run by the owner itself (not a superuser): it cannot replay a grant made by another grantor, so it
  // aborts with nothing changed; once that grant is gone, it succeeds and restores everything.
  sql('GRANT CREATE ON SCHEMA public TO xau_a_c3_view_owner;');
  const migrated = state();
  assert.throws(() => sql(`SET SESSION AUTHORIZATION xau_a_c3_view_owner;\n${ROLLBACK}`), /permission denied to set role/);
  assert.deepEqual(state(), migrated, 'owner-run rollback that cannot replay a grantor: nothing changed');
  sql('REVOKE SELECT ON public.v_market_latest FROM authenticated CASCADE;');
  const ownerGrantsOnly = state();
  assert.doesNotMatch(ownerGrantsOnly.acl, /authenticated/);
  sql(`SET SESSION AUTHORIZATION xau_a_c3_view_owner;\n${ROLLBACK}`);
  const ownerRestored = state();
  assert.deepEqual(ownerRestored.columns, before.columns);
  assert.deepEqual([ownerRestored.owner, ownerRestored.acl, ownerRestored.column_acl],
    [ownerGrantsOnly.owner, ownerGrantsOnly.acl, ownerGrantsOnly.column_acl]);
  sql('REVOKE CREATE ON SCHEMA public FROM xau_a_c3_view_owner;');
  console.log('PASS owner-run rollback: aborts untouched when a grantor cannot be replayed, otherwise restores exactly');
} finally {
  // Only the database this run created: owned by this role and still carrying this run's token.
  if (ours()) admin(`DROP DATABASE ${SCRATCH};`);
  else { console.error(`NOT dropped: ${SCRATCH} is not this run's database`); process.exitCode = 1; }
}
