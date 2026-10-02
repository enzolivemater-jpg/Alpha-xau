import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

assert.equal(process.env.PGDATABASE, 'xau_recovery_manifest_test', 'disposable database required');
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST), 'local test server required');
const root = new URL('../', import.meta.url);
const script = new URL('scripts/recovery_manifest.mjs', root);
const psql = sql => execFileSync('psql', ['-X','-q','-v','ON_ERROR_STOP=1','-c',sql], {
  env: process.env, encoding: 'utf8', timeout: 20000,
});

psql(`
  CREATE ROLE supabase_storage_admin NOLOGIN;
  CREATE ROLE supabase_auth_admin NOLOGIN;
  CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
  CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE TABLE storage.buckets(id text PRIMARY KEY);
  CREATE TABLE storage.objects(id uuid PRIMARY KEY, updated_at timestamptz);
  ALTER TABLE auth.users OWNER TO supabase_auth_admin;
  ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
  ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN NEW.updated_at = now(); RETURN NEW; END';
  ALTER FUNCTION storage.update_updated_at_column() OWNER TO supabase_storage_admin;
  CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects
    FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();
  CREATE SCHEMA vault;
  CREATE TABLE vault.secrets(id uuid PRIMARY KEY);
  CREATE SCHEMA supabase_migrations;
  CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);
  INSERT INTO supabase_migrations.schema_migrations VALUES('20260923133811',ARRAY['select 1'],'gold_transmission_atomic_rpc');
  CREATE TYPE public.state_t AS ENUM ('ready','done');
  CREATE TABLE public.recovery_probe(id integer PRIMARY KEY, state public.state_t NOT NULL DEFAULT 'ready');
  ALTER TABLE public.recovery_probe ENABLE ROW LEVEL SECURITY;
  CREATE POLICY recovery_read ON public.recovery_probe FOR SELECT USING (true);
  CREATE FUNCTION public.recovery_probe_count() RETURNS bigint LANGUAGE sql STABLE SET search_path='' AS
    'SELECT count(*) FROM public.recovery_probe';
  CREATE VIEW public.recovery_probe_view WITH (security_invoker=true) AS SELECT * FROM public.recovery_probe;
  INSERT INTO public.recovery_probe(id) VALUES(1),(2);
`);

const dir = mkdtempSync(path.join(tmpdir(), 'xau-recovery-'));
const sourcePath = path.join(dir, 'source.json');
const targetPath = path.join(dir, 'target.json');
const baseEnv = { ...process.env, RECOVERY_ALLOW_LOCAL_TEST: 'YES' };
const capture = (role, ref, extra={}) => execFileSync(process.execPath, [script.pathname, 'capture'], {
  env: { ...baseEnv, RECOVERY_MANIFEST_ROLE: role, RECOVERY_PROJECT_REF: ref, ...extra },
  encoding: 'utf8', timeout: 30000,
});

writeFileSync(sourcePath, capture('source', 'ejvwmjgfvhsslqiydwpz'));
writeFileSync(targetPath, capture('target', 'aaaaaaaaaaaaaaaaaaaa', { RECOVERY_REHEARSAL: 'YES' }));
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
assert.equal(source.identity.transaction_read_only, 'on');
assert.equal(source.rowCounts['public.recovery_probe'], 2);
assert.equal(source.migrationHistory[0].name, 'gold_transmission_atomic_rpc');
assert.deepEqual(source.managedSchemas, { status: 'PASS', rowCounts: {
  'auth.users': 0, 'storage.buckets': 0, 'storage.objects': 0, 'vault.secrets': 0,
} });
assert.ok(!readFileSync(sourcePath, 'utf8').includes(process.env.PGPASSWORD));

const pass = execFileSync(process.execPath, [script.pathname, 'compare', sourcePath, targetPath], {
  encoding: 'utf8', timeout: 10000,
});
assert.equal(JSON.parse(pass).status, 'PASS');
console.log('PASS identical isolated restore manifest compares exactly');

psql('INSERT INTO public.recovery_probe(id) VALUES(3);');
writeFileSync(targetPath, capture('target', 'aaaaaaaaaaaaaaaaaaaa', { RECOVERY_REHEARSAL: 'YES' }));
const mismatch = spawnSync(process.execPath, [script.pathname, 'compare', sourcePath, targetPath], { encoding: 'utf8' });
assert.notEqual(mismatch.status, 0);
assert.match(mismatch.stderr, /rowCounts mismatch/);
console.log('PASS row-count drift fails closed');

