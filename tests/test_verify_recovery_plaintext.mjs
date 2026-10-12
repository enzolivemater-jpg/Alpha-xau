import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const verifier = new URL('scripts/verify_recovery_plaintext.mjs', root);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const names = [
  'roles.sql',
  'schema.sql',
  'data.sql',
  'history-schema.sql',
  'history-data.sql',
  'source-manifest.json',
];

function fixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'xau-rec1-plaintext-'));
  const workdir = path.join(rootDir, 'fresh');
  mkdirSync(workdir);
  const ledger = path.join(workdir, 'plaintext-sha256.txt');
  const lines = [];
  for (const name of names) {
    const content = `content:${name}\n`;
    writeFileSync(path.join(workdir, name), content);
    lines.push(`${sha256(content)}  /tmp/old-rec1-workdir/${name}`);
  }
  writeFileSync(ledger, lines.join('\n') + '\n');
  return { rootDir, workdir, ledger };
}

function run(workdir, ledger) {
  return spawnSync(process.execPath, [verifier.pathname, ledger, workdir], { encoding: 'utf8' });
}

{
  const f = fixture();
  const result = run(f.workdir, f.ledger);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(Object.keys(report.verified), names);
  console.log('PASS old absolute ledger paths verify only files in the new recovery workdir');
}

{
  const f = fixture();
  writeFileSync(path.join(f.workdir, 'roles.sql'), 'tampered\n');
  const result = run(f.workdir, f.ledger);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch for roles\.sql/);
}

{
  const f = fixture();
  const lines = readFileSync(f.ledger, 'utf8').trim().split('\n');
  writeFileSync(f.ledger, [...lines, lines[0]].join('\n') + '\n');
  const result = run(f.workdir, f.ledger);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly the expected recovery files|each expected recovery file exactly once/);
}

{
  const f = fixture();
  const lines = readFileSync(f.ledger, 'utf8').trim().split('\n');
  lines[0] = `${'0'.repeat(64)}  /tmp/old-rec1-workdir/unexpected.sql`;
  writeFileSync(f.ledger, lines.join('\n') + '\n');
  const result = run(f.workdir, f.ledger);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected checksum ledger file/);
}

{
  const f = fixture();
  const outside = path.join(f.rootDir, 'outside.sql');
  writeFileSync(outside, 'content:roles.sql\n');
  const target = path.join(f.workdir, 'roles.sql');
  // replace regular file with a symlink to prove the verifier does not escape the new workdir
  const { unlinkSync } = await import('node:fs');
  unlinkSync(target);
  symlinkSync(outside, target);
  const result = run(f.workdir, f.ledger);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular non-symlink/);
}

console.log('PASS checksum drift, duplicate/unexpected ledger entries, and symlink escape fail closed');
