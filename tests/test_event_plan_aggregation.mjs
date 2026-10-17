// EIA-0 (backend/event_aggregation/contract.ts): per-event Event Impact and
// Gold Transmission plans -> the chain-level summary S-0 consumes. Plans are
// produced by the real processors. Only "every admitted plan insufficient"
// yields INSUFFICIENT_EVIDENCE; every other set is UNAVAILABLE with a reason,
// and the summary is never ASSESSED.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const eia = await loadBackendModule('event_aggregation/contract.ts');
const ei = await loadBackendModule('event_impact/deterministic_processor.ts');
const gt = await loadBackendModule('gold_transmission/deterministic_processor.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));

const CUTOFF = golden.knowledgeCutoff; // 2026-10-01T14:15:00.000Z
const id = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const eventVersion = (n, knowledgeCutoff = '2026-09-22T00:00:00.123456+00:00', overrides = {}) => ({
  id: id(n), clusterId: '22222222-2222-4222-8222-222222222222', versionNumber: 1, transitionType: 'NOVELTY',
  knowledgeCutoff, effectiveTime: null, effectiveTimePrecision: null, canonicalEventStateSchemaVersion: 1,
  canonicalEventState: { event_type: 'MONETARY_POLICY_COMMUNICATION', subject: 'Federal Reserve issues FOMC statement',
    detail: 'The Committee maintained the target range.' },
  officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
  supersedesVersionId: null, stateFingerprint: 'a'.repeat(64), ...overrides,
});
const eiPlan = (...args) => ei.planDeterministicEventImpact({ eventVersion: eventVersion(...args) });
const gtPlan = (...args) => gt.planDeterministicGoldTransmission({ eventVersion: eventVersion(...args) });

const p1 = eiPlan(1);
const p2 = eiPlan(2, '2026-10-01T14:15:00Z');
assert.equal(p1.kind, 'PROCESS');
assert.equal(p1.assessmentStatus, 'INSUFFICIENT_EVIDENCE');

// --- The decided case.
let out = eia.aggregateEventPlans('EVENT_IMPACT', [p2, p1], CUTOFF);
assert.equal(out.schemaVersion, 'xau.event-plan-aggregation.v1');
assert.equal(out.algorithmVersion, 'event-plan-aggregation-gate-1.0.0');
assert.deepEqual(out.summary, { algorithmVersion: 'event-impact-deterministic-processor-v5',
  status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: CUTOFF });
assert.deepEqual(out.reasonCodes, ['ALL_EVENTS_INSUFFICIENT']);
assert.deepEqual(out.eventVersionIds, [id(1), id(2)]);
assert.deepEqual(out.counts, { received: 2, admitted: 2, excludedAfterCutoff: 0, insufficient: 2, unavailable: 0, assessed: 0, rejected: 0 });
assert.deepEqual(eia.aggregateEventPlans('EVENT_IMPACT', [p1, p2], CUTOFF), out, 'order-independent');
const g = eia.aggregateEventPlans('GOLD_TRANSMISSION', [gtPlan(1), gtPlan(2)], CUTOFF);
assert.deepEqual(g.summary, { algorithmVersion: 'gold-transmission-deterministic-processor-v5',
  status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: CUTOFF });
console.log('PASS all-insufficient plan sets aggregate to INSUFFICIENT_EVIDENCE, order-independent');

// --- The summary feeds CHAIN-0 exactly like the golden summary.
const input = { ...structuredClone(golden.input), eventImpact: out.summary, goldTransmission: g.summary };
const digest = await chain.computeDecisionChainDigest(chain.evaluateDecisionChain(input, CUTOFF).result);
assert.equal(digest, 'sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7');
console.log('PASS aggregated summaries reproduce the golden CHAIN-0 digest');

// --- Every other set is UNAVAILABLE, with the reason.
const unavailable = (plans, reason, kind = 'EVENT_IMPACT', cutoff = CUTOFF) => {
  const result = eia.aggregateEventPlans(kind, plans, cutoff);
  assert.equal(result.summary.status, 'UNAVAILABLE', reason);
  assert.ok(result.reasonCodes.includes(reason), `${reason}: ${result.reasonCodes}`);
  assert.ok(!result.reasonCodes.includes('ALL_EVENTS_INSUFFICIENT'), reason);
  return result;
};
unavailable([], 'NO_EVENT_PLANS');
unavailable(null, 'INVALID_PLAN_SET');
unavailable({ 0: p1 }, 'INVALID_PLAN_SET');
unavailable([p1, null], 'INVALID_EVENT_PLAN');
unavailable([p1, { ...p1, kind: 'MAYBE' }], 'INVALID_EVENT_PLAN');
unavailable([p1, { ...p2, eventVersionId: '' }], 'INVALID_EVENT_PLAN');
unavailable([p1, { ...p2, knowledgeCutoff: '2026-02-30T00:00:00Z' }], 'INVALID_EVENT_PLAN');
unavailable([p1, { ...p2, assessmentStatus: 'BULLISH' }], 'INVALID_EVENT_PLAN');
unavailable([gtPlan(1), { ...gtPlan(2), assessmentStatus: 'ASSESSED' }], 'INVALID_EVENT_PLAN', 'GOLD_TRANSMISSION');
const abstain = ei.planDeterministicEventImpact({ eventVersion: { id: id(3) } });
assert.equal(abstain.kind, 'ABSTAIN');
unavailable([p1, abstain], 'EVENT_PLAN_ABSTAINED');
unavailable([p1, { ...p2, processorVersion: 'event-impact-deterministic-processor-v4' }], 'EVENT_PLAN_VERSION_MISMATCH');
unavailable([p1, { ...p2, algorithmVersion: 'event-impact-deterministic-processor-v6' }], 'EVENT_PLAN_VERSION_MISMATCH');
unavailable([gtPlan(1)], 'EVENT_PLAN_VERSION_MISMATCH', 'EVENT_IMPACT');
unavailable([p1, eiPlan(1, '2026-09-23T00:00:00Z')], 'DUPLICATE_EVENT_VERSION');
unavailable([p1, { ...p2, assessmentStatus: 'UNAVAILABLE' }], 'EVENT_PLAN_UNAVAILABLE');
const assessed = unavailable([p1, { ...p2, assessmentStatus: 'ASSESSED' }], 'AGGREGATION_RULE_NOT_APPROVED');
assert.equal(assessed.counts.assessed, 1);
unavailable([{ ...p1, assessmentStatus: 'ASSESSED' }, { ...p2, assessmentStatus: 'ASSESSED' }], 'AGGREGATION_RULE_NOT_APPROVED');
for (const cutoff of [undefined, 42, '', '2026-10-01T14:15:00', '2026-02-30T00:00:00Z']) {
  const result = eia.aggregateEventPlans('EVENT_IMPACT', [p1], cutoff);
  assert.equal(result.summary.status, 'UNAVAILABLE', String(cutoff));
  assert.deepEqual(result.reasonCodes, ['INVALID_KNOWLEDGE_CUTOFF'], String(cutoff));
  assert.equal(result.summary.knowledgeCutoff, typeof cutoff === 'string' ? cutoff : '');
}
console.log('PASS every non-decided set is UNAVAILABLE with its reason; ASSESSED is never aggregated');

// --- No lookahead: a plan known after the cutoff is excluded, to the microsecond.
out = eia.aggregateEventPlans('EVENT_IMPACT', [p1, eiPlan(4, '2026-10-01T14:15:00.000001Z')], CUTOFF);
assert.equal(out.summary.status, 'INSUFFICIENT_EVIDENCE');
assert.deepEqual(out.reasonCodes, ['EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'ALL_EVENTS_INSUFFICIENT']);
assert.deepEqual(out.eventVersionIds, [id(1)]);
assert.equal(out.counts.excludedAfterCutoff, 1);
// A future ASSESSED plan cannot block or unblock anything at this cutoff.
out = eia.aggregateEventPlans('EVENT_IMPACT', [p1, { ...eiPlan(5, '2026-10-02T00:00:00Z'), assessmentStatus: 'ASSESSED' }], CUTOFF);
assert.equal(out.summary.status, 'INSUFFICIENT_EVIDENCE');
unavailable([eiPlan(4, '2026-10-01T14:15:00.000001Z')], 'NO_EVENT_PLANS');
console.log('PASS plans known after the cutoff are excluded, to the microsecond');

// --- Never throws, never ASSESSED.
const hostile = [undefined, 0, 'x', [], {}, [[]], [{}], [{ kind: 'PROCESS' }], [Object.create(null)],
  [{ get kind() { return 'PROCESS'; }, processorVersion: ei.EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION }]];
for (const plans of hostile) {
  for (const kind of ['EVENT_IMPACT', 'GOLD_TRANSMISSION']) {
    const result = eia.aggregateEventPlans(kind, plans, CUTOFF);
    assert.equal(result.summary.status, 'UNAVAILABLE');
  }
}
const source = readFileSync(new URL('../backend/event_aggregation/contract.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /status: 'ASSESSED'|fetch\(|process\.env|Date\.now\(|new Date\(|Math\.random\(/);
console.log(`PASS ${hostile.length * 2} hostile plan sets degrade to UNAVAILABLE without throwing`);

// ===== EIA-0 v2 (B3): the same aggregation, plus required official-release evidence per event version.
// v1 above is unchanged; v2 is a separate, versioned contract. A plan whose cutoff precedes its
// event's official publication instant is excluded; an admitted plan without valid evidence blocks.
const instant = await loadBackendModule('event_facts/official_release_instant.ts');
const eia2 = await loadBackendModule('event_aggregation/release_gate_contract.ts');
assert.equal(eia.EVENT_AGGREGATION_SCHEMA_VERSION, 'xau.event-plan-aggregation.v1', 'v1 identity kept');
assert.equal(eia.EVENT_AGGREGATION_ALGORITHM_VERSION, 'event-plan-aggregation-gate-1.0.0', 'v1 identity kept');
assert.equal(eia2.EVENT_AGGREGATION_V2_SCHEMA_VERSION, 'xau.event-plan-aggregation.v2');
assert.equal(eia2.EVENT_AGGREGATION_V2_ALGORITHM_VERSION, 'event-plan-aggregation-release-gate-2.0.0');
const v2 = (plans, releases, kind = 'EVENT_IMPACT', cutoff = CUTOFF) =>
  eia2.aggregateEventPlansWithOfficialRelease(kind, plans, releases, cutoff);
const release = (n, publishedAt) => ({ eventVersionId: id(n), publishedAt });
const okReleases = [release(1, '2026-09-21T12:30:00.000Z'), release(2, '2026-10-01T14:15:00.000Z')];

// Decided case: same S-0 summary as v1, so CHAIN-0 and its golden digest are unaffected.
let r = v2([p2, p1], okReleases);
assert.equal(r.schemaVersion, 'xau.event-plan-aggregation.v2');
assert.equal(r.algorithmVersion, 'event-plan-aggregation-release-gate-2.0.0');
assert.equal(r.releaseEvidence, 'REQUIRED');
assert.deepEqual(r.summary, eia.aggregateEventPlans('EVENT_IMPACT', [p1, p2], CUTOFF).summary);
assert.deepEqual(r.reasonCodes, ['ALL_EVENTS_INSUFFICIENT']);
assert.deepEqual(r.eventVersionIds, [id(1), id(2)]);
assert.deepEqual(r.counts, { received: 2, admitted: 2, excludedAfterCutoff: 0, excludedBeforeOfficialRelease: 0,
  missingReleaseInstant: 0, releasesUnused: 0, insufficient: 2, unavailable: 0, assessed: 0, rejected: 0 });
assert.deepEqual(v2([p1, p2], [...okReleases].reverse()), r, 'order-independent (plans and evidence)');
const v2Digest = await chain.computeDecisionChainDigest(chain.evaluateDecisionChain(
  { ...structuredClone(golden.input), eventImpact: r.summary,
    goldTransmission: v2([gtPlan(1), gtPlan(2)], okReleases, 'GOLD_TRANSMISSION').summary }, CUTOFF).result);
assert.equal(v2Digest, 'sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7', 'golden digest unchanged');
console.log('PASS EIA-0 v2: with valid release evidence the summary equals v1 and keeps the golden CHAIN-0 digest');

// Back-dated, equal, later: the comparison is exact to the nanosecond, across offsets.
const cpiAt = '2026-09-11T12:30:00.000Z';
const cpiPlan = (cutoff) => eiPlan(5, cutoff);
const atCpi = (cutoff) => v2([p1, cpiPlan(cutoff)], [okReleases[0], release(5, cpiAt)]);
r = atCpi('2026-09-01T00:00:00Z');
assert.equal(r.summary.status, 'INSUFFICIENT_EVIDENCE', 'the other event still aggregates');
assert.deepEqual(r.reasonCodes, ['EVENT_PLAN_BEFORE_OFFICIAL_RELEASE', 'ALL_EVENTS_INSUFFICIENT']);
assert.deepEqual(r.eventVersionIds, [id(1)], 'back-dated CPI excluded');
assert.equal(r.counts.excludedBeforeOfficialRelease, 1);
assert.deepEqual(atCpi('2026-09-11T12:29:59.999999999Z').eventVersionIds, [id(1)], '1 ns before: excluded');
assert.deepEqual(atCpi('2026-09-11T08:29:59.999999999-04:00').eventVersionIds, [id(1)], 'offset form, 1 ns before');
assert.deepEqual(atCpi('2026-09-11T12:30:00Z').eventVersionIds, [id(1), id(5)].sort(), 'equal: admitted');
assert.deepEqual(atCpi('2026-09-11T08:30:00-04:00').eventVersionIds, [id(1), id(5)].sort(), 'equal in offset form');
assert.deepEqual(atCpi('2026-09-22T00:00:00Z').eventVersionIds, [id(1), id(5)].sort(), 'later: admitted');
r = v2([cpiPlan('2026-09-01T00:00:00Z')], [release(5, cpiAt)]);
assert.equal(r.summary.status, 'UNAVAILABLE');
assert.deepEqual(r.reasonCodes, ['NO_EVENT_PLANS', 'EVENT_PLAN_BEFORE_OFFICIAL_RELEASE']);
// The v1 contract, unchanged, still admits the back-dated plan: the protection lives in v2 only.
assert.equal(eia.aggregateEventPlans('EVENT_IMPACT', [cpiPlan('2026-09-01T00:00:00Z')], CUTOFF).counts.admitted, 1);
console.log('PASS EIA-0 v2 excludes a plan known before its official release, exactly at the instant');

// DST: the instant comes from the official text; an EDT assumption in winter would admit too early.
for (const [raw, early, exact] of [
  ['8:30 a.m. (ET) Friday, March 6, 2026', '2026-03-06T12:30:00Z', '2026-03-06T13:30:00Z'],
  ['8:30 a.m. (ET) Thursday, March 12, 2026', '2026-03-12T12:29:59.999Z', '2026-03-12T12:30:00Z'],
  ['8:30 a.m. (ET) Friday, October 30, 2026', '2026-10-30T12:29:59.999Z', '2026-10-30T12:30:00Z'],
  ['8:30 a.m. (ET) Friday, November 6, 2026', '2026-11-06T12:30:00Z', '2026-11-06T13:30:00Z'],
]) {
  const publishedAt = instant.parseOfficialReleaseInstant(raw);
  const late = '2026-12-31T00:00:00.000Z';
  assert.equal(v2([eiPlan(6, early)], [release(6, publishedAt)], 'EVENT_IMPACT', late).counts.excludedBeforeOfficialRelease, 1, raw);
  assert.equal(v2([eiPlan(6, exact)], [release(6, publishedAt)], 'EVENT_IMPACT', late).counts.admitted, 1, raw);
}
console.log('PASS EIA-0 v2 applies the daylight-saving instants of the official texts');

// Fail-closed: evidence required but missing or invalid makes the summary UNAVAILABLE.
const blocked = (plans, releases, reason, kind = 'EVENT_IMPACT') => {
  const out2 = v2(plans, releases, kind);
  assert.equal(out2.summary.status, 'UNAVAILABLE', reason);
  assert.ok(out2.reasonCodes.includes(reason), `${reason}: ${out2.reasonCodes}`);
  assert.ok(!out2.reasonCodes.includes('ALL_EVENTS_INSUFFICIENT'), reason);
  return out2;
};
assert.equal(blocked([p1, p2], [okReleases[0]], 'RELEASE_INSTANT_MISSING').counts.missingReleaseInstant, 1);
blocked([p1, p2], [], 'RELEASE_INSTANT_MISSING');
for (const bad of [undefined, null, {}, 'x', { 0: okReleases[0] }]) blocked([p1, p2], bad, 'INVALID_RELEASE_SET');
for (const entry of [
  null, [], 'x', {}, { eventVersionId: id(2) }, { publishedAt: '2026-10-01T14:15:00Z' },
  { eventVersionId: '', publishedAt: '2026-10-01T14:15:00Z' }, { eventVersionId: 7, publishedAt: '2026-10-01T14:15:00Z' },
  { eventVersionId: id(2), publishedAt: '2026-09-31T12:30:00Z' }, { eventVersionId: id(2), publishedAt: '2026-10-01' },
  { eventVersionId: id(2), publishedAt: 1_790_000_000_000 }, { eventVersionId: id(2), publishedAt: null },
  { eventVersionId: id(2), publishedAt: '2026-10-01T14:15:00Z', source: 'trust me' },
  { get eventVersionId() { throw new Error('hostile'); }, publishedAt: '2026-10-01T14:15:00Z' },
]) {
  blocked([p1, p2], [okReleases[0], entry], 'INVALID_RELEASE_SET');
}
blocked([p1, p2], [...okReleases, release(2, '2026-10-01T14:15:00.000Z')], 'INVALID_RELEASE_SET'); // duplicate, same instant
blocked([p1, p2], [...okReleases, release(2, '2026-09-01T00:00:00.000Z')], 'INVALID_RELEASE_SET'); // duplicate, conflicting
// Version inconsistencies are refused exactly as in v1.
blocked([gtPlan(1)], [release(1, '2026-09-21T12:30:00Z')], 'EVENT_PLAN_VERSION_MISMATCH');
blocked([p1, { ...p2, processorVersion: 'event-impact-deterministic-processor-v4' }], okReleases, 'EVENT_PLAN_VERSION_MISMATCH');
blocked([p1, { ...p2, algorithmVersion: 'event-impact-deterministic-processor-v6' }], okReleases, 'EVENT_PLAN_VERSION_MISMATCH');
blocked([p1, { ...p2, assessmentStatus: 'ASSESSED' }], okReleases, 'AGGREGATION_RULE_NOT_APPROVED');
// A plan known after the chain cutoff needs no evidence; unused evidence is counted, never trusted.
r = v2([p1, eiPlan(4, '2026-10-01T14:15:00.000001Z')], [okReleases[0]]);
assert.equal(r.summary.status, 'INSUFFICIENT_EVIDENCE');
assert.deepEqual(r.reasonCodes, ['EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'ALL_EVENTS_INSUFFICIENT']);
assert.equal(v2([p1], okReleases).counts.releasesUnused, 1);
for (const cutoff of [undefined, '', '2026-02-30T00:00:00Z']) {
  const out3 = eia2.aggregateEventPlansWithOfficialRelease('EVENT_IMPACT', [p1], okReleases, cutoff);
  assert.equal(out3.summary.status, 'UNAVAILABLE', String(cutoff));
  assert.ok(out3.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'), String(cutoff));
}
for (const plans of hostile) {
  for (const kind of ['EVENT_IMPACT', 'GOLD_TRANSMISSION']) assert.equal(v2(plans, okReleases, kind).summary.status, 'UNAVAILABLE');
}
const releasesBefore = JSON.stringify(okReleases);
v2([p1, p2], okReleases);
assert.equal(JSON.stringify(okReleases), releasesBefore, 'evidence not mutated');
assert.equal(eia.aggregateEventPlansWithOfficialRelease, undefined, 'v1 module exports no v2 entry point');
for (const file of ['core.ts', 'release_gate_contract.ts']) {
  const text = readFileSync(new URL(`../backend/event_aggregation/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(text, /status: 'ASSESSED'|fetch\(|process\.env|Date\.now\(|new Date\(|Math\.random\(/, file);
}
console.log('PASS EIA-0 v2 is fail-closed: missing, malformed, duplicate or hostile evidence and version drift are UNAVAILABLE');
