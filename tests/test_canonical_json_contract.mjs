import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'backend/shared/canonical_json.ts'), 'utf8');
const temp = mkdtempSync(path.join(tmpdir(), 'xau-canonical-json-'));
let mod;
try {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = path.join(temp, 'canonical_json.mjs');
  writeFileSync(file, js);
  mod = await import(pathToFileURL(file).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const { canonicalJson, sha256Text, sha256Canonical } = mod;

// Key order and whitespace independence.
assert.equal(canonicalJson({ b: 1, a: { d: [3, 2], c: null } }), '{"a":{"c":null,"d":[3,2]},"b":1}');
assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
assert.equal(canonicalJson([{ z: 1, y: 2 }, 'x', true, null]), '[{"y":2,"z":1},"x",true,null]');
assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]', 'array order is preserved');
assert.equal(canonicalJson(Object.create(null)), '{}');
assert.equal(canonicalJson({ 'é': 1, 'Z': 2, 'a': 3 }), '{"Z":2,"a":3,"é":1}', 'code-unit key order');

// Rejection instead of silent coercion.
for (const bad of [NaN, Infinity, -Infinity, undefined, () => 1, Symbol('s'), 1n,
  new Date(0), new Map(), new Set(), { a: undefined }, [undefined && 1, new Date(0)]]) {
  assert.throws(() => canonicalJson(bad), TypeError, `must reject ${String(bad)}`);
}
assert.throws(() => canonicalJson({ nested: { x: undefined } }), /undefined at x/);

// Digests: known SHA-256 vectors and canonical equivalence.
assert.equal(await sha256Text(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.equal(await sha256Text('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(await sha256Canonical({ b: 1, a: 2 }), await sha256Canonical({ a: 2, b: 1 }));
assert.notEqual(await sha256Canonical({ a: 1 }), await sha256Canonical({ a: '1' }));
assert.match(await sha256Canonical([]), /^sha256:[0-9a-f]{64}$/);

console.log('canonical_json contract: OK');
