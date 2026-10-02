import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOL_UI_CLAIMS_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
  DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION,
  mapDolUiWeeklyClaimsReleaseToEventFacts,
  resolveDolUiClaimsReleaseIdentity,
} from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  root, 'backend', 'event_facts', 'dol_ui_weekly_claims_adapter.ts',
);
const fixture = JSON.parse(readFileSync(path.join(
  root, 'tests', 'fixtures', 'dol_ui_weekly_claims_2026_10_01.json',
), 'utf8'));
const clone = value => structuredClone(value);

let passed = 0;
let failed = 0;
function test(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function expectState(result, kind, reason, label) {
  test(`${label}: ${kind}`, result?.kind === kind, JSON.stringify(result));
  test(`${label}: reason`, result?.reason === reason, JSON.stringify(result));
}

test('adapter version frozen', DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION
  === 'dol-ui-claims-event-facts-adapter-v1');
test('CES schema version frozen at 2',
  DOL_UI_CLAIMS_CANONICAL_EVENT_STATE_SCHEMA_VERSION === 2);

const before = JSON.stringify(fixture);
const result = mapDolUiWeeklyClaimsReleaseToEventFacts(fixture);
const replay = mapDolUiWeeklyClaimsReleaseToEventFacts(fixture);
test('official DOL fixture resolves', result.kind === 'RESOLVED', JSON.stringify(result));
test('mapping is byte deterministic', JSON.stringify(result) === JSON.stringify(replay));
test('input is not mutated', JSON.stringify(fixture) === before);
if (result.kind !== 'RESOLVED') process.exit(1);

test('official release identity namespace exact', result.releaseIdentity.authorityNamespace
  === 'xau_v2:official_release:us_dol_eta:v1');
test('official release identity type exact', result.releaseIdentity.identityType
  === 'official_release_id:dol_ui_weekly_claims_v1');
test('raw footer number maps to canonical release ID', result.releaseIdentity.identityValue
  === JSON.stringify({
    authority: 'us_dol_eta',
    release_family: 'US_JOBLESS_CLAIMS',
    release_id: 'USDL-26-1543-NAT',
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: 'dol_ui_weekly_claims_v1',
  }));
const identityObject = JSON.parse(result.releaseIdentity.identityValue);
test('identity JSON keys lexicographically ordered',
  Object.keys(identityObject).join(',')
  === [...Object.keys(identityObject)].sort().join(','));
const identityKey = createHash('sha256').update([
  result.releaseIdentity.authorityNamespace,
  result.releaseIdentity.identityType,
  result.releaseIdentity.identityValue,
].join('\u001f')).digest('hex');
test('existing strong identity formula accepts exact output', /^[0-9a-f]{64}$/.test(identityKey));

test('CES V2 emitted explicitly', result.canonicalEventStateSchemaVersion === 2);
test('release family exact',
  result.canonicalEventState.facts.release_family === 'US_JOBLESS_CLAIMS');
test('subject uses the initial-claims week', result.canonicalEventState.subject
  === 'US Department of Labor releases jobless claims report for week ending September 26, 2026');
test('detail remains null', result.canonicalEventState.detail === null);
const metrics = result.canonicalEventState.facts.metrics;
test('exactly three reviewed metrics', metrics.length === 3);
test('metrics sorted by metric_code', metrics.map(metric => metric.metric_code).join(',')
  === 'CLAIMS_4WK_AVERAGE,CONTINUING_CLAIMS,INITIAL_CLAIMS');
test('all metrics use thousands of persons',
  metrics.every(metric => metric.unit === 'THOUSANDS_OF_PERSONS'));
test('official release never fabricates consensus', metrics.every(metric =>
  metric.consensus.state === 'UNKNOWN' && metric.consensus.value === null));

const average = metrics.find(metric => metric.metric_code === 'CLAIMS_4WK_AVERAGE');
const continuing = metrics.find(metric => metric.metric_code === 'CONTINUING_CLAIMS');
const initial = metrics.find(metric => metric.metric_code === 'INITIAL_CLAIMS');
test('initial claims exact', initial?.actual.value === '197');
test('continuing claims exact', continuing?.actual.value === '1701');
test('initial four-week average exact', average?.actual.value === '200');
test('initial reference week exact',
  initial?.reference_period.date === '2026-09-26');
test('average anchor week exact',
  average?.reference_period.date === '2026-09-26');
test('continuing claims preserve the official one-week lag',
  continuing?.reference_period.date === '2026-09-19');
test('each metric retains its release-local prior revision',
  metrics.every(metric => metric.prior_periods.length === 1));
test('initial revision exact', initial?.prior_periods[0]?.reference_period.date === '2026-09-19'
  && initial.prior_periods[0].prior_value.value === '197'
  && initial.prior_periods[0].revised_value.value === '198');
test('continuing revision exact',
  continuing?.prior_periods[0]?.reference_period.date === '2026-09-12'
  && continuing.prior_periods[0].prior_value.value === '1719'
  && continuing.prior_periods[0].revised_value.value === '1712');
test('quarter-thousand average revision remains exact',
  average?.prior_periods[0]?.prior_value.value === '202.25'
  && average.prior_periods[0].revised_value.value === '202.5');

const correction = clone(fixture);
correction.summary.initialClaims.currentPersons = 196000;
const correctionResult = mapDolUiWeeklyClaimsReleaseToEventFacts(correction);
test('same-release correction remains resolvable', correctionResult.kind === 'RESOLVED');
test('same official number keeps identity across correction',
  correctionResult.kind === 'RESOLVED'
  && correctionResult.releaseIdentity.identityValue === result.releaseIdentity.identityValue);
test('correction changes facts, not identity', correctionResult.kind === 'RESOLVED'
  && correctionResult.canonicalEventState.facts.metrics.find(metric =>
    metric.metric_code === 'INITIAL_CLAIMS')?.actual.value === '196');
const identityWithChangedFacts = resolveDolUiClaimsReleaseIdentity(correction);
test('metrics cannot alter release identity', !('kind' in identityWithChangedFacts)
  && identityWithChangedFacts.identityValue === result.releaseIdentity.identityValue);

const nextRelease = clone(fixture);
nextRelease.release.releaseNumberRaw = 'USDL 26-9999-NAT';
const nextIdentity = resolveDolUiClaimsReleaseIdentity(nextRelease);
test('different official release number yields different identity',
  !('kind' in nextIdentity)
  && nextIdentity.identityValue !== result.releaseIdentity.identityValue);

const missingNumber = clone(fixture);
missingNumber.release.releaseNumberRaw = null;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(missingNumber), 'UNAVAILABLE',
  'OFFICIAL_RELEASE_NUMBER_UNAVAILABLE', 'missing official release number');
