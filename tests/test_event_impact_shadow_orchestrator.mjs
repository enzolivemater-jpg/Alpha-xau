// Behavioral contract for PR-EI-4. Transpiles and executes the real
// orchestrator with the real PR-EI-3 processor against a deterministic DB port.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_PATH = path.join(__dirname, '..', 'backend', 'event_impact', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(__dirname, '..', 'backend', 'event_impact', 'deterministic_processor.ts');

let passed = 0;
let failed = 0;
const test = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

test('shadow_orchestrator.ts existe', existsSync(ORCHESTRATOR_PATH));

const orchestratorSource = existsSync(ORCHESTRATOR_PATH) ? readFileSync(ORCHESTRATOR_PATH, 'utf8') : '';
const processorSource = existsSync(PROCESSOR_PATH) ? readFileSync(PROCESSOR_PATH, 'utf8') : '';

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
}

let mod = null;
let tempDirectory = null;
try {
  tempDirectory = mkdtempSync(path.join(tmpdir(), 'event-impact-shadow-'));
  writeFileSync(path.join(tempDirectory, 'deterministic_processor.mjs'), transpile(processorSource), 'utf8');
  const orchestrator = transpile(orchestratorSource).replace(
    /(['"])\.\/deterministic_processor\.js\1/,
    '$1./deterministic_processor.mjs$1',
  );
  const modulePath = path.join(tempDirectory, 'shadow_orchestrator.mjs');
  writeFileSync(modulePath, orchestrator, 'utf8');
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.error('FAILED TO TRANSPILE/LOAD Event Impact shadow orchestrator:', error);
} finally {
  if (tempDirectory !== null) {
    try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('orchestrateur et processeur réels se chargent', mod !== null);
test('processEventImpactShadowVersion exportée', typeof mod?.processEventImpactShadowVersion === 'function');
test('guard plan exporté', typeof mod?.assertSupportedEventImpactPlan === 'function');
test('canonical serializer exporté', typeof mod?.canonicalStringifyEventImpact === 'function');
test('SHA-256 helper exporté', typeof mod?.sha256EventImpact === 'function');
test('erreur typée exportée', typeof mod?.EventImpactShadowInvariantError === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const {
  processEventImpactShadowVersion,
  assertSupportedEventImpactPlan,
  canonicalStringifyEventImpact,
  sha256EventImpact,
  EventImpactShadowInvariantError,
  EVENT_IMPACT_SHADOW_ORCHESTRATOR_VERSION,
  EVENT_IMPACT_SHADOW_PRODUCER_ACTOR,
} = mod;

const EVENT_VERSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_EVENT_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const CLUSTER_ID = '33333333-3333-4333-8333-333333333333';
const ASSESSMENT_ID = '44444444-4444-4444-8444-444444444444';
const CUTOFF = '2026-09-22T00:00:00.123456+00:00';

function makeEventVersionRow(overrides = {}) {
  return {
    id: EVENT_VERSION_ID,
    cluster_id: CLUSTER_ID,
    version_number: 1,
    transition_type: 'NOVELTY',
    knowledge_cutoff: CUTOFF,
    effective_time: null,
    effective_time_precision: null,
    canonical_event_state_schema_version: 1,
    canonical_event_state: {
      event_type: 'MONETARY_POLICY_COMMUNICATION',
      subject: 'Federal Reserve issues FOMC statement',
      detail: 'The Committee maintained the target range.',
    },
    official_confirmation_state: 'OFFICIALLY_CONFIRMED',
    source_independence_state: 'SINGLE_EDITORIAL_ORIGIN',
    supersedes_version_id: null,
    state_fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

function makeRpcRow(overrides = {}) {
  return { assessment_id: ASSESSMENT_ID, replayed: false, interpretation_count: 0, ...overrides };
}

function makeAssessmentRow(body, overrides = {}) {
  return {
    id: ASSESSMENT_ID,
    event_version_id: body.p_event_version_id,
    assessment_status: body.p_assessment_status,
    knowledge_cutoff: body.p_knowledge_cutoff,
    producer_type: body.p_producer_type,
    producer_actor: body.p_producer_actor,
    algorithm_version: body.p_algorithm_version,
    input_fingerprint: body.p_input_fingerprint,
    semantic_fingerprint: body.p_semantic_fingerprint,
    idempotency_fingerprint: body.p_idempotency_fingerprint,
    supersedes_assessment_id: body.p_supersedes_assessment_id,
    ...overrides,
  };
}

function makeDb(options = {}) {
  const calls = [];
  const persistenceBodies = [];
  let persistenceAttempts = 0;
  const db = {
    async request(method, requestPath, body, extraHeaders) {
      calls.push({ method, path: requestPath, body, extraHeaders });
      if (requestPath.startsWith('event_versions?')) {
        return options.eventVersionRows ?? [makeEventVersionRow(options.eventVersionOverrides)];
      }
      if (requestPath === 'rpc/fn_event_impact_create_assessment') {
        persistenceAttempts += 1;
        persistenceBodies.push(structuredClone(body));
        if (options.failFirstPersistence && persistenceAttempts === 1) {
          throw new Error('synthetic lost response after commit');
        }
        if (options.rpcRows) return options.rpcRows;
        return [makeRpcRow({ replayed: options.replayAfterFirst ? persistenceAttempts > 1 : Boolean(options.replayed) })];
      }
      if (requestPath.startsWith('event_impact_assessments?')) {
        const lastBody = persistenceBodies.at(-1);
        if (options.assessmentRows) return options.assessmentRows(lastBody);
        return [makeAssessmentRow(lastBody, options.assessmentOverrides)];
      }
      if (requestPath.startsWith('event_impact_interpretations?')) {
        return options.interpretationRows ?? [];
      }
      throw new Error(`unexpected DB call: ${method} ${requestPath}`);
    },
  };
  return { db, calls, persistenceBodies };
}

async function expectError(fn, label, code = null) {
  try {
    await fn();
    test(label, false, 'expected rejection');
    return null;
  } catch (error) {
    test(label, code === null || (error instanceof EventImpactShadowInvariantError && error.code === code), String(error));
    return error;
  }
}

// Happy path: exact explicit read -> one RPC -> exact parent/child read-back.
{
  const { db, calls, persistenceBodies } = makeDb();
  const result = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  const body = persistenceBodies[0];
  test('happy path PROCESSED', result.kind === 'PROCESSED', JSON.stringify(result));
  test('status conservateur', result.assessmentStatus === 'INSUFFICIENT_EVIDENCE');
  test('raison explicite', result.assessmentReason === 'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE');
  test('zéro interprétation', result.interpretationCount === 0);
  test('cutoff microseconde préservé', result.knowledgeCutoff === CUTOFF);
  test('assessment non replay initial', result.assessmentReplayed === false);
  test('versions exposées', result.orchestratorVersion === EVENT_IMPACT_SHADOW_ORCHESTRATOR_VERSION
    && typeof result.processorVersion === 'string');
  test('séquence exacte de quatre appels', calls.length === 4
    && calls[0].method === 'GET'
    && calls[1].path === 'rpc/fn_event_impact_create_assessment'
    && calls[2].path.startsWith('event_impact_assessments?')
    && calls[3].path.startsWith('event_impact_interpretations?'));
  test('lecture Event Version ciblée, sans wildcard', calls[0].path.includes(`id=eq.${EVENT_VERSION_ID}`)
    && calls[0].path.includes('&select=id,cluster_id,') && !calls[0].path.includes('select=*'));
  test('payload RPC exact', JSON.stringify(Object.keys(body).sort()) === JSON.stringify([
    'p_algorithm_version', 'p_assessment_status', 'p_event_version_id',
    'p_idempotency_fingerprint', 'p_input_fingerprint', 'p_interpretations',
    'p_knowledge_cutoff', 'p_producer_actor', 'p_producer_type',
    'p_semantic_fingerprint', 'p_supersedes_assessment_id',
  ].sort()));
  test('payload provenance déterministe', body.p_producer_type === 'DETERMINISTIC'
    && body.p_producer_actor === EVENT_IMPACT_SHADOW_PRODUCER_ACTOR
    && body.p_algorithm_version === result.processorVersion);
  test('payload sans analytique inventée', body.p_assessment_status === 'INSUFFICIENT_EVIDENCE'
    && body.p_interpretations.length === 0 && body.p_supersedes_assessment_id === null);
  for (const [name, value] of [
    ['input', body.p_input_fingerprint],
    ['semantic', body.p_semantic_fingerprint],
    ['idempotency', body.p_idempotency_fingerprint],
  ]) test(`empreinte ${name} SHA-256 minuscule`, /^[0-9a-f]{64}$/.test(value));
  test('domaines produisent trois empreintes distinctes', new Set([
    body.p_input_fingerprint, body.p_semantic_fingerprint, body.p_idempotency_fingerprint,
  ]).size === 3);
}

// Exact replay: every request fact and fingerprint is stable.
{
  const { db, persistenceBodies } = makeDb({ replayAfterFirst: true });
  const first = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  const second = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  test('premier appel créé, second replay', !first.assessmentReplayed && second.assessmentReplayed);
  test('replay retourne le même assessment', first.assessmentId === second.assessmentId);
  test('payloads de rejeu byte-equivalent JSON', JSON.stringify(persistenceBodies[0]) === JSON.stringify(persistenceBodies[1]));
  test('résultat conserve les mêmes empreintes', first.inputFingerprint === second.inputFingerprint
    && first.semanticFingerprint === second.semanticFingerprint
    && first.idempotencyFingerprint === second.idempotencyFingerprint);
}

// Lost response after commit: retry is exactly the same RPC intent.
{
  const { db, persistenceBodies } = makeDb({ failFirstPersistence: true, replayAfterFirst: true });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), 'réponse perdue propagée');
  const recovered = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  test('reprise après réponse perdue = replay', recovered.kind === 'PROCESSED' && recovered.assessmentReplayed);
  test('reprise réutilise exactement le payload', JSON.stringify(persistenceBodies[0]) === JSON.stringify(persistenceBodies[1]));
}

// No row and invalid caller id never mutate.
{
  const { db, calls } = makeDb({ eventVersionRows: [] });
  const result = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  test('Event Version absente = SKIPPED', result.kind === 'SKIPPED' && result.reason === 'EVENT_VERSION_NOT_FOUND');
  test('Event Version absente = une lecture seulement', calls.length === 1 && calls[0].method === 'GET');
}
{
  const { db, calls } = makeDb();
  await expectError(() => processEventImpactShadowVersion(db, 'not-a-uuid'), 'id appelant invalide rejeté', 'INVALID_EVENT_VERSION_ID');
  test('id invalide rejeté avant DB', calls.length === 0);
}

// Row-count/identity invariants before processor or mutation.
{
  const { db, calls } = makeDb({ eventVersionRows: [makeEventVersionRow(), makeEventVersionRow()] });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), 'deux lignes Event Version rejetées', 'EVENT_VERSION_ROW_COUNT_INVARIANT');
  test('row-count invariant avant write', calls.length === 1);
}
{
  const { db, calls } = makeDb({ eventVersionOverrides: { id: OTHER_EVENT_VERSION_ID } });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), 'identité Event Version divergente rejetée', 'EVENT_VERSION_IDENTITY_MISMATCH');
  test('identity mismatch avant write', calls.length === 1);
}

// Malformed persisted rows become explicit processor abstentions, no RPC.
for (const [label, overrides, reason] of [
  ['fingerprint majuscule', { state_fingerprint: 'A'.repeat(64) }, 'INVALID_STATE_FINGERPRINT'],
  ['subject non canonique', { canonical_event_state: { event_type: 'OFFICIAL_SPEECH', subject: 'Two  spaces', detail: null } }, 'INVALID_CANONICAL_EVENT_STATE_V1'],
  ['transition inconnue', { transition_type: 'UPDATE' }, 'INVALID_TRANSITION_TYPE'],
]) {
  const { db, calls } = makeDb({ eventVersionOverrides: overrides });
  const result = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  test(`${label}: ABSTAINED`, result.kind === 'ABSTAINED' && result.reason === reason, JSON.stringify(result));
  test(`${label}: aucune mutation`, calls.length === 1);
}

// A valid future schema is persisted explicitly as UNAVAILABLE.
{
  const { db, persistenceBodies } = makeDb({
    eventVersionOverrides: {
      canonical_event_state_schema_version: 3,
      canonical_event_state: { future: ['opaque'], direction: 'BULLISH', horizon: 'H6' },
    },
    assessmentOverrides: { assessment_status: 'UNAVAILABLE' },
  });
  const result = await processEventImpactShadowVersion(db, EVENT_VERSION_ID);
  test('schéma futur = PROCESSED/UNAVAILABLE', result.kind === 'PROCESSED'
    && result.assessmentStatus === 'UNAVAILABLE'
    && result.assessmentReason === 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
  test('schéma futur persiste zéro interprétation', persistenceBodies[0].p_assessment_status === 'UNAVAILABLE'
    && persistenceBodies[0].p_interpretations.length === 0);
}

// RPC response contract and count coherence.
for (const [label, rpcRows, code] of [
  ['zéro ligne RPC', [], 'ASSESSMENT_RPC_ROW_COUNT_INVARIANT'],
  ['deux lignes RPC', [makeRpcRow(), makeRpcRow()], 'ASSESSMENT_RPC_ROW_COUNT_INVARIANT'],
  ['assessment id invalide', [makeRpcRow({ assessment_id: 'bad' })], 'MALFORMED_DB_RESPONSE'],
  ['replayed invalide', [makeRpcRow({ replayed: 'false' })], 'MALFORMED_DB_RESPONSE'],
  ['count fractionnaire', [makeRpcRow({ interpretation_count: 0.5 })], 'MALFORMED_DB_RESPONSE'],
  ['count divergent', [makeRpcRow({ interpretation_count: 1 })], 'ASSESSMENT_RPC_COUNT_MISMATCH'],
]) {
  const { db } = makeDb({ rpcRows });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), label, code);
}

