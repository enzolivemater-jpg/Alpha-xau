import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'backend/shared/temporal_contract.ts'), 'utf8');
const temp = mkdtempSync(path.join(tmpdir(), 'xau-time-0-'));
let temporal;
try {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = path.join(temp, 'temporal.mjs');
  writeFileSync(mod, js);
  temporal = await import(pathToFileURL(mod).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const { parseStrictInstant: parse, compareStrictInstants: compare, isStrictTimestamp: valid } = temporal;

assert.equal(temporal.TEMPORAL_SCHEMA_VERSION, 'xau.temporal-instant.v1');
assert.equal(temporal.TEMPORAL_ALGORITHM_VERSION, 'strict-gregorian-nanoseconds-1.0.0');

const accepted = [
  '0001-01-01T00:00:00Z', '0099-01-01T00:00:00Z',
  '1900-01-01T00:00:00Z', '2000-02-29T23:59:59Z',
  '2028-02-29T10:11:12Z', '9999-12-31T23:59:59.999999999Z',
  '2026-10-13T12:30:00.000Z', '2026-10-13T14:30:00+02:00',
  '2026-10-13T00:30:00-12:00',
  '2026-10-13T14:30:00+14:00',
  '2026-10-13T12:30:00+00:00', '2026-10-13T12:30:00.000000001Z',
];
for (const value of accepted) {
  assert.equal(valid(value), true, value);
  assert.ok(parse(value) !== null, value);
  assert.equal(compare(value, value), 0, value);
}
const rejected = [
  null, undefined, '', 0, [], {}, 'now', '2026-10-13', '2026-10-13T12:30Z',
  '0000-01-01T00:00:00Z',
  '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z',
  '2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z',
  '2026-00-01T00:00:00Z', '2026-13-01T00:00:00Z',
  '2026-01-00T00:00:00Z', '2026-01-32T00:00:00Z',
  '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z',
  '2026-01-01T00:00:60Z',
  '2026-10-13T12:30:00+15:00', '2026-10-13T12:30:00-14:30',
  '2026-10-13T12:30:00+00:60', '2026-10-13T12:30:00-00:00',
  '2026-10-13T12:30:00', '2026-10-13T12:30:00z',
  '2026-10-13T12:30:00.1234567890Z', '2026-10-13T12:30:00.Z',
  ' 2026-10-13T12:30:00Z', '2026-10-13T12:30:00Z ',
];
for (const value of rejected) {
  assert.equal(parse(value), null, String(value));
  assert.equal(valid(value), false, String(value));
  assert.equal(compare(value, accepted[0]), null, String(value));
  assert.equal(compare(accepted[0], value), null, String(value));
}

// Nanosecond ordering must be exact and not rounded into Date.parse milliseconds.
const zero = '2026-10-13T12:30:00.000000000Z';
const tiny = '2026-10-13T12:30:00.000000001Z';
const ms = '2026-10-13T12:30:00.001Z';
assert.equal(compare(zero, tiny), -1);
assert.equal(compare(tiny, zero), 1);
assert.equal(compare(tiny, tiny), 0);
assert.equal(compare(tiny, ms), -1);
assert.equal(parse(tiny).epochNanoseconds - parse(zero).epochNanoseconds, 1n);
assert.equal(parse(tiny).fractionalDigits, 9);
assert.equal(parse('2026-10-13T12:30:00Z').fractionalDigits, 0);
assert.equal(parse('2026-10-13T12:30:00.123Z').fractionalDigits, 3);
assert.equal(parse('2026-10-13T12:30:00.123456Z').fractionalDigits, 6);

// Compare instants, not text, and handle days crossed by zone offsets.
assert.equal(compare('2026-10-13T14:30:00+02:00', '2026-10-13T12:30:00Z'), 0);
assert.equal(compare('2026-10-13T01:00:00+02:00', '2026-10-12T23:00:00Z'), 0);
assert.equal(compare('2026-10-13T00:00:00-10:00', '2026-10-13T10:00:00Z'), 0);
assert.equal(compare('2026-10-13T12:30:01Z', '2026-10-13T12:30:00.999999999Z'), 1);
assert.equal(compare('2026-10-13T12:30:00.000000009Z',
  '2026-10-13T12:30:00.000000010Z'), -1);

// EVIDENCE-0 retains its 0..3 digits historical public contract by explicit opt-in.
for (const value of [zero, tiny, '2026-10-13T12:30:00.0001Z']) {
  assert.equal(parse(value, 3), null, value);
}
assert.ok(parse('2026-10-13T12:30:00.999Z', 3) !== null);
assert.equal(compare('2026-10-13T12:30:00.999Z', ms, 3), 1);
assert.equal(compare(tiny, ms, 3), null);

const bytes = readFileSync(path.join(root, 'backend/shared/temporal_contract.ts'), 'utf8');
assert.doesNotMatch(bytes, /\bfetch\(|\bWebSocket\b|new Date\(|Date\.now\(|Math\.random\(|process\.env|import\(/);
assert.match(bytes, /Date\.parse\(normalized\)/,
  'Only explicit, strictly validated timestamp may pass to Date.parse');
console.log('PASS TIME-0 strict Gregorian RFC3339, nanosecond ordering and 3-digit evidence mode');
