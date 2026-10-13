import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDecisionChainModule } from '../scripts/run_decision_chain_dry_run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await loadDecisionChainModule();

const golden = JSON.parse(readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json'), 'utf8'));
const cutoff = golden.knowledgeCutoff;
const live = (value, observedAt, source) => ({ value, status: 'LIVE', observedAt, ageSeconds: 60, source });
const evidenceKeys = [
  'restorableRecoveryPoint', 'productionMigrationsApplied', 'officialBundleLiveProven',
  'runtimeDeploymentProven', 'providerPoliciesApproved', 'semanticMethodsApproved',
  'portfolioRiskPoliciesApproved', 'alertDeliveryPolicyApproved', 'goldenPathReplayProven',
  'incidentRecoveryProven', 'executionAuthorityApproved',
];
/** Current honest state: nothing authorized, no runtime identity, no policy. */
const baseline = golden.input;
assert.deepEqual(Object.values(baseline.authorizations).sort(), Array(7).fill('UNAUTHORIZED'));
assert.deepEqual(baseline.runtimeEvidence, { correlationId: null, deploymentId: null });
assert.deepEqual(Object.keys(baseline.acceptanceEvidence), evidenceKeys);
assert.ok(Object.values(baseline.acceptanceEvidence).every((flag) => flag === false));

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

// --- 2. Determinism and golden replay: any unreviewed gate drift changes the digest.
assert.deepEqual(mod.runDecisionChainDryRun(structuredClone(baseline), cutoff), result);
assert.deepEqual(result.trace, golden.expected.trace);
const digest = await mod.computeDecisionChainDigest(result);
assert.match(digest, /^sha256:[0-9a-f]{64}$/);
assert.equal(digest, golden.expected.digest);
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

assert.deepEqual(unlocked.inputFindings, []);
assert.deepEqual(result.inputFindings, []);

// --- 3b. Blank or malformed identifiers never count as present evidence.
const blank = structuredClone(authorized);
Object.assign(blank, {
  evidenceGraph: { schemaVersion: ' ', complete: true, nodeCount: 3 },
  brokerConstraintsVersion: '', recipientPolicyVersion: 'policy\nv1',
  runtimeEvidence: { correlationId: '', deploymentId: 'x'.repeat(129) },
});
const blanked = mod.runDecisionChainDryRun(blank, cutoff);
assert.equal(blanked.integrity, 'CONSISTENT');
assert.deepEqual(blanked.inputFindings.map((finding) => finding.field), [
  'evidenceGraph.schemaVersion', 'brokerConstraintsVersion', 'recipientPolicyVersion',
  'runtimeEvidence.correlationId', 'runtimeEvidence.deploymentId',
]);
assert.ok(blanked.inputFindings.every((finding) => finding.code === 'INVALID_IDENTIFIER_NULLIFIED'));
const b = byStage(blanked);
assert.ok(b.PRE_PM.reasonCodes.includes('EVIDENCE_GRAPH_UNAVAILABLE'));
assert.ok(b.FINAL_ACTION_RISK.reasonCodes.includes('BROKER_CONSTRAINTS_UNAVAILABLE'));
assert.ok(b.ALERT.reasonCodes.includes('RECIPIENT_POLICY_UNAVAILABLE'));
assert.deepEqual(b.COMMAND_CENTER.reasonCodes, [
  'RUNTIME_CORRELATION_UNAVAILABLE', 'DEPLOYMENT_NOT_PROVEN', 'COMMAND_CENTER_RUNTIME_NOT_APPROVED',
]);
assert.deepEqual(blanked.stages.commandCenter.observability,
  { state: 'CONTRACT_ONLY', correlationId: null, deploymentId: null });
assert.equal(blank.runtimeEvidence.correlationId, '', 'caller input is never mutated');

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
assert.deepEqual(tamper((r) => { r.chainState = 'READY'; }), ['CHAIN:CHAIN_ENVELOPE_MISMATCH']);
assert.deepEqual(tamper((r) => { r.execution = 'AUTHORIZED'; }), ['CHAIN:CHAIN_ENVELOPE_MISMATCH']);
assert.deepEqual(tamper((r) => { r.algorithmVersion = 'decision-chain-dry-run-0.9.0'; }), ['CHAIN:CHAIN_ENVELOPE_MISMATCH']);
// Malformed reloads are reported, never thrown.
assert.deepEqual(tamper((r) => { r.stages.horizonSynthesis.scenarios = 'none'; }), ['CHAIN:MALFORMED_RESULT']);
assert.deepEqual(tamper((r) => { r.trace = {}; }), ['CHAIN:MALFORMED_RESULT']);
assert.deepEqual(tamper((r) => { r.stages.regime.reasonCodes = null; }), ['CHAIN:MALFORMED_RESULT']);
assert.deepEqual(codes(mod.verifyDecisionChainIntegrity(null)), ['CHAIN:MALFORMED_RESULT']);
assert.deepEqual(codes(mod.verifyDecisionChainIntegrity(JSON.parse(JSON.stringify(result)))), []);
assert.deepEqual(tamper((r) => { r.knowledgeCutoff = later; }).filter((code) => code.endsWith('STAGE_CUTOFF_MISMATCH')),
  STAGES.map((stage) => `${stage}:STAGE_CUTOFF_MISMATCH`));

// --- 8. Canonical JSON is order-independent and refuses lossy values.
assert.equal(mod.canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
assert.equal(mod.canonicalJson({ a: 1, b: 2 }), mod.canonicalJson({ b: 2, a: 1 }));
assert.throws(() => mod.canonicalJson({ a: Number.NaN }), TypeError);
assert.throws(() => mod.canonicalJson({ a: undefined }), TypeError);
assert.throws(() => mod.canonicalJson({ a: new Date(0) }), TypeError);
assert.throws(() => mod.canonicalJson(1n), TypeError);

// --- 9. The local simulation CLI reports the same verdict and digest.
const cli = path.join(ROOT, 'scripts', 'run_decision_chain_dry_run.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const goldenRun = run();
assert.equal(goldenRun.status, 0, goldenRun.stderr);
const summary = JSON.parse(goldenRun.stdout);
assert.equal(summary.integrity, 'CONSISTENT');
assert.equal(summary.chainState, 'HOLD');
assert.equal(summary.execution, 'FORBIDDEN');
assert.equal(summary.digest, golden.expected.digest);
assert.deepEqual(summary.trace.map((item) => item.stage), STAGES);
const scratch = mkdtempSync(path.join(tmpdir(), 'decision-chain-cli-'));
try {
  const blankFile = path.join(scratch, 'blank.json');
  writeFileSync(blankFile, JSON.stringify({ knowledgeCutoff: cutoff, input: blank }));
  const blankRun = run(blankFile);
  assert.equal(blankRun.status, 0, blankRun.stderr);
  assert.equal(JSON.parse(blankRun.stdout).inputFindings.length, 5);
  const badFile = path.join(scratch, 'bad.json');
  writeFileSync(badFile, JSON.stringify({ input: baseline }));
  assert.equal(run(badFile).status, 1);
  writeFileSync(badFile, '{not json');
  assert.equal(run(badFile).status, 1);
  assert.equal(run(badFile, 'extra').status, 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- 10. Static guards on source and documentation.
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
