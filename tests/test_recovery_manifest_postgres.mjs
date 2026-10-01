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

