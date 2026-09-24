// PostgreSQL 17 proof for EF-5A in the event-facts disposable CI database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_event_facts_test', 'disposable database required');
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

assert.equal(sql('SHOW server_version_num;').slice(0, 2), '17', 'PostgreSQL 17 required');
sql(`
  CREATE SCHEMA IF NOT EXISTS extensions;
  CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
  CREATE TABLE public.ingestion_runs (id uuid PRIMARY KEY);
  CREATE TABLE public.data_sources (code text PRIMARY KEY);
  INSERT INTO public.ingestion_runs VALUES ('00000000-0000-4000-8000-000000000001');
  INSERT INTO public.data_sources VALUES ('bls_cpi_release');
`);
sql(readFileSync(new URL('database/migrations/0030_official_source_artifacts.sql', root), 'utf8'));

const base = `
  INSERT INTO public.official_source_artifacts
    (ingest_run_id, authority, provider, source_code, source_domain,
     canonical_url, artifact_role, media_type, content_bytes, observed_at)
  VALUES
    ('00000000-0000-4000-8000-000000000001', 'US_BLS', 'bls',
     'bls_cpi_release', 'bls.gov',
     'https://www.bls.gov/news.release/archives/cpi_09112026.htm',
     'RELEASE_HEADER_HTML', 'text/html', decode('3c680074006d6c3e', 'hex'),
     '2026-09-11T12:30:00Z')`;
sql(`${base};`);
assert.equal(sql(`SELECT encode(content_bytes, 'hex') FROM public.official_source_artifacts;`),
  '3c680074006d6c3e', 'exact bytes, including NUL, must survive');
assert.equal(sql(`SELECT length(content_sha256), length(observation_hash)
  FROM public.official_source_artifacts;`), '64|64');

rejects(`${base};`, /uq_official_source_artifacts_observation_hash|duplicate key/);
sql(`${base.replace('3c680074006d6c3e', '3c680074016d6c3e')};`);
assert.equal(sql('SELECT count(*) FROM public.official_source_artifacts;'), '2');
console.log('PASS exact re-polls deduplicate and one-byte changes remain immutable evidence');

rejects(base.replace('https://www.bls.gov/', 'https://www.bls.gov.evil.example/'),
  /chk_official_source_artifacts_bls_cpi_scope|check constraint/);
rejects(base.replace("'text/html'", "'application/json'"), /check constraint/);
rejects(`UPDATE public.official_source_artifacts SET observed_at = now();`, /append-only/);
rejects(`DELETE FROM public.official_source_artifacts;`, /append-only/);
assert.equal(sql(`SELECT
  relrowsecurity
  AND NOT has_table_privilege('anon', 'public.official_source_artifacts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.official_source_artifacts', 'SELECT')
  AND has_table_privilege('service_role', 'public.official_source_artifacts', 'SELECT')
  AND has_table_privilege('service_role', 'public.official_source_artifacts', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.official_source_artifacts', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.official_source_artifacts', 'DELETE')
FROM pg_class WHERE oid = 'public.official_source_artifacts'::regclass;`), 't');
console.log('PASS scope/media checks, append-only trigger, RLS, and grants fail closed');
