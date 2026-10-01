import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'event_impact/deterministic_processor.ts', 'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts', 'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
  'horizon_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
  'risk_engine/pre_pm_contract.ts', 'portfolio_engine/contract.ts',
  'risk_engine/final_action_contract.ts', 'action_engine/contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'decision-chain-contract-'));
const modules = new Map();
try {
  for (const sourcePath of sourceFiles) {
    const input = readFileSync(path.join(ROOT, 'backend', sourcePath), 'utf8');
    const output = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const destination = path.join(temp, sourcePath.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output, 'utf8');
  }
  for (const name of ['portfolio_engine/contract', 'risk_engine/final_action_contract', 'action_engine/contract']) {
    modules.set(name, await import(pathToFileURL(path.join(temp, `${name}.mjs`)).href));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
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
