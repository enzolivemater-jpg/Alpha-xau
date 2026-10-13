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
  'command_center/contract.ts', 'alert_engine/contract.ts',
  'acceptance_engine/contract.ts', 'decision_chain/dry_run.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'decision-chain-dry-run-'));
let mod;
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
  mod = await import(pathToFileURL(path.join(temp, 'decision_chain', 'dry_run.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T14:15:00.000Z';
const live = (value, observedAt, source) => ({ value, status: 'LIVE', observedAt, ageSeconds: 60, source });
const unavailable = { value: null, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null };
const evidenceKeys = [
  'restorableRecoveryPoint', 'productionMigrationsApplied', 'officialBundleLiveProven',
  'runtimeDeploymentProven', 'providerPoliciesApproved', 'semanticMethodsApproved',
  'portfolioRiskPoliciesApproved', 'alertDeliveryPolicyApproved', 'goldenPathReplayProven',
  'incidentRecoveryProven', 'executionAuthorityApproved',
];

/** Current honest state: nothing authorized, no runtime identity, no policy. */
const baseline = {
  marketSnapshot: {
    available: true,
    reason: null,
    spot: live(3900, '2026-10-01T14:14:00.000Z', 'twelve_data'),
    bid: live(3899.8, '2026-10-01T14:14:00.000Z', 'twelve_data'),
    ask: live(3900.2, '2026-10-01T14:14:00.000Z', 'twelve_data'),
    dxy: unavailable,
    us10y: live(4.1, '2026-10-01T00:00:00.000Z', 'fred'),
    realYield: live(1.7, '2026-10-01T00:00:00.000Z', 'fred'),
    vix: live(17.2, '2026-10-01T00:00:00.000Z', 'fred'),
    wti: live(66.4, '2026-10-01T00:00:00.000Z', 'fred'),
    capturedAt: '2026-10-01T14:14:00.000Z',
  },
  positioningEvidence: [{
    sourceAuthority: 'authority_test', datasetCode: 'weekly_positions', instrumentCode: 'GC',
    metricCode: 'managed_money_net', value: 12345, unit: 'CONTRACTS', periodEnd: '2026-09-29',
    publishedAt: '2026-09-30T19:30:00.000Z', observedAt: '2026-09-30T19:31:00.000Z',
    artifactId: 'sha256:test-artifact', revision: null,
  }],
  eventImpact: {
    algorithmVersion: 'event-impact-deterministic-processor-v5',
    status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff,
  },
  goldTransmission: {
    algorithmVersion: 'gold-transmission-deterministic-processor-v5',
    status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff,
  },
  evidenceGraph: { schemaVersion: null, complete: false, nodeCount: 0 },
  authorizations: {
    provider: 'UNAUTHORIZED', cost: 'UNAUTHORIZED', portfolioPolicy: 'UNAUTHORIZED',
    riskPolicy: 'UNAUTHORIZED', execution: 'UNAUTHORIZED', alertPolicy: 'UNAUTHORIZED',
    delivery: 'UNAUTHORIZED',
  },
  portfolioState: 'UNAVAILABLE',
  brokerConstraintsVersion: null,
  brokerConnection: 'ABSENT',
  recipientPolicyVersion: null,
  runtimeEvidence: { correlationId: null, deploymentId: null },
  acceptanceEvidence: Object.fromEntries(evidenceKeys.map((key) => [key, false])),
};

const STAGES = [
  'MARKET_PRICING', 'POSITIONING', 'REGIME', 'HORIZON_SYNTHESIS', 'AI_COMMITTEE', 'PRE_PM',
  'PORTFOLIO_MANAGER', 'FINAL_ACTION_RISK', 'ACTION', 'COMMAND_CENTER', 'ALERT', 'ACCEPTANCE',
];
const byStage = (result) => Object.fromEntries(result.trace.map((item) => [item.stage, item]));
const codes = (violations) => violations.map((v) => `${v.stage}:${v.code}`);

// --- 1. Current state composes end to end into an honest, consistent HOLD.
const result = mod.runDecisionChainDryRun(baseline, cutoff);
assert.equal(result.schemaVersion, 'xau.decision-chain-dry-run.v1');
assert.equal(result.algorithmVersion, 'decision-chain-dry-run-1.0.0');
assert.equal(result.mode, 'DRY_RUN');
assert.equal(result.chainState, 'HOLD');
assert.equal(result.execution, 'FORBIDDEN');
assert.equal(result.integrity, 'CONSISTENT');
assert.deepEqual(result.violations, []);
assert.deepEqual(result.trace.map((item) => item.stage), STAGES);
assert.deepEqual(mod.DECISION_CHAIN_STAGES.map((item) => item.stage), STAGES);
for (const item of result.trace) assert.equal(item.knowledgeCutoff, cutoff, item.stage);
assert.deepEqual(result.trace.map((item) => item.state), [
  'DEGRADED', 'EVIDENCE_READY', 'DEGRADED', 'ABSTAIN', 'ABSTAIN', 'ABSTAIN',
  'ABSTAIN', 'ABSTAIN', 'ABSTAIN', 'HOLD', 'SUPPRESSED', 'NOT_ACCEPTED',
]);
const t = byStage(result);
assert.deepEqual(t.REGIME.reasonCodes, [
  'MARKET_PRICING_DEGRADED', 'POSITIONING_SIGNAL_UNAVAILABLE', 'REGIME_METHODOLOGY_NOT_APPROVED',
]);
assert.deepEqual(t.HORIZON_SYNTHESIS.reasonCodes, [
  'EVENT_IMPACT_INSUFFICIENT', 'GOLD_TRANSMISSION_INSUFFICIENT', 'MARKET_PRICING_NOT_AVAILABLE',
  'POSITIONING_SIGNAL_UNAVAILABLE', 'REGIME_UNAVAILABLE', 'HORIZON_METHODOLOGY_NOT_APPROVED',
]);
assert.deepEqual(t.AI_COMMITTEE.reasonCodes, [
  'HORIZON_NOT_READY', 'PROVIDER_NOT_AUTHORIZED', 'COST_NOT_AUTHORIZED',
  'COMMITTEE_V2_METHOD_NOT_APPROVED',
]);
assert.deepEqual(t.ACTION.reasonCodes, [
  'FINAL_RISK_NOT_READY', 'EXECUTION_NOT_AUTHORIZED', 'BROKER_NOT_CONNECTED',
  'ACTION_METHOD_NOT_APPROVED',
]);
assert.deepEqual(t.COMMAND_CENTER.reasonCodes, [
  'RUNTIME_CORRELATION_UNAVAILABLE', 'DEPLOYMENT_NOT_PROVEN', 'COMMAND_CENTER_RUNTIME_NOT_APPROVED',
]);
assert.equal(result.stages.action.order, null);
assert.equal(result.stages.commandCenter.tradeTicket, null);
assert.equal(result.stages.alert.delivery, 'FORBIDDEN');
assert.deepEqual(result.stages.acceptance.missingEvidence, evidenceKeys);
// No stage reports a version mismatch: every builder accepted its real upstream.
for (const item of result.trace) {
  assert.ok(!item.reasonCodes.some((code) => /VERSION_MISMATCH|CUTOFF_MISMATCH|SET_MISMATCH/.test(code)),
    `${item.stage}: ${item.reasonCodes.join(',')}`);
}

// --- 2. Determinism and replay digest.
assert.deepEqual(mod.runDecisionChainDryRun(structuredClone(baseline), cutoff), result);
const digest = await mod.computeDecisionChainDigest(result);
assert.match(digest, /^sha256:[0-9a-f]{64}$/);
assert.equal(await mod.computeDecisionChainDigest(mod.runDecisionChainDryRun(structuredClone(baseline), cutoff)), digest);
const later = '2026-10-01T14:16:00.000Z';
const laterInput = structuredClone(baseline);
laterInput.eventImpact.knowledgeCutoff = later;
laterInput.goldTransmission.knowledgeCutoff = later;
assert.notEqual(await mod.computeDecisionChainDigest(mod.runDecisionChainDryRun(laterInput, later)), digest);

// --- 3. Authorizations alone never unlock an action: methods remain unapproved.
const authorized = structuredClone(baseline);
for (const key of Object.keys(authorized.authorizations)) authorized.authorizations[key] = 'AUTHORIZED';
Object.assign(authorized, {
  evidenceGraph: { schemaVersion: 'xau.evidence-graph.v0-test', complete: true, nodeCount: 3 },
  portfolioState: 'AVAILABLE', brokerConstraintsVersion: 'broker-test-1',
  brokerConnection: 'CONNECTED', recipientPolicyVersion: 'recipients-test-1',
  runtimeEvidence: { correlationId: 'corr-test-1', deploymentId: 'deploy-test-1' },
  acceptanceEvidence: Object.fromEntries(evidenceKeys.map((key) => [key, true])),
});
const unlocked = mod.runDecisionChainDryRun(authorized, cutoff);
assert.equal(unlocked.integrity, 'CONSISTENT');
assert.equal(unlocked.chainState, 'HOLD');
assert.equal(unlocked.stages.action.decision, 'ABSTAIN');
assert.equal(unlocked.stages.action.order, null);
const u = byStage(unlocked);
assert.deepEqual(u.AI_COMMITTEE.reasonCodes, ['HORIZON_NOT_READY', 'COMMITTEE_V2_METHOD_NOT_APPROVED']);
assert.deepEqual(u.ACTION.reasonCodes, ['FINAL_RISK_NOT_READY', 'ACTION_METHOD_NOT_APPROVED']);
assert.deepEqual(u.COMMAND_CENTER.reasonCodes, ['COMMAND_CENTER_RUNTIME_NOT_APPROVED']);
assert.deepEqual(u.ACCEPTANCE.reasonCodes, ['ALERT_NOT_DELIVERABLE', 'E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED']);
assert.equal(unlocked.stages.commandCenter.observability.correlationId, 'corr-test-1');

// --- 4. Upstream drift and legacy identities fail closed at the right stage.
const drift = structuredClone(baseline);
drift.eventImpact.knowledgeCutoff = '2026-10-01T14:14:59.000Z';
drift.goldTransmission.algorithmVersion = 'legacy';
const drifted = mod.runDecisionChainDryRun(drift, cutoff);
assert.equal(drifted.integrity, 'CONSISTENT');
assert.ok(byStage(drifted).HORIZON_SYNTHESIS.reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));
assert.ok(byStage(drifted).HORIZON_SYNTHESIS.reasonCodes.includes('GOLD_TRANSMISSION_VERSION_MISMATCH'));

// --- 5. Look-ahead market data abstains and propagates to Regime.
const lookahead = structuredClone(baseline);
lookahead.marketSnapshot.vix = live(17.2, '2026-10-01T14:20:00.000Z', 'fred');
const ahead = byStage(mod.runDecisionChainDryRun(lookahead, cutoff));
assert.equal(ahead.MARKET_PRICING.state, 'ABSTAIN');
assert.ok(ahead.MARKET_PRICING.reasonCodes.includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
assert.equal(ahead.REGIME.state, 'ABSTAIN');
assert.ok(ahead.REGIME.reasonCodes.includes('MARKET_PRICING_ABSTAINED'));

// --- 6. An invalid cutoff is rejected by every stage, not just the first.
const invalid = mod.runDecisionChainDryRun(baseline, '2026-10-01');
for (const item of invalid.trace) {
  assert.ok(item.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'), item.stage);
}
assert.equal(invalid.chainState, 'HOLD');

// --- 7. The verifier catches tampered or reloaded results.
const tamper = (mutate) => {
  const copy = structuredClone(result);
  mutate(copy);
  return codes(mod.verifyDecisionChainIntegrity(copy));
};
assert.deepEqual(tamper(() => {}), []);
assert.deepEqual(tamper((r) => { r.stages.action.order = { side: 'BUY' }; }), ['ACTION:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.commandCenter.tradeTicket = {}; }), ['COMMAND_CENTER:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.committee.providerInvocation = 'COMPLETED'; }), ['AI_COMMITTEE:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.horizonSynthesis.scenarios[2].probability = 0.6; }), ['HORIZON_SYNTHESIS:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.finalActionRisk.positionSize = 1; }), ['FINAL_ACTION_RISK:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.alert.recipient = 'desk'; }), ['ALERT:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.portfolioManager.state = 'READY'; }), [
  'PORTFOLIO_MANAGER:STAGE_STATE_FORBIDDEN', 'CHAIN:TRACE_STAGE_MISMATCH',
]);
assert.deepEqual(tamper((r) => { r.stages.regime.algorithmVersion = 'regime-legacy'; }), [
  'REGIME:STAGE_VERSION_MISMATCH', 'CHAIN:TRACE_STAGE_MISMATCH',
]);
assert.deepEqual(tamper((r) => { r.stages.prePm.knowledgeCutoff = later; }), [
  'PRE_PM:STAGE_CUTOFF_MISMATCH', 'CHAIN:TRACE_STAGE_MISMATCH',
]);
assert.deepEqual(tamper((r) => { r.trace.reverse(); }), ['CHAIN:TRACE_STAGE_MISMATCH']);
assert.deepEqual(tamper((r) => { r.trace[8].reasonCodes = []; }), ['CHAIN:TRACE_STAGE_MISMATCH']);
assert.deepEqual(tamper((r) => { r.stages.commandCenter.lineage = r.stages.commandCenter.lineage.slice(1); }), [
  'COMMAND_CENTER:LINEAGE_MISMATCH',
]);
assert.deepEqual(tamper((r) => { r.stages.commandCenter.actionReasonCodes = []; }), [
  'COMMAND_CENTER:ACTION_REASONS_NOT_PROPAGATED',
]);
assert.deepEqual(tamper((r) => { r.stages.alert.dedupeKey = 'replayed'; }), ['ALERT:ALERT_DEDUPE_KEY_MISMATCH']);
assert.deepEqual(tamper((r) => { delete r.stages.prePm; }), ['CHAIN:STAGE_SET_MISMATCH']);
assert.deepEqual(tamper((r) => { r.knowledgeCutoff = later; }).filter((code) => code.endsWith('STAGE_CUTOFF_MISMATCH')),
  STAGES.map((stage) => `${stage}:STAGE_CUTOFF_MISMATCH`));

// --- 8. Canonical JSON is order-independent and refuses lossy values.
assert.equal(mod.canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
assert.equal(mod.canonicalJson({ a: 1, b: 2 }), mod.canonicalJson({ b: 2, a: 1 }));
assert.throws(() => mod.canonicalJson({ a: Number.NaN }), TypeError);
assert.throws(() => mod.canonicalJson({ a: undefined }), TypeError);
assert.throws(() => mod.canonicalJson({ a: new Date(0) }), TypeError);
assert.throws(() => mod.canonicalJson(1n), TypeError);

// --- 9. Static guards on source and documentation.
const source = readFileSync(path.join(ROOT, 'backend', 'decision_chain', 'dry_run.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_DECISION_CHAIN_DRY_RUN_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(|Date\.now\(|new Date\(/);
assert.match(source, /chainState: 'HOLD'/);
assert.match(source, /execution: 'FORBIDDEN'/);
assert.match(docs, /DRY RUN ONLY/);
assert.match(docs, /xau\.decision-chain-dry-run\.v1/);
assert.match(docs, /decision-chain-dry-run-1\.0\.0/);
assert.match(docs, /authorizes no persistence[\s\S]*trading/i);
console.log('PASS CHAIN-0 composes MP-0..E2E-0 into a verified, replayable HOLD dry run');
