// Behavioral contract for EI-6 (backend/event_impact/shadow_runtime.ts).
// Transpiles TypeScript with `typescript` (already a devDependency, no new
// dependency) and executes the REAL compiled modules — shadow_runtime.ts,
// shadow_batch.ts (EI-5), shadow_orchestrator.ts (EI-4),
// deterministic_processor.ts (EI-3), shared/run_lock.ts — never a fake
// substitute for any of them. ONLY the external network boundary
// (`globalThis.fetch`) is simulated. backend/worker.ts wiring (item B) is
// checked statically on its source text, since importing it would also
// have to load unrelated heavy engines (market/news/committee) that are
// out of scope for this runtime's own contract.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'backend', 'event_impact', 'shadow_runtime.ts');
const BATCH_PATH = path.join(ROOT, 'backend', 'event_impact', 'shadow_batch.ts');
const ORCHESTRATOR_PATH = path.join(ROOT, 'backend', 'event_impact', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(ROOT, 'backend', 'event_impact', 'deterministic_processor.ts');
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

// Comment-stripped views (block comments + dedicated `//` comment lines
// removed) for keyword-absence assertions below, so this file's OWN prose
// documentation (which necessarily names the things it explicitly does
// NOT do, e.g. "no cron", "never calls fn_event_impact_create_assessment
// directly") never makes a false-positive match against itself.
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
//    relative directory structure (event_impact/ + shared/) so relative
//    import specifiers resolve.
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
  tmpDir = mkdtempSync(path.join(tmpdir(), 'event-impact-runtime-'));
  const eiDir = path.join(tmpDir, 'event_impact');
  const sharedDir = path.join(tmpDir, 'shared');
  mkdirSync(eiDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  writeFileSync(path.join(eiDir, 'deterministic_processor.mjs'), transpile(processorSource), 'utf8');

  const orchestrator = transpile(orchestratorSource).replace(
    /(['"])\.\/deterministic_processor\.js\1/,
    '$1./deterministic_processor.mjs$1',
  );
  writeFileSync(path.join(eiDir, 'shadow_orchestrator.mjs'), orchestrator, 'utf8');
  writeFileSync(path.join(sharedDir, 'run_lock.mjs'), transpile(lockSource), 'utf8');

  const batch = transpile(batchSource)
    .replace(/(['"])\.\/shadow_orchestrator\.js\1/, '$1./shadow_orchestrator.mjs$1')
    .replace(/(['"])\.\.\/shared\/run_lock\.js\1/, '$1../shared/run_lock.mjs$1');
  writeFileSync(path.join(eiDir, 'shadow_batch.mjs'), batch, 'utf8');

  const runtime = transpile(runtimeSource).replace(
    /(['"])\.\/shadow_batch\.js\1/,
    '$1./shadow_batch.mjs$1',
  );
  const runtimeTmpFile = path.join(eiDir, 'shadow_runtime.mjs');
  writeFileSync(runtimeTmpFile, runtime, 'utf8');

  mod = await import(pathToFileURL(runtimeTmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD Event Impact shadow_runtime.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------
// A. module loads
// ---------------------------------------------------------------------
t('les cinq modules réels transpilent et se chargent sans erreur', mod !== null);
t('handleEventImpactShadowRequest est exporté (fonction)', typeof mod?.handleEventImpactShadowRequest === 'function');
t('PostgrestEventImpactShadowDb est exporté (classe)', typeof mod?.PostgrestEventImpactShadowDb === 'function');
t('buildPostgrestHeaders est exporté (fonction)', typeof mod?.buildPostgrestHeaders === 'function');
t('validateSupabaseUrl est exporté (fonction)', typeof mod?.validateSupabaseUrl === 'function');
t('validatePostgrestPath est exporté (fonction)', typeof mod?.validatePostgrestPath === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const {
  handleEventImpactShadowRequest,
  PostgrestEventImpactShadowDb,
  buildPostgrestHeaders,
  validateSupabaseUrl,
  validatePostgrestPath,
} = mod;

// ---------------------------------------------------------------------
// B. worker.ts static wiring — exact route, no cron/scheduled/JobName
//    change, EI-6 import present.
// ---------------------------------------------------------------------
t('worker.ts importe handleEventImpactShadowRequest depuis ./event_impact/shadow_runtime.js',
  /import\s*\{\s*handleEventImpactShadowRequest\s*\}\s*from\s*'\.\/event_impact\/shadow_runtime\.js'/.test(workerSource));
t('worker.ts route EXACTEMENT path === \'/event-impact-shadow\'',
  /if \(path === '\/event-impact-shadow'\) return handleEventImpactShadowRequest\(request, env\);/.test(workerSource));
t('worker.ts n\'utilise PAS startsWith(\'/event-impact-shadow\') dans du code exécutable',
  !/startsWith\('\/event-impact-shadow'\)/.test(liveWorkerSource));
t('aucune sous-route Event Impact (pas de /event-impact-shadow/discover ou équivalent)',
  !/\/event-impact-shadow\/[a-z]/.test(workerSource));
t('scheduled()/resolveJob()/JobName restent inchangés (EI-6 n\'y apparaît pas)',
  (() => {
    const scheduledMatch = /async scheduled\([\s\S]*?\n  \},/.exec(workerSource);
    const resolveJobMatch = /export function resolveJob\([\s\S]*?\n\}/.exec(workerSource);
    const jobNameMatch = /export type JobName[^\n]*\n/.exec(workerSource);
    return scheduledMatch !== null && resolveJobMatch !== null && jobNameMatch !== null
      && !scheduledMatch[0].includes('event_impact') && !scheduledMatch[0].includes('EventImpact')
      && !resolveJobMatch[0].includes('event_impact') && !resolveJobMatch[0].includes('EventImpact')
      && !jobNameMatch[0].includes('event_impact') && !jobNameMatch[0].includes('EventImpact');
  })());
t('wrangler.toml inchangé par cette PR (aucune référence event-impact-shadow attendue dans wrangler.toml)',
  !/event-impact-shadow/i.test(wranglerSource));
t('runtime source ne modifie pas /event-shadow existant (aucune référence à handleEventShadowRequest)',
  !/handleEventShadowRequest/.test(runtimeSource));

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

const EV1 = uid('ev1');
const EV2 = uid('ev2');
const UNKNOWN_EV = uid('unknown-ev');
const CLUSTER = uid('cluster');
const CUTOFF = '2026-09-22T00:00:00.123456+00:00';

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
 * PostgREST path (after REST_PREFIX), records every call (url, method,
 * headers, parsed body, path), returns real Fetch API `Response` objects.
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

    // Per-item network-level failure (fetch itself throws, not a non-2xx
    // Response) on the RPC call for one specific Event Version — this is
    // the EXACT escape path an independent review flagged: PostgREST
    // adapter error -> EI-5 per-item FAILED.safeErrorMessage -> structured
    // HTTP 200 report. `message` is the raw, uncrafted error text (the
    // caller controls its exact shape, including with NO recognizable
    // token=/Bearer/apikey prefix) to prove exact-value redaction, not
    // just pattern-based redaction.
    if (
      options.perItemNetworkFailure
      && method === 'POST'
      && restPath === 'rpc/fn_event_impact_create_assessment'
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
    if (method === 'POST' && restPath === 'rpc/fn_event_impact_create_assessment') {
      const eventVersionId = body?.p_event_version_id;
      if (options.upstreamErrorForEventVersionId === eventVersionId) {
        return new Response(
          JSON.stringify({ message: `synthetic upstream error containing a fake secret apiKey=${SERVICE_ROLE_KEY} token=FAKE_TOKEN_LEAK Authorization: Bearer FAKE_BEARER_LEAK` }),
          { status: 500 },
        );
      }
      const count = (createCallCountByEventVersion.get(eventVersionId) ?? 0) + 1;
      createCallCountByEventVersion.set(eventVersionId, count);
      const assessmentId = assessmentIdByEventVersion.get(eventVersionId) ?? uid(`assessment:${eventVersionId}`);
      assessmentIdByEventVersion.set(eventVersionId, assessmentId);
      bodyByAssessment.set(assessmentId, structuredClone(body));
      return new Response(JSON.stringify([{
        assessment_id: assessmentId,
        replayed: count > 1,
        interpretation_count: 0,
      }]), { status: 200 });
    }
    if (method === 'GET' && restPath.startsWith('event_impact_assessments?')) {
      const assessmentId = extractEq(restPath, 'id');
      const persistedBody = bodyByAssessment.get(assessmentId);
      if (!persistedBody) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([{
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
      }]), { status: 200 });
    }
    if (method === 'GET' && restPath.startsWith('event_impact_interpretations?')) {
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
  return new Request('https://worker.test/event-impact-shadow', init);
}

const AUTH_HEADERS = { 'x-ingest-token': INGEST_TOKEN, 'content-type': 'application/json' };

// ---------------------------------------------------------------------
// D/E/F. Authentication.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('D) auth manquante => 401', res.status === 401);
  t('D) auth manquante => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: { 'x-ingest-token': 'wrong-token', 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('D) auth incorrecte => 401', res.status === 401);
  t('D) auth incorrecte => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('E) x-ingest-token autorisé => 200', res.status === 200);
  const text = await res.text();
  t('AD) INGEST_TOKEN n\'apparaît jamais dans la réponse', !text.includes(INGEST_TOKEN));
  t('AD) SUPABASE_SERVICE_ROLE_KEY n\'apparaît jamais dans la réponse', !text.includes(SERVICE_ROLE_KEY));
}
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }),
    ENV,
  ));
  t('F) repli Authorization: Bearer <INGEST_TOKEN> accepté', res.status === 200);
}

// ---------------------------------------------------------------------
// C. Method contract.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(makeRequest({ method: 'GET', headers: AUTH_HEADERS }), ENV));
  t('C) GET => 405', res.status === 405);
  t('C) GET => en-tête Allow: POST', res.headers.get('allow') === 'POST');
  t('C) GET => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(makeRequest({ method: 'PUT', headers: AUTH_HEADERS }), ENV));
  t('C) PUT => 405', res.status === 405 && calls.length === 0);
}

// ---------------------------------------------------------------------
// B (route exactness at runtime). exact route contract already covered
// statically above; here confirm the handler itself has no method/path
// dispatch beyond what worker.ts already gates.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// G/H/I/J/K. Envelope validation.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: '{not valid json' }), ENV));
  t('G) JSON malformé => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify('just a string') }), ENV));
  t('H) corps non-objet (chaîne) => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify([1, 2, 3]) }), ENV));
  t('H) corps non-objet (tableau) => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({}) }), ENV));
  t('I) eventVersionIds manquant => 400', res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1], triggerType: 'automatic' }) }), ENV,
  ));
  t('J) champ inattendu (triggerType) => 400', res.status === 400 && calls.length === 0);
}
for (const field of ['maxCandidates', 'lane', 'processorVersion', 'orchestratorVersion', 'assessmentStatus', 'producerType', 'algorithmVersion', 'dryRun', 'cursor', 'timestamp', 'backfill']) {
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1], [field]: 'x' }) }), ENV,
  ));
  t(`J) champ inattendu "${field}" => 400`, res.status === 400 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: 'not-an-array' }) }), ENV,
  ));
  t('K) eventVersionIds non-array => 400', res.status === 400 && calls.length === 0);
}