const malformedNumber = clone(fixture);
malformedNumber.release.releaseNumberRaw = 'USDL-26-1543-NAT';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(malformedNumber), 'MALFORMED',
  'OFFICIAL_RELEASE_NUMBER_MALFORMED', 'pre-normalized release number rejected');
const missingMetric = clone(fixture);
missingMetric.summary.continuingClaims = null;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(missingMetric), 'UNAVAILABLE',
  'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE', 'missing continuing claims');

const invalidDate = clone(fixture);
invalidDate.summary.initialClaims.referencePeriod.date = '2026-02-30';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(invalidDate), 'MALFORMED',
  'WEEK_ENDING_PERIOD_MALFORMED', 'invalid calendar date');
const nonSaturday = clone(fixture);
nonSaturday.summary.initialClaims.referencePeriod.date = '2026-09-25';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(nonSaturday), 'MALFORMED',
  'WEEK_ENDING_PERIOD_MALFORMED', 'non-Saturday week ending');
const wrongPrior = clone(fixture);
wrongPrior.summary.initialClaims.priorRevision.referencePeriod.date = '2026-09-12';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongPrior), 'CONFLICT',
  'PRIOR_REVISION_PERIOD_CONFLICT', 'non-immediate initial revision');
const wrongLag = clone(fixture);
wrongLag.summary.continuingClaims.referencePeriod.date = '2026-09-12';
wrongLag.summary.continuingClaims.priorRevision.referencePeriod.date = '2026-09-05';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongLag), 'CONFLICT',
  'METRIC_REFERENCE_PERIOD_CONFLICT', 'continuing-claims lag conflict');
