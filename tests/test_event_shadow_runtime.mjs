// Contrat BEHAVIORAL (pas seulement statique) du runtime Worker OPS-023
// PR7+PR9 (backend/event_engine/shadow_runtime.ts). Comme pour les tests
// PR5/PR6/PR8, ce fichier transpile le TypeScript source avec `typescript`
// (déjà présent en devDependency, aucune nouvelle dépendance) et exécute
// les SIX modules réellement compilés — shadow_runtime.ts, shadow_batch.ts,
// shadow_orchestrator.ts, deterministic_processor.ts, run_lock.ts,
// shadow_candidate_discovery.ts (PR9) — jamais aucun n'est remplacé par une
// version factice. SEULE la frontière réseau externe (`global fetch`) est
// simulée.
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_runtime.ts');
const BATCH_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_batch.ts');
const ORCHESTRATOR_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'deterministic_processor.ts');
const RUN_LOCK_PATH = path.join(__dirname, '..', 'backend', 'shared', 'run_lock.ts');
const DISCOVERY_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_candidate_discovery.ts');
const WORKER_PATH = path.join(__dirname, '..', 'backend', 'worker.ts');
const WRANGLER_PATH = path.join(__dirname, '..', 'wrangler.toml');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('backend/event_engine/shadow_runtime.ts existe', existsSync(RUNTIME_PATH));

const runtimeSource = existsSync(RUNTIME_PATH) ? readFileSync(RUNTIME_PATH, 'utf8') : '';
const batchSource = existsSync(BATCH_PATH) ? readFileSync(BATCH_PATH, 'utf8') : '';
const orchestratorSource = existsSync(ORCHESTRATOR_PATH) ? readFileSync(ORCHESTRATOR_PATH, 'utf8') : '';
const processorSource = existsSync(PROCESSOR_PATH) ? readFileSync(PROCESSOR_PATH, 'utf8') : '';
const runLockSource = existsSync(RUN_LOCK_PATH) ? readFileSync(RUN_LOCK_PATH, 'utf8') : '';
const discoverySource = existsSync(DISCOVERY_PATH) ? readFileSync(DISCOVERY_PATH, 'utf8') : '';
const workerSource = existsSync(WORKER_PATH) ? readFileSync(WORKER_PATH, 'utf8') : '';
const wranglerSource = existsSync(WRANGLER_PATH) ? readFileSync(WRANGLER_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Transpilation + chargement ESM réel des SIX modules, avec la MÊME
//    structure de répertoires relative que le dépôt (event_engine/ +
//    shared/) pour que les spécificateurs d'import relatifs résolvent.
// ---------------------------------------------------------------------
function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;
}

