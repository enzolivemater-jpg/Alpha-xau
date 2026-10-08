import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapBeaPceReleaseToEventFacts } from '../backend/event_facts/bea_pce_adapter.ts';
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';
import { mapBlsEmploymentReleaseToEventFacts } from '../backend/event_facts/bls_employment_situation_adapter.ts';
import { mapDolUiWeeklyClaimsReleaseToEventFacts } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import { planDeterministicEventImpact } from '../backend/event_impact/deterministic_processor.ts';
import { planDeterministicGoldTransmission } from '../backend/gold_transmission/deterministic_processor.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bls_cpi_table1_2026_08.json', import.meta.url), 'utf8'));
const mapped = mapBlsCpiReleaseToEventFacts(fixture);
assert.equal(mapped.kind, 'RESOLVED');
const nfpFixture = JSON.parse(readFileSync(new URL(
  './fixtures/bls_employment_situation_2026_08.json', import.meta.url,
), 'utf8'));
const nfpMapped = mapBlsEmploymentReleaseToEventFacts(nfpFixture);
assert.equal(nfpMapped.kind, 'RESOLVED');
const claimsFixture = JSON.parse(readFileSync(new URL(
  './fixtures/dol_ui_weekly_claims_2026_10_01.json', import.meta.url,
), 'utf8'));
const claimsMapped = mapDolUiWeeklyClaimsReleaseToEventFacts(claimsFixture);
assert.equal(claimsMapped.kind, 'RESOLVED');
const pceFixture = JSON.parse(readFileSync(new URL(
  './fixtures/bea_pce_2026_08.json', import.meta.url,
), 'utf8'));
const pceMapped = mapBeaPceReleaseToEventFacts(pceFixture);
assert.equal(pceMapped.kind, 'RESOLVED');

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