const wrongAverageAnchor = clone(fixture);
wrongAverageAnchor.summary.initialClaimsFourWeekAverage.referencePeriod.date = '2026-09-19';
wrongAverageAnchor.summary.initialClaimsFourWeekAverage.priorRevision.referencePeriod.date =
  '2026-09-12';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongAverageAnchor), 'CONFLICT',
  'METRIC_REFERENCE_PERIOD_CONFLICT', 'average anchor conflict');

const fractionalPersons = clone(fixture);
fractionalPersons.summary.initialClaims.currentPersons = 197000.5;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(fractionalPersons), 'MALFORMED',
  'CLAIMS_VALUE_MALFORMED', 'fractional source person count');
const negativePersons = clone(fixture);
negativePersons.summary.continuingClaims.currentPersons = -1;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(negativePersons), 'MALFORMED',
  'CLAIMS_VALUE_MALFORMED', 'negative person count');
const unsafePersons = clone(fixture);
unsafePersons.summary.initialClaimsFourWeekAverage.priorRevision.priorPersons =
  Number.MAX_SAFE_INTEGER;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(unsafePersons), 'MALFORMED',
  'CLAIMS_VALUE_MALFORMED', 'out-of-bound person count');

const wrongLabel = clone(fixture);
wrongLabel.summary.initialClaims.seriesLabel = 'Initial Claims (NSA)';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongLabel), 'MALFORMED',
  'CLAIMS_METRIC_SHAPE_MALFORMED', 'unreviewed NSA series');
const wrongHeader = clone(fixture);
wrongHeader.release.headerTitle = 'WEEKLY CLAIMS';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongHeader), 'CONFLICT',
  'RELEASE_ARTIFACT_CONFLICT', 'wrong official header');
const wrongArtifact = clone(fixture);
wrongArtifact.release.artifactPath = '/newsroom/claims.pdf';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongArtifact), 'CONFLICT',
  'RELEASE_ARTIFACT_CONFLICT', 'wrong artifact path');
const wrongSource = clone(fixture);
wrongSource.source.sourceDomain = 'example.com';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongSource), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'source tuple mismatch');
const wrongFamily = clone(fixture);
wrongFamily.release.releaseFamily = 'US_NFP';
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(wrongFamily), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'release family mismatch');
const extraKey = clone(fixture);
extraKey.summary.initialClaims.extra = true;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(extraKey), 'MALFORMED',
  'CLAIMS_METRIC_SHAPE_MALFORMED', 'extra metric projection key');
const missingShape = clone(fixture);
delete missingShape.summary.initialClaimsFourWeekAverage;
expectState(mapDolUiWeeklyClaimsReleaseToEventFacts(missingShape), 'MALFORMED',
  'INVALID_SUMMARY_SHAPE', 'missing projection field');

const source = readFileSync(sourcePath, 'utf8');
const executableSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
test('pure adapter has no imports', !/^\s*import\s/m.test(executableSource));
test('no database or network access',
  !/\b(fetch|request|supabase|postgres|sql\s*`)/i.test(executableSource));
test('no environment, application clock, or randomness',
  !/process\.env|Math\.random|crypto\.random/i.test(executableSource)
  && !/\bDate\.|new Date/.test(executableSource));
test('no LLM, market, legacy score, or price reaction dependency',
  !/Anthropic|OpenAI|LLM|news_score|gold_direction|market_reaction|price_action/i
    .test(executableSource));
test('no consensus provider accepted by payload contract',
  !/providerConsensus|consensusValue|forecastValue/.test(source));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