let mod = null;
let tmpDir = null;
try {
  const processorTranspiled = transpile(processorSource);
  let orchestratorTranspiled = transpile(orchestratorSource);
  orchestratorTranspiled = orchestratorTranspiled.replace(
    /(['"])\.\/deterministic_processor\.js\1/,
    "$1./deterministic_processor.mjs$1",
  );
  const runLockTranspiled = transpile(runLockSource);
  const discoveryTranspiled = transpile(discoverySource);
  let batchTranspiled = transpile(batchSource);
  batchTranspiled = batchTranspiled
    .replace(/(['"])\.\/shadow_orchestrator\.js\1/, "$1./shadow_orchestrator.mjs$1")
    .replace(/(['"])\.\.\/shared\/run_lock\.js\1/, "$1../shared/run_lock.mjs$1");
  let runtimeTranspiled = transpile(runtimeSource);
  runtimeTranspiled = runtimeTranspiled
    .replace(/(['"])\.\/shadow_batch\.js\1/, "$1./shadow_batch.mjs$1")
    .replace(/(['"])\.\/shadow_candidate_discovery\.js\1/, "$1./shadow_candidate_discovery.mjs$1");

  tmpDir = mkdtempSync(path.join(tmpdir(), 'ops023-shadow-runtime-'));
  const eventEngineDir = path.join(tmpDir, 'event_engine');
  const sharedDir = path.join(tmpDir, 'shared');
  mkdirSync(eventEngineDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  writeFileSync(path.join(eventEngineDir, 'deterministic_processor.mjs'), processorTranspiled, 'utf8');
  writeFileSync(path.join(eventEngineDir, 'shadow_orchestrator.mjs'), orchestratorTranspiled, 'utf8');
  writeFileSync(path.join(sharedDir, 'run_lock.mjs'), runLockTranspiled, 'utf8');
  writeFileSync(path.join(eventEngineDir, 'shadow_batch.mjs'), batchTranspiled, 'utf8');
  writeFileSync(path.join(eventEngineDir, 'shadow_candidate_discovery.mjs'), discoveryTranspiled, 'utf8');
  const runtimeTmpFile = path.join(eventEngineDir, 'shadow_runtime.mjs');
  writeFileSync(runtimeTmpFile, runtimeTranspiled, 'utf8');

  mod = await import(pathToFileURL(runtimeTmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD shadow_runtime.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

t('les six modules transpilent et se chargent sans erreur', mod !== null);
t('handleEventShadowRequest est exporté (fonction)', typeof mod?.handleEventShadowRequest === 'function');
t('handleEventShadowDiscoverRequest est exporté (fonction, PR9)', typeof mod?.handleEventShadowDiscoverRequest === 'function');
t('PostgrestEventShadowDb est exporté (classe)', typeof mod?.PostgrestEventShadowDb === 'function');
t('buildPostgrestHeaders est exporté (fonction)', typeof mod?.buildPostgrestHeaders === 'function');
t('validateSupabaseUrl est exporté (fonction)', typeof mod?.validateSupabaseUrl === 'function');
t('validatePostgrestPath est exporté (fonction)', typeof mod?.validatePostgrestPath === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const {
  handleEventShadowRequest,
  handleEventShadowDiscoverRequest,
  PostgrestEventShadowDb,
  buildPostgrestHeaders,
  validateSupabaseUrl,
  validatePostgrestPath,
} = mod;

// ---------------------------------------------------------------------
// Environnement + fixtures.
// ---------------------------------------------------------------------
const SUPABASE_URL = 'https://fake-project.supabase.test';
const SERVICE_ROLE_KEY = 'srv-role-secret-DO-NOT-LEAK-9f8e7d6c5b4a';
const INGEST_TOKEN = 'ingest-secret-DO-NOT-LEAK-3a2b1c0d9e8f';
const ENV = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, INGEST_TOKEN };
const REST_PREFIX = `${SUPABASE_URL}/rest/v1/`;

function uid(label) {
  const hex = createHash('md5').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function makeRawRow(id, overrides = {}) {
  return {
    id,
    provider: 'federal_reserve',
    provider_item_id: `guid-${id}`,
    source_code: 'federalreserve',
    source_domain: 'federalreserve.gov',
    canonical_url: `https://www.federalreserve.gov/newsevents/pressreleases/${id}.htm`,
    title: `Federal Reserve statement ${id}`,
    summary: 'The Committee decided to maintain the target range.',
    content: null,
    provider_category: 'monetary_policy_press_release',
    published_at: '2026-09-01T18:00:00.000Z',
    published_date: null,
    observed_at: '2026-09-01T18:05:00.000Z',
    ingested_at: '2026-09-01T18:05:03.000Z',
    ingest_quality_state: 'VALID',
    ingest_quality_reasons: [],
    ...overrides,
  };
}

function makeObservation(id, overrides = {}) {
  return {
    id,
    row: makeRawRow(id, overrides.row),
    clusterId: overrides.clusterId ?? uid(`${id}:cluster`),
    decisionId: overrides.decisionId ?? uid(`${id}:decision`),
    eventVersionId: overrides.eventVersionId ?? uid(`${id}:version`),
    assignedAt: overrides.assignedAt ?? '2026-09-01T18:05:05.000Z',
    editorialOriginKey: overrides.editorialOriginKey ?? 'official:federal_reserve',
    wireLineageKey: overrides.wireLineageKey ?? null,
    assignBehavior: overrides.assignBehavior ?? null,
  };
}

// ---------------------------------------------------------------------
// PR9 discovery RPC row fixtures — the exact 8-key shape
// fn_event_shadow_discover_candidates returns (mirrors
// tests/test_event_shadow_candidate_discovery.mjs's fixtures).
// ---------------------------------------------------------------------
const DISCOVERY_EXPECTED_PROCESSOR_VERSION = 'ops023-deterministic-event-processor-v1';
const DISCOVERY_EXPECTED_ORCHESTRATOR_VERSION = 'ops023-event-shadow-orchestrator-v1';

function makeFreshDiscoveryRow(id, overrides = {}) {
  return {
    observation_id: id,
    lane: 'FRESH',
    ingested_at: '2026-09-01T18:05:03.000Z',
    cluster_id: null,
    decision_id: null,
    assigned_at: null,
    expected_processor_version: DISCOVERY_EXPECTED_PROCESSOR_VERSION,
    expected_orchestrator_version: DISCOVERY_EXPECTED_ORCHESTRATOR_VERSION,
    ...overrides,
  };
}

function makeRecoveryDiscoveryRow(id, overrides = {}) {
  return {
    observation_id: id,
    lane: 'RECOVERY',
    ingested_at: '2026-09-01T18:05:03.000Z',
    cluster_id: uid(`${id}:disc-cluster`),
    decision_id: uid(`${id}:disc-decision`),
    assigned_at: '2026-09-01T18:05:05.000Z',
    expected_processor_version: DISCOVERY_EXPECTED_PROCESSOR_VERSION,
    expected_orchestrator_version: DISCOVERY_EXPECTED_ORCHESTRATOR_VERSION,
    ...overrides,
  };
}

/**
 * Faux `global fetch` — la SEULE frontière simulée. Route par path
 * PostgREST (après REST_PREFIX), enregistre chaque appel (url, method,
 * headers, body parsé, path), renvoie de vrais objets `Response` (Fetch
 * API native de Node).
 *
 * `options.discovery = { recoveryRows, freshRows }` (PR9) alimente
 * rpc/fn_event_shadow_discover_candidates ; par défaut, deux tableaux
 * vides (zéro candidat découvert).
 */
function makeFakeFetch(observations, options = {}) {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const byDecisionId = new Map(observations.map((o) => [o.decisionId, o]));
  const byClusterId = new Map(observations.map((o) => [o.clusterId, o]));
  const calls = [];
  let runRowCounter = 0;
  let releaseCallCount = 0;
  const assignCallCounts = new Map();
  const eventVersionCallCounts = new Map();
  const discoveryRecoveryRows = options.discovery?.recoveryRows ?? [];
  const discoveryFreshRows = options.discovery?.freshRows ?? [];

  async function fakeFetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const bodyText = init.body;
    const body = typeof bodyText === 'string' ? JSON.parse(bodyText) : undefined;

    if (!url.startsWith(REST_PREFIX)) {
      throw new Error(`fake fetch: URL escaped the expected PostgREST prefix: ${url}`);
    }
    const restPath = url.slice(REST_PREFIX.length);
    calls.push({ url, method, headers, body, bodyText, path: restPath });

    if (options.networkFailureOnAcquire && method === 'POST' && restPath === 'ingestion_runs?select=id') {
      throw new Error('simulated network failure (fetch itself threw)');
    }

    if (restPath === 'rpc/fn_event_shadow_discover_candidates') {
      if (options.discoveryRpcFailure) {
        return new Response(JSON.stringify({ message: 'simulated discovery RPC failure' }), { status: 500 });
      }
      if (body?.p_lane === 'RECOVERY') return new Response(JSON.stringify(discoveryRecoveryRows), { status: 200 });
      if (body?.p_lane === 'FRESH') return new Response(JSON.stringify(discoveryFreshRows), { status: 200 });
      throw new Error(`fake fetch: unexpected p_lane for discovery RPC: ${JSON.stringify(body?.p_lane)}`);
    }

    if (restPath === 'rpc/fn_reclaim_stale_runs') {
      return new Response('0', { status: 200 });
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
        return new Response('simulated release failure', { status: 500 });
      }
      return new Response(null, { status: 204 });
    }
    if (restPath.startsWith('news_articles?')) {
      const m = /id=eq\.([^&]+)/.exec(restPath);
      const id = m ? decodeURIComponent(m[1]) : null;
      const obs = id ? byId.get(id) : null;
      return new Response(JSON.stringify(obs ? [obs.row] : []), { status: 200 });
    }
    if (restPath === 'rpc/fn_event_assign_observation') {
      const id = body?.p_observation_id;
      const obs = byId.get(id);
      if (!obs) return new Response(JSON.stringify({ message: 'unknown observation' }), { status: 500 });
      const count = (assignCallCounts.get(id) ?? 0) + 1;
      assignCallCounts.set(id, count);
      if (obs.assignBehavior) return obs.assignBehavior({ count, body });
      return new Response(JSON.stringify([{
        cluster_id: obs.clusterId, decision_id: obs.decisionId,
        cluster_created_now: count === 1, replayed: count > 1,
      }]), { status: 200 });
    }
    if (restPath.startsWith('event_observation_memberships?')) {
      const m = /decision_id=eq\.([^&]+)/.exec(restPath);
      const decisionId = m ? decodeURIComponent(m[1]) : null;
      const obs = decisionId ? byDecisionId.get(decisionId) : null;
      if (!obs) return new Response(JSON.stringify({ message: 'unknown membership' }), { status: 500 });
      return new Response(JSON.stringify([{
        decision_id: obs.decisionId, observation_id: obs.id, cluster_id: obs.clusterId,
        assigned_at: obs.assignedAt, decision_type: 'ASSIGN',
        editorial_origin_key: obs.editorialOriginKey, wire_lineage_key: obs.wireLineageKey,
      }]), { status: 200 });
    }
    if (restPath === 'rpc/fn_event_create_event_version') {
      const clusterId = body?.p_cluster_id;
      const obs = byClusterId.get(clusterId);
      const count = (eventVersionCallCounts.get(clusterId) ?? 0) + 1;
      eventVersionCallCounts.set(clusterId, count);
      return new Response(JSON.stringify([{
        event_version_id: obs?.eventVersionId ?? uid(`unknown-cluster:${clusterId}`),
        version_number: 1, transition_type: 'NOVELTY',
        state_fingerprint: 'fingerprint-for-runtime-tests',
        source_independence_state: 'SINGLE_EDITORIAL_ORIGIN',
        evidence_count: 1, outcome: count === 1 ? 'CREATED' : 'REPLAYED', replayed: count > 1,
      }]), { status: 200 });
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
  return new Request('https://worker.test/event-shadow', init);
}

/** PR9 — same shape as makeRequest(), targeting POST /event-shadow/discover. */
function makeDiscoverRequest({ method = 'POST', headers = {}, bodyText, path = '/event-shadow/discover' } = {}) {
  const init = { method, headers };
  if (bodyText !== undefined) init.body = bodyText;
  return new Request(`https://worker.test${path}`, init);
}

const AUTH_HEADERS = { 'x-ingest-token': INGEST_TOKEN, 'content-type': 'application/json' };

async function expectThrow(fn, label) {
  try {
    await fn();
    t(label, false, 'expected a throw/rejection, none occurred');
    return null;
  } catch (err) {
    t(label, true);
    return err;
  }
}

// ---------------------------------------------------------------------
// 1. Authentification — MÊME convention que /news (INGEST_TOKEN).
// ---------------------------------------------------------------------
{
  const id = uid('auth-missing');
  const { fakeFetch, calls } = makeFakeFetch([makeObservation(id)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ observationIds: [id] }) }),
    ENV,
  ));
  t('auth manquante => 401', res.status === 401);
  t('auth manquante => ZÉRO appel DB', calls.length === 0);
}
{
  const id = uid('auth-wrong');
  const { fakeFetch, calls } = makeFakeFetch([makeObservation(id)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: { 'x-ingest-token': 'wrong-token', 'content-type': 'application/json' }, bodyText: JSON.stringify({ observationIds: [id] }) }),
    ENV,
  ));
  t('auth incorrecte => 401', res.status === 401);
  t('auth incorrecte => ZÉRO appel DB', calls.length === 0);
}
{
  const id = uid('auth-correct');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }),
    ENV,
  ));
  t('auth correcte (x-ingest-token) atteint le handler => 200', res.status === 200);
  const text = await res.text();
  t('INGEST_TOKEN n\'apparaît jamais dans la réponse', !text.includes(INGEST_TOKEN));
  t('SUPABASE_SERVICE_ROLE_KEY n\'apparaît jamais dans la réponse', !text.includes(SERVICE_ROLE_KEY));
}
{
  // Convention de repli Authorization: Bearer <token>, identique à /news.
  const id = uid('auth-bearer');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, bodyText: JSON.stringify({ observationIds: [id] }) }),
    ENV,
  ));
  t('auth via Authorization: Bearer <INGEST_TOKEN> acceptée (même convention que /news)', res.status === 200);
}

// ---------------------------------------------------------------------
// 2. Contrat HTTP.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ method: 'GET', headers: AUTH_HEADERS }), ENV));
  t('GET => 405', res.status === 405);
  t('GET => en-tête Allow: POST', res.headers.get('allow') === 'POST');
  t('GET => ZÉRO appel DB', calls.length === 0);
}
{
  const id = uid('http-valid');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  t('POST JSON valide => 200 accepté', res.status === 200);
  const json = await res.json();
  t('réponse { ok: true, report: ... }', json.ok === true && typeof json.report === 'object');
  t('report.status = success pour un batch entièrement réussi', json.report.status === 'success');
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: '{not valid json' }), ENV));
  t('JSON malformé => 400', res.status === 400);
  t('JSON malformé => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify('just a string') }), ENV));
  t('corps non-objet (chaîne) => 400', res.status === 400);
  t('corps non-objet => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify([1, 2, 3]) }), ENV));
  t('corps non-objet (tableau) => 400', res.status === 400);
  t('corps tableau => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({}) }), ENV));
  t('observationIds manquant => 400', res.status === 400);
  t('observationIds manquant => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: 'not-an-array' }) }), ENV));
  t('observationIds pas un tableau => 400', res.status === 400);
  t('observationIds non-tableau => ZÉRO appel DB', calls.length === 0);
}
{
  const id = uid('http-unexpected-field');
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id], extra: 'nope' }) }), ENV));
  t('champ top-level inattendu => 400', res.status === 400);
  t('champ inattendu => ZÉRO appel DB', calls.length === 0);
}
{
  const id = uid('http-trigger-field');
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id], triggerType: 'cron' }) }), ENV));
  t('champ triggerType dans le corps => 400 (jamais accepté)', res.status === 400);
  t('champ triggerType => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: ['not-a-uuid'] }) }), ENV));
  t('UUID malformé (rejeté par PR6) => 400', res.status === 400);
  const json = await res.json();
  t('code MALFORMED_OBSERVATION_ID propagé', json.code === 'MALFORMED_OBSERVATION_ID');
  t('UUID malformé => ZÉRO appel DB (rejeté avant acquireLock)', calls.length === 0);
}
{
  const id = uid('http-duplicate');
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id, id] }) }), ENV));
  t('UUID dupliqué (rejeté par PR6) => 400', res.status === 400);
  const json = await res.json();
  t('code DUPLICATE_OBSERVATION_ID propagé', json.code === 'DUPLICATE_OBSERVATION_ID');
  t('UUID dupliqué => ZÉRO appel DB', calls.length === 0);
}
{
  const ids = Array.from({ length: 26 }, (_, i) => uid(`http-toomany-${i}`));
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: ids }) }), ENV));
  t('>25 IDs (rejeté par PR6) => 400', res.status === 400);
  const json = await res.json();
  t('code BATCH_SIZE_EXCEEDED propagé', json.code === 'BATCH_SIZE_EXCEEDED');
  t('>25 IDs => ZÉRO appel DB', calls.length === 0);
}
{
  const id = uid('http-busy');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)], { forceAlreadyRunning: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV));
  t('verrou déjà pris => 409', res.status === 409);
  const json = await res.json();
  t('code EVENT_SHADOW_ALREADY_RUNNING propagé', json.code === 'EVENT_SHADOW_ALREADY_RUNNING');
}
{
  // Rapport PARTIAL : un item échoue (assignation malformée), l'autre réussit.
  const idFail = uid('http-partial-fail');
  const idOk = uid('http-partial-ok');
  const { fakeFetch } = makeFakeFetch([
    makeObservation(idFail, { assignBehavior: () => new Response(JSON.stringify([{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }]), { status: 200 }) }),
    makeObservation(idOk),
  ]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [idFail, idOk] }) }), ENV,
  ));
  t('rapport PR6 partial => TOUJOURS HTTP 200 (l\'opération runtime a réussi)', res.status === 200);
  const json = await res.json();
  t('report.status = partial reflété fidèlement', json.report.status === 'partial');
}
{
  // Rapport FAILED : tous les items échouent.
  const idFail1 = uid('http-allfail-1');
  const idFail2 = uid('http-allfail-2');
  const malformed = () => new Response(JSON.stringify([{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }]), { status: 200 });
  const { fakeFetch } = makeFakeFetch([
    makeObservation(idFail1, { assignBehavior: malformed }),
    makeObservation(idFail2, { assignBehavior: malformed }),
  ]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [idFail1, idFail2] }) }), ENV,
  ));
  t('rapport PR6 failed => TOUJOURS HTTP 200', res.status === 200);
  const json = await res.json();
  t('report.status = failed reflété fidèlement', json.report.status === 'failed');
}
{
  // Invariant interne (pas d'origine appelant) : échec de libération du verrou.
  const id = uid('http-internal-invariant');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)], { forceReleaseFailure: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  t('invariant interne (EVENT_SHADOW_LOCK_RELEASE_FAILED, pas d\'origine appelant) => 500', res.status === 500);
}
{
  // Échec réseau/PostgREST brut (fetch lui-même lève).
  const id = uid('http-network-failure');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)], { networkFailureOnAcquire: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  t('échec réseau/PostgREST brut => 500', res.status === 500);
}