// ---------------------------------------------------------------------
// L/M. Body size limits.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const oversizedDeclared = String(20 * 1024);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: { ...AUTH_HEADERS, 'content-length': oversizedDeclared }, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('L) Content-Length déclaré surdimensionné => 413 sans parsing du corps', res.status === 413 && calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const bigArray = Array.from({ length: 2000 }, () => EV1);
  const oversizedBody = JSON.stringify({ eventVersionIds: bigArray });
  t('précondition: corps réellement surdimensionné', Buffer.byteLength(oversizedBody, 'utf8') > 16 * 1024);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: oversizedBody }), ENV,
  ));
  t('M) corps réellement surdimensionné => 413 même sans Content-Length déclaré/sous-estimé', res.status === 413 && calls.length === 0);
}

// ---------------------------------------------------------------------
// N. EI-5 caller-input invariants map to 400.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [] }) }), ENV,
  ));
  t('N) liste vide (EI-5 EMPTY_EVENT_VERSION_LIST) => 400', res.status === 400);
  const json = await res.json();
  t('N) code EMPTY_EVENT_VERSION_LIST exposé', json.code === 'EMPTY_EVENT_VERSION_LIST');
}
{
  const { fakeFetch } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: ['not-a-uuid'] }) }), ENV,
  ));
  t('N) UUID malformé (EI-5 MALFORMED_EVENT_VERSION_ID) => 400', res.status === 400);
}
{
  const { fakeFetch } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV1.toUpperCase()] }) }), ENV,
  ));
  t('N) doublon casse différente (EI-5 DUPLICATE_EVENT_VERSION_ID) => 400', res.status === 400);
}
{
  const many = Array.from({ length: 26 }, (_, i) => uid(`max-${i}`));
  const { fakeFetch } = makeFakeFetch(many.map((id) => makeEventVersion(id)));
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: many }) }), ENV,
  ));
  t('N) > 25 ids (EI-5 BATCH_SIZE_EXCEEDED) => 400', res.status === 400);
}

