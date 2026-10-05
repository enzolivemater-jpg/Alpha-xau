import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  BEA_PCE_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
  BEA_PCE_EVENT_FACTS_ADAPTER_VERSION,
  mapBeaPceReleaseToEventFacts,
  resolveBeaPceReleaseIdentity,
} from '../backend/event_facts/bea_pce_adapter.ts';

const readFixture = month => JSON.parse(readFileSync(new URL(
  `./fixtures/bea_pce_2026_${month}.json`, import.meta.url,
), 'utf8'));
const august = readFixture('08');
const july = readFixture('07');
const clone = value => structuredClone(value);

assert.equal(BEA_PCE_EVENT_FACTS_ADAPTER_VERSION, 'bea-pce-event-facts-adapter-v1');
assert.equal(BEA_PCE_CANONICAL_EVENT_STATE_SCHEMA_VERSION, 2);

const before = JSON.stringify(august);
const resolved = mapBeaPceReleaseToEventFacts(august);
assert.equal(resolved.kind, 'RESOLVED', JSON.stringify(resolved));
assert.deepEqual(mapBeaPceReleaseToEventFacts(august), resolved);
assert.equal(JSON.stringify(august), before);
console.log('PASS official BEA PCE fixture resolves deterministically without input mutation');

assert.deepEqual(resolved.releaseIdentity, {
  authorityNamespace: 'xau_v2:official_release:us_bea:v1',
  identityType: 'official_release_id:bea_personal_income_outlays_v1',
  identityValue: JSON.stringify({
    authority: 'us_bea',
    release_family: 'US_PCE',
    release_id: 'BEA-26-43',
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: 'bea_personal_income_outlays_v1',
  }),
});
const identityObject = JSON.parse(resolved.releaseIdentity.identityValue);
assert.deepEqual(Object.keys(identityObject), [...Object.keys(identityObject)].sort());
assert.match(createHash('sha256').update([
  resolved.releaseIdentity.authorityNamespace,
  resolved.releaseIdentity.identityType,
  resolved.releaseIdentity.identityValue,
].join('\u001f')).digest('hex'), /^[0-9a-f]{64}$/);
console.log('PASS BEA release number maps to exact strong release identity');

assert.equal(resolved.canonicalEventStateSchemaVersion, 2);
assert.equal(resolved.canonicalEventState.event_type, 'STATISTICAL_RELEASE');
assert.equal(resolved.canonicalEventState.detail, null);
assert.equal(resolved.canonicalEventState.facts.release_family, 'US_PCE');
assert.equal(
  resolved.canonicalEventState.subject,
  'US Bureau of Economic Analysis releases August 2026 PCE price indexes',
);
assert.deepEqual(resolved.canonicalEventState.facts.metrics.map(metric => ({
  code: metric.metric_code,
  unit: metric.unit,
  value: metric.actual.value,
  period: metric.reference_period,
  consensus: metric.consensus,
  priors: metric.prior_periods,
})), [
  { code: 'PCE_CORE_MOM', unit: 'PERCENT_CHANGE_MOM', value: '0.2', period: { kind: 'MONTH', year: 2026, month: 8 }, consensus: { state: 'UNKNOWN', value: null }, priors: [] },
  { code: 'PCE_CORE_YOY', unit: 'PERCENT_CHANGE_YOY', value: '3', period: { kind: 'MONTH', year: 2026, month: 8 }, consensus: { state: 'UNKNOWN', value: null }, priors: [] },
  { code: 'PCE_HEADLINE_MOM', unit: 'PERCENT_CHANGE_MOM', value: '0.3', period: { kind: 'MONTH', year: 2026, month: 8 }, consensus: { state: 'UNKNOWN', value: null }, priors: [] },
  { code: 'PCE_HEADLINE_YOY', unit: 'PERCENT_CHANGE_YOY', value: '3.4', period: { kind: 'MONTH', year: 2026, month: 8 }, consensus: { state: 'UNKNOWN', value: null }, priors: [] },
]);
console.log('PASS exact headline/core MoM/YoY facts map with UNKNOWN consensus and no invented revisions');

const reordered = clone(august);
reordered.summary.metrics.reverse();
assert.deepEqual(mapBeaPceReleaseToEventFacts(reordered), resolved);
const julyResolved = mapBeaPceReleaseToEventFacts(july);
assert.equal(julyResolved.kind, 'RESOLVED');
assert.notEqual(julyResolved.releaseIdentity.identityValue, resolved.releaseIdentity.identityValue);
const corrected = clone(august);
corrected.summary.metrics[1].valuePercent = 0.4;
corrected.release.archiveSha256 = 'a'.repeat(64);
const correctedResolved = mapBeaPceReleaseToEventFacts(corrected);
assert.equal(correctedResolved.kind, 'RESOLVED');
assert.equal(correctedResolved.releaseIdentity.identityValue, resolved.releaseIdentity.identityValue);
assert.equal(correctedResolved.canonicalEventState.facts.metrics
  .find(metric => metric.metric_code === 'PCE_HEADLINE_MOM').actual.value, '0.4');