// ---------------------------------------------------------------------
// 3. Preuve du trigger 'manual' — jamais influençable par le payload.
// ---------------------------------------------------------------------
{
  const id = uid('manual-trigger-proof');
  const { fakeFetch, calls } = makeFakeFetch([makeObservation(id)]);
  await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  const acquireCall = calls.find((c) => c.method === 'POST' && c.path === 'ingestion_runs?select=id');
  t('ingestion_runs.trigger_type inséré = "manual" (jamais depuis le corps de requête)', acquireCall.body[0].trigger_type === 'manual');
}
{
  // Code exécutable uniquement (commentaires retirés) : le mot "triggerType"
  // apparaît légitimement dans un commentaire de documentation ("no
  // triggerType") expliquant l'intention — seul le CODE ne doit jamais le
  // lire depuis la requête.
  const codeOnlyRuntimeSource = runtimeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  t('shadow_runtime.ts (code exécutable) ne lit jamais un champ camelCase "triggerType" depuis la requête', !codeOnlyRuntimeSource.includes('triggerType'));
}
t('EVENT_SHADOW_RUNTIME_TRIGGER_TYPE est le littéral \'manual\'', /EVENT_SHADOW_RUNTIME_TRIGGER_TYPE = 'manual' as const/.test(runtimeSource));

