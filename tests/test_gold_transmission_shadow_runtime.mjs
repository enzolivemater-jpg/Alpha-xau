// Behavioral contract for GT-6 (backend/gold_transmission/shadow_runtime.ts).
// Transpiles TypeScript with `typescript` (already a devDependency, no new
// dependency) and executes the REAL compiled modules — shadow_runtime.ts,
// shadow_batch.ts (GT-5), shadow_orchestrator.ts (GT-4),
// deterministic_processor.ts (GT-3), shared/run_lock.ts — never a fake
// substitute for any of them. ONLY the external network boundary
// (`globalThis.fetch`) is simulated. backend/worker.ts wiring is checked
// statically on its source text, since importing it would also have to
// load unrelated heavy engines (market/news/committee) out of scope here.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'backend', 'gold_transmission', 'shadow_runtime.ts');
const BATCH_PATH = path.join(ROOT, 'backend', 'gold_transmission', 'shadow_batch.ts');
const ORCHESTRATOR_PATH = path.join(ROOT, 'backend', 'gold_transmission', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(ROOT, 'backend', 'gold_transmission', 'deterministic_processor.ts');
const LOCK_PATH = path.join(ROOT, 'backend', 'shared', 'run_lock.ts');
const WORKER_PATH = path.join(ROOT, 'backend', 'worker.ts');
const WRANGLER_PATH = path.join(ROOT, 'wrangler.toml');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

for (const [name, file] of [
  ['shadow_runtime.ts', RUNTIME_PATH],
  ['shadow_batch.ts', BATCH_PATH],
  ['shadow_orchestrator.ts', ORCHESTRATOR_PATH],
  ['deterministic_processor.ts', PROCESSOR_PATH],
  ['run_lock.ts', LOCK_PATH],
  ['worker.ts', WORKER_PATH],
]) t(`${name} existe`, existsSync(file));

const runtimeSource = existsSync(RUNTIME_PATH) ? readFileSync(RUNTIME_PATH, 'utf8') : '';
const batchSource = existsSync(BATCH_PATH) ? readFileSync(BATCH_PATH, 'utf8') : '';
const orchestratorSource = existsSync(ORCHESTRATOR_PATH) ? readFileSync(ORCHESTRATOR_PATH, 'utf8') : '';
const processorSource = existsSync(PROCESSOR_PATH) ? readFileSync(PROCESSOR_PATH, 'utf8') : '';
const lockSource = existsSync(LOCK_PATH) ? readFileSync(LOCK_PATH, 'utf8') : '';
const workerSource = existsSync(WORKER_PATH) ? readFileSync(WORKER_PATH, 'utf8') : '';
const wranglerSource = existsSync(WRANGLER_PATH) ? readFileSync(WRANGLER_PATH, 'utf8') : '';

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}
const liveRuntimeSource = stripJsComments(runtimeSource);
const liveWorkerSource = stripJsComments(workerSource);