// ---------------------------------------------------------------------
// O. Successful one-item call.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('O) un seul item => 200', res.status === 200);
  const json = await res.json();
  t('O) { ok: true, report } avec report.status=success', json.ok === true && json.report.status === 'success');
  t('O) une évaluation créée, V1 reste INSUFFICIENT_EVIDENCE/UNAVAILABLE, zéro interprétation', json.report.processed === 1
    && json.report.assessmentsCreated === 1
    && json.report.items[0].interpretationCount === 0
    && (json.report.items[0].assessmentStatus === 'INSUFFICIENT_EVIDENCE' || json.report.items[0].assessmentStatus === 'UNAVAILABLE'));
  t('O) trigger toujours "manual" dans le report', json.report.triggerType === 'manual');
  const rpcCall = calls.find((c) => c.path === 'rpc/fn_event_impact_create_assessment');
  t('AF) le runtime n\'appelle jamais directement fn_event_impact_create_assessment (c\'est EI-4, atteint via EI-5 réel)', rpcCall !== undefined);
}

// ---------------------------------------------------------------------
// P/Q. Multi-item sequential batch + exact replay.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  t('P) batch multi-item => 200, deux items traités', res.status === 200);
  const json = await res.json();
  t('P) ordre de l\'appelant conservé', json.report.items[0].eventVersionId === EV1 && json.report.items[1].eventVersionId === EV2);

  const relevant = calls.filter((c) => c.path.startsWith('event_versions?') || c.path === 'rpc/fn_event_impact_create_assessment');
  t('P) traitement strictement séquentiel (event_versions puis RPC, en alternance)', relevant.length === 4
    && relevant[0].path.startsWith('event_versions?') && relevant[1].path === 'rpc/fn_event_impact_create_assessment'
    && relevant[2].path.startsWith('event_versions?') && relevant[3].path === 'rpc/fn_event_impact_create_assessment');

  const firstAssessmentId = json.report.items[0].assessmentId;
  const res2 = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const json2 = await res2.json();
  t('Q) rejeu exact => replayed=true, même assessment_id, zéro nouvelle persistance', res2.status === 200
    && json2.report.assessmentsCreated === 0
    && json2.report.assessmentsReplayed === 2
    && json2.report.items[0].assessmentReplayed === true
    && json2.report.items[0].assessmentId === firstAssessmentId);
}