// ---------------------------------------------------------------------
// 4. Sécurité PostgREST.
// ---------------------------------------------------------------------
{
  const id = uid('security-headers');
  const { fakeFetch, calls } = makeFakeFetch([makeObservation(id)]);
  await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  t('toutes les URLs commencent exactement sous SUPABASE_URL/rest/v1/', calls.every((c) => c.url.startsWith(REST_PREFIX)));
  t('apikey service-role présent sur chaque appel', calls.every((c) => c.headers.apikey === SERVICE_ROLE_KEY));
  // AUTH HOTFIX (revue PR7) : la crédential service-role est envoyée
  // UNIQUEMENT via apikey — jamais via Authorization: Bearer. Les clés
  // secrètes Supabase modernes (sb_secret_...) ne sont pas des JWT et
  // n'acceptent que apikey ; les clés service_role JWT historiques
  // restent utilisables via apikey seul (élargissement de compatibilité,
  // aucune perte de comportement).
  t('AUCUN en-tête Authorization sur les appels PostgREST (apikey seul porte la crédential service-role)',
    calls.every((c) => c.headers.authorization === undefined));

  const acquireCall = calls.find((c) => c.method === 'POST' && c.path === 'ingestion_runs?select=id');
  t('Prefer survit (extraHeader interne de run_lock.ts, acquire)', acquireCall.headers.prefer === 'return=representation');
  const releaseCall = calls.find((c) => c.method === 'PATCH' && c.path.startsWith('ingestion_runs?id=eq.'));
  t('Prefer survit (extraHeader interne de run_lock.ts, release)', releaseCall.headers.prefer === 'return=minimal');

  const getCalls = calls.filter((c) => c.method === 'GET');
  t('les requêtes GET n\'ont jamais de corps', getCalls.length > 0 && getCalls.every((c) => c.bodyText === undefined));

  const assignCall = calls.find((c) => c.path === 'rpc/fn_event_assign_observation');
  t('le corps POST est sérialisé correctement (JSON round-trip exact)', assignCall.body.p_observation_id === id);

  t('PATCH est supporté (libération de verrou observée)', releaseCall !== undefined);
}
{
  t('buildPostgrestHeaders : extraHeaders ne peut PAS écraser apikey',
    buildPostgrestHeaders(SERVICE_ROLE_KEY, false, { apikey: 'evil-injected-key' }).apikey === SERVICE_ROLE_KEY);
  t('buildPostgrestHeaders : n\'émet JAMAIS d\'en-tête Authorization pour la crédential service-role (apikey seul)',
    buildPostgrestHeaders(SERVICE_ROLE_KEY, false, {}).authorization === undefined);
  t('buildPostgrestHeaders : un Authorization fourni via extraHeaders (même avec une casse différente) est toujours supprimé, jamais transmis (défense en profondeur)',
    buildPostgrestHeaders(SERVICE_ROLE_KEY, false, { Authorization: 'Bearer evil-injected-token' }).authorization === undefined);
  t('buildPostgrestHeaders : un en-tête sûr (Prefer) survit sans modification',
    buildPostgrestHeaders(SERVICE_ROLE_KEY, false, { prefer: 'return=minimal' }).prefer === 'return=minimal');
  t('buildPostgrestHeaders : content-type ajouté seulement si hasBody',
    buildPostgrestHeaders(SERVICE_ROLE_KEY, true, {})['content-type'] === 'application/json'
    && buildPostgrestHeaders(SERVICE_ROLE_KEY, false, {})['content-type'] === undefined);
}
t('le type de méthode du contrat request<T> n\'inclut ni DELETE ni PUT (GET | POST | PATCH uniquement)',
  /method: 'GET' \| 'POST' \| 'PATCH'/.test(runtimeSource) && !/'DELETE'|'PUT'/.test(runtimeSource));
{
  // Réponse non-2xx rejetée en sécurité (test direct de l'adaptateur).
  const db = new PostgrestEventShadowDb(ENV);
  const fakeFetch = async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
  await withFakeFetch(fakeFetch, () => expectThrow(() => db.request('GET', 'news_articles?id=eq.x'), 'réponse non-2xx rejetée par l\'adaptateur'));
}
{
  // JSON de réponse malformé rejeté en sécurité.
  const db = new PostgrestEventShadowDb(ENV);
  const fakeFetch = async () => new Response('{not-valid-json', { status: 200 });
  await withFakeFetch(fakeFetch, () => expectThrow(() => db.request('GET', 'news_articles?id=eq.x'), 'JSON de réponse malformé (2xx) rejeté par l\'adaptateur'));
}
{
  // Réponse 2xx vide supportée (undefined-compatible).
  const db = new PostgrestEventShadowDb(ENV);
  const fakeFetch = async () => new Response(null, { status: 204 });
  const result = await withFakeFetch(fakeFetch, () => db.request('PATCH', 'ingestion_runs?id=eq.x', { a: 1 }));
  t('réponse 2xx vide => résultat undefined-compatible', result === undefined);
}
{
  // validateSupabaseUrl / validatePostgrestPath — garde-fous directs.
  let threw = false;
  try { validateSupabaseUrl('not a url'); } catch { threw = true; }
  t('validateSupabaseUrl rejette une URL invalide', threw);
  threw = false;
  try { validateSupabaseUrl('http://insecure.example.com'); } catch { threw = true; }
  t('validateSupabaseUrl rejette un protocole non-https', threw);
  threw = false;
  try { validatePostgrestPath('news_articles?x=y://evil'); } catch { threw = true; }
  t('validatePostgrestPath rejette un path contenant "://"', threw);
  threw = false;
  try { validatePostgrestPath('../../etc/passwd'); } catch { threw = true; }
  t('validatePostgrestPath rejette un path contenant ".."', threw);
}
{
  // Aucune fuite de secret : scan de TOUTES les réponses HTTP capturées sur un run complet.
  const id = uid('no-secret-leak');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  const text = await res.text();
  t('aucune fuite : ni le service-role key ni INGEST_TOKEN dans la réponse HTTP finale',
    !text.includes(SERVICE_ROLE_KEY) && !text.includes(INGEST_TOKEN));
}
{
  // BLOCKER (revue) : un échec PostgREST survenant PENDANT le traitement
  // PAR-OBSERVATION (rpc/fn_event_assign_observation), dont le corps de
  // réponse upstream contient LITTÉRALEMENT le service-role key, ne doit
  // JAMAIS laisser fuiter ce secret — même quand PR6 convertit cet échec
  // en item FAILED d'un rapport que PR7 retourne intentionnellement en
  // HTTP 200 (rapport auditable, pas un échec de l'opération runtime).
  const id = uid('secret-leak-in-failed-item');
  const { fakeFetch } = makeFakeFetch([
    makeObservation(id, {
      assignBehavior: () => new Response(JSON.stringify({ message: SERVICE_ROLE_KEY }), { status: 500 }),
    }),
  ]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(
    makeRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ observationIds: [id] }) }), ENV,
  ));
  t('échec PostgREST par-observation avec secret dans le corps upstream => toujours HTTP 200 (rapport auditable)', res.status === 200);
  const bodyText = await res.text();
  t('la réponse HTTP complète NE CONTIENT PAS SUPABASE_SERVICE_ROLE_KEY', !bodyText.includes(SERVICE_ROLE_KEY));
  t('la réponse HTTP complète NE CONTIENT PAS INGEST_TOKEN', !bodyText.includes(INGEST_TOKEN));
  const json = JSON.parse(bodyText);
  t('report.items[0].kind = FAILED', json.report?.items?.[0]?.kind === 'FAILED');
  t('safeErrorMessage de l\'item FAILED ne contient NI le service-role key NI INGEST_TOKEN',
    typeof json.report?.items?.[0]?.safeErrorMessage === 'string'
    && !json.report.items[0].safeErrorMessage.includes(SERVICE_ROLE_KEY)
    && !json.report.items[0].safeErrorMessage.includes(INGEST_TOKEN));
}

