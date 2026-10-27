// Local terminal view (backend/decision_chain/terminal_view.ts): a read-only
// projection of a CHAIN-0 outcome. It must copy every stage state and
// reason code, classify each reason code, never report a stage that
// abstains as usable, and stay HOLD with execution forbidden on every path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const tv = await loadBackendModule('decision_chain/terminal_view.ts');
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

// --- Every classified code has a plain-French meaning, and nothing else does.
assert.deepEqual(Object.keys(tv.REASON_CODE_PLAIN_FR).sort(), [...classified].sort());
for (const [code, text] of Object.entries(tv.REASON_CODE_PLAIN_FR)) {
  assert.match(text, /^[A-ZÀ-Ý].{10,}\.$/u, `${code}: one sentence`);
  assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z]/, `${code}: no raw code in the plain text`);
  // The plain text never promises a trade or a direction.
  assert.doesNotMatch(text, /\b(achat|vente|acheter|vendre|BUY|SELL|haussier|baissier)\b/i, code);
}
assert.deepEqual(Object.keys(tv.BLOCKER_CATEGORY_PLAIN_FR).sort(), [...CATEGORIES].sort());
console.log(`PASS ${classified.length} reason codes have a plain-French meaning`);

// --- Golden view: a faithful copy of the chain.
const outcome = chain.evaluateDecisionChain(golden.input, golden.knowledgeCutoff);
assert.equal(outcome.kind, 'COMPLETED');
const digest = await chain.computeDecisionChainDigest(outcome.result);
const view = tv.buildTerminalView(outcome, digest, ORIGIN, AT);
assert.equal(view.schemaVersion, 'xau.terminal-local-view.v4');
assert.equal(view.algorithmVersion, 'terminal-local-view-4.12.0');
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
  assert.ok(stage.reasons.every((r) => r.plain === tv.REASON_CODE_PLAIN_FR[r.code]), entry.stage);
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
// B5: no freshness policy approved, so the evidence is kept but abstains; its age is shown, not judged.
// 4.6.0: the kept evidence itself, as raw facts (the golden fixture's one synthetic tuple).
assert.deepEqual(view.positioning, { evidenceState: 'ABSTAIN', positioningState: 'UNAVAILABLE',
  evidenceCount: 1, sourceAuthorities: ['authority_test'], observedThrough: '2026-09-30T19:31:00.000Z',
  evidence: [{ sourceAuthority: 'authority_test', datasetCode: 'weekly_positions', instrumentCode: 'GC', metricCode: 'managed_money_net',
    value: 12345, unit: 'CONTRACTS', periodEnd: '2026-09-29', publishedAt: '2026-09-30T19:30:00.000Z', observedAt: '2026-09-30T19:31:00.000Z',
    afterCutoff: false }],
  evidenceTruncated: false,
  freshness: { status: 'NOT_EVALUATED', reason: 'FRESHNESS_POLICY_NOT_APPROVED', plain: 'fraîcheur non évaluée — aucun seuil approuvé',
    latestPublishedAt: '2026-09-30T19:30:00.000Z', publishedAgeSecondsAtCutoff: 67500 } });
assert.deepEqual(view.horizons, ['H1', 'H2', 'H3', 'H4', 'H5'].map((horizon) =>
  ({ horizon, status: 'ABSTAIN', direction: 'UNAVAILABLE' })));
const acceptance = await loadBackendModule('acceptance_engine/contract.ts');
assert.deepEqual(view.acceptance, { state: 'NOT_ACCEPTED', productionReadiness: 'HOLD',
  evidence: acceptance.ACCEPTANCE_EVIDENCE_KEYS.map((key) => ({ key, declared: false })) });
assert.deepEqual(view.observability, { state: 'CONTRACT_ONLY', correlationId: null, deploymentId: null });
console.log('PASS golden view copies every stage state, reason and market field');

// --- Temporal class: the existing XAUUSD LIVE window, not a new threshold.
assert.equal(tv.TERMINAL_VIEW_CURRENT_WINDOW_SECONDS, 360);
assert.deepEqual(view.temporal, { classification: 'HISTORICAL', cutoffAgeSeconds: 1104300, currentWindowSeconds: 360 });
const at = (generated) => tv.buildTerminalView(outcome, digest, ORIGIN, generated).temporal;
assert.equal(at('2026-10-01T14:21:00.000Z').classification, 'AT_GENERATION', '360 s: still current');
assert.equal(at('2026-10-01T14:21:01.000Z').classification, 'HISTORICAL', '361 s: historical');
assert.deepEqual(at('2026-10-01T14:15:00.000Z'), { classification: 'AT_GENERATION', cutoffAgeSeconds: 0, currentWindowSeconds: 360 });
assert.equal(at('not a time').classification, 'UNKNOWN');
assert.equal(at('not a time').cutoffAgeSeconds, null);
// A cutoff AFTER generation is impossible: never a negative age, never "at generation".
for (const early of ['2026-10-01T14:14:59.999Z', '2026-10-01T14:14:59.000Z', '2026-10-01T14:00:00.000Z', '2026-09-01T00:00:00.000Z']) {
  assert.deepEqual(at(early), { classification: 'UNKNOWN', cutoffAgeSeconds: null, currentWindowSeconds: 360 }, `generated ${early} before the cutoff`);
}
console.log('PASS temporal class: HISTORICAL beyond the XAUUSD LIVE window, UNKNOWN when unreadable or when the cutoff is in the future');

