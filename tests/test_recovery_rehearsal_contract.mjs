import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');
const script = read('scripts/recovery_manifest.mjs');

for (const required of [
  'REC-1 V3 OPERATOR KIT READY — RESUME/RE-EXECUTION NOT AUTHORIZED',
  'ejvwmjgfvhsslqiydwpz',
  'supabase db dump --db-url "$SOURCE_DB_URL"',
  '--role-only', '--data-only', '--use-copy', '--schema supabase_migrations',
  'psql --single-transaction --variable ON_ERROR_STOP=1',
  'xau-recovery.tar.age', 'COMPARISON_STATUS=PASS',
  'scripts/prepare_recovery_roles.mjs', 'roles.restore.sql',
  'scripts/verify_recovery_plaintext.mjs', 'plaintext-verification.json',
  'SOURCE_ROLES_SHA256', 'RESTORE_ROLES_SHA256',
  'MANAGED_PARAMETER_ACL_COMPATIBILITY=PASS',
  'This does not authorize migrations 0029–0034 or runtime.',
]) assert.ok(runbook.includes(required), `runbook missing ${required}`);

assert.match(runbook, /generic instruction such as “continue” is insufficient/i);
assert.ok(runbook.includes(
  'supabase db dump --db-url "$SOURCE_DB_URL" -f "$RECOVERY_WORKDIR/data.sql" --use-copy --data-only \\\n'
  + '  -x "storage.buckets_vectors" -x "storage.vector_indexes"',
), 'runbook data dump must carry both current Supabase vector exclusions');
assert.match(runbook, /Capture also runs the managed-schema guard before any dump is taken/);
assert.match(runbook, /The guard fails closed, so capture exits non-zero and `STOP` applies/);
assert.match(runbook, /Do not reproduce, migrate, or\s+waive Supabase-managed internal objects/);
assert.match(runbook, /Storage API objects, Edge Functions/);
assert.match(runbook, /perform no new\s+production capture or dump/i);
assert.match(runbook, /target already has exactly the platform-managed privilege/i);
assert.match(runbook, /exactly one occurrence of the reviewed/i);
assert.match(runbook, /Never replace the original `roles\.sql`/i);
assert.match(runbook, /never follows the old absolute ledger paths/i);
assert.doesNotMatch(runbook, /sha256sum -c "\$RECOVERY_WORKDIR\/plaintext-sha256\.txt"/);
assert.doesNotMatch(runbook, /--file "\$RECOVERY_WORKDIR\/roles\.sql"/);
assert.ok(!/postgres(?:ql)?:\/\/[^\s<]*:[^\s@<]+@/.test(runbook), 'credential-like URL in runbook');

for (const guard of [
  "BEGIN TRANSACTION READ ONLY",
  "RECOVERY_ALLOW_PRODUCTION_READ_ONLY",
  "RECOVERY_REHEARSAL",
  "production can never be a recovery rehearsal target",
  "assert.deepEqual(target[key], source[key])",
  "const managedSchemas = managedSchemaGuard();",
  "FROM pg_catalog.pg_policies WHERE schemaname IN ('auth','storage')",
  "FROM pg_catalog.pg_publication_tables WHERE schemaname IN ('auth','storage')",
  "project-owned auth/storage ${key} detected",
  "['auth.users', 'storage.buckets', 'storage.objects']",
  "'vault.secrets'",
]) assert.ok(script.includes(guard), `manifest script missing ${guard}`);

assert.ok(!script.includes('PGPASSWORD:'), 'script must not construct a password value');
assert.ok(!script.includes('--dbname'), 'script must use libpq env rather than URL arguments');
assert.ok(!script.includes("'-c default_transaction_read_only=on'"),
  'manifest must not configure the pooler/session startup GUC as its read-only guard');
assert.ok(script.includes("SET LOCAL statement_timeout = '60s'"),
  'manifest must scope statement_timeout to the read-only transaction');
assert.ok(script.includes("SET LOCAL lock_timeout = '5s'"),
  'manifest must scope lock_timeout to the read-only transaction');
console.log('PASS recovery runbook freezes complete dump, isolated restore, equivalence, and authorization guards');