// ---------------------------------------------------------------------
// 4b. Allowlist runtime des méthodes DB — DELETE/PUT rejetés AVANT tout
//     appel global fetch (le typage TypeScript seul n'est pas une
//     frontière de sécurité : un appelant JavaScript peut le contourner).
// ---------------------------------------------------------------------
{
  const db = new PostgrestEventShadowDb(ENV);
  let fetchCallCount = 0;
  const fakeFetch = async () => { fetchCallCount += 1; return new Response(null, { status: 204 }); };
  await withFakeFetch(fakeFetch, () => expectThrow(() => db.request('DELETE', 'news_articles?id=eq.x'), 'DELETE rejeté AU RUNTIME (pas seulement par le typage TS)'));
  t('DELETE : global fetch JAMAIS appelé', fetchCallCount === 0);
}
{
  const db = new PostgrestEventShadowDb(ENV);
  let fetchCallCount = 0;
  const fakeFetch = async () => { fetchCallCount += 1; return new Response(null, { status: 204 }); };
  await withFakeFetch(fakeFetch, () => expectThrow(() => db.request('PUT', 'news_articles?id=eq.x'), 'PUT rejeté AU RUNTIME (pas seulement par le typage TS)'));
  t('PUT : global fetch JAMAIS appelé', fetchCallCount === 0);
}
{
  const db = new PostgrestEventShadowDb(ENV);
  let fetchCallCount = 0;
  const fakeFetch = async () => { fetchCallCount += 1; return new Response(null, { status: 204 }); };
  await withFakeFetch(fakeFetch, () => expectThrow(() => db.request('delete', 'news_articles?id=eq.x'), 'méthode minuscule "delete" rejetée (aucune normalisation silencieuse vers DELETE)'));
  t('méthode minuscule "delete" : global fetch JAMAIS appelé', fetchCallCount === 0);
}
t('le contrat request<T> reste exactement \'GET\' | \'POST\' | \'PATCH\' (typage TS inchangé)',
  /method: 'GET' \| 'POST' \| 'PATCH'/.test(runtimeSource));

// ---------------------------------------------------------------------
// 4c. Enveloppe de requête bornée — limite de transport (16 KiB), jamais
//     une duplication des limites sémantiques de PR6 (25 IDs max,
//     validité/doublons UUID).
// ---------------------------------------------------------------------
{
  // A) Content-Length déclaré > limite => 413, ZÉRO appel DB, JSON jamais parsé.
  const { fakeFetch, calls } = makeFakeFetch([]);
  const req = new Request('https://worker.test/event-shadow', {
    method: 'POST',
    headers: { ...AUTH_HEADERS, 'content-length': String(mod.MAX_EVENT_SHADOW_REQUEST_BODY_BYTES + 1) },
    body: 'small-actual-body-irrelevant-here',
  });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(req, ENV));
  t('A) Content-Length déclaré > limite => 413', res.status === 413);
  const json = await res.json();
  t('A) code REQUEST_BODY_TOO_LARGE', json.code === 'REQUEST_BODY_TOO_LARGE');
  t('A) ZÉRO appel DB', calls.length === 0);
}
{
  // B) AUCUN Content-Length, mais le corps RÉEL dépasse la limite => 413,
  //    ZÉRO appel DB (la limite s'applique au corps réel, pas seulement
  //    à un en-tête client potentiellement absent/mensonger).
  const oversizedBody = `{"observationIds":["${'x'.repeat(mod.MAX_EVENT_SHADOW_REQUEST_BODY_BYTES + 1000)}"]}`;
  const { fakeFetch, calls } = makeFakeFetch([]);
  const req = new Request('https://worker.test/event-shadow', {
    method: 'POST',
    headers: { 'x-ingest-token': INGEST_TOKEN, 'content-type': 'application/json' },
    body: oversizedBody,
  });
  t('B) précondition du test : aucun en-tête Content-Length présent', req.headers.get('content-length') === null);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(req, ENV));
  t('B) corps réel > limite (sans Content-Length) => 413', res.status === 413);
  const json = await res.json();
  t('B) code REQUEST_BODY_TOO_LARGE', json.code === 'REQUEST_BODY_TOO_LARGE');
  t('B) ZÉRO appel DB', calls.length === 0);
}
{
  // C) Requête valide normale, confortablement sous la limite => comportement inchangé.
  const id = uid('size-normal-ok');
  const { fakeFetch } = makeFakeFetch([makeObservation(id)]);
  const bodyText = JSON.stringify({ observationIds: [id] });
  t('C) précondition : le corps de test est confortablement sous la limite', new TextEncoder().encode(bodyText).length < mod.MAX_EVENT_SHADOW_REQUEST_BODY_BYTES);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowRequest(makeRequest({ headers: AUTH_HEADERS, bodyText }), ENV));
  t('C) requête normale sous la limite => 200 (comportement inchangé)', res.status === 200);
}

// ---------------------------------------------------------------------
// 5. Intégration Worker — statique (backend/worker.ts, wrangler.toml).
// ---------------------------------------------------------------------
t('worker.ts importe handleEventShadowRequest depuis ./event_engine/shadow_runtime.js (PR9 : aux côtés de handleEventShadowDiscoverRequest, même import)',
  /import \{ handleEventShadowRequest, handleEventShadowDiscoverRequest \} from '\.\/event_engine\/shadow_runtime\.js';/.test(workerSource));
