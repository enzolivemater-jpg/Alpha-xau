import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const script = new URL('scripts/prepare_recovery_roles.mjs', root);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const observed = [
  'ALTER ROLE "anon" SET "statement_timeout" TO \'3s\';',
  'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
  'RESET ALL;',
  '',
].join('\n');

const run = ({ sql = observed, ledgerHash = sha256(observed), precreate = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xau-rec1-roles-'));
  const source = path.join(dir, 'roles.sql');
  const ledger = path.join(dir, 'plaintext-sha256.txt');
  const output = path.join(dir, 'roles.restore.sql');
  writeFileSync(source, sql);
  writeFileSync(ledger, `${ledgerHash}  /old/private/workdir/roles.sql\n`);
  if (precreate) writeFileSync(output, 'do not overwrite\n');
  const result = spawnSync(process.execPath, [script.pathname, source, ledger, output], { encoding: 'utf8' });
  return { ...result, source, output };
};

const pass = run();
assert.equal(pass.status, 0, pass.stderr);
const report = JSON.parse(pass.stdout);
assert.equal(report.status, 'PASS');
assert.equal(report.omittedStatements, 1);
assert.equal(readFileSync(pass.source, 'utf8'), observed, 'source dump must remain immutable');
const restored = readFileSync(pass.output, 'utf8');
assert.match(restored, /REC-1 V3: omitted on restore/);
assert.doesNotMatch(restored, /GRANT SET ON PARAMETER "log_min_messages"/);
assert.equal(report.restoreSha256, sha256(restored));
console.log('PASS exact verified managed grant produces a separate traceable restore copy');

for (const [label, options, expected] of [
  ['checksum drift', { ledgerHash: '0'.repeat(64) }, /checksum mismatch/],
  ['missing grant', { sql: 'RESET ALL;\n', ledgerHash: sha256('RESET ALL;\n') }, /exactly one log_min_messages/],
  ['duplicate grant', { sql: observed + observed, ledgerHash: sha256(observed + observed) }, /exactly one log_min_messages/],
  ['unknown variant', {
    sql: observed.replace('TO "supabase_realtime_admin"', 'TO "postgres"'),
    ledgerHash: sha256(observed.replace('TO "supabase_realtime_admin"', 'TO "postgres"')),
  }, /differs from the reviewed/],
  ['existing output', { precreate: true }, /EEXIST/],
]) {
  const failed = run(options);
  assert.notEqual(failed.status, 0, `${label} must fail closed`);
  assert.match(failed.stderr, expected, label);
}
console.log('PASS checksum drift, statement drift, duplication, and overwrite fail closed');
