// Local terminal view (backend/command_center/terminal_view.ts): a read-only
// projection of a CHAIN-0 outcome. It must copy every stage state and
// reason code, classify each reason code, never report a stage that
// abstains as usable, and stay HOLD with execution forbidden on every path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const tv = await loadBackendModule('command_center/terminal_view.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const ORIGIN = { kind: 'GOLDEN_FIXTURE', label: 'tests/fixtures/decision_chain_dry_run_baseline.json' };
const AT = '2026-10-14T09:00:00.000Z';

// --- Every reason code a chain gate can emit is classified, and nothing else.
const GATES = [
  ['market_engine/institutional_snapshot.ts', 'MarketPricingReasonCode'],
  ['positioning_engine/evidence_contract.ts', 'PositioningReasonCode'],
  ['regime_engine/contract.ts', 'RegimeReasonCode'],
  ['horizon_engine/contract.ts', 'HorizonReasonCode'],
  ['ai_engine/v2_committee_contract.ts', 'CommitteeGateReasonCode'],
  ['risk_engine/pre_pm_contract.ts', 'PrePmReasonCode'],
  ['portfolio_engine/contract.ts', 'PortfolioManagerReasonCode'],
  ['risk_engine/final_action_contract.ts', 'FinalActionRiskReasonCode'],
  ['action_engine/contract.ts', 'ActionReasonCode'],
  ['command_center/contract.ts', 'CommandCenterReasonCode'],
  ['alert_engine/contract.ts', 'AlertReasonCode'],
  ['acceptance_engine/contract.ts', 'AcceptanceReasonCode'],
];
assert.equal(GATES.length, chain.DECISION_CHAIN_STAGES.length);
const emitted = new Set();
for (const [file, type] of GATES) {
  const source = readFileSync(new URL(`../backend/${file}`, import.meta.url), 'utf8');
  const match = new RegExp(`type ${type}\\s*=([^;]+);`).exec(source);
  assert.ok(match, `${type} not found in ${file}`);
  const codes = [...match[1].matchAll(/'([A-Z0-9_]+)'/g)].map(([, code]) => code);
  assert.ok(codes.length > 0, type);
  for (const code of codes) emitted.add(code);
}
const classified = Object.keys(tv.REASON_CODE_CATEGORY);
assert.deepEqual([...emitted].filter((code) => !classified.includes(code)), [], 'unclassified gate reason codes');
assert.deepEqual(classified.filter((code) => !emitted.has(code)), [], 'classified codes no gate emits');
const CATEGORIES = ['DATA', 'UPSTREAM', 'INTEGRITY', 'BUSINESS_DECISION', 'AUTHORIZATION', 'ENVIRONMENT'];
for (const [code, category] of Object.entries(tv.REASON_CODE_CATEGORY)) assert.ok(CATEGORIES.includes(category), code);
// Name-implied categories cannot drift.
for (const code of classified) {
  if (/_NOT_AUTHORIZED$/.test(code)) assert.equal(tv.REASON_CODE_CATEGORY[code], 'AUTHORIZATION', code);
  if (/_(VERSION|CUTOFF)_MISMATCH$/.test(code)) assert.equal(tv.REASON_CODE_CATEGORY[code], 'INTEGRITY', code);
  if (/(METHOD|METHODOLOGY|POLICY)_NOT_APPROVED$/.test(code)) assert.equal(tv.REASON_CODE_CATEGORY[code], 'BUSINESS_DECISION', code);
}
console.log(`PASS ${emitted.size} gate reason codes classified exactly once (${GATES.length} gates)`);

// --- Golden view: a faithful copy of the chain.
const outcome = chain.evaluateDecisionChain(golden.input, golden.knowledgeCutoff);
assert.equal(outcome.kind, 'COMPLETED');
const digest = await chain.computeDecisionChainDigest(outcome.result);
const view = tv.buildTerminalView(outcome, digest, ORIGIN, AT);
assert.equal(view.schemaVersion, 'xau.terminal-local-view.v1');
assert.equal(view.simulated, true);
assert.equal(view.generatedAt, AT);
assert.deepEqual(view.origin, ORIGIN);
assert.equal(view.chain.chainState, 'HOLD');
assert.equal(view.chain.execution, 'FORBIDDEN');
assert.equal(view.chain.integrity, 'CONSISTENT');
assert.equal(view.chain.digest, digest);
assert.equal(view.chain.knowledgeCutoff, golden.knowledgeCutoff);
assert.deepEqual(view.stages.map((s) => s.stage), tv.TERMINAL_VIEW_STAGES);
outcome.result.trace.forEach((entry, i) => {
  const stage = view.stages[i];
  assert.equal(stage.state, entry.state, entry.stage);
  assert.deepEqual(stage.reasons.map((r) => r.code), entry.reasonCodes, entry.stage);
  assert.equal(stage.schemaVersion, entry.schemaVersion);
  assert.equal(stage.algorithmVersion, entry.algorithmVersion);
  assert.ok(stage.reasons.every((r) => r.category !== null), entry.stage);
});
const abstaining = ['ABSTAIN', 'HOLD', 'SUPPRESSED', 'NOT_ACCEPTED'];
for (const stage of view.stages) {
  if (abstaining.includes(stage.state)) {
    assert.equal(stage.capability, 'BLOCKED', stage.stage);
    assert.ok(stage.blockers.length > 0, `${stage.stage} blocked without a named blocker`);
  } else {
    assert.equal(stage.capability, 'SIMULATED', stage.stage);
  }
  assert.notEqual(stage.capability, 'OPERATIONAL_LOCAL', stage.stage);
}
assert.equal(view.market.state, 'DEGRADED');
assert.equal(view.market.fields.length, 8);
const spot = view.market.fields.find((f) => f.field === 'spot');
assert.deepEqual(spot, { field: 'spot', role: 'REQUIRED', value: 3900, statusAtCutoff: 'LIVE',
  observedAt: '2026-10-01T14:14:00.000Z', ageSecondsAtCutoff: 60, source: 'twelve_data' });