// ---------------------------------------------------------------------
// R. Busy lock -> 409.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)], { forceAlreadyRunning: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('R) verrou déjà pris => 409', res.status === 409);
  const json = await res.json();
  t('R) code EVENT_IMPACT_SHADOW_ALREADY_RUNNING', json.code === 'EVENT_IMPACT_SHADOW_ALREADY_RUNNING');
  t('R) aucune Event Version lue (verrou jamais acquis)', !calls.some((c) => c.path.startsWith('event_versions?')));
}

// ---------------------------------------------------------------------
// S. Partial batch still HTTP 200.
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)], { upstreamErrorForEventVersionId: EV1 });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  t('S) échec isolé => toujours HTTP 200 avec report structuré', res.status === 200);
  const json = await res.json();
  t('S) report.status = partial', json.report.status === 'partial' && json.report.failed === 1 && json.report.processed === 1);
}

// ---------------------------------------------------------------------
// T. Operational lock release failure -> 500.
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], { forceReleaseFailure: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('T) échec opérationnel de libération de verrou => 500', res.status === 500);
  const text = await res.text();
  t('T) 500 sans fuite de secret', !text.includes(SERVICE_ROLE_KEY) && !text.includes('apiKey='));
}

// ---------------------------------------------------------------------
// U/V/W. Supabase auth security.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('U) toutes les requêtes PostgREST portent apikey === SUPABASE_SERVICE_ROLE_KEY',
    calls.length > 0 && calls.every((c) => c.headers.apikey === SERVICE_ROLE_KEY));
  t('V) aucune requête PostgREST ne porte un en-tête Authorization dérivé de la clé service-role',
    calls.every((c) => c.headers.authorization === undefined));
}
{
  const headers = buildPostgrestHeaders('real-key', false, { apikey: 'malicious-override', authorization: 'Bearer malicious', prefer: 'return=representation' });
  t('W) apikey malicieux dans extraHeaders ne peut PAS écraser la clé authoritative', headers.apikey === 'real-key');
  t('W) authorization malicieux dans extraHeaders est éliminé', headers.authorization === undefined);
  t('W) en-têtes internes légitimes (prefer) passent inchangés', headers.prefer === 'return=representation');
}