t('la route exacte /event-shadow existe (comparaison stricte ===, jamais startsWith)',
  /if \(path === '\/event-shadow'\) return handleEventShadowRequest\(request, env\);/.test(workerSource));
{
  // Code exécutable uniquement : le commentaire au-dessus de la route
  // mentionne délibérément startsWith('/event-shadow') en TEXTE pour
  // expliquer pourquoi ce n'est PAS fait — seul le CODE ne doit jamais
  // contenir cet appel.
  const codeOnlyWorkerSource = workerSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  t('aucune route large startsWith(\'/event-shadow\') dans le code exécutable', !codeOnlyWorkerSource.includes("startsWith('/event-shadow')"));
}
t('/news reste inchangée', /path\.startsWith\('\/news'\)/.test(workerSource));
t('/committee reste inchangée', /path\.startsWith\('\/committee'\)/.test(workerSource));
t('/health reste inchangée', /path\.startsWith\('\/health'\)/.test(workerSource));

t('aucune référence à CRON_EVENT_SHADOW', !workerSource.includes('CRON_EVENT_SHADOW'));
{
  const jobNameLine = workerSource.split('\n').find((l) => l.includes('export type JobName'));
  t('le type JobName existe toujours et n\'inclut jamais event_shadow', jobNameLine != null && !/event[_-]shadow/i.test(jobNameLine));
}
{
  const resolveJobStart = workerSource.indexOf('export function resolveJob');
  const fetchStart = workerSource.indexOf('async fetch(request');
  t('resolveJob() est délimitable dans le source', resolveJobStart > -1 && fetchStart > resolveJobStart);
  const resolveJobSection = workerSource.slice(resolveJobStart, fetchStart);
  t('resolveJob() ne référence jamais event_shadow', !/event[_-]shadow/i.test(resolveJobSection));
}
{
  const scheduledStart = workerSource.indexOf('async scheduled(');
  t('scheduled() est délimitable dans le source', scheduledStart > -1);
  const scheduledSection = workerSource.slice(scheduledStart);
  t('scheduled() ne lance/ne référence jamais event-shadow', !/event[_-]shadow/i.test(scheduledSection) && !scheduledSection.includes('handleEventShadowRequest'));
}
t('wrangler.toml : crons inchangés (exactement les trois expressions d\'origine, aucune quatrième)',
  wranglerSource.includes('crons = ["*/5 * * * *", "7-59/15 * * * *", "0 * * * *"]'));
t('wrangler.toml : aucune référence à event_shadow/event-shadow', !/event[_-]shadow/i.test(wranglerSource));

// ---------------------------------------------------------------------
// 6. Isolation legacy/shadow — shadow_runtime.ts.
// ---------------------------------------------------------------------
const liveRuntimeSource = runtimeSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

const FORBIDDEN_LEGACY_TOKENS = ['news_events', 'notifications', 'ai_committee', 'Committee', 'ScoredEvent', 'scoreArticle', 'dispatchActions'];
for (const token of FORBIDDEN_LEGACY_TOKENS) {
  t(`shadow_runtime.ts : aucune référence exécutable à "${token}"`, !new RegExp(token, 'i').test(liveRuntimeSource));
}
t('shadow_runtime.ts n\'appelle JAMAIS directement rpc/fn_event_assign_observation (délégué à PR5 via PR6)', !liveRuntimeSource.includes('rpc/fn_event_assign_observation'));
t('shadow_runtime.ts n\'appelle JAMAIS directement rpc/fn_event_create_event_version (délégué à PR5 via PR6)', !liveRuntimeSource.includes('rpc/fn_event_create_event_version'));
t('shadow_runtime.ts n\'importe jamais backend/ingest.ts', !/backend\/ingest/.test(liveRuntimeSource));
t('shadow_runtime.ts ne lit jamais process.env', !/process\.env/.test(liveRuntimeSource));
t('shadow_runtime.ts ne référence jamais news_articles directement (aucune sélection RAW automatique — PR5 seul lit news_articles)', !liveRuntimeSource.includes('news_articles'));

// =========================================================================
// 7. OPS-023 PR9 — POST /event-shadow/discover (manual discovered batch).
// =========================================================================

// ---------------------------------------------------------------------
// 7.1 AUTH / HTTP.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ maxCandidates: 5 }) }),
    ENV,
  ));
  t('PR9 auth manquante => 401', res.status === 401);
  t('PR9 auth manquante => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: { 'x-ingest-token': 'wrong-token', 'content-type': 'application/json' }, bodyText: JSON.stringify({ maxCandidates: 5 }) }),
    ENV,
  ));
  t('PR9 auth incorrecte => 401', res.status === 401);
  t('PR9 auth incorrecte => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ method: 'GET', headers: AUTH_HEADERS }), ENV));
  t('PR9 GET => 405', res.status === 405);
  t('PR9 GET => en-tête Allow: POST', res.headers.get('allow') === 'POST');
  t('PR9 GET => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: '{not valid json' }), ENV));
  t('PR9 JSON malformé => 400', res.status === 400);
  t('PR9 JSON malformé => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify([1, 2, 3]) }), ENV));
  t('PR9 corps non-objet (tableau) => 400', res.status === 400);
  t('PR9 corps tableau => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify('just a string') }), ENV));
  t('PR9 corps non-objet (chaîne) => 400', res.status === 400);
  t('PR9 corps chaîne => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({}) }), ENV));
  t('PR9 maxCandidates manquant => 400', res.status === 400);
  const json = await res.json();
  t('PR9 maxCandidates manquant => code MISSING_MAX_CANDIDATES', json.code === 'MISSING_MAX_CANDIDATES');
  t('PR9 maxCandidates manquant => ZÉRO appel DB', calls.length === 0);
}
for (const [label, extraField] of [
  ['observationIds', { observationIds: ['x'] }],
  ['lane', { lane: 'FRESH' }],
  ['triggerType', { triggerType: 'cron' }],
  ['processorVersion', { processorVersion: 'ops023-deterministic-event-processor-v1' }],
  ['orchestratorVersion', { orchestratorVersion: 'ops023-event-shadow-orchestrator-v1' }],
  ['clusterId', { clusterId: 'x' }],
  ['decisionId', { decisionId: 'x' }],
  ['backfill', { backfill: true }],
  ['cursor', { cursor: 'x' }],
  ['timestamp', { timestamp: '2026-09-01T00:00:00.000Z' }],
  ['dryRun', { dryRun: true }],
  ['dbParameter', { apikey: 'evil-injected-key' }],
]) {
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 5, ...extraField }) }), ENV,
  ));
  t(`PR9 champ inattendu "${label}" (jamais accepté) => 400`, res.status === 400);
  const json = await res.json();
  t(`PR9 champ inattendu "${label}" => code UNEXPECTED_FIELD`, json.code === 'UNEXPECTED_FIELD');
  t(`PR9 champ inattendu "${label}" => ZÉRO appel DB`, calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 0 }) }), ENV));
  t('PR9 maxCandidates=0 => 400', res.status === 400);
  const json = await res.json();
  t('PR9 maxCandidates=0 => code INVALID_MAX_CANDIDATES', json.code === 'INVALID_MAX_CANDIDATES');
  t('PR9 maxCandidates=0 => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 26 }) }), ENV));
  t('PR9 maxCandidates=26 => 400', res.status === 400);
  const json = await res.json();
  t('PR9 maxCandidates=26 => code INVALID_MAX_CANDIDATES', json.code === 'INVALID_MAX_CANDIDATES');
  t('PR9 maxCandidates=26 => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch, calls } = makeFakeFetch([]);
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 5.5 }) }), ENV));
  t('PR9 maxCandidates flottant (non entier) => 400', res.status === 400);
  const json = await res.json();
  t('PR9 maxCandidates flottant => code INVALID_MAX_CANDIDATES', json.code === 'INVALID_MAX_CANDIDATES');
  t('PR9 maxCandidates flottant => ZÉRO appel DB', calls.length === 0);
}
{
  const { fakeFetch } = makeFakeFetch([], { discovery: { recoveryRows: [], freshRows: [] } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 1 }) }), ENV));
  t('PR9 maxCandidates=1 (borne basse) accepté => 200', res.status === 200);
}
{
  const { fakeFetch } = makeFakeFetch([], { discovery: { recoveryRows: [], freshRows: [] } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV));
  t('PR9 maxCandidates=25 (borne haute) accepté => 200', res.status === 200);
}

