import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_event_facts_test', 'disposable database required');
const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
const sql = query => execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();

sql(`
  CREATE TABLE public.event_clusters (id uuid PRIMARY KEY);
  CREATE TABLE public.event_cluster_identity_claims (
    identity_claim_id uuid PRIMARY KEY,
    cluster_id uuid NOT NULL REFERENCES public.event_clusters(id),
    authority_namespace text NOT NULL,
    identity_type text NOT NULL,
    identity_value text NOT NULL,
    strong_identity_key text GENERATED ALWAYS AS (
      encode(extensions.digest(authority_namespace || chr(31) || identity_type || chr(31) || identity_value, 'sha256'), 'hex')
    ) STORED,
    supersedes_claim_id uuid REFERENCES public.event_cluster_identity_claims(identity_claim_id)
  );
  INSERT INTO public.event_clusters VALUES
    ('11111111-1111-4111-8111-111111111111'),
    ('22222222-2222-4222-8222-222222222222');
`);
sql(readFileSync(new URL('database/migrations/0031_event_identity_active_lookup.sql', root), 'utf8'));
const argsSql = `'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', 'release-a'`;
assert.equal(sql(`SELECT count(*) FROM public.fn_event_lookup_active_identity_claims(${argsSql});`), '0');
sql(`INSERT INTO public.event_cluster_identity_claims VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
   'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', 'release-a', NULL);`);
assert.equal(sql(`SELECT cluster_id FROM public.fn_event_lookup_active_identity_claims(${argsSql});`),
  '11111111-1111-4111-8111-111111111111');
sql(`INSERT INTO public.event_cluster_identity_claims VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111',
   'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', 'release-b',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`);
assert.equal(sql(`SELECT count(*) FROM public.fn_event_lookup_active_identity_claims(${argsSql});`), '0');
assert.equal(sql(`SELECT cluster_id FROM public.fn_event_lookup_active_identity_claims(
  'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', 'release-b');`),
  '11111111-1111-4111-8111-111111111111');
sql(`INSERT INTO public.event_cluster_identity_claims VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222',
   'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', 'release-b', NULL);`);
assert.equal(sql(`SELECT count(*) FROM public.fn_event_lookup_active_identity_claims(
  'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', 'release-b');`), '2');
console.log('PASS PostgreSQL returns exact 0/1/>1 active-claim cardinality across key-changing supersession');

assert.equal(sql(`SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.proisstrict
  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND has_function_privilege('service_role', p.oid, 'EXECUTE')
FROM pg_proc p WHERE p.oid =
  'public.fn_event_lookup_active_identity_claims(text,text,text)'::regprocedure;`), 't');
console.log('PASS lookup is stable, strict, invoker-secured, and service-role-only');