const nfpBase = {
  ...base,
  canonicalEventStateSchemaVersion: nfpMapped.canonicalEventStateSchemaVersion,
  canonicalEventState: nfpMapped.canonicalEventState,
  stateFingerprint: 'b'.repeat(64),
};
const nfpAccepted = run(nfpBase);
assert.equal(nfpAccepted.impact.kind, 'PROCESS');
assert.equal(nfpAccepted.impact.processorVersion, 'event-impact-deterministic-processor-v5');
assert.equal(nfpAccepted.impact.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(nfpAccepted.impact.assessmentReason, 'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE');
assert.deepEqual(nfpAccepted.impact.interpretations, []);
assert.equal(nfpAccepted.transmission.kind, 'PROCESS');
assert.equal(nfpAccepted.transmission.processorVersion,
  'gold-transmission-deterministic-processor-v5');
assert.equal(nfpAccepted.transmission.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(nfpAccepted.transmission.assessmentReason, 'CONSENSUS_FACTS_UNAVAILABLE');
assert.deepEqual(nfpAccepted.transmission.paths, []);
const reversedRevisions = structuredClone(nfpBase);
reversedRevisions.canonicalEventState.facts.metrics
  .find(metric => metric.metric_code === 'NFP_PAYROLL_CHANGE').prior_periods.reverse();
assert.deepEqual(run(reversedRevisions), nfpAccepted);
console.log('PASS exact official NFP facts and release-local revisions are admitted without signal inference');

const claimsBase = {
  ...base,
  canonicalEventStateSchemaVersion: claimsMapped.canonicalEventStateSchemaVersion,
  canonicalEventState: claimsMapped.canonicalEventState,
  stateFingerprint: 'c'.repeat(64),
};
const claimsAccepted = run(claimsBase);
assert.equal(claimsAccepted.impact.kind, 'PROCESS');
assert.equal(claimsAccepted.impact.processorVersion, 'event-impact-deterministic-processor-v5');
assert.equal(claimsAccepted.impact.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(claimsAccepted.impact.assessmentReason,
  'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE');
assert.deepEqual(claimsAccepted.impact.interpretations, []);
assert.equal(claimsAccepted.transmission.kind, 'PROCESS');
assert.equal(claimsAccepted.transmission.processorVersion,
  'gold-transmission-deterministic-processor-v5');
assert.equal(claimsAccepted.transmission.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(claimsAccepted.transmission.assessmentReason,
  'CONSENSUS_FACTS_UNAVAILABLE');
assert.deepEqual(claimsAccepted.transmission.paths, []);
const reversedClaimsMetrics = structuredClone(claimsBase);
reversedClaimsMetrics.canonicalEventState.facts.metrics.reverse();
assert.deepEqual(run(reversedClaimsMetrics), claimsAccepted);
console.log('PASS exact official jobless-claims facts are admitted without signal inference');

const pceBase = {
  ...base,
  canonicalEventStateSchemaVersion: pceMapped.canonicalEventStateSchemaVersion,
  canonicalEventState: pceMapped.canonicalEventState,
  stateFingerprint: 'd'.repeat(64),
};
const pceAccepted = run(pceBase);
assert.equal(pceAccepted.impact.kind, 'PROCESS');
assert.equal(pceAccepted.impact.processorVersion, 'event-impact-deterministic-processor-v5');
assert.equal(pceAccepted.impact.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(pceAccepted.impact.assessmentReason,
  'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE');
assert.deepEqual(pceAccepted.impact.interpretations, []);
assert.equal(pceAccepted.transmission.kind, 'PROCESS');
assert.equal(pceAccepted.transmission.processorVersion,
  'gold-transmission-deterministic-processor-v5');
assert.equal(pceAccepted.transmission.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(pceAccepted.transmission.assessmentReason,
  'CONSENSUS_FACTS_UNAVAILABLE');
assert.deepEqual(pceAccepted.transmission.paths, []);
const reversedPceMetrics = structuredClone(pceBase);
reversedPceMetrics.canonicalEventState.facts.metrics.reverse();
assert.deepEqual(run(reversedPceMetrics), pceAccepted);
console.log('PASS exact official PCE facts are admitted without signal inference');

for (const [label, mutate] of [
  ['unsupported family', state => { state.facts.release_family = 'US_PPI'; }],
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

for (const [label, mutate] of [
  ['missing payroll revision', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'NFP_PAYROLL_CHANGE')
      .prior_periods.pop();
  }],
  ['duplicate payroll revision period', state => {
    const prior = state.facts.metrics.find(metric => metric.metric_code === 'NFP_PAYROLL_CHANGE')
      .prior_periods;
    prior[0].reference_period = structuredClone(prior[1].reference_period);
  }],
  ['wrong payroll unit', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'NFP_PAYROLL_CHANGE').unit =
      'LEVEL_PERCENT';
  }],
  ['fractional payroll', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'NFP_PAYROLL_CHANGE').actual.value =
      '162.5';
  }],
  ['unsupported AHE precision', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'AVG_HOURLY_EARNINGS_MOM')
      .actual.value = '0.25';
  }],
  ['invented NFP consensus', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'UNEMPLOYMENT_RATE').consensus =
      { state: 'KNOWN', value: '4.0' };
  }],
  ['invented unemployment revision', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'UNEMPLOYMENT_RATE')
      .prior_periods = [{}];
  }],
]) {
  const eventVersion = structuredClone(nfpBase);
  mutate(eventVersion.canonicalEventState);
  const rejected = run(eventVersion);
  assert.equal(rejected.impact.kind, 'ABSTAIN', `${label}: EI`);
  assert.equal(rejected.impact.reason, 'INVALID_CANONICAL_EVENT_STATE_V2', `${label}: EI reason`);
  assert.equal(rejected.transmission.kind, 'ABSTAIN', `${label}: GT`);
  assert.equal(rejected.transmission.reason, 'INVALID_CANONICAL_EVENT_STATE_V2', `${label}: GT reason`);
}
console.log('PASS EI and GT fail closed on malformed NFP units, precision, consensus, and revisions');

