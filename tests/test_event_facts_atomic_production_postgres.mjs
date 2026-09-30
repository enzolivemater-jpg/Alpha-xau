// PostgreSQL 17 proof for EF-8 in the disposable Event Facts database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_event_facts_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
const sql = query => execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
const rejects = (query, pattern) => assert.throws(() => sql(query), pattern);

assert.equal(sql('SHOW server_version_num;').slice(0, 2), '17');
sql(`
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  DROP SCHEMA IF EXISTS extensions CASCADE;
  DROP ROLE IF EXISTS anon;
  DROP ROLE IF EXISTS authenticated;
  DROP ROLE IF EXISTS service_role;
  CREATE SCHEMA extensions;
  CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.ingestion_runs (id uuid PRIMARY KEY);
  CREATE TABLE public.news_articles (
    id uuid PRIMARY KEY, ingest_run_id uuid NOT NULL REFERENCES public.ingestion_runs(id),
    provider text NOT NULL, source_code text NOT NULL, source_domain text,
    canonical_url text, observed_at timestamptz NOT NULL, ingested_at timestamptz NOT NULL
  );
  CREATE TABLE public.official_source_artifacts (
    id uuid PRIMARY KEY, ingest_run_id uuid NOT NULL REFERENCES public.ingestion_runs(id),
    artifact_role text NOT NULL, content_sha256 text NOT NULL,
    observed_at timestamptz NOT NULL, ingested_at timestamptz NOT NULL
  );
  CREATE TABLE public.event_clusters (id uuid PRIMARY KEY, first_observation_id uuid NOT NULL);
  CREATE TABLE public.event_observation_memberships (
    decision_id uuid PRIMARY KEY, observation_id uuid NOT NULL, cluster_id uuid NOT NULL,
    decision_type text NOT NULL, supersedes_decision_id uuid, assigned_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.event_cluster_identity_claims (
    identity_claim_id uuid PRIMARY KEY, cluster_id uuid NOT NULL,
    authority_namespace text NOT NULL, identity_type text NOT NULL, identity_value text NOT NULL,
    strong_identity_key text GENERATED ALWAYS AS (
      encode(extensions.digest(authority_namespace || chr(31) || identity_type || chr(31) || identity_value, 'sha256'), 'hex')
    ) STORED,
    supersedes_claim_id uuid
  );
  CREATE TABLE public.event_versions (
    id uuid PRIMARY KEY, cluster_id uuid NOT NULL, version_number integer NOT NULL,
    canonical_event_state jsonb NOT NULL
  );
  CREATE OR REPLACE FUNCTION public.fn_event_schema_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only'; END $$;
  CREATE OR REPLACE FUNCTION public.fn_event_is_supported_canonical_state(smallint, jsonb)
  RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT $1 = 2 AND $2->>'event_type' = 'STATISTICAL_RELEASE'
      AND $2->'facts'->>'release_family' = 'US_CPI'
  $$;
  CREATE OR REPLACE FUNCTION public.fn_event_lock_cluster(uuid) RETURNS void
  LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended('cluster:' || $1::text, 0)) $$;
  CREATE OR REPLACE FUNCTION public.fn_event_assign_observation(
    p_observation_id uuid, p_membership_method text, p_evidence_digest text,
    p_membership_algorithm_version text, p_decision_actor text,
    p_idempotency_fingerprint text, p_semantic_state_fingerprint text,
    p_cluster_id uuid DEFAULT NULL, p_cluster_key text DEFAULT NULL,
    p_category text DEFAULT NULL, p_region text DEFAULT NULL,
    p_cluster_algorithm_version text DEFAULT NULL, p_membership_confidence numeric DEFAULT NULL,
    p_editorial_origin_key text DEFAULT NULL, p_wire_lineage_key text DEFAULT NULL,
    p_lineage_resolution_method text DEFAULT NULL,
    p_lineage_resolution_confidence numeric DEFAULT NULL, p_lineage_evidence text DEFAULT NULL
  ) RETURNS TABLE(cluster_id uuid, decision_id uuid, cluster_created_now boolean, replayed boolean)
  LANGUAGE plpgsql AS $$
  DECLARE c uuid := COALESCE(p_cluster_id, gen_random_uuid()); d uuid := gen_random_uuid();
  BEGIN
    IF p_cluster_id IS NULL THEN INSERT INTO public.event_clusters VALUES (c, p_observation_id); END IF;
    INSERT INTO public.event_observation_memberships
      (decision_id, observation_id, cluster_id, decision_type) VALUES (d, p_observation_id, c, 'ASSIGN');
    RETURN QUERY SELECT c, d, p_cluster_id IS NULL, false;
  END $$;
  CREATE OR REPLACE FUNCTION public.fn_event_assert_identity_claim(
    p_cluster_id uuid, p_authority_namespace text, p_identity_type text,
    p_identity_value text, p_knowledge_cutoff timestamptz, p_algorithm_version text,
    p_decision_actor text, p_reason text, p_idempotency_fingerprint text,
    p_supersedes_claim_id uuid DEFAULT NULL
  ) RETURNS TABLE(cluster_id uuid, identity_claim_id uuid, strong_identity_key text,
    superseded_claim_id uuid, replayed boolean)
  LANGUAGE plpgsql AS $$
  DECLARE i uuid := gen_random_uuid(); k text;
  BEGIN
    INSERT INTO public.event_cluster_identity_claims
      (identity_claim_id, cluster_id, authority_namespace, identity_type, identity_value, supersedes_claim_id)
    VALUES (i, p_cluster_id, p_authority_namespace, p_identity_type, p_identity_value, p_supersedes_claim_id)
    RETURNING event_cluster_identity_claims.strong_identity_key INTO k;
    RETURN QUERY SELECT p_cluster_id, i, k, p_supersedes_claim_id, false;
  END $$;
  CREATE OR REPLACE FUNCTION public.fn_event_create_event_version(
    p_cluster_id uuid, p_transition_type text, p_knowledge_cutoff timestamptz,
    p_effective_time timestamptz, p_effective_time_precision text,
    p_canonical_event_state_schema_version smallint, p_canonical_event_state jsonb,
    p_official_confirmation_state text, p_source_independence_state text,
    p_algorithm_version text, p_decision_actor text, p_idempotency_fingerprint text,
    p_supersedes_version_id uuid DEFAULT NULL
  ) RETURNS TABLE(event_version_id uuid, version_number integer, transition_type text,
    state_fingerprint text, source_independence_state text, evidence_count integer,
    outcome text, replayed boolean)
  LANGUAGE plpgsql AS $$
  DECLARE v uuid := gen_random_uuid(); n integer; prior record;
  BEGIN
    IF p_canonical_event_state->>'subject' = 'ROLLBACK' THEN RAISE EXCEPTION 'forced downstream failure'; END IF;
    SELECT ev.id, ev.version_number, ev.canonical_event_state INTO prior
      FROM public.event_versions ev WHERE ev.cluster_id = p_cluster_id ORDER BY ev.version_number DESC LIMIT 1;
    IF FOUND AND prior.canonical_event_state = p_canonical_event_state THEN
      RETURN QUERY SELECT prior.id, prior.version_number, p_transition_type, 'same',
        p_source_independence_state, 1, 'NO_MATERIAL_CHANGE'::text, false; RETURN;
    END IF;
    n := COALESCE(prior.version_number, 0) + 1;
    INSERT INTO public.event_versions VALUES (v, p_cluster_id, n, p_canonical_event_state);
    RETURN QUERY SELECT v, n, p_transition_type, 'state', p_source_independence_state,
      1, 'CREATED'::text, false;
  END $$;
`);
sql(readFileSync(new URL('database/migrations/0032_event_facts_atomic_production.sql', root), 'utf8'));