// ---------------------------------------------------------------------
// X. GET carries no request body.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([makeEventVersion(EV1)]);
  await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const getCalls = calls.filter((c) => c.method === 'GET');
  t('X) au moins un appel GET observé', getCalls.length > 0);
  t('X) aucun appel GET ne porte de corps', getCalls.every((c) => c.hasBody === false));
}

// ---------------------------------------------------------------------
// Y. Path escape rejected.
// ---------------------------------------------------------------------
{
  let threw = false;
  try { validatePostgrestPath('event_versions/../../secrets'); } catch { threw = true; }
  t('Y) segment de traversée de répertoire (..) rejeté', threw);
}
{
  let threw = false;
  try { validatePostgrestPath('https://evil.example/steal'); } catch { threw = true; }
  t('Y) URL/schéma embarqué (://) rejeté', threw);
}
{
  const db = new PostgrestEventImpactShadowDb(ENV);
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
  t('Y) request() rejette un path d\'échappement AVANT tout appel fetch', threw && fetchCalled === false);
}

// ---------------------------------------------------------------------
// Z. Unsupported DB method rejected at runtime.
// ---------------------------------------------------------------------
{
  const db = new PostgrestEventImpactShadowDb(ENV);
  let threw = false;
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
  try {
    await db.request('DELETE', 'event_impact_assessments?id=eq.x');
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = original;
  }
  t('Z) méthode DELETE rejetée avant tout appel fetch (seules GET/POST/PATCH autorisées au runtime)', threw && fetchCalled === false);
}

// ---------------------------------------------------------------------
// AA. Malformed successful PostgREST JSON fails safely. EI-5 isolates
//     per-item failures (same established convention as item S) — this
//     is the ONLY requested Event Version, so the batch itself still
//     completes and returns HTTP 200 with a structured FAILED item,
//     never an unhandled crash and never a raw JSON-parse error leaking
//     to the caller.
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], { malformedEventVersionsJson: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  t('AA) JSON PostgREST malformé sur une réponse 2xx => échec sûr (report structuré, jamais un crash non géré)', res.status === 200);
  const json = await res.json();
  t('AA) l\'item concerné devient FAILED avec un code sûr, le batch reste "failed" mais structuré', json.report.status === 'failed'
    && json.report.items[0].kind === 'FAILED'
    && json.report.items[0].errorCode === 'UNEXPECTED_ERROR');
}