// ---------------------------------------------------------------------
// 7.2 DISCOVERY — exactement UNE invocation, maxCandidates forwarded,
//     résultat préservé dans la réponse.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([], { discovery: { recoveryRows: [], freshRows: [] } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 7 }) }), ENV,
  ));
  const discoveryCalls = calls.filter((c) => c.path === 'rpc/fn_event_shadow_discover_candidates');
  t('PR9 exactement 2 appels RPC de découverte (RECOVERY puis FRESH) => discoverEventShadowCandidates invoquée exactement une fois', discoveryCalls.length === 2);
  t('PR9 le premier appel de découverte est RECOVERY', discoveryCalls[0].body.p_lane === 'RECOVERY');
  t('PR9 le second appel de découverte est FRESH', discoveryCalls[1].body.p_lane === 'FRESH');
  t('PR9 maxCandidates EXACT transmis comme p_limit sur les deux appels', discoveryCalls[0].body.p_limit === 7 && discoveryCalls[1].body.p_limit === 7);
  t('PR9 200 pour une découverte vide', res.status === 200);
  const json = await res.json();
  t('PR9 résultat de découverte préservé dans la réponse (maxCandidates/selected)', json.discovery.maxCandidates === 7 && Array.isArray(json.discovery.selected) && json.discovery.selected.length === 0);
}