// ---------------------------------------------------------------------
// 0. Transpile + real ESM load of the FIVE modules, mirroring the repo's
//    relative directory structure (gold_transmission/ + shared/).
// ---------------------------------------------------------------------
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
let tmpDir = null;
try {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'gold-transmission-runtime-'));
  const gtDir = path.join(tmpDir, 'gold_transmission');
  const sharedDir = path.join(tmpDir, 'shared');
  mkdirSync(gtDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  writeFileSync(path.join(gtDir, 'deterministic_processor.mjs'), transpile(processorSource), 'utf8');

  const orchestrator = transpile(orchestratorSource).replace(
    /(['"])\.\/deterministic_processor\.js\1/,
    '$1./deterministic_processor.mjs$1',
  );
  writeFileSync(path.join(gtDir, 'shadow_orchestrator.mjs'), orchestrator, 'utf8');
  writeFileSync(path.join(sharedDir, 'run_lock.mjs'), transpile(lockSource), 'utf8');

  const batch = transpile(batchSource)
    .replace(/(['"])\.\/shadow_orchestrator\.js\1/, '$1./shadow_orchestrator.mjs$1')
    .replace(/(['"])\.\.\/shared\/run_lock\.js\1/, '$1../shared/run_lock.mjs$1');
  writeFileSync(path.join(gtDir, 'shadow_batch.mjs'), batch, 'utf8');

  const runtime = transpile(runtimeSource).replace(
    /(['"])\.\/shadow_batch\.js\1/,
    '$1./shadow_batch.mjs$1',
  );
  const runtimeTmpFile = path.join(gtDir, 'shadow_runtime.mjs');
  writeFileSync(runtimeTmpFile, runtime, 'utf8');

  mod = await import(pathToFileURL(runtimeTmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD Gold Transmission shadow_runtime.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------
// A. module loads
// ---------------------------------------------------------------------
t('les cinq modules réels transpilent et se chargent sans erreur', mod !== null);
t('handleGoldTransmissionShadowRequest est exporté (fonction)', typeof mod?.handleGoldTransmissionShadowRequest === 'function');
t('PostgrestGoldTransmissionShadowDb est exporté (classe)', typeof mod?.PostgrestGoldTransmissionShadowDb === 'function');
t('buildPostgrestHeaders est exporté (fonction)', typeof mod?.buildPostgrestHeaders === 'function');
t('validateSupabaseUrl est exporté (fonction)', typeof mod?.validateSupabaseUrl === 'function');
t('validatePostgrestPath est exporté (fonction)', typeof mod?.validatePostgrestPath === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const {
  handleGoldTransmissionShadowRequest,
  PostgrestGoldTransmissionShadowDb,
  buildPostgrestHeaders,
  validateSupabaseUrl,
  validatePostgrestPath,
} = mod;

// ---------------------------------------------------------------------
// WORKER — exact route, no cron/scheduled/JobName change.
// ---------------------------------------------------------------------
t('worker.ts importe handleGoldTransmissionShadowRequest depuis ./gold_transmission/shadow_runtime.js',
  /import\s*\{\s*handleGoldTransmissionShadowRequest\s*\}\s*from\s*'\.\/gold_transmission\/shadow_runtime\.js'/.test(workerSource));
t('worker.ts route EXACTEMENT path === \'/gold-transmission-shadow\'',
  /if \(path === '\/gold-transmission-shadow'\) return handleGoldTransmissionShadowRequest\(request, env\);/.test(workerSource));
t('worker.ts n\'utilise PAS startsWith(\'/gold-transmission-shadow\') dans du code exécutable',
  !/startsWith\('\/gold-transmission-shadow'\)/.test(liveWorkerSource));
t('aucune sous-route Gold Transmission',
  !/\/gold-transmission-shadow\/[a-z]/.test(workerSource));
t('scheduled()/resolveJob()/JobName restent inchangés (GT-6 n\'y apparaît pas)',
  (() => {
    const scheduledMatch = /async scheduled\([\s\S]*?\n  \},/.exec(workerSource);
    const resolveJobMatch = /export function resolveJob\([\s\S]*?\n\}/.exec(workerSource);
    const jobNameMatch = /export type JobName[^\n]*\n/.exec(workerSource);
    return scheduledMatch !== null && resolveJobMatch !== null && jobNameMatch !== null
      && !scheduledMatch[0].includes('gold_transmission') && !scheduledMatch[0].includes('GoldTransmission')
      && !resolveJobMatch[0].includes('gold_transmission') && !resolveJobMatch[0].includes('GoldTransmission')
      && !jobNameMatch[0].includes('gold_transmission') && !jobNameMatch[0].includes('GoldTransmission');
  })());
t('wrangler.toml inchangé par cette PR (aucune référence gold-transmission-shadow attendue)',
  !/gold-transmission-shadow/i.test(wranglerSource));
t('worker.ts ne modifie pas les routes existantes (/event-shadow, /event-shadow/discover, /event-impact-shadow toujours présentes)',
  /path === '\/event-shadow\/discover'/.test(workerSource)
  && /path === '\/event-shadow'/.test(workerSource)
  && /path === '\/event-impact-shadow'/.test(workerSource));
t('runtime source ne référence pas les handlers Event Shadow/Event Impact existants',
  !/handleEventShadowRequest|handleEventImpactShadowRequest/.test(runtimeSource));

// ---------------------------------------------------------------------
// Environment + fixtures.
// ---------------------------------------------------------------------
const SUPABASE_URL = 'https://fake-project.supabase.test';
const SERVICE_ROLE_KEY = 'srv-role-secret-DO-NOT-LEAK-9f8e7d6c5b4a';
const INGEST_TOKEN = 'ingest-secret-DO-NOT-LEAK-3a2b1c0d9e8f';
const ENV = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, INGEST_TOKEN };
const REST_PREFIX = `${SUPABASE_URL}/rest/v1/`;

function uid(label) {
  const hex = createHash('md5').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const EV1 = uid('gt-ev1');
const EV2 = uid('gt-ev2');
const CLUSTER = uid('gt-cluster');
const CUTOFF = '2026-09-23T00:00:00.123456+00:00';

function makeEventVersion(id, overrides = {}) {
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
    ...overrides,
  };
}

function extractEq(pathValue, column) {
  const match = pathValue.match(new RegExp(`${column}=eq\\.([^&]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Fake `globalThis.fetch` — the ONLY simulated boundary. Routes by
 * PostgREST path (after REST_PREFIX), records every call, returns real
 * Fetch API `Response` objects.
 */
function makeFakeFetch(eventVersions, options = {}) {
  const byId = new Map(eventVersions.map((v) => [v.id, v]));
  const calls = [];
  let runRowCounter = 0;
  let releaseCallCount = 0;
  const assessmentIdByEventVersion = new Map();
  const bodyByAssessment = new Map();
  const createCallCountByEventVersion = new Map();

  async function fakeFetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const bodyText = init.body;
    const body = typeof bodyText === 'string' ? JSON.parse(bodyText) : undefined;

    if (!url.startsWith(REST_PREFIX)) {
      throw new Error(`fake fetch: URL escaped the expected PostgREST prefix: ${url}`);
    }
    const restPath = url.slice(REST_PREFIX.length);
    calls.push({ url, method, headers, body, bodyText, hasBody: init.body !== undefined, path: restPath });

    if (options.networkFailureOnAcquire && method === 'POST' && restPath === 'ingestion_runs?select=id') {
      throw new Error(`simulated network failure containing a fake secret: ${SERVICE_ROLE_KEY}`);
    }

    if (
      options.perItemNetworkFailure
      && method === 'POST'
      && restPath === 'rpc/fn_gold_transmission_create_assessment'
      && body?.p_event_version_id === options.perItemNetworkFailure.eventVersionId
    ) {
      throw new Error(options.perItemNetworkFailure.message);
    }

    if (restPath === 'rpc/fn_reclaim_stale_runs') {
      return new Response(JSON.stringify([{ reclaimed: 0 }]), { status: 200 });
    }
    if (method === 'POST' && restPath === 'ingestion_runs?select=id') {
      if (options.forceAlreadyRunning) {
        return new Response(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "uq_ingestion_runs_active"' }), { status: 409 });
      }
      runRowCounter += 1;
      return new Response(JSON.stringify([{ id: `run-row-${runRowCounter}` }]), { status: 201 });
    }
    if (method === 'PATCH' && restPath.startsWith('ingestion_runs?id=eq.')) {
      releaseCallCount += 1;
      if (options.forceReleaseFailure) {
        return new Response(`simulated release failure with fake secret apiKey=${SERVICE_ROLE_KEY}`, { status: 500 });
      }
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && restPath.startsWith('event_versions?')) {
      const id = extractEq(restPath, 'id');
      if (options.malformedEventVersionsJson) {
        return new Response('{not valid json', { status: 200 });
      }
      const row = id ? byId.get(id) : null;
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    }
    if (method === 'POST' && restPath === 'rpc/fn_gold_transmission_create_assessment') {
      const eventVersionId = body?.p_event_version_id;
      if (options.upstreamErrorForEventVersionId === eventVersionId) {
        return new Response(
          JSON.stringify({ message: `synthetic upstream error containing a fake secret apiKey=${SERVICE_ROLE_KEY} token=FAKE_TOKEN_LEAK Authorization: Bearer FAKE_BEARER_LEAK` }),
          { status: 500 },
        );
      }
      const count = (createCallCountByEventVersion.get(eventVersionId) ?? 0) + 1;
      createCallCountByEventVersion.set(eventVersionId, count);
      const assessmentId = assessmentIdByEventVersion.get(eventVersionId) ?? uid(`gt-assessment:${eventVersionId}`);
      assessmentIdByEventVersion.set(eventVersionId, assessmentId);
      bodyByAssessment.set(assessmentId, structuredClone(body));
      return new Response(JSON.stringify([{
        assessment_id: assessmentId,
        replayed: count > 1,
        path_count: 0,
        evidence_count: 0,
      }]), { status: 200 });
    }
    if (method === 'GET' && restPath.startsWith('gold_transmission_assessments?')) {
      const assessmentId = extractEq(restPath, 'id');
      const persistedBody = bodyByAssessment.get(assessmentId);
      if (!persistedBody) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([{
        id: assessmentId,
        event_version_id: persistedBody.p_event_version_id,
        assessment_status: persistedBody.p_assessment_status,
        assessment_reason: persistedBody.p_assessment_reason,
        knowledge_cutoff: persistedBody.p_knowledge_cutoff,
        producer_type: persistedBody.p_producer_type,
        producer_actor: persistedBody.p_producer_actor,
        algorithm_version: persistedBody.p_algorithm_version,
        input_fingerprint: persistedBody.p_input_fingerprint,
        semantic_fingerprint: persistedBody.p_semantic_fingerprint,
        idempotency_fingerprint: persistedBody.p_idempotency_fingerprint,
        supersedes_assessment_id: persistedBody.p_supersedes_assessment_id,
      }]), { status: 200 });
    }
    if (method === 'GET' && restPath.startsWith('gold_transmission_paths?')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    throw new Error(`fake fetch: unexpected DB call reached the fake (isolation violation): ${method} ${restPath}`);
  }

  return { fakeFetch, calls, getReleaseCallCount: () => releaseCallCount };
}

async function withFakeFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function makeRequest({ method = 'POST', headers = {}, bodyText } = {}) {
  const init = { method, headers };
  if (bodyText !== undefined) init.body = bodyText;
  return new Request('https://worker.test/gold-transmission-shadow', init);
}

const AUTH_HEADERS = { 'x-ingest-token': INGEST_TOKEN, 'content-type': 'application/json' };

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('auth manquante => 401', res.status === 401);
  t('auth manquante => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: { 'x-ingest-token': 'wrong-token', 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('auth incorrecte => 401', res.status === 401);
  t('auth incorrecte => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('x-ingest-token autorisé => 200', res.status === 200);
  const text = await res.text();
  t('INGEST_TOKEN n\'apparaît jamais dans la réponse', !text.includes(INGEST_TOKEN));
  t('SUPABASE_SERVICE_ROLE_KEY n\'apparaît jamais dans la réponse', !text.includes(SERVICE_ROLE_KEY));
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('repli Authorization: Bearer <INGEST_TOKEN> accepté', res.status === 200);
}
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    { ...ENV, INGEST_TOKEN: '' },
  ));
  t('INGEST_TOKEN configuré vide => échoue fermé (401), jamais un accès sans vérification', res.status === 401 && calls.length === 0);
}

// ---------------------------------------------------------------------
// METHOD
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(makeRequest({ method: 'GET', headers: AUTH_HEADERS }), ENV));
  t('GET => 405', res.status === 405);
  t('GET => en-tête Allow: POST', res.headers.get('allow') === 'POST');
  t('GET => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(makeRequest({ method: 'PUT', headers: AUTH_HEADERS }), ENV));
  t('PUT => 405', res.status === 405 && calls.length === 0);
}

// ---------------------------------------------------------------------
// BODY
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: '{not valid json' }), ENV));
  t('JSON malformé => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify('just a string') }), ENV));
  t('corps non-objet (chaîne) => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify([1, 2, 3]) }), ENV));
  t('corps non-objet (tableau) => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({}) }), ENV));
  t('eventVersionIds manquant => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1], triggerType: 'automatic' }) }), ENV,
  ));
  t('champ inattendu (triggerType) => 400', res.status === 400 && calls.length === 0);
}
for (const field of ['maxCandidates', 'lane', 'processorVersion', 'orchestratorVersion', 'assessmentStatus', 'producerType', 'algorithmVersion', 'dryRun', 'cursor', 'timestamp', 'backfill']) {
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1], [field]: 'x' }) }), ENV,
  ));
  t(`champ inattendu "${field}" => 400`, res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: 'not-an-array' }) }), ENV,
  ));
  t('eventVersionIds non-array => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const oversizedDeclared = String(20 * 1024);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: { ...AUTH_HEADERS, 'content-length': oversizedDeclared }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('Content-Length déclaré surdimensionné => 413 sans parsing du corps', res.status === 413 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const bigArray = Array.from({ length: 2000 }, () => EV1);
  const oversizedBody = JSON.stringify({ eventVersionIds: bigArray });
  t('précondition: corps réellement surdimensionné', Buffer.byteLength(oversizedBody, 'utf8') > 16 * 1024);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: oversizedBody }), ENV,
  ));
  t('corps réellement surdimensionné => 413 même sans Content-Length déclaré/sous-estimé', res.status === 413 && calls.length === 0);
}

// ---------------------------------------------------------------------
// GT-5 SEMANTIC FORWARDING
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [] }) }), ENV,
  ));
  t('liste vide (GT-5 EMPTY_EVENT_VERSION_LIST) => 400', res.status === 400);
  const json = await res.json();
  t('code EMPTY_EVENT_VERSION_LIST exposé', json.code === 'EMPTY_EVENT_VERSION_LIST');
}
{
  const { fakeFetch } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: ['not-a-uuid'] }) }), ENV,
  ));
  t('UUID malformé (GT-5 MALFORMED_EVENT_VERSION_ID) => 400', res.status === 400);
}
{
  const { fakeFetch } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV1.toUpperCase()] }) }), ENV,
  ));
  t('doublon casse différente (GT-5 DUPLICATE_EVENT_VERSION_ID) => 400', res.status === 400);
}
{
  const many = Array.from({ length: 26 }, (_, i) => uid(`gt-max-${i}`));
  const { fakeFetch } = makeFakeFetch(many.map((id) => makeEventVersion(id)));
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: many }) }), ENV,
  ));
  t('> 25 ids (GT-5 BATCH_SIZE_EXCEEDED) => 400', res.status === 400);
}
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const json = await res.json();
  t('ordre de l\'appelant préservé dans le report', json.report.items[0].eventVersionId === EV1 && json.report.items[1].eventVersionId === EV2);
  const relevant = calls.filter((c) => c.path.startsWith('event_versions?') || c.path === 'rpc/fn_gold_transmission_create_assessment');
  t('traitement strictement séquentiel', relevant.length === 4
    && relevant[0].path.startsWith('event_versions?') && relevant[1].path === 'rpc/fn_gold_transmission_create_assessment'
    && relevant[2].path.startsWith('event_versions?') && relevant[3].path === 'rpc/fn_gold_transmission_create_assessment');
  t('trigger toujours le littéral "manual"', json.report.triggerType === 'manual');
}

// ---------------------------------------------------------------------
// BATCH
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('un seul item => 200', res.status === 200);
  const json = await res.json();
  t('{ ok: true, report } avec report.status=success', json.ok === true && json.report.status === 'success');
  t('une évaluation créée, zéro path/evidence pour V1', json.report.processed === 1
    && json.report.assessmentsCreated === 1
    && json.report.items[0].pathCount === 0
    && json.report.items[0].evidenceCount === 0
    && (json.report.items[0].assessmentStatus === 'INSUFFICIENT_EVIDENCE' || json.report.items[0].assessmentStatus === 'UNAVAILABLE'));
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)]);
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const json = await res.json();
  t('multi-item séquentiel => 200, deux items traités', res.status === 200 && json.report.processed === 2);

  const firstAssessmentId = json.report.items[0].assessmentId;
  const res2 = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const json2 = await res2.json();
  t('rejeu exact => replayed=true, même assessment_id, assessmentsCreated=0, assessmentsReplayed incrémenté', res2.status === 200
    && json2.report.assessmentsCreated === 0
    && json2.report.assessmentsReplayed === 2
    && json2.report.items[0].assessmentReplayed === true
    && json2.report.items[0].assessmentId === firstAssessmentId);
}
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)], { forceAlreadyRunning: true });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('verrou déjà pris => 409', res.status === 409);
  const json = await res.json();
  t('code GOLD_TRANSMISSION_SHADOW_ALREADY_RUNNING', json.code === 'GOLD_TRANSMISSION_SHADOW_ALREADY_RUNNING');
  t('aucune Event Version lue (verrou jamais acquis)', !calls.some((c) => c.path.startsWith('event_versions?')));
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)], { upstreamErrorForEventVersionId: EV1 });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  t('échec isolé => toujours HTTP 200 avec report structuré', res.status === 200);
  const json = await res.json();
  t('report.status = partial, verrou tout de même libéré proprement', json.report.status === 'partial' && json.report.failed === 1 && json.report.processed === 1);
}
{
  const { fakeFetch, getReleaseCallCount } = makeFakeFetch([makeEventVersion(EV1)]);
  await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('verrou libéré après un run réussi', getReleaseCallCount() === 1);
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], { forceReleaseFailure: true });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('échec opérationnel de libération de verrou => 500', res.status === 500);
  const text = await res.text();
  t('500 sans fuite de secret', !text.includes(SERVICE_ROLE_KEY) && !text.includes('apiKey='));
}

// ---------------------------------------------------------------------
// POSTGREST
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('toutes les requêtes PostgREST portent apikey === SUPABASE_SERVICE_ROLE_KEY',
    calls.length > 0 && calls.every((c) => c.headers.apikey === SERVICE_ROLE_KEY));
  t('aucune requête PostgREST ne porte un en-tête Authorization dérivé de la clé service-role',
    calls.every((c) => c.headers.authorization === undefined));
  const getCalls = calls.filter((c) => c.method === 'GET');
  t('au moins un appel GET observé', getCalls.length > 0);
  t('aucun appel GET ne porte de corps', getCalls.every((c) => c.hasBody === false));
}
{
  const headers = buildPostgrestHeaders('real-key', false, { apikey: 'malicious-override', authorization: 'Bearer malicious', prefer: 'return=representation' });
  t('apikey malicieux dans extraHeaders ne peut PAS écraser la clé authoritative', headers.apikey === 'real-key');
  t('authorization malicieux dans extraHeaders est éliminé', headers.authorization === undefined);
  t('en-têtes internes légitimes (prefer) passent inchangés', headers.prefer === 'return=representation');
}
{
  let threw = false;
  try { validateSupabaseUrl('http://insecure.example.test'); } catch { threw = true; }
  t('SUPABASE_URL non-https rejetée', threw);
}
{
  let threw = false;
  try { validateSupabaseUrl('not a url'); } catch { threw = true; }
  t('SUPABASE_URL invalide rejetée', threw);
}
{
  let threw = false;
  try { validatePostgrestPath('event_versions/../../secrets'); } catch { threw = true; }
  t('segment de traversée de répertoire (..) rejeté', threw);
}
{
  let threw = false;
  try { validatePostgrestPath('https://evil.example/steal'); } catch { threw = true; }
  t('URL/schéma embarqué (://) rejeté', threw);
}
{
  const db = new PostgrestGoldTransmissionShadowDb(ENV);
  let threw = false;
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
  try {
    await db.request('GET', '../escape');
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = original;
  }
  t('request() rejette un path d\'échappement AVANT tout appel fetch', threw && fetchCalled === false);
}
{
  const db = new PostgrestGoldTransmissionShadowDb(ENV);
  let threw = false;
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
  try {
    await db.request('DELETE', 'gold_transmission_assessments?id=eq.x');
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = original;
  }
  t('méthode DELETE rejetée avant tout appel fetch (seules GET/POST/PATCH autorisées)', threw && fetchCalled === false);
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], { malformedEventVersionsJson: true });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('JSON PostgREST malformé sur une réponse 2xx => échec sûr (report structuré, jamais un crash non géré)', res.status === 200);
  const json = await res.json();
  t('l\'item concerné devient FAILED avec un code sûr', json.report.status === 'failed'
    && json.report.items[0].kind === 'FAILED'
    && json.report.items[0].errorCode === 'UNEXPECTED_ERROR');
}

// ---------------------------------------------------------------------
// SECRET REDACTION
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)], { upstreamErrorForEventVersionId: EV1 });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const text = await res.text();
  t('corps d\'erreur PostgREST amont (contenant de faux secrets) jamais reflété dans la réponse HTTP',
    !text.includes('FAKE_TOKEN_LEAK') && !text.includes('FAKE_BEARER_LEAK') && !text.includes(SERVICE_ROLE_KEY));
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], { networkFailureOnAcquire: true });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('erreur réseau contenant un faux secret => jamais exposée en clair', !text.includes(SERVICE_ROLE_KEY));
  t('échec réseau non caractérisé => 500 générique', res.status === 500);
}
{
  // Raw literal SUPABASE_SERVICE_ROLE_KEY, no token=/Bearer prefix.
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `connection failed: ${SERVICE_ROLE_KEY}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('SUPABASE_SERVICE_ROLE_KEY brut (sans préfixe token=/Bearer) sur le chemin per-item => jamais exposé', res.status === 200 && !text.includes(SERVICE_ROLE_KEY));
}
{
  // Raw literal INGEST_TOKEN, no token=/Bearer prefix.
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `connection failed: ${INGEST_TOKEN}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('INGEST_TOKEN brut (sans préfixe token=/Bearer) sur le chemin per-item => jamais exposé', res.status === 200 && !text.includes(INGEST_TOKEN));
}
{
  // query/header-shaped secret pattern.
  const FAKE = 'FAKE_ACCESS_TOKEN_SECRET';
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `upstream redirected to https://example.test/callback?access_token=${FAKE}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('access_token=... jamais exposé en clair', res.status === 200 && !text.includes(FAKE));
}
{
  // Bearer token68 including +, / and ~ plus trailing "=" padding.
  const BEARER_TOKEN = 'FAKE+BEARER/TOKEN~VALUE==';
  const leakingTail = '+BEARER/TOKEN~VALUE==';
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `upstream rejected request: Authorization: Bearer ${BEARER_TOKEN}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('Authorization: Bearer <token avec +, / et ~ et padding =====> valeur complète absente', res.status === 200 && !text.includes(BEARER_TOKEN));
  t('le fragment (incluant le padding "=") qui fuirait avec une regex Bearer étroite n\'apparaît pas', !text.includes(leakingTail));
}
{
  // Secret straddling the truncation boundary — SUPABASE_SERVICE_ROLE_KEY.
  const PREFIX_LEN = 'Error: '.length;
  const STRADDLE_OFFSET = 5;
  const padding = 'x'.repeat(400 - PREFIX_LEN - STRADDLE_OFFSET);
  const leakingFragment = SERVICE_ROLE_KEY.slice(0, STRADDLE_OFFSET);
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `${padding}${SERVICE_ROLE_KEY}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('SUPABASE_SERVICE_ROLE_KEY à cheval sur la limite de troncature => secret complet absent', res.status === 200 && !text.includes(SERVICE_ROLE_KEY));
  t('fragment qui fuirait avec un ordre troncature-avant-redaction n\'apparaît pas', !text.includes(leakingFragment));
}
{
  // Secret straddling the truncation boundary — INGEST_TOKEN.
  const PREFIX_LEN = 'Error: '.length;
  const STRADDLE_OFFSET = 5;
  const padding = 'x'.repeat(400 - PREFIX_LEN - STRADDLE_OFFSET);
  const leakingFragment = INGEST_TOKEN.slice(0, STRADDLE_OFFSET);
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `${padding}${INGEST_TOKEN}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('INGEST_TOKEN à cheval sur la limite de troncature => secret complet absent', res.status === 200 && !text.includes(INGEST_TOKEN));
  t('fragment INGEST_TOKEN qui fuirait avec troncature-avant-redaction n\'apparaît pas', !text.includes(leakingFragment));
}
{
  const { fakeFetch } = makeFakeFetch([], {});
  const res = await withFakeFetch(fakeFetch, () => handleGoldTransmissionShadowRequest(
    makeRequest({ headers: { 'x-ingest-token': 'wrong', 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [] }) }), ENV,
  ));
  const text = await res.text();
  t('401 ne fuit ni INGEST_TOKEN ni SUPABASE_SERVICE_ROLE_KEY', !text.includes(INGEST_TOKEN) && !text.includes(SERVICE_ROLE_KEY));
}

// ---------------------------------------------------------------------
// ISOLATION STATIC GUARDS
// ---------------------------------------------------------------------
t('aucune référence exécutable à la découverte/cron dans le runtime',
  !/discover|cron|scheduled\(/i.test(liveRuntimeSource));
t('aucune référence exécutable LLM/Anthropic/OpenAI/Gemini/Committee dans le runtime',
  !/anthropic|openai|gemini|committee/i.test(liveRuntimeSource));
t('aucune référence exécutable au scoring legacy / pricing-positioning-regime dans le runtime',
  !/news_score|expected_move_usd|gold_direction_impact|pricing_state|positioning|market_regime/i.test(liveRuntimeSource));
t('aucun triggerType lu depuis la requête dans du code exécutable (toujours le littéral \'manual\')',
  !/triggerType/.test(liveRuntimeSource) && /'manual' as const/.test(runtimeSource));
t('shadow_runtime.ts ne référence jamais fn_gold_transmission_create_assessment dans du code exécutable',
  !/fn_gold_transmission_create_assessment/.test(liveRuntimeSource));
t('shadow_runtime.ts n\'importe pas shadow_orchestrator.ts/deterministic_processor.ts directement (seulement shadow_batch.ts)',
  !/from '\.\/shadow_orchestrator\.js'/.test(liveRuntimeSource) && !/from '\.\/deterministic_processor\.js'/.test(liveRuntimeSource));
t('shadow_runtime.ts importe runGoldTransmissionShadowBatch depuis ./shadow_batch.js',
  /import\s*\{[\s\S]*?runGoldTransmissionShadowBatch[\s\S]*?\}\s*from\s*'\.\/shadow_batch\.js'/.test(runtimeSource));
t('shadow_runtime.ts n\'implémente pas sa propre boucle de traitement séquentiel',
  !/for \(const eventVersionId of/.test(runtimeSource));
t('shadow_runtime.ts ne redéfinit pas acquireLock/releaseLock (pas de verrou custom)',
  !/function acquireLock|function releaseLock/.test(runtimeSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