// Exact read-back: mismatch, missing parent, or unexpected child all fail.
{
  const { db } = makeDb({ assessmentRows: () => [] });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), 'parent read-back absent', 'ASSESSMENT_READBACK_ROW_COUNT_INVARIANT');
}
for (const [field, value] of [
  ['event_version_id', OTHER_EVENT_VERSION_ID],
  ['assessment_status', 'UNAVAILABLE'],
  ['producer_actor', 'different-actor'],
  ['input_fingerprint', 'b'.repeat(64)],
  ['supersedes_assessment_id', ASSESSMENT_ID],
]) {
  const { db } = makeDb({ assessmentOverrides: { [field]: value } });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), `read-back mismatch ${field}`, 'PERSISTED_ASSESSMENT_MISMATCH');
}
{
  const { db } = makeDb({ interpretationRows: [{ id: '55555555-5555-4555-8555-555555555555' }] });
  await expectError(() => processEventImpactShadowVersion(db, EVENT_VERSION_ID), 'enfant inattendu rejeté', 'UNEXPECTED_PERSISTED_INTERPRETATIONS');
}

// Guard is behaviorally proven with a synthetic future ASSESSED plan.
{
  const futurePlan = {
    kind: 'PROCESS',
    processorVersion: 'event-impact-deterministic-processor-v2',
    eventVersionId: EVENT_VERSION_ID,
    canonicalEventStateSchemaVersion: 1,
    producerType: 'DETERMINISTIC',
    algorithmVersion: 'event-impact-deterministic-processor-v2',
    knowledgeCutoff: CUTOFF,
    assessmentStatus: 'ASSESSED',
    assessmentReason: 'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE',
    interpretations: [{ horizon: 'H1' }],
  };
  await expectError(
    () => Promise.resolve(assertSupportedEventImpactPlan(futurePlan, { id: EVENT_VERSION_ID, knowledgeCutoff: CUTOFF })),
    'future ASSESSED plan fails closed',
    'UNSUPPORTED_PROCESSOR_PLAN_SHAPE',
  );
}

