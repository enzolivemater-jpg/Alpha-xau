// PostgreSQL 17.6 proof for provider-neutral Positioning P-1 persistence.
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
sql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;`);
sql(readFileSync(new URL('database/migrations/20261002092118_positioning_evidence_history_as_of.sql', root), 'utf8'));

assert.equal(sql(`SELECT relrowsecurity FROM pg_class
  WHERE oid='public.positioning_evidence_observations'::regclass;`), 't');
assert.equal(sql(`SELECT
  NOT has_table_privilege('anon','public.positioning_evidence_observations','SELECT')
  AND NOT has_table_privilege('authenticated','public.positioning_evidence_observations','SELECT')
  AND has_table_privilege('service_role','public.positioning_evidence_observations','SELECT')
  AND has_table_privilege('service_role','public.positioning_evidence_observations','INSERT')
  AND NOT has_table_privilege('service_role','public.positioning_evidence_observations','UPDATE')
  AND NOT has_table_privilege('service_role','public.positioning_evidence_observations','DELETE');`), 't');
console.log('PASS P-1 RLS and exact table privileges fail closed');

const record = value => sql(`SET ROLE service_role; SELECT evidence_id || '|' || outcome || '|' || observed_at
  FROM public.fn_positioning_evidence_record(
    'authority_test','weekly_positions','GC','managed_money_net',${value},
    'CONTRACTS','2025-01-01','2025-01-02T00:00:00Z','sha256:initial',NULL
  );`);
const persisted = record(12000);
assert.match(persisted, /^[0-9a-f-]{36}\|PERSISTED\|/);
const replayed = record(12000);
assert.equal(replayed.replace('|REPLAYED|', '|PERSISTED|'), persisted);
rejects(`SET ROLE service_role; SELECT * FROM public.fn_positioning_evidence_record(
  'authority_test','weekly_positions','GC','managed_money_net',12001,
  'CONTRACTS','2025-01-01','2025-01-02T00:00:00Z','sha256:initial',NULL);`,
  /divergent payload/);
console.log('PASS P-1 writer is idempotent and divergent identity reuse fails closed');

sql(`INSERT INTO public.positioning_evidence_observations
  (id,source_authority,dataset_code,instrument_code,metric_code,value,unit,
   period_end,published_at,observed_at,artifact_id,revision)
VALUES
  ('30000000-0000-4000-8000-000000000001','authority_test','weekly_positions','GC','managed_money_net',12345,'CONTRACTS','2026-09-29','2026-09-30T19:30Z','2026-09-30T19:31Z','sha256:r1',NULL),
  ('30000000-0000-4000-8000-000000000002','authority_test','weekly_positions','GC','managed_money_net',12350,'CONTRACTS','2026-09-29','2026-09-30T19:30Z','2026-10-01T12:05Z','sha256:r2','r2'),
  ('30000000-0000-4000-8000-000000000003','authority_test','weekly_positions','GC','open_interest',450000,'CONTRACTS','2026-09-29','2026-09-30T19:30Z','2026-09-30T19:31Z','sha256:oi',NULL);`);

assert.equal(sql(`SET ROLE service_role; SELECT string_agg(evidence_id::text, ',' ORDER BY observed_at)
  FROM public.fn_positioning_evidence_as_of('2026-10-01T12:00Z', 20)
  WHERE metric_code='managed_money_net';`), '30000000-0000-4000-8000-000000000001');
assert.equal(sql(`SET ROLE service_role; SELECT string_agg(evidence_id::text, ',' ORDER BY observed_at)
  FROM public.fn_positioning_evidence_as_of('2026-10-01T12:06Z', 20)
  WHERE metric_code='managed_money_net';`),
  '30000000-0000-4000-8000-000000000001,30000000-0000-4000-8000-000000000002');
rejects(`SET ROLE service_role; SELECT * FROM public.fn_positioning_evidence_as_of('2026-10-01T12:06Z', 1);`,
  /exceeds explicit bound/);
rejects(`SET ROLE service_role; SELECT * FROM public.fn_positioning_evidence_as_of('infinity', 20);`,
  /finite timestamp/);
console.log('PASS P-1 revisions obey dual-timestamp cutoff and complete-or-error bounds');

rejects(`UPDATE public.positioning_evidence_observations SET value=value+1
  WHERE id='30000000-0000-4000-8000-000000000001';`, /append-only/);
rejects(`DELETE FROM public.positioning_evidence_observations
  WHERE id='30000000-0000-4000-8000-000000000001';`, /append-only/);
rejects(`INSERT INTO public.positioning_evidence_observations
  (source_authority,dataset_code,instrument_code,metric_code,value,unit,
   period_end,published_at,observed_at,artifact_id)
  VALUES ('authority_test','weekly_positions','GC','open_interest',1,'CONTRACTS',
    '2026-09-29','2026-10-01T10:01Z','2026-10-01T10:00Z','sha256:future');`,
  /chk_positioning_evidence_chronology|check constraint/);
console.log('PASS P-1 append-only and chronology constraints reject corruption');

assert.equal(sql(`SELECT bool_and(
  NOT p.prosecdef
  AND EXISTS (SELECT 1 FROM unnest(p.proconfig) setting WHERE setting IN ('search_path=', 'search_path=""'))
  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND has_function_privilege('service_role', p.oid, 'EXECUTE')
)
FROM pg_proc p
WHERE p.oid IN (
  'public.fn_positioning_evidence_record(text,text,text,text,numeric,text,date,timestamptz,text,text)'::regprocedure,
  'public.fn_positioning_evidence_as_of(timestamptz,integer)'::regprocedure
);`), 't');
console.log('PASS P-1 writer and reader are invoker, empty-search-path, service-role-only');
