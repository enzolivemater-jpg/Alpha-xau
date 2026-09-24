import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';
import { planDeterministicEventImpact } from '../backend/event_impact/deterministic_processor.ts';
import { planDeterministicGoldTransmission } from '../backend/gold_transmission/deterministic_processor.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bls_cpi_table1_2026_08.json', import.meta.url), 'utf8'));
const mapped = mapBlsCpiReleaseToEventFacts(fixture);
assert.equal(mapped.kind, 'RESOLVED');

const base = {
  id: '11111111-1111-4111-8111-111111111111', clusterId: '22222222-2222-4222-8222-222222222222',
  versionNumber: 1, transitionType: 'NOVELTY', knowledgeCutoff: '2026-09-22T00:00:00.123456Z',
  effectiveTime: null, effectiveTimePrecision: null,
  canonicalEventStateSchemaVersion: mapped.canonicalEventStateSchemaVersion,
  canonicalEventState: mapped.canonicalEventState,
  officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
  supersedesVersionId: null, stateFingerprint: 'a'.repeat(64),
};
const run = eventVersion => ({
  impact: planDeterministicEventImpact({ eventVersion }),
  transmission: planDeterministicGoldTransmission({ eventVersion }),
});

const before = JSON.stringify(base);
const accepted = run(base);
assert.equal(accepted.impact.kind, 'PROCESS');
assert.equal(accepted.impact.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.deepEqual(accepted.impact.interpretations, []);
assert.equal(accepted.transmission.kind, 'PROCESS');
assert.equal(accepted.transmission.assessmentReason, 'CONSENSUS_FACTS_UNAVAILABLE');
assert.deepEqual(accepted.transmission.paths, []);
assert.equal(JSON.stringify(base), before);
console.log('PASS exact EF-2 adapter output is consumed conservatively by EI and GT');

for (const [label, mutate] of [
  ['unsupported family', state => { state.facts.release_family = 'US_NFP'; }],
  ['duplicate metric', state => { state.facts.metrics[1].metric_code = 'CPI_CORE_MOM'; }],
  ['non-canonical decimal', state => { state.facts.metrics[0].actual.value = '0.30'; }],
  ['invented consensus', state => { state.facts.metrics[0].consensus = { state: 'KNOWN', value: '0.2' }; }],
  ['invented prior', state => { state.facts.metrics[0].prior_periods = [{}]; }],
]) {
  const eventVersion = structuredClone(base);
  mutate(eventVersion.canonicalEventState);
  const rejected = run(eventVersion);
  assert.equal(rejected.impact.kind, 'ABSTAIN', `${label}: EI`);
  assert.equal(rejected.impact.reason, 'INVALID_CANONICAL_EVENT_STATE_V2', `${label}: EI reason`);
  assert.equal(rejected.transmission.kind, 'ABSTAIN', `${label}: GT`);
  assert.equal(rejected.transmission.reason, 'INVALID_CANONICAL_EVENT_STATE_V2', `${label}: GT reason`);
}
console.log('PASS EI and GT reject the same unsupported/malformed CES V2 corpus');

const future = run({ ...base, canonicalEventStateSchemaVersion: 3, canonicalEventState: { opaque: true } });
assert.equal(future.impact.assessmentReason, 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
assert.equal(future.transmission.assessmentReason, 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
console.log('PASS future schemas remain explicitly unavailable');