const run = '00000000-0000-4000-8000-000000000001';
const observation = '10000000-0000-4000-8000-000000000001';
const header = '20000000-0000-4000-8000-000000000001';
const table = '30000000-0000-4000-8000-000000000001';
sql(`
  INSERT INTO public.ingestion_runs VALUES ('${run}');
  INSERT INTO public.news_articles VALUES
    ('${observation}','${run}','bls','bls_cpi_release','bls.gov',
     'https://www.bls.gov/news.release/archives/cpi_09112026.htm', now(), now());
  INSERT INTO public.official_source_artifacts VALUES
    ('${header}','${run}','RELEASE_HEADER_HTML','${'a'.repeat(64)}',now(),now()),
    ('${table}','${run}','RELEASE_TABLE1_XLSX','${'b'.repeat(64)}',now(),now());
`);
const state = subject => JSON.stringify({ event_type: 'STATISTICAL_RELEASE', subject, detail: null,
  facts: { release_family: 'US_CPI', metrics: [] } }).replaceAll("'", "''");
const identity = '{"release_id":"USDL-26-1496"}';
const fp = 'c'.repeat(64);
const call = (subject = 'CPI August 2026', fingerprint = fp, identityValue = identity) => `
  SELECT version_outcome, operation_replayed FROM public.fn_event_fact_produce_bls_cpi(
    '${observation}','${header}','${table}',
    'xau_v2:official_release:us_bls:v1','official_release_id:bls_cpi_v1',
    '${identityValue.replaceAll("'", "''")}','${state(subject)}'::jsonb,'${fingerprint}');`;