// ---------------------------------------------------------------------
// AB. Upstream PostgREST error body with fake secrets never echoed.
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)], { upstreamErrorForEventVersionId: EV1 });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const text = await res.text();
  t('AB) corps d\'erreur PostgREST amont (contenant de faux secrets) jamais reflété dans la réponse HTTP',
    !text.includes('FAKE_TOKEN_LEAK') && !text.includes('FAKE_BEARER_LEAK') && !text.includes(SERVICE_ROLE_KEY));
}

// ---------------------------------------------------------------------
// AC. Network error containing fake secret redacted.
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], { networkFailureOnAcquire: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('AC) erreur réseau contenant un faux secret => jamais exposée en clair dans la réponse HTTP',
    !text.includes(SERVICE_ROLE_KEY));
  t('AC) échec réseau non caractérisé => 500 générique', res.status === 500);
}

// ---------------------------------------------------------------------
// SECURITY FIX REGRESSION — independent review BLOCKER: the PostgREST
// network-error path previously exact-redacted only this.apiKey
// (SUPABASE_SERVICE_ROLE_KEY), never INGEST_TOKEN, so a raw INGEST_TOKEN
// literal with no recognizable "token="/Bearer prefix could in principle
// flow: PostgREST adapter network error -> EI-5 per-item
// FAILED.safeErrorMessage -> structured HTTP 200 report, unredacted.
// Fixed by having PostgrestEventImpactShadowDb also retain INGEST_TOKEN
// and pass BOTH known secrets to redactExactSecrets() in the
// network-failure catch, and by adding access_token= to the generic
// pattern-based redactString(). These four cases exercise the EXACT
// per-item escape path (fetch() itself throws on the RPC call for one
// specific Event Version, caught by EI-5's per-item try/catch, embedded
// in the batch report EI-6 returns with HTTP 200) — not the
// lock-acquisition network failure already covered by AC above, and not
// the non-2xx upstream-body path already covered by AB above.
// ---------------------------------------------------------------------
{
  // A. Raw literal SUPABASE_SERVICE_ROLE_KEY, no token=/Bearer prefix.
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `connection failed: ${SERVICE_ROLE_KEY}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('SECURITY FIX A) SUPABASE_SERVICE_ROLE_KEY brut (sans préfixe token=/Bearer) sur le chemin per-item => jamais exposé', res.status === 200 && !text.includes(SERVICE_ROLE_KEY));
}
{
  // B. Raw literal INGEST_TOKEN, no token=/Bearer prefix — the exact gap
  //    the independent review identified.
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `connection failed: ${INGEST_TOKEN}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('SECURITY FIX B) INGEST_TOKEN brut (sans préfixe token=/Bearer) sur le chemin per-item => jamais exposé', res.status === 200 && !text.includes(INGEST_TOKEN));
  const json = JSON.parse(text);
  t('SECURITY FIX B) le rapport structuré confirme l\'item FAILED avec message expurgé', json.report.items[0].kind === 'FAILED' && json.report.items[0].safeErrorMessage.includes('[REDACTED]'));
}
{
  // C. access_token= query-style pattern (generic redaction extension).
  const FAKE = 'FAKE_ACCESS_TOKEN_SECRET';
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `upstream redirected to https://example.test/callback?access_token=${FAKE}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('SECURITY FIX C) access_token=... jamais exposé en clair', res.status === 200 && !text.includes(FAKE));
}
{
  // D. Authorization: Bearer <secret> shape.
  const FAKE = 'FAKE_BEARER_SECRET_VALUE';
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `upstream rejected request: Authorization: Bearer ${FAKE}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const text = await res.text();
  t('SECURITY FIX D) Authorization: Bearer <secret> jamais exposé en clair', res.status === 200 && !text.includes(FAKE));
}
{
  // E. Existing partial-batch HTTP 200 behavior is unchanged by the fix:
  //    one failing item + one succeeding item => still 200/partial.
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1), makeEventVersion(EV2)], {
    perItemNetworkFailure: { eventVersionId: EV1, message: `connection failed: ${INGEST_TOKEN}` },
  });
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1, EV2] }) }), ENV,
  ));
  const json = await res.json();
  t('SECURITY FIX E) comportement partial-batch HTTP 200 inchangé (un échec isolé n\'empêche pas le second item)',
    res.status === 200 && json.report.status === 'partial' && json.report.failed === 1 && json.report.processed === 1
    && json.report.items[1].kind === 'PROCESSED');
}
{
  // F. Successful (no-failure) path is unchanged by the fix.
  const { fakeFetch } = makeFakeFetch([makeEventVersion(EV1)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ eventVersionIds: [EV1] }) }), ENV,
  ));
  const json = await res.json();
  t('SECURITY FIX F) chemin de succès inchangé (report.status=success, une évaluation créée)',
    res.status === 200 && json.report.status === 'success' && json.report.assessmentsCreated === 1);
}

