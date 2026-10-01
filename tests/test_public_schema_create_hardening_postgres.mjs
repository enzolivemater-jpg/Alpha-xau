import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_public_schema_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
const root = new URL('../', import.meta.url);
const args = ['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
const sql = query => execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();
const rejects = (query, pattern) => assert.throws(() => sql(query), pattern);

assert.equal(sql('SHOW server_version_num;').slice(0, 2), '17');
sql(`
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public AUTHORIZATION postgres;
  DROP ROLE IF EXISTS anon;
  DROP ROLE IF EXISTS authenticated;
  DROP ROLE IF EXISTS service_role;
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
  GRANT CREATE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE public.probe(id integer PRIMARY KEY, payload text NOT NULL);
  INSERT INTO public.probe VALUES(1,'unchanged');
  CREATE FUNCTION public.probe_count() RETURNS bigint LANGUAGE sql STABLE AS
    'SELECT count(*) FROM public.probe';
  GRANT SELECT ON public.probe TO anon, authenticated;
  GRANT SELECT, INSERT ON public.probe TO service_role;
  GRANT EXECUTE ON FUNCTION public.probe_count() TO anon, authenticated, service_role;
`);

const aclBefore = sql(`SELECT c.relacl::text||'|'||p.proacl::text
  FROM pg_class c CROSS JOIN pg_proc p
  WHERE c.oid='public.probe'::regclass AND p.oid='public.probe_count()'::regprocedure;`);
const definitionBefore = sql(`SELECT pg_get_functiondef('public.probe_count()'::regprocedure);`);
sql(readFileSync(new URL('database/migrations/0034_public_schema_create_hardening.sql', root), 'utf8'));

for (const role of ['anon','authenticated','service_role']) {
  assert.equal(sql(`SELECT has_schema_privilege('${role}','public','CREATE');`), 'f');
  assert.equal(sql(`SELECT has_schema_privilege('${role}','public','USAGE');`), 't');
  rejects(`SET ROLE ${role}; CREATE TABLE public.forbidden_${role}(id integer);`, /permission denied for schema public/);
}
assert.equal(sql(`SELECT has_schema_privilege('postgres','public','CREATE');`), 't');
assert.equal(sql(`SET ROLE anon; SELECT public.probe_count();`), '1');
assert.equal(sql(`SET ROLE authenticated; SELECT payload FROM public.probe;`), 'unchanged');
assert.equal(sql(`SET ROLE service_role; INSERT INTO public.probe VALUES(2,'allowed') RETURNING payload;`), 'allowed');
sql('CREATE TABLE public.owner_probe(id integer); DROP TABLE public.owner_probe;');
assert.equal(sql(`SELECT payload FROM public.probe WHERE id=1;`), 'unchanged');
assert.equal(sql(`SELECT c.relacl::text||'|'||p.proacl::text FROM pg_class c CROSS JOIN pg_proc p
  WHERE c.oid='public.probe'::regclass AND p.oid='public.probe_count()'::regprocedure;`), aclBefore);
assert.equal(sql(`SELECT pg_get_functiondef('public.probe_count()'::regprocedure);`), definitionBefore);
console.log('PASS application DDL is denied while usage, DML, RPC, owner DDL, ACLs, and data remain intact');

