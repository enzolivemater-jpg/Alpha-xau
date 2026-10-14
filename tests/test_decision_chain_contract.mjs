import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
for (const name of ['portfolio_engine/contract', 'risk_engine/final_action_contract', 'action_engine/contract']) {
  modules.set(name, await loadBackendModule(`${name}.ts`));
}

const cutoff = '2026-10-01T14:00:00.000Z';
const pm = modules.get('portfolio_engine/contract').buildPortfolioManagerGate({
  prePm: {
    schemaVersion: 'xau.pre-pm-evidence-risk.v1',
    algorithmVersion: 'pre-pm-dependency-gate-1.0.0',
    state: 'ABSTAIN', portfolioManagerEligibility: 'BLOCKED', knowledgeCutoff: cutoff,
  },
  portfolioPolicyAuthorization: 'UNAUTHORIZED', portfolioState: 'UNAVAILABLE',
}, cutoff);
assert.equal(pm.state, 'ABSTAIN');
assert.equal(pm.advisoryOnly, true);
assert.equal(pm.recommendation, null);
assert.equal(pm.targetAllocation, null);
assert.equal(pm.sizing, null);
assert.deepEqual(pm.reasonCodes, [
  'PRE_PM_NOT_READY', 'PORTFOLIO_POLICY_NOT_APPROVED',
  'PORTFOLIO_STATE_UNAVAILABLE', 'PORTFOLIO_METHOD_NOT_APPROVED',
]);

const far = modules.get('risk_engine/final_action_contract').buildFinalActionRiskGate({
  portfolioManager: { ...pm, knowledgeCutoff: cutoff },
  riskPolicyAuthorization: 'UNAUTHORIZED', brokerConstraintsVersion: null,
}, cutoff);
assert.equal(far.state, 'ABSTAIN');
assert.equal(far.actionEligibility, 'BLOCKED');
assert.equal(far.maximumLoss, null);
assert.equal(far.positionSize, null);
assert.equal(far.stopLoss, null);
assert.deepEqual(far.reasonCodes, [
  'PORTFOLIO_NOT_READY', 'RISK_POLICY_NOT_APPROVED',
  'BROKER_CONSTRAINTS_UNAVAILABLE', 'FINAL_RISK_METHOD_NOT_APPROVED',
]);

const action = modules.get('action_engine/contract').buildActionAbstentionGate({
  finalRisk: { ...far, knowledgeCutoff: cutoff },
  executionAuthorization: 'UNAUTHORIZED', brokerConnection: 'ABSENT',
}, cutoff);
assert.equal(action.decision, 'ABSTAIN');
assert.equal(action.execution, 'FORBIDDEN');
assert.equal(action.advisoryOnly, true);
assert.equal(action.recommendation, null);
assert.equal(action.order, null);
assert.deepEqual(action.reasonCodes, [
  'FINAL_RISK_NOT_READY', 'EXECUTION_NOT_AUTHORIZED',
  'BROKER_NOT_CONNECTED', 'ACTION_METHOD_NOT_APPROVED',
]);

const source = [
  'portfolio_engine/contract.ts', 'risk_engine/final_action_contract.ts',
  'action_engine/contract.ts',
].map((file) => readFileSync(path.join(ROOT, 'backend', file), 'utf8')).join('\n');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_DECISION_CHAIN_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.doesNotMatch(source, /maximumLoss:\s*[0-9]|positionSize:\s*[0-9]|stopLoss:\s*[0-9]/);
assert.match(docs, /generic request to continue is not execution authorization/i);
assert.match(docs, /authorizes no LLM call[\s\S]*trading/i);
console.log('PASS D-0 freezes PM, final-risk and action gates as advisory abstention only');