const prodTarget = spawnSync(process.execPath, [script.pathname, 'capture'], {
  env: { ...baseEnv, RECOVERY_MANIFEST_ROLE: 'target', RECOVERY_PROJECT_REF: 'ejvwmjgfvhsslqiydwpz', RECOVERY_REHEARSAL: 'YES' },
  encoding: 'utf8',
});
assert.notEqual(prodTarget.status, 0);
assert.match(prodTarget.stderr, /production can never be a recovery rehearsal target/);

const nonLocal = spawnSync(process.execPath, [script.pathname, 'capture'], {
  env: { ...process.env, PGHOST: 'db.example.invalid', RECOVERY_ALLOW_LOCAL_TEST: 'YES',
    RECOVERY_MANIFEST_ROLE: 'source', RECOVERY_PROJECT_REF: 'ejvwmjgfvhsslqiydwpz' },
  encoding: 'utf8',
});
assert.notEqual(nonLocal.status, 0);
assert.match(nonLocal.stderr, /RECOVERY_ALLOW_PRODUCTION_READ_ONLY=YES/);
console.log('PASS production target and unapproved source captures fail closed');

const managedDrift = [
  ['storage RLS policy', 'CREATE POLICY project_read ON storage.objects FOR SELECT USING (true)',
    'DROP POLICY project_read ON storage.objects', /project-owned auth\/storage policies detected; REC-1 requires renewed review: storage\.objects:project_read/],
  ['auth trigger with project function', `CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()`,
    'DROP TRIGGER on_auth_user_created ON auth.users; DROP FUNCTION public.handle_new_user()',
    /project-owned auth\/storage triggers detected; REC-1 requires renewed review: auth\.users:on_auth_user_created/],
  ['project-owned storage function', `CREATE FUNCTION storage.project_helper() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
    'DROP FUNCTION storage.project_helper()', /project-owned auth\/storage functions detected; REC-1 requires renewed review: storage\.project_helper/],
  ['storage publication entry', 'CREATE PUBLICATION project_pub FOR TABLE storage.objects',
    'DROP PUBLICATION project_pub', /project-owned auth\/storage publications detected; REC-1 requires renewed review/],
  ['auth user row', `INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001')`,
    'DELETE FROM auth.users', /auth\.users is no longer empty/],
  ['storage object row', `INSERT INTO storage.objects(id) VALUES ('00000000-0000-0000-0000-000000000001')`,
    'DELETE FROM storage.objects', /storage\.objects is no longer empty/],
  ['vault secret row', `INSERT INTO vault.secrets VALUES ('00000000-0000-0000-0000-000000000001')`,
    'DELETE FROM vault.secrets', /vault\.secrets is no longer empty/],
];
for (const [label, apply, revert, expected] of managedDrift) {
  psql(apply);
  const drift = spawnSync(process.execPath, [script.pathname, 'capture'], {
    env: { ...baseEnv, RECOVERY_MANIFEST_ROLE: 'source', RECOVERY_PROJECT_REF: 'ejvwmjgfvhsslqiydwpz' },
    encoding: 'utf8',
  });
  psql(revert);
  assert.notEqual(drift.status, 0, `${label} must fail closed`);
  assert.equal(drift.stdout, '', `${label} must not emit a manifest`);
  assert.match(drift.stderr, expected, label);
}
psql('ALTER TABLE auth.users RENAME TO users_moved');
const missing = spawnSync(process.execPath, [script.pathname, 'capture'], {
  env: { ...baseEnv, RECOVERY_MANIFEST_ROLE: 'source', RECOVERY_PROJECT_REF: 'ejvwmjgfvhsslqiydwpz' },
  encoding: 'utf8',
});
psql('ALTER TABLE auth.users_moved RENAME TO users');
assert.notEqual(missing.status, 0);
assert.match(missing.stderr, /expected Supabase-managed tables missing: auth\.users/);
assert.doesNotThrow(() => capture('source', 'ejvwmjgfvhsslqiydwpz'));
console.log('PASS project-owned auth/storage customizations and unpreserved managed data fail closed');
