/**
 * ARCH-2: guard synchronous institutional decision gates from importing
 * runtime side effects. This is an AST-based static review aid, not a
 * sandbox, and is not a substitute for human code review.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALWAYS = [
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
const WHEN_PRESENT = [
  'backend/decision_chain/dry_run.ts',
  'backend/observability/offline_receipt.ts',
];
// The optional files are stacked changes in separate PRs, not assumed to
// exist on main. Once merged, this guard automatically includes them.
const files = [...ALWAYS, ...WHEN_PRESENT.filter((f) => existsSync(path.join(ROOT, f)))];
const forbiddenCallees = new Set([
  'fetch', 'setTimeout', 'setInterval', 'queueMicrotask',
  'eval', 'Function', 'require',
  'Date.now', 'Math.random', 'crypto.getRandomValues',
  'crypto.randomUUID', 'globalThis.fetch', 'globalThis.setTimeout',
]);
const forbiddenConstructors = new Set(['WebSocket', 'EventSource', 'XMLHttpRequest']);
const forbiddenImports = new Set([
  'backend/worker.ts',
  'backend/ingest.ts',
  'backend/ai_engine/committee_orchestrator.ts',
]);

function pathOfImport(source, imported) {
  if (!imported.startsWith('.')) return imported;
  const relative = path.posix.normalize(path.posix.join(
    path.posix.dirname(source), imported.replace(/\.js$/, '.ts'),
  ));
  return relative;
}

function scan(source, code) {
  const errors = [];
  const ast = ts.createSourceFile(source, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const expressionName = (node) => {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      const prefix = expressionName(node.expression);
      return prefix === null ? null : `${prefix}.${node.name.text}`;
    }
    return null;
  };
  function walk(node) {
    if (ts.isImportDeclaration(node)) {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (!spec.startsWith('.') || forbiddenImports.has(pathOfImport(source, spec))) {
        errors.push(`FORBIDDEN_IMPORT:${spec}`);
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        errors.push('DYNAMIC_IMPORT');
      }
      const name = expressionName(node.expression);
      if (name !== null && forbiddenCallees.has(name)) {
        errors.push(`FORBIDDEN_CALL:${name}`);
      }
    }
    if (ts.isNewExpression(node)) {
      const name = expressionName(node.expression);
      if (name !== null && forbiddenConstructors.has(name)) {
        errors.push(`FORBIDDEN_CONSTRUCTOR:${name}`);
      }
      if (name === 'Date' && (!node.arguments || node.arguments.length === 0)) {
        errors.push('IMPLICIT_CLOCK');
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const expr = expressionName(node);
      if (expr === 'process.env' || expr === 'Deno.env') errors.push('ENVIRONMENT_ACCESS');
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return errors;
}

for (const file of ALWAYS) {
  assert.ok(existsSync(path.join(ROOT, file)), `Mandatory gate missing: ${file}`);
}
for (const file of files) {
  const errors = scan(file, readFileSync(path.join(ROOT, file), 'utf8'));
  assert.deepEqual(errors, [], `Institutional gate must remain isolated: ${file}`);
}

// Self-tests prove this check actually rejects the classes it claims to
// cover (and does not confuse deterministic Date parsing with wall clock).
const cases = [
  [`fetch('https://api.example');`, 'FORBIDDEN_CALL:fetch'],
  ['Date.now();', 'FORBIDDEN_CALL:Date.now'],
  ['new Date();', 'IMPLICIT_CLOCK'],
  ['Math.random();', 'FORBIDDEN_CALL:Math.random'],
  ["import { runJob } from '../worker.js';", 'FORBIDDEN_IMPORT:../worker.js'],
  ["import('remote');", 'DYNAMIC_IMPORT'],
  ['process.env.API_SECRET;', 'ENVIRONMENT_ACCESS'],
  ['new WebSocket("wss://example.invalid");', 'FORBIDDEN_CONSTRUCTOR:WebSocket'],
];
for (const [code, expected] of cases) {
  const errors = scan('backend/decision_chain/pure.ts', code);
  assert.ok(errors.includes(expected), `AST guard did not reject ${expected}`);
}
assert.deepEqual(scan('backend/decision_chain/pure.ts',
  "const d = Date.parse('2026-10-13T00:00:00Z');"), []);
console.log(`PASS ARCH-2 purity guard: ${files.length} contracts and ${cases.length} attack cases`);
