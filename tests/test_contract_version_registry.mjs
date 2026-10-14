// Cross-module guard for the frozen V2 contract versions.
//
// Every backend module that exports a `xau.*` schema version is a frozen
// contract: its schema and algorithm versions must be unique across the
// backend (a reused string would let one contract's output pass another's
// version check) and must be recorded in a docs/XAU_V2_*.md contract.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const VERSION_EXPORT = /export const ([A-Z0-9_]+_(?:SCHEMA|ALGORITHM)_VERSION) = '([^']+)' as const;/g;
const contracts = [];
for (const file of walk(path.join(ROOT, 'backend'))) {
  const source = readFileSync(file, 'utf8');
  const versions = [...source.matchAll(VERSION_EXPORT)].map(([, name, value]) => ({ name, value }));
  if (!versions.some(({ name, value }) => name.endsWith('_SCHEMA_VERSION') && value.startsWith('xau.'))) continue;
  contracts.push({ file: path.relative(ROOT, file), versions });
}

const docs = readdirSync(path.join(ROOT, 'docs'))
  .filter((name) => /^XAU_V2_.*\.md$/.test(name))
  .map((name) => ({ name, text: readFileSync(path.join(ROOT, 'docs', name), 'utf8') }));

console.log('--- registry ---');
t('at least the 16 V2 contract modules are discovered', contracts.length >= 16, String(contracts.length));
for (const { file, versions } of contracts) {
  t(`${file}: exports one schema and one algorithm version`,
    versions.filter(({ name }) => name.endsWith('_SCHEMA_VERSION')).length === 1
    && versions.filter(({ name }) => name.endsWith('_ALGORITHM_VERSION')).length === 1,
    versions.map(({ name }) => name).join(','));
}

console.log('--- uniqueness ---');
const owners = new Map();
for (const { file, versions } of contracts) {
  for (const { value } of versions) owners.set(value, [...(owners.get(value) ?? []), file]);
}
for (const [value, files] of owners) {
  t(`${value} is owned by exactly one module`, files.length === 1, files.join(','));
}

console.log('--- documented ---');
for (const { file, versions } of contracts) {
  for (const { name, value } of versions) {
    const documentedIn = docs.filter(({ text }) => text.includes(`\`${value}\``)).map(({ name: doc }) => doc);
    t(`${name} (${value}) is recorded in a contract doc`, documentedIn.length > 0, file);
  }
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
