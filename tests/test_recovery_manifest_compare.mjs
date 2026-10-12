import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/recovery_manifest.mjs', import.meta.url));
const targetRef = 'abcdefghijklmnopqrst';

function column(name, position, overrides = {}) {
  return {
    schema: 'public',
    table: 'items',
    name,
    position,
    type: 'text',
    not_null: false,
    default: null,
    identity: '',
    generated: '',
    ...overrides,
  };
}

function manifest(role, projectRef, columns) {
  return {
    formatVersion: 1,
    capturedAt: '2026-10-12T19:00:00.000Z',
    role,
    projectRef,
    identity: { server_version_num: '170011' },
    managedSchemas: { status: 'PASS', rowCounts: {} },
    migrationHistory: [{ version: '1', name: 'base' }],
    rowCounts: { 'public.items': 2 },
    catalog: {
      relations: [{ schema: 'public', name: 'items', kind: 'r' }],
      columns,
      functions: [],
      constraints: [],
      indexes: [],
      policies: [],
      triggers: [],
      views: [],
      enums: [],
      extensions: ['plpgsql'],
    },
  };
}

function compare(source, target) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xau-rec1-compare-'));
  const sourcePath = path.join(dir, 'source.json');
  const targetPath = path.join(dir, 'target.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  writeFileSync(targetPath, JSON.stringify(target));
  return spawnSync(process.execPath, [script, 'compare', sourcePath, targetPath], {
    encoding: 'utf8',
  });
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 1),
    column('name', 3),
    column('created_at', 6),
  ]);
  const target = manifest('target', targetRef, [
    column('id', 1),
    column('name', 2),
    column('created_at', 3),
  ]);
  const result = compare(source, target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'PASS');
  console.log('PASS dropped-column attnum holes are canonicalized to visible ordinals only');
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 2),
    column('name', 4),
  ]);
  const target = manifest('target', targetRef, [
    column('id', 1),
    column('name', 2),
  ]);
  const result = compare(source, target);
  assert.equal(result.status, 0, result.stderr);
  console.log('PASS leading and internal physical attnum holes do not create false recovery mismatches');
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 1),
    column('name', 3),
  ]);
  const target = manifest('target', targetRef, [
    column('name', 1),
    column('id', 2),
  ]);
  const result = compare(source, target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog mismatch/i);
  console.log('PASS changed visible column order still fails closed');
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 1),
    column('name', 3),
  ]);
  const target = manifest('target', targetRef, [
    column('id', 1),
    column('name', 2, { type: 'integer' }),
  ]);
  const result = compare(source, target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog mismatch/i);
  console.log('PASS non-position column metadata remains exact');
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 1),
    column('name', 3),
  ]);
  const target = manifest('target', targetRef, [
    column('id', 1),
    column('name', 1),
  ]);
  const result = compare(source, target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog normalization failed: .*positions must increase/i);
  console.log('PASS malformed/non-increasing physical positions fail closed');
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 1),
    column('name', 3),
  ]);
  const target = manifest('target', targetRef, [
    column('id', 1),
    column('id', 2),
  ]);
  const result = compare(source, target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog normalization failed: .*duplicate visible column/i);
  console.log('PASS duplicate visible-column identity fails closed');
}

{
  const source = manifest('source', 'ejvwmjgfvhsslqiydwpz', [
    column('id', 1),
    column('name', 3),
  ]);
  const target = manifest('target', targetRef, [
    column('id', 1),
    column('name', 2),
  ]);
  target.rowCounts['public.items'] = 3;
  const result = compare(source, target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rowCounts mismatch/i);
  console.log('PASS row counts remain exact and are never canonicalized');
}
