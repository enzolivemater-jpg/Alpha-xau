// PostgreSQL 17.6 proof for MP-2 in a disposable local database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_market_driver_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
assert.ok(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGHOSTADDR,
  'connection overrides are not allowed');

const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
function sql(query) {
  return execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
}
function rejects(query, pattern) {
  assert.throws(() => sql(query), pattern);
}

assert.match(sql('SHOW server_version;'), /^17\.6(?:\D|$)/, 'PostgreSQL 17.6 required');
sql(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.data_sources (code text PRIMARY KEY);
  INSERT INTO public.data_sources VALUES ('source_a'), ('source_b');
`);
sql(readFileSync(new URL('database/migrations/20261002085845_market_pricing_history_as_of.sql', root), 'utf8'));

assert.equal(sql(`SELECT relrowsecurity FROM pg_class
  WHERE oid='public.market_pricing_observations'::regclass;`), 't');
assert.equal(sql(`SELECT
  NOT has_table_privilege('anon','public.market_pricing_observations','SELECT')
  AND NOT has_table_privilege('authenticated','public.market_pricing_observations','SELECT')
  AND has_table_privilege('service_role','public.market_pricing_observations','SELECT')
  AND has_table_privilege('service_role','public.market_pricing_observations','INSERT')
  AND NOT has_table_privilege('service_role','public.market_pricing_observations','UPDATE')
  AND NOT has_table_privilege('service_role','public.market_pricing_observations','DELETE');`), 't');
console.log('PASS MP-2 RLS and exact table privileges fail closed');

const replayIdentityObservedAt = '2025-01-01T00:00:00Z';
const record = (value) => sql(`SET ROLE service_role; SELECT observation_id || '|' || outcome || '|' || ingested_at
  FROM public.fn_market_pricing_record_observation(
    'spot', ${value}, 'source_a', '${replayIdentityObservedAt}', 'live-r1'
  );`);
const persisted = record(3900);
assert.match(persisted, /^[0-9a-f-]{36}\|PERSISTED\|/);
const replayed = record(3900);
assert.equal(replayed.replace('|REPLAYED|', '|PERSISTED|'), persisted);
rejects(`SET ROLE service_role; SELECT * FROM public.fn_market_pricing_record_observation(
  'spot', 3901, 'source_a', '${replayIdentityObservedAt}', 'live-r1');`,
  /divergent value/);
console.log('PASS record RPC is idempotent and divergent identity reuse fails closed');

sql(`
  INSERT INTO public.market_pricing_observations
    (id, field, value, source, source_observed_at, ingested_at, evidence_revision)
  VALUES
    ('10000000-0000-4000-8000-000000000001','spot',3898,'source_a','2026-10-01T09:55Z','2026-10-01T09:56Z','r1'),
    ('10000000-0000-4000-8000-000000000002','spot',3900,'source_a','2026-10-01T09:55Z','2026-10-01T10:05Z','r2'),
    ('10000000-0000-4000-8000-000000000003','bid',3897.8,'source_a','2026-10-01T09:55Z','2026-10-01T09:56Z','r1'),
    ('10000000-0000-4000-8000-000000000004','ask',3898.2,'source_a','2026-10-01T09:55Z','2026-10-01T09:56Z','r1'),
    ('10000000-0000-4000-8000-000000000005','dxy',97.4,'source_a','2026-10-01T08:00Z','2026-10-01T08:01Z','r1'),
    ('10000000-0000-4000-8000-000000000006','us10y',4.1,'source_a','2026-10-01T00:00Z','2026-10-01T00:03Z','r1'),
    ('10000000-0000-4000-8000-000000000007','realYield',1.7,'source_a','2026-10-01T00:00Z','2026-10-01T00:03Z','r1'),
    ('10000000-0000-4000-8000-000000000008','vix',17.2,'source_a','2026-10-01T00:00Z','2026-10-01T00:03Z','r1'),
    ('10000000-0000-4000-8000-000000000009','wti',66.4,'source_a','2026-10-01T00:00Z','2026-10-01T00:03Z','r1');
`);

assert.equal(sql(`SET ROLE service_role; SELECT string_agg(candidate_id::text, ',' ORDER BY observed_at DESC, ingested_at DESC)
  FROM public.fn_market_pricing_candidates_as_of('2026-10-01T10:00Z', 20)
  WHERE field='spot';`), '10000000-0000-4000-8000-000000000001');
assert.equal(sql(`SET ROLE service_role; SELECT string_agg(candidate_id::text, ',' ORDER BY observed_at DESC, ingested_at DESC)
  FROM public.fn_market_pricing_candidates_as_of('2026-10-01T10:06Z', 20)
  WHERE field='spot';`),
  '10000000-0000-4000-8000-000000000002,10000000-0000-4000-8000-000000000001');
console.log('PASS late correction is excluded before ingestion and included at the later cutoff');

assert.equal(sql(`SET ROLE service_role; SELECT string_agg(field, ',' ORDER BY
  CASE field WHEN 'spot' THEN 1 WHEN 'bid' THEN 2 WHEN 'ask' THEN 3 WHEN 'dxy' THEN 4
  WHEN 'us10y' THEN 5 WHEN 'realYield' THEN 6 WHEN 'vix' THEN 7 WHEN 'wti' THEN 8 END)
  FROM public.fn_market_pricing_candidates_as_of('2026-10-01T10:00Z', 20);`),
  'spot,bid,ask,dxy,us10y,realYield,vix,wti');
rejects(`SET ROLE service_role; SELECT * FROM public.fn_market_pricing_candidates_as_of('2026-10-01T10:00Z', 1);`,
  /exceeds explicit bound/);
rejects(`SET ROLE service_role; SELECT * FROM public.fn_market_pricing_candidates_as_of('infinity', 20);`,
  /finite timestamp/);
console.log('PASS as-of RPC is deterministic, complete-or-error, and rejects invalid bounds');

rejects(`UPDATE public.market_pricing_observations SET value=value+1
  WHERE id='10000000-0000-4000-8000-000000000001';`, /append-only/);
rejects(`DELETE FROM public.market_pricing_observations
  WHERE id='10000000-0000-4000-8000-000000000001';`, /append-only/);
rejects(`INSERT INTO public.market_pricing_observations
  (field,value,source,source_observed_at,ingested_at,evidence_revision)
  VALUES ('spot',3900,'source_a','2026-10-01T10:01Z','2026-10-01T10:00Z','future');`,
  /chk_market_pricing_observation_chronology|check constraint/);
rejects(`INSERT INTO public.market_pricing_observations
  (field,value,source,source_observed_at,ingested_at,evidence_revision)
  VALUES ('vix','NaN','source_a','2026-10-01T09:00Z','2026-10-01T09:01Z','nan');`,
  /market_pricing_observations_value_check|check constraint/);
console.log('PASS append-only, chronology, and finite-value constraints reject corruption');

assert.equal(sql(`SELECT bool_and(
  NOT p.prosecdef
  AND EXISTS (SELECT 1 FROM unnest(p.proconfig) setting WHERE setting IN ('search_path=', 'search_path=""'))
  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND has_function_privilege('service_role', p.oid, 'EXECUTE')
)
FROM pg_proc p
WHERE p.oid IN (
  'public.fn_market_pricing_record_observation(text,numeric,text,timestamptz,text)'::regprocedure,
  'public.fn_market_pricing_candidates_as_of(timestamptz,integer)'::regprocedure
);`), 't');
console.log('PASS writer and as-of RPCs are security-invoker, empty-search-path, and service-role-only');
