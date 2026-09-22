// Behavioral contract for EI-5. Transpiles and executes the real batch,
// real EI-4 orchestrator, real EI-3 processor and real shared run lock.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BATCH_PATH = path.join(ROOT, 'backend', 'event_impact', 'shadow_batch.ts');
const ORCHESTRATOR_PATH = path.join(ROOT, 'backend', 'event_impact', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(ROOT, 'backend', 'event_impact', 'deterministic_processor.ts');
const LOCK_PATH = path.join(ROOT, 'backend', 'shared', 'run_lock.ts');

let passed = 0;
let failed = 0;
const testCase = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

for (const [name, file] of [
  ['shadow_batch.ts', BATCH_PATH],
  ['shadow_orchestrator.ts', ORCHESTRATOR_PATH],
  ['deterministic_processor.ts', PROCESSOR_PATH],
  ['run_lock.ts', LOCK_PATH],
]) testCase(`${name} existe`, existsSync(file));

const batchSource = readFileSync(BATCH_PATH, 'utf8');
const orchestratorSource = readFileSync(ORCHESTRATOR_PATH, 'utf8');
const processorSource = readFileSync(PROCESSOR_PATH, 'utf8');
const lockSource = readFileSync(LOCK_PATH, 'utf8');

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
}

let mod = null;
let tempDirectory = null;
try {
  tempDirectory = mkdtempSync(path.join(tmpdir(), 'event-impact-batch-'));
  writeFileSync(path.join(tempDirectory, 'deterministic_processor.mjs'), transpile(processorSource), 'utf8');

  const orchestrator = transpile(orchestratorSource).replace(
    /(['"])\.\/deterministic_processor\.js\1/,
    '$1./deterministic_processor.mjs$1',
  );
  writeFileSync(path.join(tempDirectory, 'shadow_orchestrator.mjs'), orchestrator, 'utf8');
  writeFileSync(path.join(tempDirectory, 'run_lock.mjs'), transpile(lockSource), 'utf8');

  const batch = transpile(batchSource)
    .replace(/(['"])\.\/shadow_orchestrator\.js\1/, '$1./shadow_orchestrator.mjs$1')
    .replace(/(['"])\.\.\/shared\/run_lock\.js\1/, '$1./run_lock.mjs$1');
  const modulePath = path.join(tempDirectory, 'shadow_batch.mjs');
  writeFileSync(modulePath, batch, 'utf8');
  mod = await import(pathToFileURL(modulePath).href);
} catch (error) {
  console.error('FAILED TO TRANSPILE/LOAD Event Impact batch:', error);
} finally {
  if (tempDirectory !== null) {
    try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

testCase('batch réel se charge', mod !== null);
if (mod === null) {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const {
  runEventImpactShadowBatch,
  EventImpactShadowBatchBusyError,
  EventImpactShadowBatchInvariantError,
  EVENT_IMPACT_SHADOW_BATCH_VERSION,
  MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE,
} = mod;

const EV1 = '11111111-1111-4111-8111-111111111111';
const EV2 = '22222222-2222-4222-8222-222222222222';
const EV3 = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const CLUSTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ASSESSMENTS = {
  [EV1]: 'c1111111-1111-4111-8111-111111111111',
  [EV2]: 'c2222222-2222-4222-8222-222222222222',
  [EV3]: 'c3333333-3333-4333-8333-333333333333',
};
const CUTOFF = '2026-09-22T00:00:00.123456+00:00';

function makeEventVersion(id) {
  return {
    id,
    cluster_id: CLUSTER,
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
  };
}

function extractEq(pathValue, column) {
  const match = pathValue.match(new RegExp(`${column}=eq\\.([^&]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function makeDb(options = {}) {
  const calls = [];
  const releases = [];
  const persisted = new Map();
  const bodyByAssessment = new Map();

  const db = {
    async request(method, requestPath, body, extraHeaders) {
      calls.push({ method, path: requestPath, body, extraHeaders });

      if (requestPath === 'rpc/fn_reclaim_stale_runs') return [{ reclaimed: 0 }];

      if (requestPath === 'ingestion_runs?select=id' && method === 'POST') {
        if (options.busy) throw new Error('PostgREST 409 code=23505 duplicate key');
        testCase(
          'lock utilise engine event_impact_shadow',
          Array.isArray(body) && body[0]?.engine === 'event_impact_shadow',
        );
        return [{ id: RUN1 }];
      }

      if (requestPath.startsWith('event_versions?') && method === 'GET') {
        const id = extractEq(requestPath, 'id');
        if (id === UNKNOWN) return [];
        if (options.invalidEventVersionId === id) {
          return [{ ...makeEventVersion(id), state_fingerprint: 'A'.repeat(64) }];
        }
        return [makeEventVersion(id)];
      }

      if (requestPath === 'rpc/fn_event_impact_create_assessment' && method === 'POST') {
        const eventVersionId = body.p_event_version_id;
        if (options.failEventVersionId === eventVersionId) {
          throw new Error(
            'synthetic upstream error ?apiKey=VERY_SECRET&token=ALSO_SECRET Authorization: Bearer TOP_SECRET',
          );
        }
        const assessmentId = ASSESSMENTS[eventVersionId];
        const replayed = persisted.has(eventVersionId);
        persisted.set(eventVersionId, assessmentId);
        bodyByAssessment.set(assessmentId, structuredClone(body));
        return [{
          assessment_id: assessmentId,
          replayed,
          interpretation_count: 0,
        }];
      }

      if (requestPath.startsWith('event_impact_assessments?') && method === 'GET') {
        const assessmentId = extractEq(requestPath, 'id');
        const persistedBody = bodyByAssessment.get(assessmentId);
        return [{
          id: assessmentId,
          event_version_id: persistedBody.p_event_version_id,
          assessment_status: persistedBody.p_assessment_status,
          knowledge_cutoff: persistedBody.p_knowledge_cutoff,
          producer_type: persistedBody.p_producer_type,
          producer_actor: persistedBody.p_producer_actor,
          algorithm_version: persistedBody.p_algorithm_version,
          input_fingerprint: persistedBody.p_input_fingerprint,
          semantic_fingerprint: persistedBody.p_semantic_fingerprint,
          idempotency_fingerprint: persistedBody.p_idempotency_fingerprint,
          supersedes_assessment_id: persistedBody.p_supersedes_assessment_id,
        }];
      }

      if (requestPath.startsWith('event_impact_interpretations?') && method === 'GET') {
        return [];
      }

      if (requestPath.startsWith('ingestion_runs?id=eq.') && method === 'PATCH') {
        if (options.releaseFails) {
          throw new Error('release failed apiKey=RELEASE_SECRET');
        }
        releases.push(structuredClone(body));
        return [];
      }

      throw new Error(`unexpected DB call: ${method} ${requestPath}`);
    },
  };

  return { db, calls, releases, persisted };
}

async function expectError(fn, label, predicate) {
  try {
    await fn();
    testCase(label, false, 'expected rejection');
    return null;
  } catch (error) {
    testCase(label, predicate(error), String(error));
    return error;
  }
}

// Input validation is fail-closed before any DB interaction.
for (const [label, ids, expectedCode] of [
  ['liste vide', [], 'EMPTY_EVENT_VERSION_LIST'],
  ['UUID invalide', ['not-a-uuid'], 'MALFORMED_EVENT_VERSION_ID'],
  ['UUID dupliqué casse différente', [EV1, EV1.toUpperCase()], 'DUPLICATE_EVENT_VERSION_ID'],
]) {
  const { db, calls } = makeDb();
  await expectError(
    () => runEventImpactShadowBatch(db, ids),
    label,
    (error) => error instanceof EventImpactShadowBatchInvariantError && error.code === expectedCode,
  );
  testCase(`${label}: aucune DB`, calls.length === 0);
}

{
  const { db, calls } = makeDb();
  await expectError(
    () => runEventImpactShadowBatch(db, null),
    'liste non-array rejetée',
    (error) => error instanceof EventImpactShadowBatchInvariantError
      && error.code === 'INVALID_EVENT_VERSION_LIST',
  );
  testCase('liste non-array: aucune DB', calls.length === 0);
}

{
  const many = Array.from({ length: MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE + 1 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
  const { db, calls } = makeDb();
  await expectError(
    () => runEventImpactShadowBatch(db, many),
    'taille max appliquée',
    (error) => error instanceof EventImpactShadowBatchInvariantError && error.code === 'BATCH_SIZE_EXCEEDED',
  );
  testCase('taille max: aucune DB', calls.length === 0);
}

{
  const { db, calls } = makeDb();
  await expectError(
    () => runEventImpactShadowBatch(db, [EV1], 'automatic'),
    'triggerType inconnu rejeté',
    (error) => error instanceof EventImpactShadowBatchInvariantError && error.code === 'UNSUPPORTED_TRIGGER_TYPE',
  );
  testCase('trigger invalide: aucune DB', calls.length === 0);
}

// Busy lock: no item processing and no release because lock was never acquired.
{
  const { db, calls, releases } = makeDb({ busy: true });
  await expectError(
    () => runEventImpactShadowBatch(db, [EV1]),
    'lock occupé',
    (error) => error instanceof EventImpactShadowBatchBusyError && error.code === 'ALREADY_RUNNING',
  );
  testCase('lock occupé: aucune Event Version lue', !calls.some((call) => call.path.startsWith('event_versions?')));
  testCase('lock occupé: aucun release', releases.length === 0);
}

// Happy path and exact replay across two complete batch invocations.
{
  const { db, calls, releases } = makeDb();
  const first = await runEventImpactShadowBatch(db, [EV1, EV2]);

  testCase('version batch exposée', first.version === EVENT_IMPACT_SHADOW_BATCH_VERSION);
  testCase('happy path success', first.status === 'success');
  testCase('deux Event Versions traitées', first.requested === 2 && first.processed === 2);
  testCase('premier batch crée deux assessments', first.assessmentsCreated === 2 && first.assessmentsReplayed === 0);
  testCase('V1 reste insuffisance de preuve', first.insufficientEvidence === 2 && first.unavailable === 0);
  testCase('zéro enfant interprétation', first.items.every((item) => item.kind !== 'PROCESSED' || item.interpretationCount === 0));
  testCase('ordre appelant conservé', first.items[0].kind === 'PROCESSED' && first.items[0].eventVersionId === EV1
    && first.items[1].kind === 'PROCESSED' && first.items[1].eventVersionId === EV2);
  testCase('release premier run', releases.length === 1
    && releases[0].status === 'success'
    && releases[0].persisted_count === 2
    && releases[0].duplicate_count === 0);

  const relevant = calls.filter((call) =>
    call.path.startsWith('event_versions?') || call.path === 'rpc/fn_event_impact_create_assessment');
  testCase('traitement strictement séquentiel', relevant.length === 4
    && relevant[0].path.startsWith('event_versions?')
    && relevant[1].path === 'rpc/fn_event_impact_create_assessment'
    && relevant[2].path.startsWith('event_versions?')
    && relevant[3].path === 'rpc/fn_event_impact_create_assessment');

  const second = await runEventImpactShadowBatch(db, [EV1, EV2]);
  testCase('second batch exact = replay', second.status === 'success'
    && second.assessmentsCreated === 0
    && second.assessmentsReplayed === 2);
  testCase('replay mêmes assessment ids', second.items[0].kind === 'PROCESSED'
    && second.items[1].kind === 'PROCESSED'
    && second.items[0].assessmentId === first.items[0].assessmentId
    && second.items[1].assessmentId === first.items[1].assessmentId);
  testCase('release replay comptabilisé', releases.length === 2
    && releases[1].persisted_count === 0
    && releases[1].duplicate_count === 2);
}

// ABSTAINED and SKIPPED are explicit non-failures.
{
  const { db } = makeDb({ invalidEventVersionId: EV1 });
  const report = await runEventImpactShadowBatch(db, [EV1, UNKNOWN, EV2]);
  testCase('abstention/skipped ne deviennent pas failure', report.status === 'success' && report.failed === 0);
  testCase('abstention comptée', report.abstained === 1);
  testCase('skip compté', report.skipped === 1);
  testCase('autre item continue', report.processed === 1 && report.assessmentsCreated === 1);
}

// One item failure is isolated, report is partial, and secrets are redacted.
{
  const { db, releases } = makeDb({ failEventVersionId: EV1 });
  const report = await runEventImpactShadowBatch(db, [EV1, EV2]);
  const failedItem = report.items.find((item) => item.kind === 'FAILED');
  testCase('échec isolé = partial', report.status === 'partial' && report.failed === 1 && report.processed === 1);
  testCase('batch continue après échec', report.items[1].kind === 'PROCESSED');
  testCase('message erreur redacted', failedItem
    && failedItem.safeErrorMessage.includes('[REDACTED]')
    && !failedItem.safeErrorMessage.includes('VERY_SECRET')
    && !failedItem.safeErrorMessage.includes('ALSO_SECRET')
    && !failedItem.safeErrorMessage.includes('TOP_SECRET'));
  testCase('release error redacted', JSON.stringify(releases[0]).includes('[REDACTED]')
    && !JSON.stringify(releases[0]).includes('VERY_SECRET')
    && !JSON.stringify(releases[0]).includes('ALSO_SECRET')
    && !JSON.stringify(releases[0]).includes('TOP_SECRET'));
}

// Release failure is never hidden behind a successful report.
{
  const { db } = makeDb({ releaseFails: true });
  const error = await expectError(
    () => runEventImpactShadowBatch(db, [EV3]),
    'release failure remonte',
    (candidate) => candidate instanceof EventImpactShadowBatchInvariantError
      && candidate.code === 'EVENT_IMPACT_SHADOW_LOCK_RELEASE_FAILED',
  );
  testCase('release failure redacted', error && !String(error).includes('RELEASE_SECRET') && String(error).includes('[REDACTED]'));
}

// Static boundaries: no discovery/runtime/provider widening.
const executable = batchSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

testCase('réutilise EI-4 réel', /from ['"]\.\/shadow_orchestrator\.js['"]/.test(batchSource));
testCase('réutilise verrou partagé réel', /from ['"]\.\.\/shared\/run_lock\.js['"]/.test(batchSource));
testCase('aucun appel direct RPC Event Impact', !executable.includes('rpc/fn_event_impact_create_assessment'));
testCase('aucun discovery/backfill automatique', !/candidate_discovery|select=\*|order=|limit=/.test(executable));
for (const token of [
  '@supabase', 'process.env', 'news_events', 'gold_direction_impact',
  'expected_move_usd', 'news_score', 'market_regime', 'ai_scenarios',
  'Anthropic', 'OpenAI', 'Gemini', 'worker.ts', 'wrangler', 'cron(',
]) {
  testCase(`frontière statique sans ${token}`, !executable.includes(token));
}
testCase('aucun Promise.all/allSettled de traitement', !/Promise\.(all|allSettled)\s*\(/.test(executable));
testCase('MAX batch 25', MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE === 25);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
