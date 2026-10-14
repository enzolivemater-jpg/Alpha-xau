/** METH-0: ensure the review blueprint never claims a positive methodology. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => readFileSync(path.join(root, p), 'utf8');
const m = JSON.parse(load('docs/XAU_V2_METH_0_REVIEW_MATRIX.json'));

assert.equal(m.schemaVersion, 'xau.methodology-review-matrix.v1');
assert.equal(m.mode, 'DOCUMENTATION_ONLY');
assert.equal(m.authorization, 'NONE');
assert.equal(m.productionActivation, 'FORBIDDEN');
assert.equal(m.status, 'UNAPPROVED');
assert.equal(m.businessDecisionsApproved, false);
assert.deepEqual(m.horizonIdentifiers, ['H1', 'H2', 'H3', 'H4', 'H5']);
assert.ok(Object.values(m.assumptions).every((value) => value === null),
  'No thresholds, weights, providers or risk limits may be silently selected');
assert.ok(m.crossCuttingRequiredProof.length >= 8);
assert.equal(new Set(m.crossCuttingRequiredProof).size, m.crossCuttingRequiredProof.length);

const expected = [
  ['REGIME', 'backend/regime_engine/contract.ts', 'REGIME_METHODOLOGY_NOT_APPROVED'],
  ['HORIZON_SYNTHESIS', 'backend/horizon_engine/contract.ts', 'HORIZON_METHODOLOGY_NOT_APPROVED'],
  ['AI_COMMITTEE', 'backend/ai_engine/v2_committee_contract.ts', 'COMMITTEE_V2_METHOD_NOT_APPROVED'],
  ['PRE_PM', 'backend/risk_engine/pre_pm_contract.ts', 'PRE_PM_METHOD_NOT_APPROVED'],
  ['PORTFOLIO_MANAGER', 'backend/portfolio_engine/contract.ts', 'PORTFOLIO_METHOD_NOT_APPROVED'],
  ['FINAL_ACTION_RISK', 'backend/risk_engine/final_action_contract.ts', 'FINAL_RISK_METHOD_NOT_APPROVED'],
  ['ACTION', 'backend/action_engine/contract.ts', 'ACTION_METHOD_NOT_APPROVED'],
  ['ALERTS', 'backend/alert_engine/contract.ts', 'ALERT_METHOD_NOT_APPROVED'],
];
assert.equal(m.reviewGates.length, expected.length);
assert.deepEqual(m.reviewGates.map(({ gate, sourcePath, blockingReason }) => [gate, sourcePath, blockingReason]), expected);
for (const gate of m.reviewGates) {
  assert.equal(gate.stageStatus, 'RESEARCH_UNAPPROVED', gate.gate);
  assert.equal(gate.humanDecisionRequired, true, gate.gate);
  for (const key of ['approvedMethodId', 'approvedMethodVersion', 'parameterSet',
    'approvalRecord', 'independentReviewEvidence']) assert.equal(gate[key], null, gate.gate+':'+key);
  assert.ok(typeof gate.decisionToDefine === 'string' && gate.decisionToDefine.length > 24);
  assert.ok(Array.isArray(gate.requiredTestPlans) && gate.requiredTestPlans.length >= 4);
  assert.equal(new Set(gate.requiredTestPlans).size, gate.requiredTestPlans.length);
  assert.ok(existsSync(path.join(root, gate.sourcePath)), gate.sourcePath);
  const source = load(gate.sourcePath);
  assert.ok(source.includes("reasons.add('" + gate.blockingReason + "')"), gate.blockingReason);
  assert.ok(source.includes("  | '" + gate.blockingReason + "'"), 'Gate reason must be typed');
}

// The matrix must never be imported into live Worker, ingest, legacy
// Committee, or institutional runtime as if documentation could grant trust.
for (const sourceFile of ['backend/worker.ts', 'backend/ingest.ts',
  'backend/ai_engine/committee_orchestrator.ts']) {
  assert.doesNotMatch(load(sourceFile), /XAU_V2_METH_0_REVIEW_MATRIX|methodology-review-matrix\.v1/);
}
const docs = load('docs/XAU_V2_METH_0_RESEARCH_PLAN.md');
assert.match(docs, /HUMAN GATE/i);
assert.match(docs, /not a positive trading policy/i);
console.log('METH-0 PASS: 8 real block reasons, 0 method approvals, 0 invented risk/model policy');
