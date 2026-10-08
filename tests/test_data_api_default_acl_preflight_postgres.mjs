import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateDataApiDefaultAclPreflight } from '../scripts/evaluate_data_api_default_acl_preflight.mjs';

assert.equal(process.env.PGDATABASE, 'xau_public_schema_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
const sql = query => execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
const preflightSql = readFileSync(
  new URL('../scripts/data_api_default_acl_preflight.sql', import.meta.url),
  'utf8',
);

sql(`
  DROP VIEW IF EXISTS public.v_market_latest, public.v_news_high_impact, public.v_ai_latest;
  DROP TABLE IF EXISTS public.market_ticks, public.news_events;
  DROP ROLE IF EXISTS supabase_admin;
  CREATE ROLE supabase_admin NOLOGIN;
  CREATE VIEW public.v_market_latest AS SELECT 1 AS id;
  CREATE VIEW public.v_news_high_impact AS SELECT 1 AS id;
  CREATE VIEW public.v_ai_latest AS SELECT 1 AS id;
  CREATE TABLE public.market_ticks(id bigint PRIMARY KEY);
  CREATE TABLE public.news_events(id bigint PRIMARY KEY);
  GRANT SELECT ON public.v_market_latest, public.v_news_high_impact,
    public.v_ai_latest, public.market_ticks, public.news_events TO anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    GRANT SELECT ON TABLES TO anon;
`);

const catalogCountBefore = sql(`
  SELECT count(*) FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public';
`);
const held = evaluateDataApiDefaultAclPreflight(JSON.parse(sql(preflightSql)));
assert.equal(held.verdict, 'HOLD');
assert.deepEqual(
  held.blockers.map(item => item.code),
  ['SUPABASE_ADMIN_DEFAULT_ACL_DISPOSITION_REQUIRED'],
);
assert.equal(sql(`
  SELECT count(*) FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public';
`), catalogCountBefore);

sql(`
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    REVOKE SELECT ON TABLES FROM anon;
  DROP ROLE supabase_admin;
`);
const ready = evaluateDataApiDefaultAclPreflight(JSON.parse(sql(preflightSql)));
assert.equal(ready.verdict, 'READY_FOR_SCOPED_AUTHORIZATION');
assert.equal(ready.authorization_granted, false);
assert.equal(ready.production_change_performed, false);
console.log('PASS PostgreSQL 17 preflight is read-only and managed-role grants fail closed');