// ---------------------------------------------------------------------
// 7.3 EMPTY — sélection vide : 200, NO_CANDIDATES, batch=null, zéro
//     appel de verrou/batch.
// ---------------------------------------------------------------------
{
  const { fakeFetch, calls } = makeFakeFetch([], { discovery: { recoveryRows: [], freshRows: [] } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 sélection vide => HTTP 200', res.status === 200);
  const json = await res.json();
  t('PR9 sélection vide => ok true', json.ok === true);
  t('PR9 sélection vide => status NO_CANDIDATES explicite', json.status === 'NO_CANDIDATES');
  t('PR9 sélection vide => batch = null (aucune métrique fabriquée)', json.batch === null);
  const lockCalls = calls.filter((c) => c.path === 'ingestion_runs?select=id' || c.path.startsWith('ingestion_runs?id=eq.'));
  t('PR9 sélection vide => runEventShadowBatch JAMAIS appelé (zéro appel de verrou ingestion_runs)', lockCalls.length === 0);
  t('PR9 sélection vide => aucun appel rpc/fn_event_assign_observation', calls.every((c) => c.path !== 'rpc/fn_event_assign_observation'));
}

// ---------------------------------------------------------------------
// 7.4 NON-EMPTY — ordre exact préservé, batch appelé une fois, combiné.
// ---------------------------------------------------------------------
{
  const idA = uid('discover-nonempty-a');
  const idB = uid('discover-nonempty-b');
  const obsA = makeObservation(idA);
  const obsB = makeObservation(idB);
  const freshRows = [
    makeFreshDiscoveryRow(idA, { ingested_at: '2026-09-01T18:00:00.000Z' }),
    makeFreshDiscoveryRow(idB, { ingested_at: '2026-09-01T18:01:00.000Z' }),
  ];
  const { fakeFetch, calls } = makeFakeFetch([obsA, obsB], { discovery: { recoveryRows: [], freshRows } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 sélection non-vide => HTTP 200', res.status === 200);
  const json = await res.json();
  t('PR9 sélection non-vide => status BATCH_EXECUTED', json.status === 'BATCH_EXECUTED');
  t('PR9 discovery.selectedObservationIds transmis EXACTEMENT dans l\'ordre de découverte', json.discovery.selectedObservationIds.join(',') === [idA, idB].join(','));
  const acquireCalls = calls.filter((c) => c.method === 'POST' && c.path === 'ingestion_runs?select=id');
  t('PR9 runEventShadowBatch appelé EXACTEMENT une fois (un seul acquireLock)', acquireCalls.length === 1);
  t('PR9 trigger_type inséré = littéral "manual"', acquireCalls[0].body[0].trigger_type === 'manual');
  t('PR9 réponse combinée : discovery ET batch présents', typeof json.discovery === 'object' && typeof json.batch === 'object' && json.batch !== null);
  t('PR9 report.status = success pour un batch entièrement réussi', json.batch.status === 'success');
  const assignCalls = calls.filter((c) => c.path === 'rpc/fn_event_assign_observation');
  t('PR9 observations traitées dans l\'ordre EXACT de découverte (idA puis idB, jamais réordonné)', assignCalls.map((c) => c.body.p_observation_id).join(',') === [idA, idB].join(','));
}

// ---------------------------------------------------------------------
// 7.5 BUSY.
// ---------------------------------------------------------------------
{
  const id = uid('discover-busy');
  const obs = makeObservation(id);
  const freshRows = [makeFreshDiscoveryRow(id)];
  const { fakeFetch } = makeFakeFetch([obs], { discovery: { recoveryRows: [], freshRows }, forceAlreadyRunning: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 verrou déjà pris (après découverte non-vide) => 409', res.status === 409);
  const json = await res.json();
  t('PR9 code EVENT_SHADOW_ALREADY_RUNNING propagé', json.code === 'EVENT_SHADOW_ALREADY_RUNNING');
}

// ---------------------------------------------------------------------
// 7.6 REPORT SEMANTICS — partial/failed restent HTTP 200 (convention PR7).
// ---------------------------------------------------------------------
{
  const idFail = uid('discover-partial-fail');
  const idOk = uid('discover-partial-ok');
  const obsFail = makeObservation(idFail, { assignBehavior: () => new Response(JSON.stringify([{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }]), { status: 200 }) });
  const obsOk = makeObservation(idOk);
  const freshRows = [makeFreshDiscoveryRow(idFail), makeFreshDiscoveryRow(idOk)];
  const { fakeFetch } = makeFakeFetch([obsFail, obsOk], { discovery: { recoveryRows: [], freshRows } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 rapport PARTIAL => TOUJOURS HTTP 200', res.status === 200);
  const json = await res.json();
  t('PR9 batch.status = partial reflété fidèlement', json.batch.status === 'partial');
}
{
  const idFail1 = uid('discover-allfail-1');
  const idFail2 = uid('discover-allfail-2');
  const malformed = () => new Response(JSON.stringify([{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }]), { status: 200 });
  const obsFail1 = makeObservation(idFail1, { assignBehavior: malformed });
  const obsFail2 = makeObservation(idFail2, { assignBehavior: malformed });
  const freshRows = [makeFreshDiscoveryRow(idFail1), makeFreshDiscoveryRow(idFail2)];
  const { fakeFetch } = makeFakeFetch([obsFail1, obsFail2], { discovery: { recoveryRows: [], freshRows } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 rapport FAILED => TOUJOURS HTTP 200', res.status === 200);
  const json = await res.json();
  t('PR9 batch.status = failed reflété fidèlement', json.batch.status === 'failed');
}

// ---------------------------------------------------------------------
// 7.7 FAIL-CLOSED.
// ---------------------------------------------------------------------
{
  // Invariant PR8 (ligne RPC de découverte malformée) => 500, jamais 400 :
  // maxCandidates était déjà validé côté enveloppe, donc cette erreur ne
  // peut PAS provenir d'une entrée appelant.
  const id = uid('discover-invariant');
  const freshRows = [{ ...makeFreshDiscoveryRow(id), extra_unexpected_field: 'x' }];
  const { fakeFetch, calls } = makeFakeFetch([], { discovery: { recoveryRows: [], freshRows } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 ligne RPC de découverte malformée (invariant PR8) => 500', res.status === 500);
  const json = await res.json();
  t('PR9 code UNEXPECTED_ROW_SHAPE propagé (validation reste la responsabilité de la couche découverte, jamais réimplémentée ici)', json.code === 'UNEXPECTED_ROW_SHAPE');
  const lockCalls = calls.filter((c) => c.path === 'ingestion_runs?select=id');
  t('PR9 invariant de découverte => runEventShadowBatch JAMAIS appelé', lockCalls.length === 0);
}
{
  // Échec réseau/PostgREST brut sur l'appel RPC de découverte lui-même.
  const { fakeFetch } = makeFakeFetch([], { discoveryRpcFailure: true });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  t('PR9 échec RPC de découverte brut (réseau/PostgREST) => 500', res.status === 500);
  const bodyText = await res.text();
  t('PR9 aucun corps de réponse amont brut exposé dans la réponse finale', !bodyText.includes('simulated discovery RPC failure'));
}
{
  // Aucune fuite de secret sur un run complet non-vide.
  const id = uid('discover-no-leak');
  const obs = makeObservation(id);
  const freshRows = [makeFreshDiscoveryRow(id)];
  const { fakeFetch } = makeFakeFetch([obs], { discovery: { recoveryRows: [], freshRows } });
  const res = await withFakeFetch(fakeFetch, () => handleEventShadowDiscoverRequest(
    makeDiscoverRequest({ headers: AUTH_HEADERS, bodyText: JSON.stringify({ maxCandidates: 25 }) }), ENV,
  ));
  const text = await res.text();
  t('PR9 aucune fuite : ni le service-role key ni INGEST_TOKEN dans la réponse HTTP finale', !text.includes(SERVICE_ROLE_KEY) && !text.includes(INGEST_TOKEN));
}
{
  t('PR9 shadow_runtime.ts ne réimplémente pas la validation des lignes RPC de découverte (aucune duplication de EXPECTED_ROW_KEYS/validateRow, propriété exclusive de PR8)',
    !liveRuntimeSource.includes('EXPECTED_ROW_KEYS') && !liveRuntimeSource.includes('function validateRow'));
}

// ---------------------------------------------------------------------
// 7.8 ROUTING — statique (backend/worker.ts). L'import combiné est déjà
// vérifié en section 5 ci-dessus.
// ---------------------------------------------------------------------
t('PR9 la route exacte /event-shadow/discover existe (comparaison stricte ===, jamais startsWith)',
  /if \(path === '\/event-shadow\/discover'\) return handleEventShadowDiscoverRequest\(request, env\);/.test(workerSource));
t('PR9 la route exacte /event-shadow (PR7) reste INCHANGÉE',
  /if \(path === '\/event-shadow'\) return handleEventShadowRequest\(request, env\);/.test(workerSource));
{
  const discoverIdx = workerSource.indexOf("path === '/event-shadow/discover'");
  const explicitIdx = workerSource.indexOf("path === '/event-shadow'");
  t('PR9 la route /event-shadow/discover est vérifiée AVANT la route /event-shadow explicite (ordre recommandé)',
    discoverIdx > -1 && explicitIdx > -1 && discoverIdx < explicitIdx);
}
{
  const codeOnlyWorkerSource = workerSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  t('PR9 aucune route large startsWith(\'/event-shadow/discover\') dans le code exécutable', !codeOnlyWorkerSource.includes("startsWith('/event-shadow/discover')"));
  t('PR9 aucun startsWith(\'/event-shadow\') général dans le code exécutable (les deux routes restent === strictes)', !codeOnlyWorkerSource.includes("startsWith('/event-shadow')"));
}

// ---------------------------------------------------------------------
// 7.9 ISOLATION — aucun cron/scheduled/JobName/resolveJob/wrangler.
// ---------------------------------------------------------------------
t('PR9 aucune référence à CRON_EVENT_SHADOW (worker.ts)', !workerSource.includes('CRON_EVENT_SHADOW'));
{
  const jobNameLine = workerSource.split('\n').find((l) => l.includes('export type JobName'));
  t('PR9 : le type JobName n\'inclut toujours jamais event_shadow', jobNameLine != null && !/event[_-]shadow/i.test(jobNameLine));
}
{
  const resolveJobStart = workerSource.indexOf('export function resolveJob');
  const fetchStart = workerSource.indexOf('async fetch(request');
  const resolveJobSection = workerSource.slice(resolveJobStart, fetchStart);
  t('PR9 : resolveJob() ne référence toujours jamais event_shadow (même après l\'ajout de la route /discover)', !/event[_-]shadow/i.test(resolveJobSection));
}
{
  const scheduledStart = workerSource.indexOf('async scheduled(');
  const scheduledSection = workerSource.slice(scheduledStart);
  t('PR9 : scheduled() ne lance/ne référence toujours jamais event-shadow (ni discover)',
    !/event[_-]shadow/i.test(scheduledSection) && !scheduledSection.includes('handleEventShadowDiscoverRequest'));
}
t('PR9 : wrangler.toml crons toujours inchangés (exactement les trois expressions d\'origine, aucune quatrième)',
  wranglerSource.includes('crons = ["*/5 * * * *", "7-59/15 * * * *", "0 * * * *"]'));
t('PR9 : wrangler.toml toujours aucune référence à event_shadow/event-shadow', !/event[_-]shadow/i.test(wranglerSource));
t('PR9 shadow_runtime.ts importe discoverEventShadowCandidates depuis ./shadow_candidate_discovery.js (jamais réimplémenté)',
  /from '\.\/shadow_candidate_discovery\.js'/.test(liveRuntimeSource));
t('PR9 shadow_runtime.ts ne crée pas une seconde classe d\'adaptateur PostgREST (une seule export class Postgrest...)',
  (liveRuntimeSource.match(/export class Postgrest\w*/g) || []).length === 1);
t('PR9 shadow_runtime.ts ne référence jamais un curseur/watermark (aucun "last_processed"/"cursor"/"watermark")',
  !/last_processed|cursor|watermark/i.test(liveRuntimeSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
