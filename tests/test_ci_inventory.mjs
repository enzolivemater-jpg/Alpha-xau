/**
 * CI-GOV-1 — deterministic test registration cannot silently drift.
 *
 * Non-Postgres tests must be in the reviewed TEST_FILES array or in the
 * explicit, reasoned exceptions below. PostgreSQL tests must be invoked by
 * the existing ephemeral PostgreSQL GitHub Actions workflow.
 *
 * No network, DB, clock, shell commands or production resources are touched.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(ROOT, 'tests');
const runnerSource = readFileSync(path.join(ROOT, 'scripts/run_ci_tests.mjs'), 'utf8');
const workflowSource = readFileSync(path.join(ROOT, '.github/workflows/quality-gate.yml'), 'utf8');
const sourceFile = ts.createSourceFile('run_ci_tests.mjs', runnerSource,
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

const declarations = [];
for (const stmt of sourceFile.statements) {
  if (!ts.isVariableStatement(stmt)) continue;
  for (const decl of stmt.declarationList.declarations) {
    if (ts.isIdentifier(decl.name) && decl.name.text === 'TEST_FILES') {
      declarations.push(decl.initializer);
    }
  }
}
assert.equal(declarations.length, 1, 'CI runner must have exactly one TEST_FILES manifest');
const array = declarations[0];
assert.ok(array && ts.isArrayLiteralExpression(array),
  'TEST_FILES must be a literal array, with no runtime-computed paths');
const registered = array.elements.map((entry) => {
  assert.ok(ts.isStringLiteral(entry), 'every TEST_FILES entry must be a literal string');
  return entry.text;
});
const all = readdirSync(testDir).filter((n) => /^test_[a-z0-9_]+\.mjs$/.test(n))
  .map((n) => 'tests/' + n).sort();
const inventory = new Set(all);
const active = new Set(registered);
assert.equal(active.size, registered.length, 'duplicate registered tests');
for (const file of active) {
  assert.match(file, /^tests\/test_[a-z0-9_]+\.mjs$/, 'only local test entrypoints may run');
  assert.ok(inventory.has(file), 'registered test missing: ' + file);
}

/** Explicit exceptions must not silently expand; reason is reviewed policy. */
const EXEMPTIONS = {
  'tests/test_anthropic_error_path.mjs': 'real Anthropic outbound API / fixture incompatibility',
  'tests/test_assembly_http.mjs': 'requires a live local PostgreSQL service',
  'tests/test_committee_lock.mjs': 'requires a live local PostgreSQL service',
  'tests/test_frontend_contract.mjs': 'requires a live local PostgreSQL service',
  'tests/test_legacy_non_tradable.mjs': 'requires a live local PostgreSQL service',
  'tests/test_market_cycle_live.mjs': 'requires a live local PostgreSQL service',
  'tests/test_news_score_parity.mjs': 'requires a live local PostgreSQL service',
  'tests/test_provider_failure_modes.mjs': 'depends on retired Stooq module; no replacement approved',
};
const exemptions = new Set(Object.keys(EXEMPTIONS));
for (const [file, reason] of Object.entries(EXEMPTIONS)) {
  assert.ok(inventory.has(file), 'stale exception: ' + file);
  assert.ok(!active.has(file), 'exception was registered without removing waiver: ' + file);
  assert.ok(reason.length > 15, 'exception must explain why excluded: ' + file);
}

// PostgreSQL-only tests must be specifically referenced in the PR CI workflow,
// which uses disposable service databases. Presence in documentation is not
// proof of execution: require the exact 'run: node ...' command.
const pgEntries = new Set([...workflowSource.matchAll(
  /\brun:\s*node\s+(tests\/test_[a-z0-9_]+_postgres\.mjs)\b/g,
)].map((match) => match[1]));
const postgres = all.filter((file) => /_postgres\.mjs$/.test(file));
for (const file of postgres) {
  assert.ok(!active.has(file), 'PostgreSQL-only test would run without a DB: ' + file);
  assert.ok(pgEntries.has(file), 'PostgreSQL test not wired into ephemeral CI: ' + file);
}
for (const file of pgEntries) {
  assert.ok(inventory.has(file), 'workflow points to a nonexistent PostgreSQL test: ' + file);
}
for (const file of all) {
  assert.ok(active.has(file) || exemptions.has(file) || pgEntries.has(file),
    'untracked test; register in TEST_FILES, ephemeral PostgreSQL CI, or reviewed exception: ' + file);
}
assert.ok(active.has('tests/test_ci_inventory.mjs'), 'inventory guard must execute in CI');
console.log('PASS CI-GOV-1: ' + all.length + ' tests accounted for ('
  + active.size + ' deterministic; ' + pgEntries.size + ' ephemeral PostgreSQL; '
  + exemptions.size + ' reviewed exceptions).');