// Canonical hashing properties.
test('canonical JSON trie les clés', canonicalStringifyEventImpact({ z: 1, a: { d: 2, b: 1 } })
  === '{"a":{"b":1,"d":2},"z":1}');
test('canonical JSON conserve ordre tableau', canonicalStringifyEventImpact([2, 1]) === '[2,1]');
await expectError(() => Promise.resolve(canonicalStringifyEventImpact({ bad: undefined })), 'canonical JSON rejette undefined');
test('SHA-256 stable connu', await sha256EventImpact('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

// Static architecture boundary.
const executable = orchestratorSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
test('importe le processeur réel', /from ['"]\.\/deterministic_processor\.js['"]/.test(orchestratorSource));
test('une seule RPC de mutation autorisée', (executable.match(/rpc\/fn_event_impact_create_assessment/g) ?? []).length === 1
  && !/rpc\/fn_event_(?!impact_create_assessment)/.test(executable));
for (const token of [
  '@supabase', 'process.env', 'Date.now(', 'new Date(', 'Math.random(',
  'news_events', 'gold_direction_impact', 'expected_move_usd', 'news_score',
  'market_regime', 'ai_scenarios', 'Anthropic', 'OpenAI', 'Gemini',
  'worker.ts', 'wrangler', 'cron', 'discover', 'backfill',
]) {
  test(`frontière statique sans ${token}`, !executable.includes(token));
}
test('aucun H6 exécutable', !/["']H6["']/.test(executable));
test('aucun fetch/client/env runtime', !/\bfetch\s*\(|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/.test(executable));
test('aucune lecture autre que tables Event Version/Impact', !/news_articles|event_observation_memberships|ai_analyses/.test(executable));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
