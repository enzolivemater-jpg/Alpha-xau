import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLS_EMPLOYMENT_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
  BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION,
  mapBlsEmploymentReleaseToEventFacts,
  resolveBlsEmploymentReleaseIdentity,
} from '../backend/event_facts/bls_employment_situation_adapter.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  root, 'backend', 'event_facts', 'bls_employment_situation_adapter.ts',
);
const fixture = month => JSON.parse(readFileSync(path.join(
  root, 'tests', 'fixtures',
  `bls_employment_situation_2026_${String(month).padStart(2, '0')}.json`,
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

test('adapter version frozen', BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION
  === 'bls-employment-event-facts-adapter-v1');
test('CES schema version frozen at 2',
  BLS_EMPLOYMENT_CANONICAL_EVENT_STATE_SCHEMA_VERSION === 2);

const august = fixture(8);
const july = fixture(7);
const before = JSON.stringify(august);
const result = mapBlsEmploymentReleaseToEventFacts(august);
const replay = mapBlsEmploymentReleaseToEventFacts(august);
test('August official fixture resolves', result.kind === 'RESOLVED', JSON.stringify(result));
test('mapping is byte deterministic', JSON.stringify(result) === JSON.stringify(replay));
test('input is not mutated', JSON.stringify(august) === before);
if (result.kind !== 'RESOLVED') process.exit(1);

test('official release identity namespace exact', result.releaseIdentity.authorityNamespace
  === 'xau_v2:official_release:us_bls:v1');
test('official release identity type exact', result.releaseIdentity.identityType
  === 'official_release_id:bls_employment_situation_v1');
test('identity value canonical JSON exact', result.releaseIdentity.identityValue
  === JSON.stringify({
    authority: 'us_bls',
    release_family: 'US_NFP',
    release_id: 'USDL-26-1435',
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: 'bls_employment_situation_v1',
  }));
test('identity JSON keys lexicographically ordered',
  Object.keys(JSON.parse(result.releaseIdentity.identityValue)).join(',')
  === [...Object.keys(JSON.parse(result.releaseIdentity.identityValue))].sort().join(','));
const identityKey = createHash('sha256').update([
  result.releaseIdentity.authorityNamespace,
  result.releaseIdentity.identityType,
  result.releaseIdentity.identityValue,
].join('\u001f')).digest('hex');
test('existing strong identity formula accepts exact output', /^[0-9a-f]{64}$/.test(identityKey));

test('CES V2 emitted explicitly', result.canonicalEventStateSchemaVersion === 2);
test('release family exact', result.canonicalEventState.facts.release_family === 'US_NFP');
test('subject deterministic', result.canonicalEventState.subject
  === 'US Bureau of Labor Statistics releases August 2026 Employment Situation');
test('detail remains null', result.canonicalEventState.detail === null);
const metrics = result.canonicalEventState.facts.metrics;
test('exactly three reviewed metrics', metrics.length === 3);
test('metrics sorted by metric_code', metrics.map(metric => metric.metric_code).join(',')
  === 'AVG_HOURLY_EARNINGS_MOM,NFP_PAYROLL_CHANGE,UNEMPLOYMENT_RATE');
test('all metrics use release reference month', metrics.every(metric =>
  JSON.stringify(metric.reference_period)
  === JSON.stringify({ kind: 'MONTH', year: 2026, month: 8 })));
test('official release never fabricates consensus', metrics.every(metric =>
  metric.consensus.state === 'UNKNOWN' && metric.consensus.value === null));
test('payroll maps exact thousands change', metrics.find(metric =>
  metric.metric_code === 'NFP_PAYROLL_CHANGE')?.actual.value === '162');
test('unemployment maps exact level', metrics.find(metric =>
  metric.metric_code === 'UNEMPLOYMENT_RATE')?.actual.value === '4.1');
test('AHE maps exact monthly change', metrics.find(metric =>
  metric.metric_code === 'AVG_HOURLY_EARNINGS_MOM')?.actual.value === '0.3');
const payroll = metrics.find(metric => metric.metric_code === 'NFP_PAYROLL_CHANGE');
test('payroll retains both official revisions', payroll?.prior_periods.length === 2);
test('revisions sorted oldest to newest', payroll?.prior_periods.map(item =>
  `${item.reference_period.year}-${item.reference_period.month}`).join(',') === '2026-6,2026-7');
test('June revision exact', payroll?.prior_periods[0]?.prior_value.value === '20'
  && payroll?.prior_periods[0]?.revised_value.value === '31');
test('July revision exact including negative prior',
  payroll?.prior_periods[1]?.prior_value.value === '-23'
  && payroll?.prior_periods[1]?.revised_value.value === '21');
test('non-payroll metrics do not invent prior revisions', metrics
  .filter(metric => metric.metric_code !== 'NFP_PAYROLL_CHANGE')
  .every(metric => metric.prior_periods.length === 0));

const reversed = clone(august);
reversed.summary.payroll.priorRevisions.reverse();
test('source revision order carries no meaning',
  JSON.stringify(mapBlsEmploymentReleaseToEventFacts(reversed)) === JSON.stringify(result));
const julyResult = mapBlsEmploymentReleaseToEventFacts(july);
expectState(julyResult, 'UNAVAILABLE', 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE',
  'July archive lacks explicit AHE month-over-month percent evidence');
const julyIdentity = resolveBlsEmploymentReleaseIdentity(july);
test('unavailable July facts retain a resolvable official release identity',
  !('kind' in julyIdentity));
test('consecutive release identity differs', !('kind' in julyIdentity)
  && julyIdentity.identityValue !== result.releaseIdentity.identityValue);
test('July adapter output cannot fabricate a zero AHE percentage',
  julyResult.kind === 'UNAVAILABLE' && !('canonicalEventState' in julyResult));

const corrected = clone(august);
corrected.summary.payroll.currentChangeThousands = 163;
const correctedResult = mapBlsEmploymentReleaseToEventFacts(corrected);
test('same-release correction remains resolvable', correctedResult.kind === 'RESOLVED');
test('same release ID keeps identity across correction', correctedResult.kind === 'RESOLVED'
  && correctedResult.releaseIdentity.identityValue === result.releaseIdentity.identityValue);
test('correction changes facts, not identity', correctedResult.kind === 'RESOLVED'
  && correctedResult.canonicalEventState.facts.metrics.find(metric =>
    metric.metric_code === 'NFP_PAYROLL_CHANGE')?.actual.value === '163');
const identityWithChangedFacts = resolveBlsEmploymentReleaseIdentity(corrected);
test('metrics cannot alter release identity', !('kind' in identityWithChangedFacts)
  && identityWithChangedFacts.identityValue === result.releaseIdentity.identityValue);

const missingId = clone(august);
missingId.release.releaseId = null;
expectState(mapBlsEmploymentReleaseToEventFacts(missingId), 'UNAVAILABLE',
  'OFFICIAL_RELEASE_ID_UNAVAILABLE', 'missing official release ID');
const malformedId = clone(august);
malformedId.release.releaseId = 'usdl-26-1435';
expectState(mapBlsEmploymentReleaseToEventFacts(malformedId), 'MALFORMED',
  'OFFICIAL_RELEASE_ID_MALFORMED', 'malformed release ID');
const missingRevision = clone(august);
missingRevision.summary.payroll.priorRevisions = null;
expectState(mapBlsEmploymentReleaseToEventFacts(missingRevision), 'UNAVAILABLE',
  'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE', 'missing revision evidence');
const oneRevision = clone(august);
oneRevision.summary.payroll.priorRevisions.pop();
expectState(mapBlsEmploymentReleaseToEventFacts(oneRevision), 'UNAVAILABLE',
  'TWO_PRIOR_PAYROLL_REVISIONS_REQUIRED', 'incomplete revision pair');

const fractionalPayroll = clone(august);
fractionalPayroll.summary.payroll.currentChangeThousands = 162.5;
expectState(mapBlsEmploymentReleaseToEventFacts(fractionalPayroll), 'MALFORMED',
  'REQUIRED_SUMMARY_VALUE_MALFORMED', 'fractional headline payroll');
const highPrecisionRate = clone(august);
highPrecisionRate.summary.unemploymentRate.levelPercent = 4.15;
expectState(mapBlsEmploymentReleaseToEventFacts(highPrecisionRate), 'MALFORMED',
  'REQUIRED_SUMMARY_VALUE_MALFORMED', 'unsupported unemployment precision');
const fractionalRevision = clone(august);
fractionalRevision.summary.payroll.priorRevisions[0].revisedChangeThousands = 31.5;
expectState(mapBlsEmploymentReleaseToEventFacts(fractionalRevision), 'MALFORMED',
  'PAYROLL_REVISION_VALUE_MALFORMED', 'fractional revision value');
const duplicatePeriod = clone(august);
duplicatePeriod.summary.payroll.priorRevisions[0].referencePeriod =
  clone(duplicatePeriod.summary.payroll.priorRevisions[1].referencePeriod);
expectState(mapBlsEmploymentReleaseToEventFacts(duplicatePeriod), 'CONFLICT',
  'PAYROLL_REVISION_PERIOD_CONFLICT', 'duplicate revision period');
const wrongRevisionPeriod = clone(august);
wrongRevisionPeriod.summary.payroll.priorRevisions[0].referencePeriod.month = 5;
expectState(mapBlsEmploymentReleaseToEventFacts(wrongRevisionPeriod), 'CONFLICT',
  'PAYROLL_REVISION_PERIOD_CONFLICT', 'non-consecutive revision period');

const contradictoryTitle = clone(august);
contradictoryTitle.release.headerTitle = 'THE EMPLOYMENT SITUATION - JULY 2026';
expectState(mapBlsEmploymentReleaseToEventFacts(contradictoryTitle), 'CONFLICT',
  'RELEASE_SUMMARY_PERIOD_CONFLICT', 'contradictory header period');
const contradictoryArtifact = clone(august);
contradictoryArtifact.summary.artifactPath = '/news.release/archives/empsit_08072026.htm';
expectState(mapBlsEmploymentReleaseToEventFacts(contradictoryArtifact), 'CONFLICT',
  'RELEASE_SUMMARY_PERIOD_CONFLICT', 'mismatched retained artifact');
const badArchive = clone(august);
badArchive.release.archivePath = 'https://example.com/empsit.htm';
expectState(mapBlsEmploymentReleaseToEventFacts(badArchive), 'MALFORMED',
  'RELEASE_ARCHIVE_PATH_MALFORMED', 'non-BLS archive grammar');

const wrongSeries = clone(august);
wrongSeries.summary.payroll.seriesId = 'CES0500000001';
expectState(mapBlsEmploymentReleaseToEventFacts(wrongSeries), 'UNSUPPORTED',
  'UNSUPPORTED_SERIES_MAPPING', 'wrong payroll series');
const unsupportedFamily = clone(august);
unsupportedFamily.release.releaseFamily = 'US_CPI';
expectState(mapBlsEmploymentReleaseToEventFacts(unsupportedFamily), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'unsupported family');
const unsupportedSource = clone(august);
unsupportedSource.source.sourceDomain = 'example.com';
expectState(mapBlsEmploymentReleaseToEventFacts(unsupportedSource), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'source tuple mismatch');
const extraKey = clone(august);
extraKey.summary.unemploymentRate.unexpected = true;
expectState(mapBlsEmploymentReleaseToEventFacts(extraKey), 'MALFORMED',
  'OFFICIAL_EVIDENCE_MALFORMED', 'extra projection key');
const missingShape = clone(august);
delete missingShape.summary.averageHourlyEarningsMom;
expectState(mapBlsEmploymentReleaseToEventFacts(missingShape), 'MALFORMED',
  'INVALID_SUMMARY_SHAPE', 'missing projection field');

const source = readFileSync(sourcePath, 'utf8');
const executableSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
test('pure adapter has no imports', !/^\s*import\s/m.test(executableSource));
test('no database or network access',
  !/\b(fetch|request|supabase|postgres|sql\s*`)/i.test(executableSource));
test('no environment, application clock, or randomness',
  !/process\.env|Date\.|new Date|Math\.random|crypto\.random/i.test(executableSource));
test('no LLM, market, legacy score, or price reaction dependency',
  !/Anthropic|OpenAI|LLM|news_score|gold_direction|market_reaction|price_action/i
    .test(executableSource));
test('no consensus provider accepted by payload contract',
  !/providerConsensus|consensusValue|forecastValue/.test(source));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