// --- Why HOLD: root causes are the non-upstream reasons, grouped, in stage order.
const why = view.holdRationale;
assert.equal(why.firstBlockedStage, 'POSITIONING'); // B5: positioning abstains first
assert.deepEqual(why.rootCauses.map((c) => c.category), ['DATA', 'BUSINESS_DECISION', 'AUTHORIZATION', 'ENVIRONMENT']);
const upstream = view.stages.flatMap((st) => st.reasons).filter((r) => r.category === 'UPSTREAM').length;
assert.equal(why.inheritedReasonCount, upstream);
const rooted = new Set(why.rootCauses.flatMap((c) => c.codes));
for (const st of view.stages) {
  for (const r of st.reasons) {
    if (r.category !== 'UPSTREAM') {
      assert.ok(rooted.has(r.code), r.code);
      assert.ok(why.rootCauses.find((c) => c.category === r.category).stages.includes(st.stage), `${r.code} ${st.stage}`);
    }
  }
}
for (const c of why.rootCauses) assert.equal(new Set(c.codes).size, c.codes.length, `${c.category} codes distinct`);
assert.ok(why.rootCauses.find((c) => c.category === 'AUTHORIZATION').codes.includes('EXECUTION_NOT_AUTHORIZED'));
assert.deepEqual(why.unclassifiedCodes, []);
for (const c of why.rootCauses) {
  assert.deepEqual(c.reasons, c.codes.map((code) => ({ code, plain: tv.REASON_CODE_PLAIN_FR[code] })), c.category);
}
console.log('PASS HOLD rationale: first blocking stage, root causes by category, inherited reasons counted');

// --- Decision summary: state, main reasons, missing data, blocking dependencies.
const summary = view.summary;
assert.equal(summary.decision, 'HOLD');
assert.equal(summary.execution, 'FORBIDDEN');
assert.equal(summary.status, 'BLOCKED');
assert.equal(summary.stageCount, 12);
assert.equal(summary.blockedStageCount, view.stages.filter((st) => st.capability === 'BLOCKED').length);
assert.equal(summary.headline,
  `HOLD : ${summary.blockedStageCount} étage(s) sur 12 bloqué(s), le premier à POSITIONING. Aucune décision positive n'est approuvée.`);
// Main reasons: every root-cause category once, most codes first.
assert.deepEqual(summary.mainReasons.map((r) => r.category).sort(), why.rootCauses.map((c) => c.category).sort());
for (const r of summary.mainReasons) {
  assert.equal(r.count, why.rootCauses.find((c) => c.category === r.category).codes.length, r.category);
  assert.equal(r.plain, tv.BLOCKER_CATEGORY_PLAIN_FR[r.category]);
}
assert.ok(summary.mainReasons.every((r, i, all) => i === 0 || all[i - 1].count >= r.count), 'sorted by count');
// Missing data: market fields not fresh at the cutoff, then DATA reasons (optional-field codes not repeated).
assert.deepEqual(summary.missingData, [
  { kind: 'MARKET_FIELD', code: 'dxy', plain: 'DXY indisponible au cutoff.' },
  { kind: 'DATA_REASON', code: 'EVIDENCE_GRAPH_UNAVAILABLE', plain: tv.REASON_CODE_PLAIN_FR.EVIDENCE_GRAPH_UNAVAILABLE },
]);
// Blocking dependencies: every approval, authorization and environment root cause, with its stages.
const dependencyCodes = why.rootCauses.filter((c) => ['BUSINESS_DECISION', 'AUTHORIZATION', 'ENVIRONMENT'].includes(c.category))
  .flatMap((c) => c.codes);
assert.deepEqual(summary.blockingDependencies.map((d) => d.code), dependencyCodes);
for (const dep of summary.blockingDependencies) {
  assert.equal(dep.category, tv.REASON_CODE_CATEGORY[dep.code], dep.code);
  assert.equal(dep.plain, tv.REASON_CODE_PLAIN_FR[dep.code], dep.code);
  assert.deepEqual(dep.stages, view.stages.filter((st) => st.reasons.some((r) => r.code === dep.code)).map((st) => st.stage));
  assert.ok(dep.stages.length > 0, dep.code);
}
assert.ok(summary.blockingDependencies.some((d) => d.code === 'EXECUTION_NOT_AUTHORIZED' && d.stages.includes('ACTION')));
assert.equal(summary.missingAcceptanceEvidence, 11);
console.log('PASS decision summary: HOLD, main reasons by weight, missing data, blocking dependencies with stages');