assert.equal(sql(call()), 'CREATED|f');
assert.equal(sql(`SELECT
  (SELECT count(*) FROM public.event_clusters),
  (SELECT count(*) FROM public.event_observation_memberships),
  (SELECT count(*) FROM public.event_cluster_identity_claims),
  (SELECT count(*) FROM public.event_versions),
  (SELECT count(*) FROM public.event_version_official_artifacts),
  (SELECT count(*) FROM public.event_fact_production_operations);`), '1|1|1|1|2|1');
assert.equal(sql(call()), 'CREATED|t');
console.log('PASS first operation is atomic and exact replay creates no rows');

rejects(call('changed intent'), /EF8_OPERATION_IDEMPOTENCY_CONFLICT/);
assert.equal(sql('SELECT count(*) FROM public.event_versions;'), '1');
console.log('PASS divergent reuse of the operation fingerprint fails closed');

const rollbackFp = 'd'.repeat(64);
rejects(call('ROLLBACK', rollbackFp, '{"release_id":"USDL-26-9999"}'), /forced downstream failure/);
assert.equal(sql(`SELECT
  (SELECT count(*) FROM public.event_clusters),
  (SELECT count(*) FROM public.event_observation_memberships),
  (SELECT count(*) FROM public.event_cluster_identity_claims),
  (SELECT count(*) FROM public.event_versions),
  (SELECT count(*) FROM public.event_fact_production_operations);`), '1|1|1|1|1');
console.log('PASS downstream failure rolls back cluster, membership, claim, version, and ledger together');

assert.equal(sql(`SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.event_version_official_artifacts'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.event_fact_production_operations'::regclass)
  AND NOT has_function_privilege('anon','public.fn_event_fact_produce_bls_cpi(uuid,uuid,uuid,text,text,text,jsonb,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_event_fact_produce_bls_cpi(uuid,uuid,uuid,text,text,text,jsonb,text)','EXECUTE')
  AND has_function_privilege('service_role','public.fn_event_fact_produce_bls_cpi(uuid,uuid,uuid,text,text,text,jsonb,text)','EXECUTE');`), 't');
console.log('PASS EF-8 tables use RLS and the invoker RPC is service-role-only');
