import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLS_CPI_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
  BLS_CPI_EVENT_FACTS_ADAPTER_VERSION,
  mapBlsCpiReleaseToEventFacts,
  resolveBlsCpiReleaseIdentity,
} from '../backend/event_facts/bls_cpi_adapter.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'backend', 'event_facts', 'bls_cpi_adapter.ts');
const fixturePath = month => path.join(
  root, 'tests', 'fixtures', `bls_cpi_table1_2026_${String(month).padStart(2, '0')}.json`,
);
const fixture = month => JSON.parse(readFileSync(fixturePath(month), 'utf8'));
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

test('adapter version frozen', BLS_CPI_EVENT_FACTS_ADAPTER_VERSION
  === 'bls-cpi-event-facts-adapter-v1');
test('CES schema version frozen at 2', BLS_CPI_CANONICAL_EVENT_STATE_SCHEMA_VERSION === 2);

const august = fixture(8);
const july = fixture(7);
const before = JSON.stringify(august);
const result = mapBlsCpiReleaseToEventFacts(august);
const replay = mapBlsCpiReleaseToEventFacts(august);

test('August official fixture resolves', result.kind === 'RESOLVED', JSON.stringify(result));
test('mapping is byte deterministic', JSON.stringify(result) === JSON.stringify(replay));
test('input is not mutated', JSON.stringify(august) === before);
if (result.kind !== 'RESOLVED') process.exit(1);

test('official release identity namespace exact', result.releaseIdentity.authorityNamespace
  === 'xau_v2:official_release:us_bls:v1');
test('official release identity type exact', result.releaseIdentity.identityType
  === 'official_release_id:bls_cpi_v1');
test('identity value canonical JSON exact', result.releaseIdentity.identityValue === JSON.stringify({
  authority: 'us_bls',
  release_family: 'US_CPI',
  release_id: 'USDL-26-1496',
  release_stage: 'SINGLE',
  strategy: 'OFFICIAL_RELEASE_ID',
  strategy_version: 'bls_cpi_v1',
}));
test('identity JSON keys are lexicographically ordered',
  Object.keys(JSON.parse(result.releaseIdentity.identityValue)).join(',')
  === [...Object.keys(JSON.parse(result.releaseIdentity.identityValue))].sort().join(','));

const identityKey = createHash('sha256').update([
  result.releaseIdentity.authorityNamespace,
  result.releaseIdentity.identityType,
  result.releaseIdentity.identityValue,
].join('\u001f')).digest('hex');
test('existing three-part strong identity formula accepts exact output', /^[0-9a-f]{64}$/.test(identityKey));

test('CES V2 emitted explicitly', result.canonicalEventStateSchemaVersion === 2);
test('release family exact', result.canonicalEventState.facts.release_family === 'US_CPI');
test('subject deterministic', result.canonicalEventState.subject
  === 'US Bureau of Labor Statistics releases August 2026 Consumer Price Index');
test('detail remains null', result.canonicalEventState.detail === null);

const metrics = result.canonicalEventState.facts.metrics;
test('exactly four reviewed CPI metrics', metrics.length === 4);
test('metrics sorted by metric_code', metrics.map(metric => metric.metric_code).join(',')
  === 'CPI_CORE_MOM,CPI_CORE_YOY,CPI_HEADLINE_MOM,CPI_HEADLINE_YOY');
test('all metrics use source reference month', metrics.every(metric =>
  JSON.stringify(metric.reference_period) === JSON.stringify({ kind: 'MONTH', year: 2026, month: 8 })));
test('official source never fabricates consensus', metrics.every(metric =>
  metric.consensus.state === 'UNKNOWN' && metric.consensus.value === null));
test('no unsupported prior-period reconstruction', metrics.every(metric =>
  Array.isArray(metric.prior_periods) && metric.prior_periods.length === 0));
test('headline MoM mapped from seasonally adjusted cell', metrics.find(metric =>
  metric.metric_code === 'CPI_HEADLINE_MOM')?.actual.value === '0.4');
