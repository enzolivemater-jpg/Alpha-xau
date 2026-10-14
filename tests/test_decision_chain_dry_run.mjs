import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'event_impact/deterministic_processor.ts',
  'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts',
  'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts',
  'regime_engine/contract.ts',
  'horizon_engine/contract.ts',
  'ai_engine/v2_committee_contract.ts',
  'risk_engine/pre_pm_contract.ts',
  'portfolio_engine/contract.ts',
  'risk_engine/final_action_contract.ts',
  'action_engine/contract.ts',
  'command_center/contract.ts',
  'alert_engine/contract.ts',
  'acceptance_engine/contract.ts',
  'decision_chain/dry_run.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'xau-chain-0-'));
let run;
try {
  for (const source of sources) {
    const input = readFileSync(path.join(root, 'backend', source), 'utf8');
    const result = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const destination = path.join(temp, source.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, result);
  }
  ({ runDecisionChainDryRun: run } = await import(
    pathToFileURL(path.join(temp, 'decision_chain/dry_run.mjs')).href
  ));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-12T11:30:00.000Z';
function makeInput() {
  return {
    knowledgeCutoff: cutoff,
    eventImpact: {
      algorithmVersion: 'event-impact-deterministic-processor-v5',
      status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff,
    },
    goldTransmission: {
      algorithmVersion: 'gold-transmission-deterministic-processor-v5',
      status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff,
    },
    marketPricing: {
      schemaVersion: 'xau.market-pricing-snapshot.v1',
      algorithmVersion: 'market-pricing-envelope-1.0.0',
      state: 'DEGRADED', reasonCodes: ['HISTORICAL_REPLAY_UNAVAILABLE'],
      knowledgeCutoff: cutoff,
    },
    positioning: {
      schemaVersion: 'xau.positioning-evidence.v1',
      algorithmVersion: 'positioning-evidence-normalizer-1.0.0',
      evidenceState: 'ABSTAIN', positioningState: 'UNAVAILABLE',
      reasonCodes: ['NO_POSITIONING_EVIDENCE'], knowledgeCutoff: cutoff,
    },
  };
}

const input = makeInput();
const before = structuredClone(input);
const result = run(input);
assert.deepEqual(input, before, 'Never mutate input evidence');
assert.deepEqual(result, run(structuredClone(input)), 'Deterministic replay');
assert.equal(result.mode, 'OFFLINE_ONLY');
assert.equal(result.systemState, 'HOLD');
assert.equal(result.execution, 'FORBIDDEN');
assert.equal(Object.keys(result.stages).length, 10);
for (const stage of Object.values(result.stages)) {
  assert.equal(stage.knowledgeCutoff, cutoff, 'Single cutoff end to end');
}
assert.equal(result.stages.horizons.scenarios.length, 5);
assert.deepEqual(result.stages.horizons.scenarios.map((s) => s.horizon),
  ['H1', 'H2', 'H3', 'H4', 'H5']);
assert.equal(result.stages.regime.regime, 'UNAVAILABLE');
assert.equal(result.stages.committee.providerInvocation, 'FORBIDDEN');
assert.equal(result.stages.prePm.portfolioManagerEligibility, 'BLOCKED');
assert.equal(result.stages.portfolioManager.recommendation, null);
assert.equal(result.stages.finalActionRisk.positionSize, null);
assert.equal(result.stages.action.order, null);
assert.equal(result.stages.action.decision, 'ABSTAIN');
assert.equal(result.stages.commandCenter.tradeTicket, null);
assert.equal(result.stages.commandCenter.systemState, 'HOLD');
assert.equal(result.stages.alerts.delivery, 'FORBIDDEN');
assert.equal(result.stages.acceptance.acceptanceState, 'NOT_ACCEPTED');
assert.equal(result.stages.acceptance.missingEvidence.length, 11);
assert.ok(result.stages.regime.reasonCodes.includes('POSITIONING_EVIDENCE_ABSTAINED'));
assert.ok(result.stages.horizons.reasonCodes.includes('REGIME_UNAVAILABLE'));
assert.ok(result.stages.committee.reasonCodes.includes('HORIZON_NOT_READY'));
assert.ok(result.stages.prePm.reasonCodes.includes('COMMITTEE_NOT_READY'));
assert.ok(result.stages.portfolioManager.reasonCodes.includes('PRE_PM_NOT_READY'));
assert.ok(result.stages.finalActionRisk.reasonCodes.includes('PORTFOLIO_NOT_READY'));
assert.ok(result.stages.action.reasonCodes.includes('FINAL_RISK_NOT_READY'));
assert.ok(result.stages.alerts.reasonCodes.includes('COMMAND_CENTER_NOT_ACTIONABLE'));

// A real mismatched upstream version must reach the relevant stage, not be
// overwritten with an expected or newly fabricated identity.
const badVersion = makeInput();
badVersion.marketPricing.algorithmVersion = 'unapproved-version';
const versionResult = run(badVersion);
assert.ok(versionResult.stages.regime.reasonCodes.includes('MARKET_PRICING_VERSION_MISMATCH'));
assert.ok(versionResult.stages.horizons.reasonCodes.includes('MARKET_PRICING_VERSION_MISMATCH'));
assert.equal(versionResult.stages.action.execution, 'FORBIDDEN');

const badCutoff = makeInput();
badCutoff.positioning.knowledgeCutoff = '2026-10-13T00:00:00.000Z';
const cutoffResult = run(badCutoff);
assert.ok(cutoffResult.stages.regime.reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));
assert.ok(cutoffResult.stages.horizons.reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));
assert.equal(cutoffResult.stages.alerts.delivery, 'FORBIDDEN');

const invalidCutoff = makeInput();
invalidCutoff.knowledgeCutoff = 'not-a-timestamp';
const invalidResult = run(invalidCutoff);
assert.ok(invalidResult.stages.regime.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));
assert.ok(invalidResult.stages.acceptance.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));
assert.equal(invalidResult.stages.acceptance.productionReadiness, 'HOLD');

const source = readFileSync(path.join(root, 'backend/decision_chain/dry_run.ts'), 'utf8');
assert.doesNotMatch(source, /\bfetch\(|process\.env|Math\.random\(|Date\.now\(|new Date\(|\bWebSocket\b|\bsetTimeout\(/);
assert.doesNotMatch(source, /\bAUTHORIZED'\s*,|executionAuthorization: 'AUTHORIZED'/);
console.log('PASS CHAIN-0 offline composition: 10 gates, cutoff, version drift, HOLD');