assert.deepEqual(resolveBeaPceReleaseIdentity(corrected), resolved.releaseIdentity);
console.log('PASS source order and facts/hash corrections cannot alter release identity');

function expect(input, kind, reason) {
  const result = mapBeaPceReleaseToEventFacts(input);
  assert.equal(result.kind, kind, JSON.stringify(result));
  assert.equal(result.reason, reason, JSON.stringify(result));
}

const missingNumber = clone(august);
missingNumber.release.releaseNumberRaw = null;
expect(missingNumber, 'UNAVAILABLE', 'OFFICIAL_RELEASE_NUMBER_UNAVAILABLE');
const malformedNumber = clone(august);
malformedNumber.release.releaseNumberRaw = 'BEA-26-43';
expect(malformedNumber, 'MALFORMED', 'OFFICIAL_RELEASE_NUMBER_MALFORMED');
const missingHash = clone(august);
missingHash.release.archiveSha256 = null;
expect(missingHash, 'UNAVAILABLE', 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE');
const malformedHash = clone(august);
malformedHash.release.archiveSha256 = 'ABC';
expect(malformedHash, 'MALFORMED', 'OFFICIAL_EVIDENCE_MALFORMED');
const wrongPath = clone(august);
wrongPath.release.archivePath = '/news/2026/personal-income-and-outlays-july-2026';
expect(wrongPath, 'CONFLICT', 'RELEASE_PERIOD_CONFLICT');
const wrongTitle = clone(august);
wrongTitle.release.headerTitle = 'Personal Income and Outlays, July 2026';
expect(wrongTitle, 'CONFLICT', 'RELEASE_PERIOD_CONFLICT');
const wrongReleaseYear = clone(august);
wrongReleaseYear.release.releaseNumberRaw = 'BEA 25–43';
expect(wrongReleaseYear, 'CONFLICT', 'RELEASE_ID_DATE_CONFLICT');
const malformedPublication = clone(august);
malformedPublication.release.publicReleaseAtRaw = 'September 30, 2026';
expect(malformedPublication, 'CONFLICT', 'RELEASE_ID_DATE_CONFLICT');
const badPeriod = clone(august);
badPeriod.summary.referencePeriod.month = 13;
expect(badPeriod, 'MALFORMED', 'REFERENCE_PERIOD_MALFORMED');
const missingMetric = clone(august);
missingMetric.summary.metrics.pop();
expect(missingMetric, 'MALFORMED', 'REQUIRED_METRICS_MISSING_OR_DUPLICATED');
const duplicateMetric = clone(august);
duplicateMetric.summary.metrics[0] = clone(duplicateMetric.summary.metrics[1]);
expect(duplicateMetric, 'MALFORMED', 'REQUIRED_METRICS_MISSING_OR_DUPLICATED');
const badPrecision = clone(august);
badPrecision.summary.metrics[0].valuePercent = 3.01;
expect(badPrecision, 'MALFORMED', 'METRIC_VALUE_MALFORMED');
const extraMetricKey = clone(august);
extraMetricKey.summary.metrics[0].extra = true;
expect(extraMetricKey, 'MALFORMED', 'METRIC_SHAPE_MALFORMED');
const wrongSource = clone(august);
wrongSource.source.sourceDomain = 'example.com';
expect(wrongSource, 'UNSUPPORTED', 'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE');
const wrongFamily = clone(august);
wrongFamily.release.releaseFamily = 'US_CPI';
expect(wrongFamily, 'UNSUPPORTED', 'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE');
const extraSummaryKey = clone(august);
extraSummaryKey.summary.extra = true;
expect(extraSummaryKey, 'MALFORMED', 'INVALID_SUMMARY_SHAPE');
console.log('PASS PCE adapter fails closed on missing, malformed, conflicting, duplicate, and unsupported evidence');

const negativeZero = clone(august);
negativeZero.summary.metrics.find(metric => metric.changeBasis === 'PRECEDING_MONTH'
  && metric.seriesLabel === 'PCE price index').valuePercent = -0;
const negativeZeroResult = mapBeaPceReleaseToEventFacts(negativeZero);
assert.equal(negativeZeroResult.kind, 'RESOLVED');
assert.equal(negativeZeroResult.canonicalEventState.facts.metrics
  .find(metric => metric.metric_code === 'PCE_HEADLINE_MOM').actual.value, '0');

const source = readFileSync(new URL('../backend/event_facts/bea_pce_adapter.ts', import.meta.url), 'utf8');
const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert.doesNotMatch(executable, /^\s*import\s/m);
assert.doesNotMatch(executable, /\bfetch\s*\(|request|supabase|postgres|\bsql\s*`/i);
assert.doesNotMatch(executable, /process\.env|Math\.random|crypto\.random|Date\.now|new Date/);
assert.doesNotMatch(executable, /OpenAI|Anthropic|LLM|gold_direction|price_action/i);
assert.doesNotMatch(source, /providerConsensus|consensusValue|forecastValue/);
console.log('PASS PCE adapter is pure and has no network, DB, clock, model, market, or consensus dependency');
