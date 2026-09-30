import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../database/migrations/0032_event_facts_atomic_production.sql', import.meta.url), 'utf8');

for (const required of [
  'CREATE TABLE IF NOT EXISTS public.event_version_official_artifacts',
  'CREATE TABLE IF NOT EXISTS public.event_fact_production_operations',
  'CREATE OR REPLACE FUNCTION public.fn_event_fact_produce_bls_cpi',
  'SECURITY INVOKER',
  "SET search_path = ''",
  'pg_advisory_xact_lock',
  'EF8_OPERATION_IDEMPOTENCY_CONFLICT',
  'public.fn_event_assign_observation(',
  'public.fn_event_assert_identity_claim(',
  'public.fn_event_create_event_version(',
  "v_version.outcome NOT IN ('CREATED', 'NO_MATERIAL_CHANGE')",
]) assert.ok(migration.includes(required), `missing EF-8 contract: ${required}`);

assert.match(migration, /ALTER TABLE public\.event_version_official_artifacts ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /ALTER TABLE public\.event_fact_production_operations ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.fn_event_fact_produce_bls_cpi[\s\S]+FROM PUBLIC, anon, authenticated/);
assert.doesNotMatch(migration, /SECURITY DEFINER|\bUPDATE\s+public\.|\bDELETE\s+FROM\s+public\./i);
console.log('PASS EF-8 is invoker-secured, RLS-protected, append-only, and service-role-only');

const operationInsert = migration.indexOf('INSERT INTO public.event_fact_production_operations');
const versionCall = migration.indexOf('public.fn_event_create_event_version(', migration.indexOf('AS $$'));
assert.ok(versionCall > 0 && operationInsert > versionCall,
  'operation ledger must commit only after all nested mutation work succeeds');
assert.match(migration, /IF v_version\.outcome = 'CREATED' THEN[\s\S]+INSERT INTO public\.event_version_official_artifacts/);
console.log('PASS operation ledger and artifact links are ordered after canonical Event Version creation');

assert.match(migration, /v_header\.ingest_run_id IS DISTINCT FROM v_table\.ingest_run_id/);
assert.match(migration, /v_header\.ingest_run_id IS DISTINCT FROM v_observation\.ingest_run_id/);
assert.match(migration, /EF8_FUTURE_EVIDENCE_FORBIDDEN/);
assert.match(migration, /EF8_IDENTITY_CHANGED_DURING_OPERATION/);
console.log('PASS exact artifact bundle, temporal boundary, and post-lock identity recheck fail closed');
