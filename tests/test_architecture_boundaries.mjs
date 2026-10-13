/**
 * ARCH-1: institutional contract topology and runtime separation.
 *
 * Static checks only: no TypeScript execution, database, network, provider or
 * production access. These checks complement (not replace) gate behavior tests.
 * A deliberately authorized future runtime integration must update this
 * guard in the same reviewed change.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const dependencyEdges = [
  ['backend/regime_engine/contract.ts', [
    '../market_engine/institutional_snapshot.js',
    '../positioning_engine/evidence_contract.js',
  ]],
  ['backend/horizon_engine/contract.ts', [
    '../event_impact/deterministic_processor.js',
    '../gold_transmission/deterministic_processor.js',
    '../market_engine/institutional_snapshot.js',
    '../positioning_engine/evidence_contract.js',
    '../regime_engine/contract.js',
  ]],
  ['backend/ai_engine/v2_committee_contract.ts', ['../horizon_engine/contract.js']],
  ['backend/risk_engine/pre_pm_contract.ts', ['../ai_engine/v2_committee_contract.js']],
  ['backend/portfolio_engine/contract.ts', ['../risk_engine/pre_pm_contract.js']],
  ['backend/risk_engine/final_action_contract.ts', ['../portfolio_engine/contract.js']],
  ['backend/action_engine/contract.ts', ['../risk_engine/final_action_contract.js']],
  ['backend/command_center/contract.ts', ['../action_engine/contract.js']],
  ['backend/alert_engine/contract.ts', ['../command_center/contract.js']],
  ['backend/acceptance_engine/contract.ts', ['../alert_engine/contract.js']],
];

function importsOf(file) {
  const source = read(file);
  // Existing TS modules use static ESM "from" imports. This deliberately
  // does not infer runtime wiring from comments or path-like substrings.
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function toRepoPath(origin, specifier) {
  return path.posix.normalize(path.posix.join(
    path.posix.dirname(origin),
    specifier.replace(/\.js$/, '.ts'),
  ));
}

const protectedContracts = new Set([
  ...dependencyEdges.map(([consumer]) => consumer),
  'backend/market_engine/institutional_snapshot.ts',
  'backend/positioning_engine/evidence_contract.ts',
]);

// 1. Expected directional edges are real imports and every referenced
// module is an existing source file rather than only a design diagram.
for (const [consumer, dependencies] of dependencyEdges) {
  assert.ok(existsSync(path.join(root, consumer)), `Missing institutional contract: ${consumer}`);
  const actual = importsOf(consumer);
  for (const dependency of dependencies) {
    assert.ok(actual.includes(dependency), `${consumer} must import ${dependency}`);
    const target = toRepoPath(consumer, dependency);
    assert.ok(existsSync(path.join(root, target)), `Missing dependency: ${target}`);
  }
}

// 2. The legacy runtime entrypoints may not *directly* import V2-only gates.
// This catches accidental wiring, not an exhaustive transitive reachability
// proof. The review still owns all newly introduced indirect dependencies.
for (const entrypoint of [
  'backend/worker.ts',
  'backend/ingest.ts',
  'backend/ai_engine/committee_orchestrator.ts',
]) {
  for (const specifier of importsOf(entrypoint)) {
    if (!specifier.startsWith('.')) continue;
    const imported = toRepoPath(entrypoint, specifier);
    assert.ok(!protectedContracts.has(imported),
      `Legacy entrypoint ${entrypoint} directly imports V2-only ${imported}`);
  }
}

// 3. Shadow endpoints remain exact-path, manually invoked bridges; their
// handlers cannot be added to existing cron jobs without a reviewed edit.
const worker = read('backend/worker.ts');
const manualEndpoints = [
  ['/event-shadow/discover', 'handleEventShadowDiscoverRequest'],
  ['/event-shadow', 'handleEventShadowRequest'],
  ['/event-impact-shadow', 'handleEventImpactShadowRequest'],
  ['/gold-transmission-shadow', 'handleGoldTransmissionShadowRequest'],
];
const runJobStart = worker.indexOf('export async function runJob(');
const runtimeExportStart = worker.indexOf('\nexport default', runJobStart);
assert.ok(runJobStart >= 0 && runtimeExportStart > runJobStart, 'Worker runJob boundaries changed');
const cronRegion = worker.slice(runJobStart, runtimeExportStart)
  + worker.slice(worker.indexOf('  async scheduled('));
for (const [route, handler] of manualEndpoints) {
  assert.ok(worker.includes(`if (path === '${route}') return ${handler}(request, env);`),
    `Manual endpoint must use an exact route match: ${route}`);
  assert.ok(!cronRegion.includes(`${handler}(`),
    `Manual handler must not be invoked from cron: ${handler}`);
}
assert.match(worker,
  /export type JobName\s*=\s*'market_engine'\s*\|\s*'news_engine'\s*\|\s*'ai_committee'\s*;/,
  'Cron job allowlist changed: review runtime authority and ARCH-1 first');

// 4. Architectural source-of-truth must exist; no stale example paths are
// treated as actual implemented modules.
assert.ok(existsSync(path.join(root, 'docs/XAU_V2_ARCHITECTURE_BASELINE.md')));
assert.ok(existsSync(path.join(root, 'docs/XAU_V2_DECISION_CHAIN_CONTRACT.md')));
console.log('ARCH-1 topology and legacy runtime separation: PASS');