for (const [label, mutate] of [
  ['wrong claims unit', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'INITIAL_CLAIMS').unit = 'PERSONS';
  }],
  ['missing claims revision', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'INITIAL_CLAIMS')
      .prior_periods = [];
  }],
  ['wrong continuing lag', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'CONTINUING_CLAIMS')
      .reference_period.date = '2026-09-26';
  }],
  ['wrong revision week', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'INITIAL_CLAIMS')
      .prior_periods[0].reference_period.date = '2026-09-12';
  }],
  ['non-Saturday claims period', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'INITIAL_CLAIMS')
      .reference_period.date = '2026-09-25';
  }],
  ['negative claims value', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'CONTINUING_CLAIMS')
      .actual.value = '-1';
  }],
  ['unsupported claims precision', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'CLAIMS_4WK_AVERAGE')
      .actual.value = '200.0001';
  }],
  ['invented claims consensus', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'INITIAL_CLAIMS').consensus =
      { state: 'KNOWN', value: '195' };
  }],
  ['duplicate claims metric', state => {
    state.facts.metrics[1].metric_code = 'INITIAL_CLAIMS';
  }],
]) {
  const eventVersion = structuredClone(claimsBase);
  mutate(eventVersion.canonicalEventState);
  const rejected = run(eventVersion);
  assert.equal(rejected.impact.kind, 'ABSTAIN', `${label}: EI`);
  assert.equal(rejected.impact.reason, 'INVALID_CANONICAL_EVENT_STATE_V2',
    `${label}: EI reason`);
  assert.equal(rejected.transmission.kind, 'ABSTAIN', `${label}: GT`);
  assert.equal(rejected.transmission.reason, 'INVALID_CANONICAL_EVENT_STATE_V2',
    `${label}: GT reason`);
}
console.log('PASS EI and GT fail closed on malformed jobless-claims periods, values, consensus, and revisions');

for (const [label, mutate] of [
  ['wrong PCE unit', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'PCE_CORE_MOM').unit =
      'PERCENT_CHANGE_YOY';
  }],
  ['duplicate PCE metric', state => {
    state.facts.metrics[1].metric_code = 'PCE_CORE_MOM';
  }],
  ['mismatched PCE month', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'PCE_HEADLINE_YOY')
      .reference_period = { kind: 'MONTH', year: 2026, month: 7 };
  }],
  ['unsupported PCE precision', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'PCE_HEADLINE_MOM')
      .actual.value = '0.25';
  }],
  ['non-canonical PCE decimal', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'PCE_CORE_YOY')
      .actual.value = '3.0';
  }],
  ['invented PCE consensus', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'PCE_CORE_MOM').consensus =
      { state: 'KNOWN', value: '0.2' };
  }],
  ['invented PCE prior', state => {
    state.facts.metrics.find(metric => metric.metric_code === 'PCE_HEADLINE_YOY')
      .prior_periods = [{}];
  }],
]) {
  const eventVersion = structuredClone(pceBase);
  mutate(eventVersion.canonicalEventState);
  const rejected = run(eventVersion);
  assert.equal(rejected.impact.kind, 'ABSTAIN', `${label}: EI`);
  assert.equal(rejected.impact.reason, 'INVALID_CANONICAL_EVENT_STATE_V2',
    `${label}: EI reason`);
  assert.equal(rejected.transmission.kind, 'ABSTAIN', `${label}: GT`);
  assert.equal(rejected.transmission.reason, 'INVALID_CANONICAL_EVENT_STATE_V2',
    `${label}: GT reason`);
}
console.log('PASS EI and GT fail closed on malformed PCE units, periods, values, consensus, and priors');

const future = run({ ...base, canonicalEventStateSchemaVersion: 3, canonicalEventState: { opaque: true } });
assert.equal(future.impact.assessmentReason, 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
assert.equal(future.transmission.assessmentReason, 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
console.log('PASS future schemas remain explicitly unavailable');