// ---------------------------------------------------------------------
// AD covered above (auth success path). Additional check: even on error
// responses, no secret leaks.
// ---------------------------------------------------------------------
{
  const { fakeFetch } = makeFakeFetch([], {});
  const res = await withFakeFetch(fakeFetch, () => handleEventImpactShadowRequest(
    makeRequest({ headers: { 'x-ingest-token': 'wrong', 'content-type': 'application/json' }, bodyText: JSON.stringify({ eventVersionIds: [] }) }), ENV,
  ));
  const text = await res.text();
  t('AD) 401 ne fuit ni INGEST_TOKEN ni SUPABASE_SERVICE_ROLE_KEY', !text.includes(INGEST_TOKEN) && !text.includes(SERVICE_ROLE_KEY));
}

// ---------------------------------------------------------------------
// AE. No discovery / cron / LLM / legacy scoring / Gold Transmission
//     behavior anywhere in the runtime source.
// ---------------------------------------------------------------------
t('AE) aucune référence exécutable à la découverte/cron dans le runtime',
  !/discover|cron|scheduled\(/i.test(liveRuntimeSource));
t('AE) aucune référence exécutable LLM/Anthropic/Committee dans le runtime',
  !/anthropic|openai|gemini|committee/i.test(liveRuntimeSource));
t('AE) aucune référence exécutable au scoring legacy / Gold Transmission dans le runtime',
  !/news_score|expected_move_usd|gold_direction_impact|transmission_channel|real_yield_effect|safe_haven_effect/i.test(liveRuntimeSource));
t('AE) aucun triggerType lu depuis la requête dans du code exécutable (toujours le littéral \'manual\')',
  !/triggerType/.test(liveRuntimeSource) && /'manual' as const/.test(runtimeSource));

// ---------------------------------------------------------------------
// AF. No direct Event Impact persistence RPC call in the runtime module
//     itself (only through the imported, reused EI-5/EI-4 chain).
// ---------------------------------------------------------------------
t('AF) shadow_runtime.ts ne référence jamais fn_event_impact_create_assessment dans du code exécutable',
  !/fn_event_impact_create_assessment/.test(liveRuntimeSource));
t('AF) shadow_runtime.ts n\'importe pas shadow_orchestrator.ts/deterministic_processor.ts directement (seulement shadow_batch.ts)',
  !/from '\.\/shadow_orchestrator\.js'/.test(liveRuntimeSource) && !/from '\.\/deterministic_processor\.js'/.test(liveRuntimeSource));

// ---------------------------------------------------------------------
// AG. EI-5 is imported/reused, not reimplemented.
// ---------------------------------------------------------------------
t('AG) shadow_runtime.ts importe runEventImpactShadowBatch depuis ./shadow_batch.js',
  /import\s*\{[\s\S]*?runEventImpactShadowBatch[\s\S]*?\}\s*from\s*'\.\/shadow_batch\.js'/.test(runtimeSource));
t('AG) shadow_runtime.ts n\'importe pas de boucle de traitement séquentiel ou de logique de batch dupliquée (aucune définition de "for (const eventVersionId of")',
  !/for \(const eventVersionId of/.test(runtimeSource));
t('AG) shadow_runtime.ts ne redéfinit pas acquireLock/releaseLock',
  !/function acquireLock|function releaseLock/.test(runtimeSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