test('headline YoY mapped from unadjusted cell', metrics.find(metric =>
  metric.metric_code === 'CPI_HEADLINE_YOY')?.actual.value === '3.4');
test('core MoM mapped from seasonally adjusted cell', metrics.find(metric =>
  metric.metric_code === 'CPI_CORE_MOM')?.actual.value === '0.3');
test('core YoY mapped from unadjusted cell', metrics.find(metric =>
  metric.metric_code === 'CPI_CORE_YOY')?.actual.value === '2.4');

const reversedRows = clone(august);
reversedRows.table1.rows.reverse();
const reversedRowsResult = mapBlsCpiReleaseToEventFacts(reversedRows);
test('source row order carries no meaning', reversedRowsResult.kind === 'RESOLVED'
  && JSON.stringify(reversedRowsResult) === JSON.stringify(result));

const negativeZero = clone(august);
negativeZero.table1.rows[0].seasonallyAdjustedMoM = -0;
const negativeZeroResult = mapBlsCpiReleaseToEventFacts(negativeZero);
test('negative zero canonicalizes to unsigned zero', negativeZeroResult.kind === 'RESOLVED'
  && negativeZeroResult.canonicalEventState.facts.metrics.find(metric =>
    metric.metric_code === 'CPI_HEADLINE_MOM')?.actual.value === '0');

const julyResult = mapBlsCpiReleaseToEventFacts(july);
test('consecutive official fixture resolves', julyResult.kind === 'RESOLVED', JSON.stringify(julyResult));
test('consecutive release has different identity', julyResult.kind === 'RESOLVED'
  && julyResult.releaseIdentity.identityValue !== result.releaseIdentity.identityValue);

const corrected = clone(august);
corrected.table1.rows[0].seasonallyAdjustedMoM = 0.5;
const correctedResult = mapBlsCpiReleaseToEventFacts(corrected);
test('same-release correction remains resolvable', correctedResult.kind === 'RESOLVED');
test('same release ID keeps identity across correction', correctedResult.kind === 'RESOLVED'
  && correctedResult.releaseIdentity.identityValue === result.releaseIdentity.identityValue);
test('correction changes factual output, not identity', correctedResult.kind === 'RESOLVED'
  && correctedResult.canonicalEventState.facts.metrics.find(metric =>
    metric.metric_code === 'CPI_HEADLINE_MOM')?.actual.value === '0.5');

const identityWithChangedFacts = resolveBlsCpiReleaseIdentity(corrected);
test('multiple metrics cannot alter release identity', !('kind' in identityWithChangedFacts)
  && identityWithChangedFacts.identityValue === result.releaseIdentity.identityValue);
const identityWithChangedPeriod = clone(august);
identityWithChangedPeriod.table1.referencePeriod.month = 7;
const periodIndependentIdentity = resolveBlsCpiReleaseIdentity(identityWithChangedPeriod);
test('metric/reference period cannot become release identity', !('kind' in periodIndependentIdentity)
  && periodIndependentIdentity.identityValue === result.releaseIdentity.identityValue);
const identityWithChangedArtifact = clone(august);
identityWithChangedArtifact.table1.artifactPath = '/official/representation-two.xlsx';
const artifactIndependentIdentity = resolveBlsCpiReleaseIdentity(identityWithChangedArtifact);
test('official artifact path cannot become release identity', !('kind' in artifactIndependentIdentity)
  && artifactIndependentIdentity.identityValue === result.releaseIdentity.identityValue);

const missingId = clone(august);
missingId.release.releaseId = null;
expectState(mapBlsCpiReleaseToEventFacts(missingId), 'UNAVAILABLE',
  'OFFICIAL_RELEASE_ID_UNAVAILABLE', 'missing official release ID');
const urlOnly = clone(august);
urlOnly.release.releaseId = null;
urlOnly.release.headerTitle = 'CONSUMER PRICE INDEX - AUGUST 2026';
expectState(mapBlsCpiReleaseToEventFacts(urlOnly), 'UNAVAILABLE',
  'OFFICIAL_RELEASE_ID_UNAVAILABLE', 'URL/title/period-only evidence');

