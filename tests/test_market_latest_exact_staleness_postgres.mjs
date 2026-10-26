// PostgreSQL 17.6 proof for migration 20261026120000_market_latest_exact_staleness (A-C3) and its rollback.
// Runs in a scratch database created on the job's ephemeral server and dropped at the end; it never touches
// an existing environment. Values are synthetic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

assert.equal(process.env.PGDATABASE, 'xau_market_rls_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const SCRATCH = 'xau_market_staleness_scratch';
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
admin(`DROP DATABASE IF EXISTS ${SCRATCH};`);
admin(`CREATE DATABASE ${SCRATCH};`);
try {
  // --- Fixture: the market_ticks columns the view reads, the no-future CHECK, and the view as deployed today
  // (schema.sql section 9 before A-C3, security_invoker from 0033), with the grants the application relies on.
  sql(`
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $roles$;
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
      'columns', (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                  FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
    FROM pg_class c WHERE c.oid = 'public.v_market_latest'::regclass;`));
  const before = state();
  const staleSecondsExpr = /EXTRACT\(epoch FROM \(now\(\) - (?:v_market_latest\.)?ts\)\)\)?::integer AS staleness_seconds/i;
  assert.match(sql(`SELECT pg_get_viewdef('public.v_market_latest'::regclass);`), staleSecondsExpr);

  // --- 1. Migration: additive, ACL / options / owner unchanged, staleness_seconds unchanged.
  sql(MIGRATION);
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

  // --- 5. Rollback: refused while something depends on the view (nothing changes), then exact restoration.
  sql('CREATE VIEW public.xau_dependent_probe AS SELECT symbol FROM public.v_market_latest;');
  assert.throws(() => sql(ROLLBACK), /depend/);
  assert.deepEqual(state(), after, 'a refused rollback leaves the migrated view intact');
  sql('DROP VIEW public.xau_dependent_probe;');
  sql(`GRANT SELECT ON public.v_market_latest TO authenticated WITH GRANT OPTION;`);
  const withOption = state();
  sql(ROLLBACK);
  const restored = state();
  assert.deepEqual(restored.columns, before.columns);
  assert.deepEqual([restored.acl, restored.options, restored.owner, restored.comment], [withOption.acl, before.options, before.owner, before.comment]);
  assert.match(sql(`SELECT pg_get_viewdef('public.v_market_latest'::regclass);`), staleSecondsExpr);
  sql(MIGRATION);
  assert.deepEqual(state().columns, after.columns, 'migration re-applies after a rollback');
  console.log('PASS rollback restores columns, ACL (grant options included), security_invoker, owner and comment; refused if a view depends on it');
} finally {
  admin(`DROP DATABASE IF EXISTS ${SCRATCH};`);
}
