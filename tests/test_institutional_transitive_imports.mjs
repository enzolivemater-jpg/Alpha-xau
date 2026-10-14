/**
 * ARCH-3: transitive import closure of institutional decision-only modules.
 * A targeted architectural regression check, not full side-effect analysis.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = [
  'backend/regime_engine/contract.ts',
  'backend/horizon_engine/contract.ts',
  'backend/ai_engine/v2_committee_contract.ts',
  'backend/risk_engine/pre_pm_contract.ts',
  'backend/portfolio_engine/contract.ts',
  'backend/risk_engine/final_action_contract.ts',
  'backend/action_engine/contract.ts',
  'backend/command_center/contract.ts',
  'backend/alert_engine/contract.ts',
  'backend/acceptance_engine/contract.ts',
];

const CORE_ALLOWLIST = [
  ...ROOTS,
  'backend/event_impact/deterministic_processor.ts',
  'backend/gold_transmission/deterministic_processor.ts',
  'backend/market_engine/institutional_snapshot.ts',
  'backend/market_engine/types.ts',
  'backend/positioning_engine/evidence_contract.ts',
];
// Additional independently reviewed pure modules from other *unmerged*
// branches. Test runs on main today and scans each after it becomes present.
const OPTIONAL = [
  'backend/decision_chain/dry_run.ts',
  'backend/observability/offline_receipt.ts',
  'backend/observability/evidence_manifest.ts',
  'backend/advisory_ui/contract.ts',
  'backend/advisory_ui/transport_contract.ts',
];
const activeOptional = OPTIONAL.filter((file) => existsSync(path.join(ROOT, file)));
const ALLOW = new Set([...CORE_ALLOWLIST, ...activeOptional]);

function importsIn(code, filename) {
  const ast = ts.createSourceFile(filename, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports = [];
  const problems = [];
  const walk = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) problems.push('INVALID_MODULE_SPECIFIER');
        else imports.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      problems.push('DYNAMIC_IMPORT_FORBIDDEN');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'require') {
      problems.push('REQUIRE_FORBIDDEN');
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return { imports, problems };
}

function target(origin, specifier) {
  if (!specifier.startsWith('.')) return null;
  const suffix = path.posix.extname(specifier);
  if (suffix !== '.js' && suffix !== '.ts') return null;
  return path.posix.normalize(path.posix.join(
    path.posix.dirname(origin),
    specifier.replace(/\.js$/, '.ts'),
  ));
}

function inspectGraph(roots, allowed, lookup) {
  const seen = new Set();
  const visiting = new Set();
  const issues = new Set();
  const dependencies = new Map();
  const visit = (source) => {
    if (!allowed.has(source)) {
      issues.add(`NOT_ALLOWLISTED:${source}`);
      return;
    }
    if (visiting.has(source)) {
      issues.add(`IMPORT_CYCLE:${source}`);
      return;
    }
    if (seen.has(source)) return;
    const contents = lookup(source);
    if (contents === null) {
      issues.add(`MISSING_SOURCE:${source}`);
      return;
    }
    visiting.add(source);
    const parsed = importsIn(contents, source);
    for (const failure of parsed.problems) issues.add(`${failure}:${source}`);
    const next = [];
    for (const specifier of parsed.imports) {
      const resolved = target(source, specifier);
      if (resolved === null) {
        issues.add(`UNSUPPORTED_IMPORT:${source}:${specifier}`);
      } else {
        next.push(resolved);
      }
    }
    dependencies.set(source, next);
    for (const child of next) visit(child);
    visiting.delete(source);
    seen.add(source);
  };
  roots.forEach(visit);
  return {
    visited: [...seen].sort(),
    issues: [...issues].sort(),
    edges: [...dependencies.entries()].reduce((total, [, items]) => total + items.length, 0),
  };
}

const inspection = inspectGraph(
  [...ROOTS, ...activeOptional],
  ALLOW,
  (source) => {
    const filename = path.join(ROOT, source);
    return existsSync(filename) ? readFileSync(filename, 'utf8') : null;
  },
);
assert.deepEqual(inspection.issues, [],
  'Pure gate transitive imports changed — review and update ARCH-3 before merging');
assert.deepEqual(inspection.visited, [...ALLOW].sort(),
  'All expected modules should belong to exactly the approved closure');

const mock = (files, roots, allow) => inspectGraph(
  roots, new Set(allow), (name) => files[name] ?? null,
);
assert.deepEqual(mock({
  'backend/a.ts': "import './b.js';",
  'backend/b.ts': 'export const ok = 1;',
}, ['backend/a.ts'], ['backend/a.ts', 'backend/b.ts']).issues, []);

const tests = [
  [{ 'backend/a.ts': "import './b.js';" }, ['backend/a.ts', 'backend/b.ts'], 'MISSING_SOURCE:backend/b.ts'],
  [{ 'backend/a.ts': "import './b.js';", 'backend/b.ts': "import './a.js';" },
    ['backend/a.ts', 'backend/b.ts'], 'IMPORT_CYCLE:backend/a.ts'],
  [{ 'backend/a.ts': "import './b.js';", 'backend/b.ts': 'export const ok = 1;' },
    ['backend/a.ts'], 'NOT_ALLOWLISTED:backend/b.ts'],
  [{ 'backend/a.ts': "import 'node:fs';" }, ['backend/a.ts'],
    'UNSUPPORTED_IMPORT:backend/a.ts:node:fs'],
  [{ 'backend/a.ts': "const mod = import('./unsafe.js');" }, ['backend/a.ts'],
    'DYNAMIC_IMPORT_FORBIDDEN:backend/a.ts'],
  [{ 'backend/a.ts': "const mod = require('./unsafe.js');" }, ['backend/a.ts'],
    'REQUIRE_FORBIDDEN:backend/a.ts'],
];
for (const [files, allowlist, expected] of tests) {
  const found = mock(files, ['backend/a.ts'], allowlist);
  assert.ok(found.issues.includes(expected), `ARCH-3 did not detect ${expected}`);
}
console.log(`PASS ARCH-3: ${inspection.visited.length} transitive modules, ${inspection.edges} imports, ${tests.length} negative self-tests`);