assert.equal(view.market.fields.find((f) => f.field === 'dxy').statusAtCutoff, 'UNAVAILABLE');
assert.deepEqual(view.market.replay, { mode: 'LATEST_ONLY', reproducible: false, reason: 'INGESTION_CUTOFF_NOT_AVAILABLE' });
assert.deepEqual(view.positioning, { evidenceState: 'EVIDENCE_READY', positioningState: 'UNAVAILABLE',
  evidenceCount: 1, sourceAuthorities: ['authority_test'], observedThrough: '2026-09-30T19:31:00.000Z' });
console.log('PASS golden view copies every stage state, reason and market field');

// --- Capability matrix.
const caps = Object.fromEntries(view.capabilities.map((c) => [c.id, c]));
assert.equal(view.capabilities.length, new Set(view.capabilities.map((c) => c.id)).size, 'duplicate capability id');
const STATUSES = ['OPERATIONAL_LOCAL', 'SIMULATED', 'BLOCKED', 'NOT_VALIDATED'];
for (const c of view.capabilities) {
  assert.ok(STATUSES.includes(c.status), c.id);
  assert.ok(typeof c.detail === 'string' && c.detail.length > 0, c.id);
  if (c.status !== 'OPERATIONAL_LOCAL') assert.ok(c.blockers.length > 0, `${c.id} ${c.status} without blocker`);
}
assert.deepEqual(view.capabilities.filter((c) => c.status === 'OPERATIONAL_LOCAL').map((c) => c.id),
  ['CHAIN_DRY_RUN', 'REPLAY_DIGEST', 'INTEGRITY_CHECK']);
for (const id of ['EXECUTION', 'ACTION', 'ALERTS', 'ACCEPTANCE', 'SCENARIO_TREE', 'AI_COMMITTEE',
  'PORTFOLIO_MANAGER', 'FINAL_ACTION_RISK', 'EVENT_IMPACT_GOLD_TRANSMISSION']) {
  assert.equal(caps[id].status, 'BLOCKED', id);
}
assert.ok(caps.EXECUTION.blockers.includes('AUTHORIZATION'));
assert.equal(caps.MARKET_PRICING.status, 'SIMULATED');
assert.equal(caps.LEGACY_V1_FEED.status, 'NOT_VALIDATED');
console.log('PASS capability matrix: only local tooling is operational, every other status names its blocker');

// --- The view is deterministic for a fixed generation time.
assert.deepEqual(tv.buildTerminalView(outcome, digest, ORIGIN, AT), view);
assert.equal(chain.canonicalJson(view), chain.canonicalJson(JSON.parse(JSON.stringify(view))), 'view is plain JSON');

// --- Rejected input: HOLD, no stage, every capability blocked.
for (const [input, cutoff] of [[undefined, undefined], [{ ...golden.input, extra: 1 }, golden.knowledgeCutoff],
  [golden.input, 42]]) {
  const rejected = chain.evaluateDecisionChain(input, cutoff);
  assert.equal(rejected.kind, 'REJECTED');
  const rv = tv.buildTerminalView(rejected, null, { kind: 'LOCAL_INPUT_FILE', label: 'x.json' }, AT);
  assert.equal(rv.chain.outcome, 'REJECTED');
  assert.equal(rv.chain.chainState, 'HOLD');
  assert.equal(rv.chain.execution, 'FORBIDDEN');
  assert.equal(rv.chain.digest, null);
  assert.equal(rv.chain.rejection.failedAt, 'INPUT');
  assert.ok(rv.chain.rejection.inputErrors.length > 0);
  assert.deepEqual(rv.stages, []);
  assert.deepEqual(rv.market.fields, []);
  assert.ok(rv.capabilities.every((c) => c.status === 'BLOCKED' || c.status === 'NOT_VALIDATED'), 'rejected view operational');
}
const unknownKey = tv.buildTerminalView(chain.evaluateDecisionChain({ ...golden.input, extra: 1 }, golden.knowledgeCutoff),
  null, ORIGIN, AT);
assert.ok(unknownKey.chain.rejection.inputErrors.includes('extra: UNKNOWN_KEY'));
console.log('PASS rejected inputs yield a HOLD view with no stage and no operational capability');

// --- Integrity violation: every stage blocked with INTEGRITY.
const tampered = structuredClone(outcome.result);
tampered.trace[2].state = 'READY_TO_TRADE';
const violations = chain.verifyDecisionChainIntegrity(tampered);
assert.ok(violations.length > 0);
const violated = tv.buildTerminalView({ kind: 'COMPLETED', result: { ...tampered, integrity: 'VIOLATED', violations } },
  null, ORIGIN, AT);
assert.equal(violated.chain.integrity, 'VIOLATED');
const regime = violated.stages.find((s) => s.stage === 'REGIME');
assert.equal(regime.capability, 'BLOCKED');
assert.ok(regime.blockers.includes('INTEGRITY'));
console.log('PASS a violated chain marks the offending stage BLOCKED with an INTEGRITY blocker');

// --- An unknown reason code is shown unclassified, never dropped.
const odd = structuredClone(outcome.result);
odd.trace[0].reasonCodes = [...odd.trace[0].reasonCodes, 'NEW_CODE'];
const oddView = tv.buildTerminalView({ kind: 'COMPLETED', result: odd }, null, ORIGIN, AT);
assert.deepEqual(oddView.stages[0].reasons.at(-1), { code: 'NEW_CODE', category: null });
console.log('PASS an unclassified reason code stays visible with a null category');