// --- Degraded inputs: the summary names what is missing.
const degradedInput = structuredClone(golden.input);
for (const field of ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti']) {
  degradedInput.marketSnapshot[field] = { value: null, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null };
}
Object.assign(degradedInput.marketSnapshot, { available: false, reason: 'outage', capturedAt: null });
const degraded = tv.buildTerminalView(chain.evaluateDecisionChain(degradedInput, golden.knowledgeCutoff), null, ORIGIN, AT);
assert.equal(degraded.summary.status, 'BLOCKED');
assert.ok(degraded.summary.missingData.filter((m) => m.kind === 'MARKET_FIELD').length === 8, 'every field listed');
assert.ok(degraded.summary.missingData.some((m) => m.code === 'SOURCE_SNAPSHOT_UNAVAILABLE'));
assert.equal(degraded.holdRationale.firstBlockedStage, 'MARKET_PRICING');
assert.match(degraded.summary.headline, /le premier à MARKET PRICING\./);
const staleView = tv.buildTerminalView(chain.evaluateDecisionChain(golden.input, '2026-10-08T14:15:00.000Z'), null, ORIGIN, AT);
assert.ok(staleView.summary.missingData.filter((m) => m.kind === 'MARKET_FIELD').every((m) => /(périmé|indisponible) au cutoff\.$/.test(m.plain)));
assert.ok(staleView.summary.missingData.some((m) => m.code === 'spot'), 'a stale spot is missing data');
console.log('PASS degraded inputs: unavailable and stale market fields are listed as missing data');

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
  assert.deepEqual(rv.horizons, []);
  assert.deepEqual(rv.acceptance.evidence, []);
  assert.deepEqual(rv.holdRationale, { firstBlockedStage: null, rootCauses: [], inheritedReasonCount: 0, unclassifiedCodes: [] });
  assert.equal(rv.summary.status, 'INPUT_REJECTED');
  assert.equal(rv.summary.decision, 'HOLD');
  assert.equal(rv.summary.execution, 'FORBIDDEN');
  assert.deepEqual(rv.summary.missingData.map((m) => m.code), rv.chain.rejection.inputErrors);
  assert.ok(rv.summary.missingData.every((m) => m.kind === 'INPUT_ERROR'));
  assert.deepEqual([rv.summary.mainReasons, rv.summary.blockingDependencies], [[], []]);
  assert.equal(rv.temporal.classification, 'UNKNOWN');
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
assert.equal(violated.summary.status, 'INTEGRITY_VIOLATED');
assert.match(violated.summary.headline, /incohérence interne/);
console.log('PASS a violated chain marks the offending stage BLOCKED with an INTEGRITY blocker');

// --- A fingerprint is displayed only with the right shape and for a consistent chain.
for (const bad of ['<script>alert(1)</script>', 'sha256:XYZ', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `md5:${'a'.repeat(64)}`,
  '', ' ', `${digest} `, 7, {}, [digest], true]) {
  assert.equal(tv.buildTerminalView(outcome, bad, ORIGIN, AT).chain.digest, null, `fingerprint ${JSON.stringify(bad)} is not shown`);
}
assert.equal(tv.buildTerminalView(outcome, digest, ORIGIN, AT).chain.digest, digest, 'a well-formed fingerprint on a consistent chain is shown');
assert.equal(tv.buildTerminalView({ kind: 'COMPLETED', result: { ...tampered, integrity: 'VIOLATED', violations } }, digest, ORIGIN, AT).chain.digest,
  null, 'a violated chain never carries a fingerprint, even a well-formed one');
console.log('PASS the terminal shows a fingerprint only when well-formed and for a consistent chain');

// --- An unknown reason code is shown unclassified, never dropped.
const odd = structuredClone(outcome.result);
odd.trace[0].reasonCodes = [...odd.trace[0].reasonCodes, 'NEW_CODE'];
const oddView = tv.buildTerminalView({ kind: 'COMPLETED', result: odd }, null, ORIGIN, AT);
assert.deepEqual(oddView.stages[0].reasons.at(-1), { code: 'NEW_CODE', category: null, plain: null });
assert.deepEqual(oddView.holdRationale.unclassifiedCodes, ['NEW_CODE']);
console.log('PASS an unclassified reason code stays visible with a null category');

