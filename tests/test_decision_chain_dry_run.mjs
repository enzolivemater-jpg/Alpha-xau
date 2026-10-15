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

// --- 3c. Freshness is re-derived at the cutoff with the existing SYMBOL_RULES.
const aged = (mutate) => {
  const copy = structuredClone(baseline);
  mutate(copy.marketSnapshot);
  const run = mod.runDecisionChainDryRun(copy, cutoff);
  return { run, findings: run.inputFindings.map((f) => `${f.field}:${f.code}`), t: byStage(run) };
};
// Spot declared LIVE but observed 2h before the cutoff (> 360s live window).
let check = aged((s) => {
  for (const name of ['spot', 'bid', 'ask']) s[name].observedAt = '2026-10-01T12:15:00.000Z';
  s.capturedAt = '2026-10-01T12:15:00.000Z';
});
assert.deepEqual(check.findings, [
  'marketSnapshot.spot:MARKET_FIELD_STALE_AT_CUTOFF', 'marketSnapshot.bid:MARKET_FIELD_STALE_AT_CUTOFF',
  'marketSnapshot.ask:MARKET_FIELD_STALE_AT_CUTOFF',
]);
assert.equal(check.run.stages.marketPricing.fields.spot.status, 'STALE');
assert.equal(check.run.stages.marketPricing.fields.spot.ageSeconds, 7200);
assert.ok(check.t.MARKET_PRICING.reasonCodes.includes('SPOT_NOT_LIVE'));
assert.equal(check.run.integrity, 'CONSISTENT');
// Spot older than the 3-day stale window: value removed, Market Pricing abstains.
check = aged((s) => {
  for (const name of ['spot', 'bid', 'ask']) s[name].observedAt = '2026-09-27T14:14:00.000Z';
  s.capturedAt = '2026-09-27T14:14:00.000Z';
});
assert.equal(check.findings[0], 'marketSnapshot.spot:MARKET_FIELD_EXPIRED_AT_CUTOFF');
assert.equal(check.run.stages.marketPricing.fields.spot.value, null);
assert.equal(check.t.MARKET_PRICING.state, 'ABSTAIN');
assert.ok(check.t.MARKET_PRICING.reasonCodes.includes('SOURCE_SNAPSHOT_UNAVAILABLE'));
assert.equal(check.t.REGIME.state, 'ABSTAIN');
// A macro driver past its 6-day window becomes unavailable, not silently live.
check = aged((s) => { s.vix.observedAt = '2026-09-24T00:00:00.000Z'; });
assert.deepEqual(check.findings, ['marketSnapshot.vix:MARKET_FIELD_EXPIRED_AT_CUTOFF']);
assert.ok(check.t.MARKET_PRICING.reasonCodes.includes('OPTIONAL_FIELD_UNAVAILABLE'));
// A value with no approved freshness rule (DXY) is never admitted.
check = aged((s) => { s.dxy = live(97.4, '2026-10-01T14:00:00.000Z', 'test'); });
assert.deepEqual(check.findings, ['marketSnapshot.dxy:MARKET_FIELD_FRESHNESS_RULE_UNAVAILABLE']);
assert.equal(check.run.stages.marketPricing.fields.dxy.value, null);
// Values outside the ingestion plausibility range (SYMBOL_RULES) are never admitted.
check = aged((s) => { s.spot.value = 39; s.bid.value = 38.9; s.ask.value = 39.1; });
assert.deepEqual(check.findings, [
  'marketSnapshot.spot:MARKET_FIELD_OUT_OF_RANGE', 'marketSnapshot.bid:MARKET_FIELD_OUT_OF_RANGE',
  'marketSnapshot.ask:MARKET_FIELD_OUT_OF_RANGE',
]);
assert.equal(check.t.MARKET_PRICING.state, 'ABSTAIN');
check = aged((s) => { s.vix.value = -1; s.us10y.value = -0.25; });
assert.deepEqual(check.findings, ['marketSnapshot.vix:MARKET_FIELD_OUT_OF_RANGE']);
assert.equal(check.run.stages.marketPricing.fields.us10y.value, -0.25);
// Freshness is never upgraded: a field declared STALE stays STALE.
check = aged((s) => { s.us10y.status = 'STALE'; });
assert.deepEqual(check.findings, []);
assert.equal(check.run.stages.marketPricing.fields.us10y.status, 'STALE');
// Look-ahead observations are left to MP-0, which abstains on them.
check = aged((s) => { s.wti.observedAt = '2026-10-01T15:00:00.000Z'; });
assert.deepEqual(check.findings, []);
assert.ok(check.t.MARKET_PRICING.reasonCodes.includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
assert.equal(baseline.marketSnapshot.spot.status, 'LIVE', 'caller snapshot is never mutated');

// --- 3d. Untrusted input: explicit, traceable rejection; never a throw, always HOLD.
const evaluate = (mutate, at = cutoff) => {
  const copy = structuredClone(baseline);
  mutate(copy);
  return mod.evaluateDecisionChain(copy, at);
};
const completed = mod.evaluateDecisionChain(structuredClone(baseline), cutoff);
assert.equal(completed.kind, 'COMPLETED');
assert.deepEqual(completed.result, result);
const rejectedPaths = (outcome) => outcome.inputErrors.map((e) => `${e.path}:${e.code}`);
for (const [mutate, expected] of [
  [(i) => { i.positioningEvidence = null; }, ['positioningEvidence:INVALID_TYPE']],
  [(i) => { delete i.marketSnapshot.spot; }, ['marketSnapshot.spot:MISSING']],
  [(i) => { delete i.runtimeEvidence; }, ['runtimeEvidence:MISSING']],
  [(i) => { i.authorizations.execution = 'yes'; }, ['authorizations.execution:INVALID_VALUE']],
  [(i) => { i.authorisations = i.authorizations; }, ['authorisations:UNKNOWN_KEY']],
  [(i) => { i.marketSnapshot.vix.value = '17.2'; }, ['marketSnapshot.vix.value:INVALID_TYPE']],
  [(i) => { i.acceptanceEvidence.executionAuthorityApproved = 'true'; },
    ['acceptanceEvidence.executionAuthorityApproved:INVALID_TYPE']],
  [(i) => { i.eventImpact.status = 'BULLISH'; }, ['eventImpact.status:INVALID_VALUE']],
  [(i) => { i.brokerConnection = undefined; }, ['brokerConnection:INVALID_TYPE']],
]) {
  const outcome = evaluate(mutate);
  assert.equal(outcome.kind, 'REJECTED');
  assert.equal(outcome.chainState, 'HOLD');
  assert.equal(outcome.execution, 'FORBIDDEN');
  assert.equal(outcome.failedAt, 'INPUT');
  assert.deepEqual(rejectedPaths(outcome), expected);
}
for (const bad of [null, [], 'input', 42]) {
  assert.deepEqual(rejectedPaths(mod.evaluateDecisionChain(bad, cutoff)), [':INVALID_TYPE']);
}
assert.deepEqual(rejectedPaths(evaluate(() => {}, 1727791200000)), ['<knowledgeCutoff>:INVALID_TYPE']);
// A stage failure on structurally valid input names the stage.
const hostile = structuredClone(baseline);
hostile.positioningEvidence = [new Proxy({}, { ownKeys() { throw new Error('boom'); } })];
assert.equal(mod.validateDecisionChainInput(hostile).length, 0);
const failed = mod.evaluateDecisionChain(hostile, cutoff);
assert.equal(failed.kind, 'REJECTED');
assert.equal(failed.failedAt, 'POSITIONING');
assert.equal(failed.stageError, 'POSITIONING: Error: boom');
assert.equal(failed.chainState, 'HOLD');
assert.throws(() => mod.runDecisionChainDryRun(hostile, cutoff),
  (error) => error instanceof mod.DecisionChainStageError && error.stage === 'POSITIONING');

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
assert.deepEqual(tamper((r) => { r.stages.horizonSynthesis.scenarios = []; }), ['HORIZON_SYNTHESIS:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.horizonSynthesis.scenarios.reverse(); }), ['HORIZON_SYNTHESIS:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.positioning.positioningState = 'CROWDED_LONG'; }), ['POSITIONING:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.prePm.evidenceAcceptance = 'ACCEPTED'; }), ['PRE_PM:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.portfolioManager.advisoryOnly = false; }), ['PORTFOLIO_MANAGER:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.action.advisoryOnly = false; }), ['ACTION:POSITIVE_OUTPUT_FORBIDDEN']);
assert.deepEqual(tamper((r) => { r.stages.commandCenter.observability.state = 'LIVE'; }), ['COMMAND_CENTER:POSITIVE_OUTPUT_FORBIDDEN']);
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
  writeFileSync(badFile, JSON.stringify({ knowledgeCutoff: cutoff, input: { ...baseline, extra: 1 } }));
  const rejectedRun = run(badFile);
  assert.equal(rejectedRun.status, 1);
  const rejectedOutcome = JSON.parse(rejectedRun.stdout);
  assert.equal(rejectedOutcome.kind, 'REJECTED');
  assert.equal(rejectedOutcome.chainState, 'HOLD');
  assert.deepEqual(rejectedOutcome.inputErrors, [{ path: 'extra', code: 'UNKNOWN_KEY' }]);
  // The replay digest is a function of the input alone: the host time zone
  // and locale (Danish collation sorts "aa" after "z") must not change it.
  const multiEvidence = structuredClone(baseline);
  multiEvidence.positioningEvidence = ['cftc', 'aa-bank', 'authority_test'].map((sourceAuthority) => ({
    ...baseline.positioningEvidence[0], sourceAuthority,
  }));
  const multiFile = path.join(scratch, 'multi-evidence.json');
  writeFileSync(multiFile, JSON.stringify({ knowledgeCutoff: cutoff, input: multiEvidence }));
  const inProcess = await mod.computeDecisionChainDigest(mod.runDecisionChainDryRun(structuredClone(multiEvidence), cutoff));
  for (const [TZ, locale] of [['UTC', 'C'], ['Pacific/Kiritimati', 'da_DK.UTF-8'], ['America/St_Johns', 'tr_TR.UTF-8']]) {
    const hostRun = spawnSync(process.execPath, [cli, multiFile], {
      encoding: 'utf8', env: { ...process.env, TZ, LC_ALL: locale, LANG: locale },
    });
    assert.equal(hostRun.status, 0, hostRun.stderr);
    assert.equal(JSON.parse(hostRun.stdout).digest, inProcess, `${TZ} ${locale}`);
  }
  writeFileSync(badFile, '{not json');
  assert.equal(run(badFile).status, 1);
  assert.equal(run(badFile, 'extra').status, 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- 10. Containment: the chain depends only on pure contracts and nothing
// in the runtime imports it, so a dry run can never reach live data or I/O.
const { listBackendImportClosure } = await import('../scripts/lib/backend_module_loader.mjs');
const closure = listBackendImportClosure('decision_chain/dry_run.ts');
assert.deepEqual(closure, [
  'acceptance_engine/contract.ts', 'action_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
  'alert_engine/contract.ts', 'command_center/contract.ts', 'decision_chain/dry_run.ts',
  'event_impact/deterministic_processor.ts', 'gold_transmission/deterministic_processor.ts',
  'horizon_engine/contract.ts', 'market_engine/institutional_snapshot.ts', 'market_engine/validate.ts',
  'portfolio_engine/contract.ts', 'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
  'risk_engine/final_action_contract.ts', 'risk_engine/pre_pm_contract.ts', 'shared/canonical_json.ts',
  'shared/strict_timestamp.ts',
]);
for (const file of closure) {
  const text = readFileSync(path.join(ROOT, 'backend', file), 'utf8');
  assert.doesNotMatch(text, /\bfetch\(|process\.env|Math\.random\(|SUPABASE_|ANTHROPIC_|OPENAI_|\benv\.[A-Z]/, file);
}
const backendFiles = spawnSync('git', ['ls-files', 'backend'], { cwd: ROOT, encoding: 'utf8' })
  .stdout.split('\n').filter((file) => file.endsWith('.ts') && !file.startsWith('backend/decision_chain/'));
assert.ok(backendFiles.length > 40);
// Only two explicitly reviewed, offline-only projection modules may consume
// the canonical chain. Production handlers, market providers and brokers cannot.
const offlineConsumers = new Set([
  'backend/observability/offline_receipt.ts',
  'backend/observability/unified_rehearsal.ts',
]);
for (const file of backendFiles) {
  const contents = readFileSync(path.join(ROOT, file), 'utf8');
  if (offlineConsumers.has(file)) {
    assert.match(contents, /decision_chain\//, file + ' must project the canonical chain');
    assert.doesNotMatch(contents, /\bfetch\(|process\.env|Math\.random\(|Date\.now\(|new WebSocket\(|SUPABASE_|ANTHROPIC_|OPENAI_/, file);
  } else {
    assert.doesNotMatch(contents, /decision_chain\//,
      file + ' imports CHAIN-0 outside the audited offline boundary');
  }
}

// --- 11. Static guards on source and documentation.
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
