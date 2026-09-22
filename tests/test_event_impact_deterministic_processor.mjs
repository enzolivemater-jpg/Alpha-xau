// Behavioral contract for PR-EI-3. The TypeScript module is transpiled and
// executed for real; static checks only complement the behavioral proof.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(
  __dirname,
  '..',
  'backend',
  'event_impact',
  'deterministic_processor.ts',
);

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

test('backend/event_impact/deterministic_processor.ts existe', existsSync(SOURCE_PATH));
const source = existsSync(SOURCE_PATH) ? readFileSync(SOURCE_PATH, 'utf8') : '';

let mod = null;
let tempDirectory = null;
try {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  tempDirectory = mkdtempSync(path.join(tmpdir(), 'event-impact-domain-'));
  const modulePath = path.join(tempDirectory, 'deterministic_processor.mjs');
  writeFileSync(modulePath, transpiled, 'utf8');
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.error('FAILED TO TRANSPILE/LOAD Event Impact processor:', error);
} finally {
  if (tempDirectory !== null) {
    try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('le module TypeScript transpile et se charge', mod !== null);
test('planDeterministicEventImpact est exporté', typeof mod?.planDeterministicEventImpact === 'function');
test(
  'version processeur V1 exportée',
  mod?.EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION === 'event-impact-deterministic-processor-v1',
);
test('schéma canonique supporté = 1', mod?.SUPPORTED_CANONICAL_EVENT_STATE_SCHEMA_VERSION === 1);

if (mod === null) {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const {
  EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
  planDeterministicEventImpact,
} = mod;

const EVENT_VERSION_ID = '11111111-1111-4111-8111-111111111111';
const CLUSTER_ID = '22222222-2222-4222-8222-222222222222';
const PREVIOUS_VERSION_ID = '33333333-3333-4333-8333-333333333333';

function canonicalState(overrides = {}) {
  return {
    event_type: 'MONETARY_POLICY_COMMUNICATION',
    subject: 'Federal Reserve issues FOMC statement',
    detail: 'The Committee maintained the target range.',
    ...overrides,
  };
}

function eventVersion(overrides = {}) {
  return {
    id: EVENT_VERSION_ID,
    clusterId: CLUSTER_ID,
    versionNumber: 1,
    transitionType: 'NOVELTY',
    knowledgeCutoff: '2026-09-22T00:00:00.123456+00:00',
    effectiveTime: null,
    effectiveTimePrecision: null,
    canonicalEventStateSchemaVersion: 1,
    canonicalEventState: canonicalState(),
    officialConfirmationState: 'OFFICIALLY_CONFIRMED',
    sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    supersedesVersionId: null,
    stateFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

function plan(overrides = {}) {
  return planDeterministicEventImpact({ eventVersion: eventVersion(overrides) });
}

function assertAbstain(result, expectedReason, label) {
  test(
    `${label}: ABSTAIN INVALID_INPUT/${expectedReason}`,
    result?.kind === 'ABSTAIN'
      && result.abstention === 'INVALID_INPUT'
      && result.reason === expectedReason,
    JSON.stringify(result),
  );
}

function assertConservativeProcess(result, label) {
  test(`${label}: kind=PROCESS`, result?.kind === 'PROCESS', JSON.stringify(result));
  test(
    `${label}: statut INSUFFICIENT_EVIDENCE`,
    result?.assessmentStatus === 'INSUFFICIENT_EVIDENCE',
    JSON.stringify(result),
  );
  test(
    `${label}: raison explicite Gold Transmission indisponible`,
    result?.assessmentReason === 'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE',
    JSON.stringify(result),
  );
  test(
    `${label}: zéro interprétation (aucun horizon/direction inventé)`,
    Array.isArray(result?.interpretations) && result.interpretations.length === 0,
    JSON.stringify(result),
  );
}

// ---------------------------------------------------------------------------
// 1. Valid schema-v1 contract: conservative assessment, exact as-of cutoff.
// ---------------------------------------------------------------------------
{
  const result = plan();
  assertConservativeProcess(result, 'Event Version v1 valide');
  test('eventVersionId préservé exactement', result.eventVersionId === EVENT_VERSION_ID);
  test('knowledgeCutoff microseconde préservé sans conversion',
    result.knowledgeCutoff === '2026-09-22T00:00:00.123456+00:00');
  test('producerType=DETERMINISTIC', result.producerType === 'DETERMINISTIC');
  test('algorithmVersion = version du processeur',
    result.algorithmVersion === EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION);
  test('schema version propagée', result.canonicalEventStateSchemaVersion === 1);
  test('aucun champ de résultat implicite supplémentaire',
    JSON.stringify(Object.keys(result).sort()) === JSON.stringify([
      'algorithmVersion',
      'assessmentReason',
      'assessmentStatus',
      'canonicalEventStateSchemaVersion',
      'eventVersionId',
      'interpretations',
      'kind',
      'knowledgeCutoff',
      'processorVersion',
      'producerType',
    ].sort()));
}

// Every current canonical event type is accepted, without a directional rule.
for (const eventType of [
  'MONETARY_POLICY_COMMUNICATION',
  'OFFICIAL_SPEECH',
  'CENTRAL_BANK_COMMUNICATION',
  'STATISTICAL_RELEASE',
  'OFFICIAL_PRESS_RELEASE',
  'SANCTIONS_ACTION',
]) {
  assertConservativeProcess(
    plan({ canonicalEventState: canonicalState({ event_type: eventType }) }),
    `event_type=${eventType}`,
  );
}

for (const transitionType of ['NOVELTY', 'CONFIRMATION', 'CORRECTION', 'REVERSAL']) {
  assertConservativeProcess(plan({ transitionType }), `transition=${transitionType}`);
}

for (const officialConfirmationState of [
  'UNCONFIRMED',
  'SECONDARY_CONFIRMED',
  'OFFICIALLY_CONFIRMED',
  'OFFICIALLY_CORRECTED',
  'OFFICIALLY_REVERSED',
]) {
  assertConservativeProcess(plan({ officialConfirmationState }), `confirmation=${officialConfirmationState}`);
}

for (const sourceIndependenceState of [
  'UNKNOWN',
  'SINGLE_EDITORIAL_ORIGIN',
  'SYNDICATED_ONLY',
  'INDEPENDENTLY_CORROBORATED',
]) {
  assertConservativeProcess(plan({ sourceIndependenceState }), `independence=${sourceIndependenceState}`);
}

assertConservativeProcess(plan({
  effectiveTime: '2026-09-23T14:30:00.000001Z',
  effectiveTimePrecision: 'MICROSECOND',
}), 'effective time explicite valide');

assertConservativeProcess(plan({
  versionNumber: 2,
  supersedesVersionId: PREVIOUS_VERSION_ID,
}), 'version successeur valide');

// ---------------------------------------------------------------------------
// 2. No lexical inference, no mutation, deterministic output.
// ---------------------------------------------------------------------------
{
  const variants = [
    ['Gold will surge after a dovish cut', 'Bullish dollar weakness and falling real yields'],
    ['Emergency tightening is hawkish', 'Gold crashes as yields rise'],
    ['Sanctions trigger safe-haven demand', 'Geopolitical risk escalates'],
    ['Neutral statement', null],
  ];
  const outputs = variants.map(([subject, detail]) => plan({
    canonicalEventState: canonicalState({ subject, detail }),
  }));
  for (const [index, output] of outputs.entries()) {
    assertConservativeProcess(output, `variante lexicale ${index + 1}`);
  }
  test('les mots de marché ne changent jamais le résultat V1',
    outputs.every((output) => JSON.stringify(output) === JSON.stringify(outputs[0])));
}

{
  const input = {
    eventVersion: eventVersion({
      canonicalEventState: canonicalState(),
    }),
  };
  const before = JSON.stringify(input);
  const first = planDeterministicEventImpact(input);
  const second = planDeterministicEventImpact(input);
  test('entrée non mutée', JSON.stringify(input) === before);
  test('deux appels identiques sont deep-equal', JSON.stringify(first) === JSON.stringify(second));
  test('tableau d’interprétations vide protégé contre la mutation', Object.isFrozen(first.interpretations));
}

// ---------------------------------------------------------------------------
// 3. Future canonical schema: explicit UNAVAILABLE, never guessed.
// ---------------------------------------------------------------------------
for (const schemaVersion of [2, 7, 999]) {
  const result = plan({
    canonicalEventStateSchemaVersion: schemaVersion,
    canonicalEventState: {
      arbitrary_future_shape: ['do', 'not', 'interpret'],
      direction: 'BULLISH',
      horizon: 'H6',
    },
  });
  test(`schéma futur ${schemaVersion}: PROCESS`, result.kind === 'PROCESS');
  test(`schéma futur ${schemaVersion}: UNAVAILABLE`, result.assessmentStatus === 'UNAVAILABLE');
  test(`schéma futur ${schemaVersion}: raison stable`,
    result.assessmentReason === 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
  test(`schéma futur ${schemaVersion}: zéro interprétation`, result.interpretations.length === 0);
}

// ---------------------------------------------------------------------------
// 4. Malformed common envelope: fail closed before any process plan.
// ---------------------------------------------------------------------------
for (const [label, input, reason] of [
  ['null root', null, 'INVALID_INPUT_SHAPE'],
  ['array root', [], 'INVALID_INPUT_SHAPE'],
  ['missing eventVersion', {}, 'INVALID_INPUT_SHAPE'],
  ['extra root key', { eventVersion: eventVersion(), extra: true }, 'INVALID_INPUT_SHAPE'],
  ['non-object eventVersion', { eventVersion: null }, 'INVALID_INPUT_SHAPE'],
]) {
  assertAbstain(planDeterministicEventImpact(input), reason, label);
}

{
  const missing = eventVersion();
  delete missing.clusterId;
  assertAbstain(planDeterministicEventImpact({ eventVersion: missing }), 'INVALID_EVENT_VERSION_SHAPE', 'champ manquant');
  assertAbstain(
    planDeterministicEventImpact({ eventVersion: { ...eventVersion(), createdAt: '2026-09-22T00:00:01Z' } }),
    'INVALID_EVENT_VERSION_SHAPE',
    'champ inconnu',
  );
}

for (const [field, value, reason] of [
  ['id', 'not-a-uuid', 'INVALID_EVENT_VERSION_ID'],
  ['clusterId', 'not-a-uuid', 'INVALID_CLUSTER_ID'],
  ['versionNumber', 0, 'INVALID_VERSION_NUMBER'],
  ['versionNumber', 1.5, 'INVALID_VERSION_NUMBER'],
  ['transitionType', 'UPDATE', 'INVALID_TRANSITION_TYPE'],
  ['knowledgeCutoff', '2026-02-30T00:00:00Z', 'INVALID_KNOWLEDGE_CUTOFF'],
  ['knowledgeCutoff', '2026-09-22T00:00:00', 'INVALID_KNOWLEDGE_CUTOFF'],
  ['knowledgeCutoff', '2026-09-22T24:00:00Z', 'INVALID_KNOWLEDGE_CUTOFF'],
  ['knowledgeCutoff', '2026-09-22T00:00:00+24:00', 'INVALID_KNOWLEDGE_CUTOFF'],
  ['effectiveTime', 'tomorrow', 'INVALID_EFFECTIVE_TIME'],
  ['canonicalEventStateSchemaVersion', 0, 'INVALID_CANONICAL_EVENT_STATE_SCHEMA_VERSION'],
  ['canonicalEventStateSchemaVersion', 1.5, 'INVALID_CANONICAL_EVENT_STATE_SCHEMA_VERSION'],
  ['officialConfirmationState', 'CONFIRMED', 'INVALID_OFFICIAL_CONFIRMATION_STATE'],
  ['sourceIndependenceState', 'TWO_SOURCES', 'INVALID_SOURCE_INDEPENDENCE_STATE'],
  ['supersedesVersionId', 'not-a-uuid', 'INVALID_SUPERSEDES_VERSION_ID'],
  ['stateFingerprint', 'A'.repeat(64), 'INVALID_STATE_FINGERPRINT'],
  ['stateFingerprint', 'a'.repeat(63), 'INVALID_STATE_FINGERPRINT'],
]) {
  assertAbstain(plan({ [field]: value }), reason, `${field} invalide`);
}

assertAbstain(
  plan({ effectiveTime: null, effectiveTimePrecision: 'SECOND' }),
  'INVALID_EFFECTIVE_TIME_PRECISION',
  'precision sans effective time',
);
assertAbstain(
  plan({ effectiveTime: '2026-09-22T00:00:00Z', effectiveTimePrecision: '  SECOND' }),
  'INVALID_EFFECTIVE_TIME_PRECISION',
  'precision non canonique',
);

// ---------------------------------------------------------------------------
// 5. Schema-v1 canonical state is exact and cannot smuggle analytics.
// ---------------------------------------------------------------------------
for (const [label, state] of [
  ['null', null],
  ['array', []],
  ['missing detail', { event_type: 'OFFICIAL_SPEECH', subject: 'Subject' }],
  ['unknown key', { ...canonicalState(), direction: 'BULLISH' }],
  ['unknown event type', canonicalState({ event_type: 'MARKET_MOVE' })],
  ['blank subject', canonicalState({ subject: '   ' })],
  ['non-canonical subject', canonicalState({ subject: 'Two  spaces' })],
  ['blank detail', canonicalState({ detail: '' })],
  ['non-canonical detail', canonicalState({ detail: ' trailing ' })],
]) {
  assertAbstain(
    plan({ canonicalEventState: state }),
    'INVALID_CANONICAL_EVENT_STATE_V1',
    `canonical state ${label}`,
  );
}

assertConservativeProcess(
  plan({ canonicalEventState: canonicalState({ detail: null }) }),
  'detail null valide',
);

// ---------------------------------------------------------------------------
// 6. Static architecture boundary.
// ---------------------------------------------------------------------------
const executableSource = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

test('aucun import exécutable', !/^\s*import\s/m.test(executableSource));
for (const token of [
  '@supabase',
  'fetch(',
  'process.env',
  'Date.now(',
  'new Date(',
  'Math.random(',
  'crypto.',
  'news_events',
  'gold_direction_impact',
  'expected_move_usd',
  'news_score',
  'market_regime',
  'ai_scenarios',
  'Anthropic',
  'OpenAI',
  'Gemini',
]) {
  test(`aucune dépendance/inférence interdite: ${token}`, !executableSource.includes(token));
}
test('aucune branche H6 dans le contrat', !/['"]H6['"]/.test(source));
test('aucune logique lexicale sur subject/detail',
  !/(subject|detail)\s*\.\s*(includes|match|search|startsWith|endsWith)\s*\(/.test(executableSource));
test('aucun switch sur event_type (validation seulement, pas règle directionnelle)',
  !/switch\s*\([^)]*event_type/.test(executableSource));
test('aucune sortie ASSESSED en V1', !/processPlan\([^)]*'ASSESSED'/.test(executableSource));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
