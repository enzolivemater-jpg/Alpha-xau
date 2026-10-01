import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');
const script = read('scripts/recovery_manifest.mjs');

for (const required of [
  'REC-1 OPERATOR KIT READY — NOT EXECUTED',
  'ejvwmjgfvhsslqiydwpz',
  'supabase db dump --db-url "$SOURCE_DB_URL"',
  '--role-only', '--data-only', '--use-copy', '--schema supabase_migrations',
  'psql --single-transaction --variable ON_ERROR_STOP=1',
  'xau-recovery.tar.age', 'COMPARISON_STATUS=PASS',
  'This does not authorize migrations 0029–0033 or runtime.',
]) assert.ok(runbook.includes(required), `runbook missing ${required}`);

assert.match(runbook, /generic instruction such as “continue” is insufficient/i);
assert.match(runbook, /Storage API objects, Edge Functions/);
assert.ok(!/postgres(?:ql)?:\/\/[^\s<]*:[^\s@<]+@/.test(runbook), 'credential-like URL in runbook');

for (const guard of [
  "default_transaction_read_only=on",
  "RECOVERY_ALLOW_PRODUCTION_READ_ONLY",
  "RECOVERY_REHEARSAL",
  "production can never be a recovery rehearsal target",
  "assert.deepEqual(target[key], source[key])",
]) assert.ok(script.includes(guard), `manifest script missing ${guard}`);

assert.ok(!script.includes('PGPASSWORD:'), 'script must not construct a password value');
assert.ok(!script.includes('--dbname'), 'script must use libpq env rather than URL arguments');
console.log('PASS recovery runbook freezes complete dump, isolated restore, equivalence, and authorization guards');

