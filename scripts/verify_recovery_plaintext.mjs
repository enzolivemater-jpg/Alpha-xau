#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const [, , ledgerArg, workdirArg] = process.argv;
if (!ledgerArg || !workdirArg || process.argv.length !== 4) {
  throw new Error('usage: verify_recovery_plaintext.mjs <plaintext-sha256.txt> <recovery-workdir>');
}

const ledgerPath = path.resolve(ledgerArg);
const workdir = path.resolve(workdirArg);
const workdirReal = realpathSync(workdir);
const expected = [
  'roles.sql',
  'schema.sql',
  'data.sql',
  'history-schema.sql',
  'history-data.sql',
  'source-manifest.json',
];

const ledger = readFileSync(ledgerPath, 'utf8');
const records = ledger.split(/\r?\n/).filter(Boolean).map((line, index) => {
  const match = line.match(/^([0-9a-fA-F]{64})\s+[ *](.+)$/);
  assert.ok(match, `invalid checksum ledger line ${index + 1}`);
  const basename = path.basename(match[2]);
  assert.ok(expected.includes(basename), `unexpected checksum ledger file: ${basename}`);
  return { hash: match[1].toLowerCase(), basename };
});

assert.equal(records.length, expected.length, 'checksum ledger must contain exactly the expected recovery files');
assert.equal(new Set(records.map(record => record.basename)).size, expected.length,
  'checksum ledger must contain each expected recovery file exactly once');

const byName = new Map(records.map(record => [record.basename, record.hash]));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const verified = {};

for (const basename of expected) {
  assert.ok(byName.has(basename), `checksum ledger missing ${basename}`);
  const candidate = path.resolve(workdir, basename);
  assert.equal(path.dirname(candidate), workdir, `resolved recovery file escaped workdir: ${basename}`);
  const stat = lstatSync(candidate);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `recovery file must be a regular non-symlink: ${basename}`);
  const real = realpathSync(candidate);
  assert.equal(path.dirname(real), workdirReal, `recovery file resolves outside workdir: ${basename}`);
  const actual = sha256(readFileSync(candidate));
  assert.equal(actual, byName.get(basename), `checksum mismatch for ${basename}`);
  verified[basename] = actual;
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  version: 'rec1-plaintext-local-verifier-v1',
  workdir: workdirReal,
  verified,
})}\n`);