const malformedId = clone(august);
malformedId.release.releaseId = ' usdl-26-1496 ';
expectState(mapBlsCpiReleaseToEventFacts(malformedId), 'MALFORMED',
  'OFFICIAL_RELEASE_ID_MALFORMED', 'malformed release ID');
const malformedValue = clone(august);
malformedValue.table1.rows[0].seasonallyAdjustedMoM = 0.45;
expectState(mapBlsCpiReleaseToEventFacts(malformedValue), 'MALFORMED',
  'REQUIRED_TABLE_VALUE_MALFORMED', 'unsupported source precision');
const exponentialValue = clone(august);
exponentialValue.table1.rows[0].seasonallyAdjustedMoM = 1e21;
expectState(mapBlsCpiReleaseToEventFacts(exponentialValue), 'MALFORMED',
  'REQUIRED_TABLE_VALUE_MALFORMED', 'exponential output forbidden');
const duplicateRow = clone(august);
duplicateRow.table1.rows[1] = clone(duplicateRow.table1.rows[0]);
expectState(mapBlsCpiReleaseToEventFacts(duplicateRow), 'MALFORMED',
  'REQUIRED_TABLE_ROWS_MISSING_OR_DUPLICATED', 'duplicate required row');
const extraKey = clone(august);
extraKey.table1.rows[0].unexpected = true;
expectState(mapBlsCpiReleaseToEventFacts(extraKey), 'MALFORMED',
  'TABLE_ROW_SHAPE_MALFORMED', 'extra source projection key');

const contradictoryTitle = clone(august);
contradictoryTitle.release.headerTitle = 'CONSUMER PRICE INDEX - JULY 2026';
expectState(mapBlsCpiReleaseToEventFacts(contradictoryTitle), 'CONFLICT',
  'RELEASE_TABLE_PERIOD_CONFLICT', 'contradictory official periods');
const contradictoryArtifact = clone(august);
contradictoryArtifact.table1.artifactPath =
  '/cpi/tables/supplemental-files/news-release-table1-202607.xlsx';
expectState(mapBlsCpiReleaseToEventFacts(contradictoryArtifact), 'CONFLICT',
  'RELEASE_TABLE_PERIOD_CONFLICT', 'wrong monthly workbook');

const unsupportedFamily = clone(august);
unsupportedFamily.release.releaseFamily = 'US_PPI';
expectState(mapBlsCpiReleaseToEventFacts(unsupportedFamily), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'unsupported release family');
const unsupportedStage = clone(august);
unsupportedStage.release.releaseStage = 'ADVANCE';
expectState(mapBlsCpiReleaseToEventFacts(unsupportedStage), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'unsupported staged release');
const unsupportedSource = clone(august);
unsupportedSource.source.sourceDomain = 'example.com';
expectState(mapBlsCpiReleaseToEventFacts(unsupportedSource), 'UNSUPPORTED',
  'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE', 'source tuple mismatch');

const missingTable = clone(august);
missingTable.table1.rows = null;
expectState(mapBlsCpiReleaseToEventFacts(missingTable), 'UNAVAILABLE',
  'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE', 'missing XLSX rows');
const malformedShape = clone(august);
delete malformedShape.table1.columns;
expectState(mapBlsCpiReleaseToEventFacts(malformedShape), 'MALFORMED',
  'INVALID_TABLE1_SHAPE', 'missing projection field');

const source = readFileSync(sourcePath, 'utf8');
const executableSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
test('pure adapter has no imports', !/^\s*import\s/m.test(executableSource));
test('no database or network access', !/\b(fetch|request|supabase|postgres|sql\s*`)/i.test(executableSource));
test('no environment, application clock, or randomness',
  !/process\.env|Date\.|new Date|Math\.random|crypto\.random/i.test(executableSource));
test('no LLM, market, legacy score, or price reaction dependency',
  !/Anthropic|OpenAI|LLM|news_score|gold_direction|market_reaction|price_action/i.test(executableSource));
test('no consensus provider accepted by payload contract', !/providerConsensus|consensusValue|forecastValue/.test(source));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