// --- A market value observed after the cutoff (an input document from the future): MP-0 abstains, and the view
// never shows that value as known, let alone fresh, at the cutoff (view 4.11.0).
{
  const doc = structuredClone(golden.input);
  const future = new Date(Date.parse(golden.knowledgeCutoff) + 3_600_000).toISOString();
  doc.marketSnapshot.spot = { ...doc.marketSnapshot.spot, observedAt: future, value: 4444 };
  doc.marketSnapshot.capturedAt = future;
  doc.marketSnapshot.vix = { ...doc.marketSnapshot.vix, observedAt: golden.knowledgeCutoff };
  const out = chain.evaluateDecisionChain(doc, golden.knowledgeCutoff);
  assert.equal(out.result.stages.marketPricing.state, 'ABSTAIN');
  assert.ok(out.result.stages.marketPricing.reasonCodes.includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
  const v = tv.buildTerminalView(out, await chain.computeDecisionChainDigest(out.result), ORIGIN, AT);
  assert.deepEqual([v.chain.chainState, v.chain.execution], ['HOLD', 'FORBIDDEN']);
  const spot = v.market.fields.find((f) => f.field === 'spot');
  assert.deepEqual(spot, { field: 'spot', role: 'REQUIRED', value: null, statusAtCutoff: 'OBSERVED_AFTER_CUTOFF', observedAt: future,
    ageSecondsAtCutoff: null, source: spot.source }, 'unknown at the cutoff: no value, no age, never LIVE');
  assert.ok(!JSON.stringify(v).includes('4444'), 'the future value appears nowhere in the view');
  // Observed exactly at the cutoff is known at the cutoff.
  assert.notEqual(v.market.fields.find((f) => f.field === 'vix').statusAtCutoff, 'OBSERVED_AFTER_CUTOFF');
  assert.ok(v.summary.missingData.some((m) => m.code === 'spot' && /observé après le cutoff/.test(m.plain)));
}
console.log('PASS a market value observed after the cutoff is never shown as known at the cutoff');

// --- A market value whose observation time is unreadable (impossible date, `-00:00`): MP-0 rejects the field
// (INVALID_FIELD_CONTRACT), so nothing shows it was known at the cutoff. Up to 4.11.0 the view kept the value and the
// declared LIVE status, and the page showed it « FRAIS AU CUTOFF » (view 4.12.0).
for (const observedAt of ['2026-02-30T00:00:00Z', new Date(Date.parse(golden.knowledgeCutoff) + 3_600_000).toISOString().replace('Z', '-00:00')]) {
  const doc = structuredClone(golden.input);
  doc.marketSnapshot.spot = { ...doc.marketSnapshot.spot, observedAt, value: 4444 };
  const out = chain.evaluateDecisionChain(doc, golden.knowledgeCutoff);
  assert.equal(out.kind, 'COMPLETED', observedAt);
  assert.ok(out.result.stages.marketPricing.reasonCodes.includes('INVALID_FIELD_CONTRACT'), observedAt);
  const v = tv.buildTerminalView(out, await chain.computeDecisionChainDigest(out.result), ORIGIN, AT);
  assert.deepEqual([v.chain.chainState, v.chain.execution], ['HOLD', 'FORBIDDEN']);
  const spot = v.market.fields.find((f) => f.field === 'spot');
  assert.deepEqual(spot, { field: 'spot', role: 'REQUIRED', value: null, statusAtCutoff: 'OBSERVATION_TIME_INVALID', observedAt,
    ageSecondsAtCutoff: null, source: spot.source }, observedAt);
  assert.ok(!JSON.stringify(v).includes('4444'), `${observedAt}: the value appears nowhere in the view`);
  assert.ok(v.summary.missingData.some((m) => m.code === 'spot' && /date d'observation illisible/.test(m.plain)), observedAt);
}
{
  // Readable times keep their 4.11.0 treatment, to the nanosecond.
  const at = (observedAt) => {
    const doc = structuredClone(golden.input);
    doc.marketSnapshot.vix = { ...doc.marketSnapshot.vix, observedAt };
    const out = chain.evaluateDecisionChain(doc, golden.knowledgeCutoff);
    return tv.buildTerminalView(out, null, ORIGIN, AT).market.fields.find((f) => f.field === 'vix');
  };
  const cutoffNs = golden.knowledgeCutoff.replace(/(\.\d{3})?Z$/, (m, f) => `${f ?? '.000'}000000Z`);
  assert.notEqual(at(cutoffNs).value, null, 'observed exactly at the cutoff: known');
  assert.equal(at(cutoffNs.replace(/0Z$/, '1Z')).statusAtCutoff, 'OBSERVED_AFTER_CUTOFF', 'one nanosecond later: not known');
}
console.log('PASS a market value with an unreadable observation time is never shown (view 4.12.0)');
