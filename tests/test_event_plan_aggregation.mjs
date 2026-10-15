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
