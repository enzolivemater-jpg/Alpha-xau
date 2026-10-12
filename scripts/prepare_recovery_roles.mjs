#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , sourceArg, ledgerArg, outputArg] = process.argv;
if (!sourceArg || !ledgerArg || !outputArg || process.argv.length !== 5) {
  throw new Error('usage: prepare_recovery_roles.mjs <roles.sql> <plaintext-sha256.txt> <roles.restore.sql>');
}

const sourcePath = path.resolve(sourceArg);
const ledgerPath = path.resolve(ledgerArg);
const outputPath = path.resolve(outputArg);
assert.notEqual(sourcePath, outputPath, 'source and output paths must differ');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const source = readFileSync(sourcePath);
const ledger = readFileSync(ledgerPath, 'utf8');
const records = ledger.split(/\r?\n/).filter(Boolean).map((line, index) => {
  const match = line.match(/^([0-9a-fA-F]{64})\s+[ *](.+)$/);
  assert.ok(match, `invalid checksum ledger line ${index + 1}`);
  return { hash: match[1].toLowerCase(), file: match[2] };
});
const roleRecords = records.filter(record => path.basename(record.file) === path.basename(sourcePath));
assert.equal(roleRecords.length, 1, 'checksum ledger must contain exactly one roles.sql record');

const sourceHash = sha256(source);
assert.equal(sourceHash, roleRecords[0].hash, 'roles.sql checksum mismatch');

const sql = source.toString('utf8');
assert.equal(Buffer.byteLength(sql), source.length, 'roles.sql must be valid UTF-8 text');
const exact = /^GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";\r?$/gm;
const broad = /^\s*GRANT\s+SET\s+ON\s+PARAMETER\s+"?log_min_messages"?.*$/gim;
const exactMatches = [...sql.matchAll(exact)];
const broadMatches = [...sql.matchAll(broad)];
assert.equal(broadMatches.length, 1, 'roles.sql must contain exactly one log_min_messages parameter grant');
assert.equal(exactMatches.length, 1, 'log_min_messages grant differs from the reviewed REC-1 V3 statement');

const replacement = '-- REC-1 V3: omitted on restore; Supabase manages this reserved parameter privilege.';
const restored = sql.replace(exact, replacement);
assert.ok(!/^\s*GRANT\s+SET\s+ON\s+PARAMETER\s+"?log_min_messages"?/gim.test(restored),
  'managed log_min_messages grant remains after normalization');
writeFileSync(outputPath, restored, { flag: 'wx', mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  version: 'rec1-roles-normalizer-v1',
  sourceSha256: sourceHash,
  restoreSha256: sha256(Buffer.from(restored)),
  omittedStatements: 1,
})}\n`);
