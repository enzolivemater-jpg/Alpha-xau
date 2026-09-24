// Behavioral and isolation contract for the pure GT-3 processor.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'backend', 'gold_transmission', 'deterministic_processor.ts');
let passed = 0;
let failed = 0;
function test(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

test('processor source exists', existsSync(sourcePath));
const source = readFileSync(sourcePath, 'utf8');
const executableSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
let mod = null;
let temp = null;
try {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  temp = mkdtempSync(path.join(tmpdir(), 'gold-transmission-domain-'));
  const modulePath = path.join(temp, 'processor.mjs');
  writeFileSync(modulePath, js, 'utf8');
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.error(error);
} finally {
  if (temp !== null) rmSync(temp, { recursive: true, force: true });
}

test('module transpiles and loads', mod !== null);
test('planner exported', typeof mod?.planDeterministicGoldTransmission === 'function');
test('processor version frozen', mod?.GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION
  === 'gold-transmission-deterministic-processor-v2');
test('supported event schema is exactly v2', mod?.GOLD_TRANSMISSION_SUPPORTED_EVENT_SCHEMA_VERSION === 2);
if (mod === null) process.exit(1);

const eventId = '11111111-1111-4111-8111-111111111111';
const clusterId = '22222222-2222-4222-8222-222222222222';
function eventVersion(overrides = {}) {
  return {
    id: eventId,
    clusterId,
    versionNumber: 1,
    transitionType: 'NOVELTY',
    knowledgeCutoff: '2026-09-22T00:00:00.123456+00:00',
    effectiveTime: null,
    effectiveTimePrecision: null,
    canonicalEventStateSchemaVersion: 1,
    canonicalEventState: {
      event_type: 'STATISTICAL_RELEASE',
      subject: 'Official statistical release',
      detail: 'Typed actual and forecast values are not present.',
    },
    officialConfirmationState: 'OFFICIALLY_CONFIRMED',
    sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    supersedesVersionId: null,
    stateFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}
function plan(overrides = {}) {
  return mod.planDeterministicGoldTransmission({ eventVersion: eventVersion(overrides) });
}
function cpiState() {
  const metric = (metric_code, unit, value) => ({
    metric_code, reference_period: { kind: 'MONTH', year: 2026, month: 8 }, unit,
    actual: { state: 'KNOWN', value }, consensus: { state: 'UNKNOWN', value: null }, prior_periods: [],
  });
  return { event_type: 'STATISTICAL_RELEASE', subject: 'US Bureau of Labor Statistics releases August 2026 Consumer Price Index', detail: null,
    facts: { release_family: 'US_CPI', metrics: [
      metric('CPI_CORE_MOM', 'PERCENT_CHANGE_MOM', '0.3'), metric('CPI_CORE_YOY', 'PERCENT_CHANGE_YOY', '3.1'),
      metric('CPI_HEADLINE_MOM', 'PERCENT_CHANGE_MOM', '0.4'), metric('CPI_HEADLINE_YOY', 'PERCENT_CHANGE_YOY', '2.9'),
    ] } };
}
function conservative(result, label) {
  test(`${label}: PROCESS`, result?.kind === 'PROCESS', JSON.stringify(result));
  test(`${label}: insufficient evidence`, result?.assessmentStatus === 'INSUFFICIENT_EVIDENCE');
  test(`${label}: typed facts reason`, result?.assessmentReason === 'TYPED_EVENT_FACTS_UNAVAILABLE');
  test(`${label}: zero paths`, Array.isArray(result?.paths) && result.paths.length === 0);
}
function abstains(result, reason, label) {
  test(`${label}: abstains ${reason}`, result?.kind === 'ABSTAIN'
    && result.abstention === 'INVALID_INPUT' && result.reason === reason, JSON.stringify(result));
}

const valid = plan();
conservative(valid, 'valid Event Version v1');
test('eventVersionId preserved', valid.eventVersionId === eventId);
test('microsecond cutoff preserved without conversion',
  valid.knowledgeCutoff === '2026-09-22T00:00:00.123456+00:00');
test('producer is deterministic', valid.producerType === 'DETERMINISTIC');
test('algorithm version equals processor version', valid.algorithmVersion
  === mod.GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION);

for (const event_type of [
  'MONETARY_POLICY_COMMUNICATION', 'OFFICIAL_SPEECH', 'CENTRAL_BANK_COMMUNICATION',
  'STATISTICAL_RELEASE', 'OFFICIAL_PRESS_RELEASE', 'SANCTIONS_ACTION',
]) {
  conservative(plan({ canonicalEventState: {
    event_type, subject: 'Canonical subject', detail: null,
  } }), `event_type=${event_type}`);
}

const lexicalVariants = [
  ['Dovish cut sends gold higher', 'Dollar and real yields collapse'],
  ['Hawkish surprise sends gold lower', 'Dollar and yields surge'],
  ['War escalation creates safe-haven bid', 'Gold explodes higher'],
  ['Neutral text', null],
].map(([subject, detail]) => plan({ canonicalEventState: {
  event_type: 'OFFICIAL_PRESS_RELEASE', subject, detail,
} }));
for (const [index, result] of lexicalVariants.entries()) conservative(result, `lexical variant ${index + 1}`);
test('market prose never changes the plan', lexicalVariants.every(result => JSON.stringify(result)
  === JSON.stringify(lexicalVariants[0])));

const input = { eventVersion: eventVersion() };
const before = JSON.stringify(input);
const first = mod.planDeterministicGoldTransmission(input);
const second = mod.planDeterministicGoldTransmission(input);
test('deterministic byte-for-byte output', JSON.stringify(first) === JSON.stringify(second));
test('input is not mutated', JSON.stringify(input) === before);
test('shared empty paths cannot be mutated', Object.isFrozen(first.paths));

const cpi = plan({ canonicalEventStateSchemaVersion: 2, canonicalEventState: cpiState() });
test('valid US_CPI v2 consumes typed facts conservatively', cpi.kind === 'PROCESS'
  && cpi.assessmentStatus === 'INSUFFICIENT_EVIDENCE'
  && cpi.assessmentReason === 'CONSENSUS_FACTS_UNAVAILABLE' && cpi.paths.length === 0);
abstains(plan({ canonicalEventStateSchemaVersion: 2, canonicalEventState: { ...cpiState(), extra: true } }),
  'INVALID_CANONICAL_EVENT_STATE_V2', 'malformed v2');
const future = plan({ canonicalEventStateSchemaVersion: 3, canonicalEventState: { any: 'shape' } });
test('future schema produces UNAVAILABLE', future.kind === 'PROCESS'
  && future.assessmentStatus === 'UNAVAILABLE'
  && future.assessmentReason === 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA'
  && future.paths.length === 0);

abstains(mod.planDeterministicGoldTransmission(null), 'INVALID_INPUT_SHAPE', 'null input');
abstains(mod.planDeterministicGoldTransmission({}), 'INVALID_INPUT_SHAPE', 'missing eventVersion');
abstains(plan({ id: 'not-a-uuid' }), 'INVALID_EVENT_VERSION_ID', 'invalid id');
abstains(plan({ knowledgeCutoff: '2026-02-30T00:00:00Z' }), 'INVALID_KNOWLEDGE_CUTOFF', 'invalid date');
abstains(plan({ canonicalEventState: {
  event_type: 'STATISTICAL_RELEASE', subject: ' Gold rises ', detail: null,
} }), 'INVALID_CANONICAL_EVENT_STATE_V1', 'non-canonical whitespace');
abstains(plan({ canonicalEventState: {
  event_type: 'STATISTICAL_RELEASE', subject: 'Valid', detail: null, actual: 3.2,
} }), 'INVALID_CANONICAL_EVENT_STATE_V1', 'undeclared typed field cannot sneak into v1');

test('no imports', !/^\s*import\s/m.test(executableSource));
test('no database or network call', !/\b(fetch|request|supabase|postgres|sql\s*`)/i.test(executableSource));
test('no environment or clock read', !/process\.env|Date\.|new Date|transaction_timestamp|now\s*\(/.test(executableSource));
test('no legacy scoring or Committee dependency', !/news_score|gold_direction_impact|expected_move_usd|Committee|Anthropic/i.test(executableSource));
test('no lexical inference API', !/\.includes\(|\.match\(|keyword|regex.*market/i.test(executableSource));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
