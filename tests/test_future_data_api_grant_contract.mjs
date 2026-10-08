import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  auditMigrationDirectory,
  auditMigrationSql,
  splitTopLevelSql,
} from '../scripts/check_data_api_grants.mjs';

const ok = sql => assert.deepEqual(auditMigrationSql(sql), []);
const fails = (sql, pattern) => assert.match(auditMigrationSql(sql).join('\n'), pattern);

assert.equal(splitTopLevelSql(`
  CREATE FUNCTION public.probe() RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    CREATE TABLE public.not_a_top_level_object(id integer);
  END;
  $$;
  REVOKE ALL ON FUNCTION public.probe() FROM PUBLIC, anon, authenticated, service_role;
`).length, 2);
console.log('PASS SQL splitter ignores comments, strings, and routine bodies');

ok(`
  CREATE TABLE public.observations(id bigint PRIMARY KEY);
  REVOKE ALL ON public.observations FROM PUBLIC, anon, authenticated, service_role;
  GRANT SELECT, INSERT ON public.observations TO service_role;
  CREATE SEQUENCE "public"."observation_seq";
  GRANT USAGE, SELECT ON SEQUENCE "public"."observation_seq" TO service_role;
  CREATE OR REPLACE FUNCTION public.record_observation() RETURNS void LANGUAGE sql AS $$ SELECT NULL $$;
  REVOKE ALL ON FUNCTION public.record_observation() FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.record_observation() TO service_role;
`);
ok(`
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO postgres;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO postgres;
`);
console.log('PASS object-specific least-privilege and owner-only dispositions are accepted');

fails('CREATE TABLE public.exposed(id bigint);', /table exposed has no explicit/);
fails('CREATE SEQUENCE "public"."quoted_exposed";', /sequence quoted_exposed has no explicit/);
fails(`
  CREATE FUNCTION public.exposed() RETURNS void LANGUAGE sql AS $$ SELECT NULL $$;
  GRANT EXECUTE ON FUNCTION public.exposed() TO postgres;
`, /routine exposed has no explicit/);
fails(`
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT SELECT ON TABLES TO anon;
`, /default GRANT is forbidden/);
fails('GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;', /schema-wide application-role GRANT is forbidden/);
fails(`
  CREATE TABLE public.implicit_id(id bigint GENERATED ALWAYS AS IDENTITY);
  REVOKE ALL ON public.implicit_id FROM PUBLIC, anon, authenticated, service_role;
`, /implicit sequence/);
console.log('PASS missing, owner-only, broad-grant, and implicit-sequence paths fail closed');

const fixtureDir = mkdtempSync(path.join(tmpdir(), 'xau-data-api-migrations-'));
writeFileSync(path.join(fixtureDir, '0035_late_legacy.sql'), 'SELECT 1;');
writeFileSync(path.join(fixtureDir, '20261008094134_safe.sql'), `
  CREATE VIEW public.safe_view AS SELECT 1 AS id;
  GRANT SELECT ON public.safe_view TO anon;
`);
writeFileSync(path.join(fixtureDir, '20261008094135_unsafe.sql'), 'CREATE SEQUENCE public.unsafe_seq;');
const fixtureErrors = auditMigrationDirectory(fixtureDir).join('\n');
assert.match(fixtureErrors, /legacy four-digit versions ended at 0034/);
assert.match(fixtureErrors, /sequence unsafe_seq has no explicit/);
assert.doesNotMatch(fixtureErrors, /safe_view/);
console.log('PASS directory audit enforces timestamp ordering and scans every post-marker migration');

const repoMigrations = new URL('../database/migrations/', import.meta.url);
assert.deepEqual(auditMigrationDirectory(repoMigrations), []);
console.log('PASS repository migration history satisfies the post-SB-3 policy');
