import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PGDATABASE, 'xau_public_schema_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
const root = new URL('../', import.meta.url);
const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' };
const sql = query => execFileSync('psql', args, { input: query, encoding: 'utf8', env, timeout: 20000 }).trim();

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
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

  CREATE TABLE public.before_table(id integer PRIMARY KEY, payload text NOT NULL);
  INSERT INTO public.before_table VALUES (1, 'preserved');
  CREATE SEQUENCE public.before_sequence;
  CREATE FUNCTION public.before_count() RETURNS bigint LANGUAGE sql STABLE AS
    'SELECT count(*) FROM public.before_table';
`);

const aclBefore = sql(`
  SELECT c.relacl::text || '|' || s.relacl::text || '|' || p.proacl::text
  FROM pg_class c
  CROSS JOIN pg_class s
  CROSS JOIN pg_proc p
  WHERE c.oid = 'public.before_table'::regclass
    AND s.oid = 'public.before_sequence'::regclass
    AND p.oid = 'public.before_count()'::regprocedure;
`);

sql(readFileSync(new URL('database/migrations/20261008094133_data_api_default_privileges.sql', root), 'utf8'));

assert.equal(sql(`SET ROLE anon; SELECT payload FROM public.before_table WHERE id=1;`), 'preserved');
assert.equal(sql(`SET ROLE authenticated; SELECT public.before_count();`), '1');
assert.equal(sql(`SET ROLE service_role; SELECT nextval('public.before_sequence');`), '1');
assert.equal(sql(`
  SELECT c.relacl::text || '|' || s.relacl::text || '|' || p.proacl::text
  FROM pg_class c
  CROSS JOIN pg_class s
  CROSS JOIN pg_proc p
  WHERE c.oid = 'public.before_table'::regclass
    AND s.oid = 'public.before_sequence'::regclass
    AND p.oid = 'public.before_count()'::regprocedure;
`), aclBefore);

sql(`
  CREATE TABLE public.after_table(id integer PRIMARY KEY, payload text NOT NULL);
  CREATE SEQUENCE public.after_sequence;
  CREATE FUNCTION public.after_count() RETURNS bigint LANGUAGE sql STABLE AS
    'SELECT count(*) FROM public.after_table';
`);

for (const role of ['anon', 'authenticated', 'service_role']) {
  for (const privilege of [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN',
  ]) {
    assert.equal(
      sql(`SELECT has_table_privilege('${role}', 'public.after_table', '${privilege}');`),
      'f',
      `${role} unexpectedly inherited ${privilege}`,
    );
  }
  assert.equal(sql(`SELECT has_sequence_privilege('${role}', 'public.after_sequence', 'USAGE');`), 'f');
  assert.equal(sql(`SELECT has_sequence_privilege('${role}', 'public.after_sequence', 'SELECT');`), 'f');
  assert.equal(sql(`SELECT has_sequence_privilege('${role}', 'public.after_sequence', 'UPDATE');`), 'f');
  assert.equal(sql(`SELECT has_function_privilege('${role}', 'public.after_count()', 'EXECUTE');`), 'f');
}

sql(`
  GRANT SELECT, INSERT ON public.after_table TO service_role;
  GRANT USAGE, SELECT ON public.after_sequence TO service_role;
  GRANT EXECUTE ON FUNCTION public.after_count() TO service_role;
`);
assert.equal(sql(`SELECT has_table_privilege('service_role', 'public.after_table', 'SELECT');`), 't');
assert.equal(sql(`SELECT has_table_privilege('service_role', 'public.after_table', 'INSERT');`), 't');
assert.equal(sql(`SELECT has_sequence_privilege('service_role', 'public.after_sequence', 'USAGE');`), 't');
assert.equal(sql(`SELECT has_sequence_privilege('service_role', 'public.after_sequence', 'SELECT');`), 't');
assert.equal(sql(`SELECT has_function_privilege('service_role', 'public.after_count()', 'EXECUTE');`), 't');
sql(`INSERT INTO public.after_table VALUES (1, 'owner');`);
assert.equal(sql(`SELECT public.after_count();`), '1');
console.log('PASS existing ACLs survive and future PostgreSQL 17 objects require explicit Data API grants');
