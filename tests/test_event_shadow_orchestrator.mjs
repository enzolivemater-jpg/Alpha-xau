// Contrat BEHAVIORAL (pas seulement statique) du shadow orchestrator
// OPS-023 PR5 (backend/event_engine/shadow_orchestrator.ts). Comme pour
// tests/test_event_deterministic_processor.mjs, ce fichier transpile le
// TypeScript source avec `typescript` (déjà présent en devDependency,
// aucune nouvelle dépendance) et exécute le module réellement compilé —
// l'orchestrateur ET sa dépendance réelle deterministic_processor.ts
// (jamais un processeur PR4 factice). Un EventShadowDb factice
// déterministe enregistre chaque requête pour inspection.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'deterministic_processor.ts');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('backend/event_engine/shadow_orchestrator.ts existe', existsSync(ORCHESTRATOR_PATH));

const orchestratorSource = existsSync(ORCHESTRATOR_PATH) ? readFileSync(ORCHESTRATOR_PATH, 'utf8') : '';
const processorSource = existsSync(PROCESSOR_PATH) ? readFileSync(PROCESSOR_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Transpilation + chargement ESM réel des DEUX modules (orchestrateur
//    + sa dépendance réelle PR4, jamais une version factice).
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
  // Le spécificateur d'import émis reste './deterministic_processor.js'
  // (texte source préservé tel quel par transpileModule) : réécrit vers le
  // nom de fichier RÉELLEMENT écrit sur disque ci-dessous (.mjs, sans
  // ambiguïté ESM même sans package.json local dans ce répertoire temporaire).
  orchestratorTranspiled = orchestratorTranspiled.replace(
    /(['"])\.\/deterministic_processor\.js\1/,
    "$1./deterministic_processor.mjs$1",
  );

  tmpDir = mkdtempSync(path.join(tmpdir(), 'ops023-shadow-orchestrator-'));
  writeFileSync(path.join(tmpDir, 'deterministic_processor.mjs'), processorTranspiled, 'utf8');
  const orchestratorTmpFile = path.join(tmpDir, 'shadow_orchestrator.mjs');
  writeFileSync(orchestratorTmpFile, orchestratorTranspiled, 'utf8');
  mod = await import(pathToFileURL(orchestratorTmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD shadow_orchestrator.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

t('les deux modules transpilent et se chargent sans erreur', mod !== null);
t('OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION est exporté', typeof mod?.OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION === 'string' && mod.OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION.length > 0);
t('OPS023_EVENT_SHADOW_DECISION_ACTOR est exporté', typeof mod?.OPS023_EVENT_SHADOW_DECISION_ACTOR === 'string' && mod.OPS023_EVENT_SHADOW_DECISION_ACTOR.length > 0);
t('processEventShadowObservation est exporté (fonction)', typeof mod?.processEventShadowObservation === 'function');
t('canonicalStringify est exporté (fonction)', typeof mod?.canonicalStringify === 'function');
t('sha256Hex est exporté (fonction)', typeof mod?.sha256Hex === 'function');
t('assertSupportedPlanShape est exporté (fonction)', typeof mod?.assertSupportedPlanShape === 'function');
t('EventShadowInvariantError est exporté (classe)', typeof mod?.EventShadowInvariantError === 'function');
t('deriveFinalKnowledgeCutoff est exporté (fonction)', typeof mod?.deriveFinalKnowledgeCutoff === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const {
  processEventShadowObservation,
  canonicalStringify,
  sha256Hex,
  assertSupportedPlanShape,
  EventShadowInvariantError,
  OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION,
  deriveFinalKnowledgeCutoff,
} = mod;

// ---------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------
function makeRawRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'federal_reserve',
    provider_item_id: 'guid-fed-1',
    source_code: 'federalreserve',
    source_domain: 'federalreserve.gov',
    canonical_url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260901a.htm',
    title: 'Federal Reserve issues FOMC statement',
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

const CLUSTER_ID = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
const DECISION_ID = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0';
const EVENT_VERSION_ID = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
const ASSIGNED_AT = '2026-09-01T18:05:05.000Z';

function makeMembershipRow(overrides = {}) {
  return {
    decision_id: DECISION_ID,
    observation_id: '11111111-1111-4111-8111-111111111111',
    cluster_id: CLUSTER_ID,
    assigned_at: ASSIGNED_AT,
    decision_type: 'ASSIGN',
    editorial_origin_key: 'official:federal_reserve',
    wire_lineage_key: null,
    ...overrides,
  };
}

function makeAssignResponseRow(overrides = {}) {
  return {
    cluster_id: CLUSTER_ID,
    decision_id: DECISION_ID,
    cluster_created_now: true,
    replayed: false,
    ...overrides,
  };
}

function makeEventVersionResponseRow(overrides = {}) {
  return {
    event_version_id: EVENT_VERSION_ID,
    version_number: 1,
    transition_type: 'NOVELTY',
    state_fingerprint: 'irrelevant-for-orchestrator-tests',
    source_independence_state: 'SINGLE_EDITORIAL_ORIGIN',
    evidence_count: 1,
    outcome: 'CREATED',
    replayed: false,
    ...overrides,
  };
}

/** Fake EventShadowDb : enregistre chaque appel, route par forme de path,
 *  lève une erreur explicite pour tout path non configuré (preuve
 *  d'isolation : aucun autre appel ne peut passer inaperçu). */
function makeFakeDb(handlers) {
  const calls = [];
  const db = {
    async request(method, path, body, extraHeaders) {
      calls.push({ method, path, body, extraHeaders });
      if (path.startsWith('news_articles?')) {
        if (!handlers.newsArticles) throw new Error(`unexpected news_articles call: ${path}`);
        return handlers.newsArticles(method, path, body);
      }
      if (path === 'rpc/fn_event_assign_observation') {
        if (!handlers.assignObservation) throw new Error('unexpected fn_event_assign_observation call');
        return handlers.assignObservation(method, path, body);
      }
      if (path.startsWith('event_observation_memberships?')) {
        if (!handlers.membership) throw new Error(`unexpected event_observation_memberships call: ${path}`);
        return handlers.membership(method, path, body);
      }
      if (path === 'rpc/fn_event_create_event_version') {
        if (!handlers.eventVersion) throw new Error('unexpected fn_event_create_event_version call');
        return handlers.eventVersion(method, path, body);
      }
      throw new Error(`unexpected DB call reached the fake (isolation violation): ${method} ${path}`);
    },
  };
  return { db, calls };
}

function happyPathHandlers(rowOverrides = {}, membershipOverrides = {}) {
  const row = makeRawRow(rowOverrides);
  return {
    newsArticles: () => [row],
    assignObservation: () => [makeAssignResponseRow()],
    membership: () => [makeMembershipRow({ observation_id: row.id, ...membershipOverrides })],
    eventVersion: () => [makeEventVersionResponseRow()],
  };
}

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
// 1. RAW / mapping — un mapping snake_case -> camelCase exact par source
//    officielle, plus 0/>1 lignes.
// ---------------------------------------------------------------------
{
  const { db } = makeFakeDb(happyPathHandlers());
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('mapping Federal Reserve : PROCESSED', result.kind === 'PROCESSED', JSON.stringify(result));
}
{
  const { db } = makeFakeDb(happyPathHandlers({
    provider: 'ecb', provider_item_id: 'ecb-1', source_code: 'ecb', source_domain: 'ecb.europa.eu',
    canonical_url: 'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260901.htm',
    provider_category: 'press_communication',
  }, { editorial_origin_key: 'official:ecb' }));
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('mapping ECB : PROCESSED', result.kind === 'PROCESSED', JSON.stringify(result));
}
{
  const { db } = makeFakeDb(happyPathHandlers({
    provider: 'us_treasury', provider_item_id: 'treasury-1', source_code: 'us_treasury', source_domain: 'home.treasury.gov',
    canonical_url: 'https://home.treasury.gov/news/press-releases/jy0001',
    provider_category: 'press_release',
  }, { editorial_origin_key: 'official:us_treasury' }));
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('mapping US Treasury : PROCESSED', result.kind === 'PROCESSED', JSON.stringify(result));
}
{
  const { db } = makeFakeDb(happyPathHandlers({
    provider: 'ofac', provider_item_id: 'ofac-1', source_code: 'ofac', source_domain: 'ofac.treasury.gov',
    canonical_url: 'https://ofac.treasury.gov/recent-actions/20260901',
    provider_category: 'Specially Designated Nationals List Update',
  }, { editorial_origin_key: 'official:ofac' }));
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('mapping OFAC : PROCESSED', result.kind === 'PROCESSED', JSON.stringify(result));
}
{
  const { db, calls } = makeFakeDb({ newsArticles: () => [] });
  const result = await processEventShadowObservation(db, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  t('0 ligne RAW => SKIPPED', result.kind === 'SKIPPED' && result.reason === 'OBSERVATION_NOT_FOUND');
  t('0 ligne RAW => AUCUN POST envoyé', !calls.some((c) => c.method === 'POST'));
}
{
  const { db } = makeFakeDb({ newsArticles: () => [makeRawRow(), makeRawRow({ id: '22222222-2222-4222-8222-222222222222' })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), '>1 lignes RAW => erreur d\'invariant');
  t('l\'erreur >1 lignes est une EventShadowInvariantError', err instanceof EventShadowInvariantError);
}

// ---------------------------------------------------------------------
// 2. Porte processeur — abstention, aucune identité forte fournie par
//    PR5, garde-fou de forme de plan avant toute écriture.
// ---------------------------------------------------------------------
{
  const { db, calls } = makeFakeDb({ newsArticles: () => [makeRawRow({ source_code: 'unknown_source', provider: 'unknown', source_domain: null })] });
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('source non supportée => ABSTAINED', result.kind === 'ABSTAINED' && result.abstention === 'UNSUPPORTED_SOURCE');
  t('source non supportée => AUCUN POST de mutation', !calls.some((c) => c.method === 'POST'));
}
{
  const { db, calls } = makeFakeDb({ newsArticles: () => [makeRawRow({ ingest_quality_state: 'UNVERIFIED' })] });
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('qualité insuffisante => ABSTAINED', result.kind === 'ABSTAINED' && result.abstention === 'DATA_QUALITY_INSUFFICIENT');
  t('qualité insuffisante => AUCUN POST de mutation', !calls.some((c) => c.method === 'POST'));
}
{
  // Aucune identité forte n'est jamais fournie par PR5 : preuve indirecte
  // via le comportement observable (précision d'abord -> CREATE_NEW_CLUSTER
  // systématique, jamais ASSIGN_EXISTING, même pour deux observations dont
  // le titre est identique — PR5 n'injecte donc jamais de contexte de
  // cluster candidat).
  const rowA = makeRawRow({ id: '30303030-3030-4030-8030-303030303030', title: 'Identical Title' });
  const rowB = makeRawRow({ id: '40404040-4040-4040-8040-404040404040', title: 'Identical Title' });
  const { db: dbA } = makeFakeDb(happyPathHandlers(rowA));
  const { db: dbB } = makeFakeDb(happyPathHandlers(rowB));
  const resultA = await processEventShadowObservation(dbA, rowA.id);
  const resultB = await processEventShadowObservation(dbB, rowB.id);
  t('aucune identité forte n\'est jamais fournie par PR5 (CREATE_NEW_CLUSTER systématique même pour un titre identique)',
    resultA.kind === 'PROCESSED' && resultB.kind === 'PROCESSED');
}
{
  // Garde-fou direct : un plan synthétique conforme ne lève rien.
  const conformingPlan = {
    kind: 'PROCESS',
    clusterDisposition: 'CREATE_NEW_CLUSTER',
    resolvedClusterId: null,
    provisionalClusterKey: 'provisional:11111111-1111-4111-8111-111111111111',
    strongIdentityClaimProposal: null,
    versionDisposition: 'CREATE_VERSION',
    transition: 'NOVELTY',
    previousEventVersionId: null,
  };
  let threw = false;
  try { assertSupportedPlanShape(conformingPlan); } catch { threw = true; }
  t('un plan synthétique CONFORME ne lève rien', !threw);

  const nonCreateNewCluster = { ...conformingPlan, clusterDisposition: 'ASSIGN_EXISTING', resolvedClusterId: 'x' };
  let err1 = null;
  try { assertSupportedPlanShape(nonCreateNewCluster); } catch (e) { err1 = e; }
  t('plan non-CREATE_NEW_CLUSTER échoue AVANT toute écriture', err1 instanceof EventShadowInvariantError && err1.code === 'UNSUPPORTED_PROCESSOR_PLAN_SHAPE');

  const withIdentityProposal = { ...conformingPlan, strongIdentityClaimProposal: { authorityNamespace: 'a', identityType: 't', identityValue: 'v' } };
  let err2 = null;
  try { assertSupportedPlanShape(withIdentityProposal); } catch (e) { err2 = e; }
  t('strongIdentityClaimProposal inattendu échoue AVANT toute écriture', err2 instanceof EventShadowInvariantError && err2.code === 'UNSUPPORTED_STRONG_IDENTITY_PLAN');

  const nonNovelty = { ...conformingPlan, transition: 'CONFIRMATION', versionDisposition: 'CREATE_VERSION' };
  let err3 = null;
  try { assertSupportedPlanShape(nonNovelty); } catch (e) { err3 = e; }
  t('transition non-NOVELTY échoue AVANT toute écriture', err3 instanceof EventShadowInvariantError && err3.code === 'UNSUPPORTED_PROCESSOR_PLAN_SHAPE');

  const noMaterialChange = { ...conformingPlan, versionDisposition: 'NO_MATERIAL_CHANGE', transition: null };
  let err4 = null;
  try { assertSupportedPlanShape(noMaterialChange); } catch (e) { err4 = e; }
  t('versionDisposition=NO_MATERIAL_CHANGE échoue AVANT toute écriture', err4 instanceof EventShadowInvariantError && err4.code === 'UNSUPPORTED_PROCESSOR_PLAN_SHAPE');

  const withPredecessor = { ...conformingPlan, previousEventVersionId: 'prev-1' };
  let err5 = null;
  try { assertSupportedPlanShape(withPredecessor); } catch (e) { err5 = e; }
  t('previousEventVersionId non-null échoue AVANT toute écriture', err5 instanceof EventShadowInvariantError && err5.code === 'UNSUPPORTED_PROCESSOR_PLAN_SHAPE');
}

// ---------------------------------------------------------------------
// 3. Empreintes déterministes — canonicalStringify + sha256Hex.
// ---------------------------------------------------------------------
{
  t('canonicalStringify trie les clés lexicographiquement, indépendamment de l\'ordre d\'insertion',
    canonicalStringify({ b: 1, a: 2 }) === canonicalStringify({ a: 2, b: 1 })
    && canonicalStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}');
  t('canonicalStringify préserve l\'ordre des tableaux',
    canonicalStringify([3, 1, 2]) === '[3,1,2]');
  t('canonicalStringify préserve null/booléens/chaînes exactement',
    canonicalStringify({ n: null, b: true, s: 'hello' }) === '{"b":true,"n":null,"s":"hello"}');
  t('canonicalStringify rejette undefined (top-level)',
    (() => { try { canonicalStringify(undefined); return false; } catch { return true; } })());
  t('canonicalStringify rejette undefined (valeur d\'objet)',
    (() => { try { canonicalStringify({ a: undefined }); return false; } catch { return true; } })());
  t('canonicalStringify rejette un nombre non fini',
    (() => { try { canonicalStringify({ a: Infinity }); return false; } catch { return true; } })());

  const h1 = await sha256Hex('same-input');
  const h2 = await sha256Hex('same-input');
  const h3 = await sha256Hex('different-input');
  t('même entrée sémantique => même SHA-256', h1 === h2);
  t('entrée sémantique modifiée => SHA-256 modifié', h1 !== h3);
  t('sha256Hex produit une chaîne hex de 64 caractères', /^[0-9a-f]{64}$/.test(h1));
}

// ---------------------------------------------------------------------
// 4. Assignation — appel exact, forme CREATE_AND_ASSIGN, validation de
//    réponse.
// ---------------------------------------------------------------------
{
  const { db, calls } = makeFakeDb(happyPathHandlers());
  const observationId = makeRawRow().id;
  await processEventShadowObservation(db, observationId);

  const postCalls = calls.filter((c) => c.method === 'POST');
  t('seul fn_event_assign_observation ET fn_event_create_event_version sont appelés (aucune autre RPC)',
    postCalls.every((c) => c.path === 'rpc/fn_event_assign_observation' || c.path === 'rpc/fn_event_create_event_version'));

  const assignCall = calls.find((c) => c.path === 'rpc/fn_event_assign_observation');
  t('fn_event_assign_observation appelé exactement une fois', calls.filter((c) => c.path === 'rpc/fn_event_assign_observation').length === 1);
  t('p_observation_id = observation.id', assignCall.body.p_observation_id === observationId);
  t('p_cluster_id = null (mode CREATE_AND_ASSIGN)', assignCall.body.p_cluster_id === null);
  t('p_cluster_key = plan.provisionalClusterKey (préservé exactement)', assignCall.body.p_cluster_key === `provisional:${observationId}`);
  t('p_region = null (jamais inféré)', assignCall.body.p_region === null);
  t('p_membership_method = DETERMINISTIC_OFFICIAL_FOUNDING_V1', assignCall.body.p_membership_method === 'DETERMINISTIC_OFFICIAL_FOUNDING_V1');
  t('p_membership_confidence = 1 EXACTEMENT (confiance déterministe d\'appartenance, jamais une confiance Gold/trading)', assignCall.body.p_membership_confidence === 1);
  t('p_editorial_origin_key = plan.lineage.editorialOriginKey', assignCall.body.p_editorial_origin_key === 'official:federal_reserve');
  t('p_wire_lineage_key = null (source officielle directe)', assignCall.body.p_wire_lineage_key === null);
  t('p_lineage_resolution_method = DIRECT_OFFICIAL_SOURCE', assignCall.body.p_lineage_resolution_method === 'DIRECT_OFFICIAL_SOURCE');
  t('p_lineage_resolution_confidence = 1', assignCall.body.p_lineage_resolution_confidence === 1);
  t('p_lineage_evidence est un marqueur textuel déterministe contenant sourceCode/sourceDomain',
    typeof assignCall.body.p_lineage_evidence === 'string' && assignCall.body.p_lineage_evidence.includes('federalreserve') && assignCall.body.p_lineage_evidence.includes('federalreserve.gov'));
  t('p_membership_algorithm_version = OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION', assignCall.body.p_membership_algorithm_version === OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION);
  t('p_decision_actor = OPS023_EVENT_SHADOW_DECISION_ACTOR', assignCall.body.p_decision_actor === mod.OPS023_EVENT_SHADOW_DECISION_ACTOR);
  t('p_evidence_digest est une chaîne hex de 64 caractères (SHA-256)', /^[0-9a-f]{64}$/.test(assignCall.body.p_evidence_digest));
  t('p_idempotency_fingerprint est une chaîne hex de 64 caractères', /^[0-9a-f]{64}$/.test(assignCall.body.p_idempotency_fingerprint));
  t('p_semantic_state_fingerprint est une chaîne hex de 64 caractères', /^[0-9a-f]{64}$/.test(assignCall.body.p_semantic_state_fingerprint));
}
{
  const { db } = makeFakeDb({
    newsArticles: () => [makeRawRow()],
    assignObservation: () => [],
  });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'réponse assign 0 ligne => erreur d\'invariant');
  t('erreur 0-ligne assign est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'ASSIGN_RESPONSE_INVARIANT');
}
{
  const { db } = makeFakeDb({
    newsArticles: () => [makeRawRow()],
    assignObservation: () => [makeAssignResponseRow(), makeAssignResponseRow()],
  });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'réponse assign >1 lignes => erreur d\'invariant');
  t('erreur >1-lignes assign est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'ASSIGN_RESPONSE_INVARIANT');
}
{
  const { db } = makeFakeDb({
    newsArticles: () => [makeRawRow()],
    assignObservation: () => [makeAssignResponseRow({ cluster_id: 'not-a-uuid' })],
  });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'réponse assign malformée (cluster_id) rejetée');
  t('erreur cluster_id malformé est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'MALFORMED_RPC_RESPONSE');
}
{
  const { db } = makeFakeDb({
    newsArticles: () => [makeRawRow()],
    assignObservation: () => [makeAssignResponseRow({ replayed: 'yes' })],
  });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'réponse assign malformée (replayed non-booléen) rejetée');
  t('erreur replayed malformé est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'MALFORMED_RPC_RESPONSE');
}

// ---------------------------------------------------------------------
// 5. Intégrité temporelle — assigned_at persisté, identité de membership,
//    cutoff final.
// ---------------------------------------------------------------------
{
  const { db, calls } = makeFakeDb(happyPathHandlers());
  const observationId = makeRawRow().id;
  const result = await processEventShadowObservation(db, observationId);

  const membershipCall = calls.find((c) => c.path.startsWith('event_observation_memberships?'));
  t('la lecture de membership survient APRÈS l\'assignation (fetch par decision_id)', membershipCall.path.includes(`decision_id=eq.${DECISION_ID}`));
  t('assigned_at persisté (2026-09-01T18:05:05.000Z) < observedAt/ingestedAt (2026-09-01T18:05:0{0,3}.000Z) => floor domine',
    result.finalKnowledgeCutoff === '2026-09-01T18:05:05.000Z');
}
{
  // observedAt/ingestedAt POSTÉRIEURS à assigned_at : le floor domine.
  const { db } = makeFakeDb(happyPathHandlers({ observed_at: '2026-09-01T19:00:00.000Z', ingested_at: '2026-09-01T19:00:05.000Z' }));
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('cutoff final = MAX(knowledgeCutoffFloor, assigned_at) — le floor l\'emporte quand il est plus tardif',
    result.finalKnowledgeCutoff === '2026-09-01T19:00:05.000Z');
}
{
  // publishedAt/publishedDate n'influencent JAMAIS le cutoff final.
  const { db: dbA } = makeFakeDb(happyPathHandlers({ published_at: '2020-01-01T00:00:00.000Z', published_date: null }));
  const { db: dbB } = makeFakeDb(happyPathHandlers({ published_at: '2030-12-31T23:59:59.000Z', published_date: null }));
  const resultA = await processEventShadowObservation(dbA, makeRawRow().id);
  const resultB = await processEventShadowObservation(dbB, makeRawRow().id);
  t('publishedAt/publishedDate n\'influencent jamais le cutoff final', resultA.finalKnowledgeCutoff === resultB.finalKnowledgeCutoff);
}
{
  const { db } = makeFakeDb(happyPathHandlers({}, { assigned_at: 'not-a-timestamp' }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'assigned_at invalide rejeté');
  t('erreur assigned_at invalide est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'INVALID_ASSIGNED_AT');
}
{
  const { db } = makeFakeDb(happyPathHandlers({}, { decision_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'identité de membership mismatchée (decision_id) rejetée');
  t('erreur mismatch decision_id est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'MEMBERSHIP_IDENTITY_MISMATCH');
}
{
  const { db } = makeFakeDb(happyPathHandlers({}, { observation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'identité de membership mismatchée (observation_id) rejetée');
  t('erreur mismatch observation_id est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'MEMBERSHIP_IDENTITY_MISMATCH');
}
{
  const { db } = makeFakeDb(happyPathHandlers({}, { decision_type: 'AMEND' }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'decision_type != ASSIGN rejeté');
  t('erreur decision_type != ASSIGN est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'MEMBERSHIP_IDENTITY_MISMATCH');
}

// ---------------------------------------------------------------------
// 5b. Précision microseconde PostgreSQL timestamptz — cutoff final.
//     Le contrat MAX(knowledgeCutoffFloor, assigned_at) doit comparer et
//     RETOURNER à précision microseconde, jamais via un round-trip
//     Date/epoch-milliseconde. Un round-trip via new Date(...).toISOString()
//     tronque jusqu'à 999 microsecondes et peut faire du cutoff final
//     RETOURNÉ une valeur < assigned_at, violant l'invariant du predicate
//     d'évidence RPC (assigned_at <= p_knowledge_cutoff) — c'est EXACTEMENT
//     l'incident live PR7 : 4 memberships committées à assigned_at
//     sub-milliseconde, 0 Event Version, 4x HTTP 400.
//     deriveFinalKnowledgeCutoff est testé DIRECTEMENT ici (en plus des
//     tests d'intégration plus bas) car plan.knowledgeCutoffFloor — dérivé
//     par le processeur PR4 réel (deterministic_processor.ts, hors
//     périmètre de ce hotfix) — ne peut lui-même transporter qu'une
//     précision milliseconde ; seul un test direct de la fonction peut
//     exercer le cas "floor microseconde gagne".
// ---------------------------------------------------------------------
{
  // CASE 1 — assigned_at gagne DANS LA MÊME milliseconde (456 > 455 µs).
  const floor = '2026-09-01T18:05:05.123455Z';
  const assigned = '2026-09-01T18:05:05.123456+00:00';
  const cutoff = deriveFinalKnowledgeCutoff(floor, assigned);
  t('CASE 1 : assigned_at gagne à la microseconde près (456 > 455 µs), aucune perte des 456 µs finales', cutoff === assigned);
}
{
  // CASE 2 — knowledgeCutoffFloor gagne DANS LA MÊME milliseconde (457 > 456 µs).
  const floor = '2026-09-01T18:05:05.123457Z';
  const assigned = '2026-09-01T18:05:05.123456+00:00';
  const cutoff = deriveFinalKnowledgeCutoff(floor, assigned);
  t('CASE 2 : knowledgeCutoffFloor gagne exactement à la microseconde près (457 > 456 µs)', cutoff === floor);
}
{
  // CASE 3 — équivalence de fuseau horaire : +02:00 et Z doivent être
  // comparés par INSTANT réel, jamais en tant que texte.
  const floorSameInstant = '2026-09-01T20:05:05.500000+02:00'; // == 18:05:05.500000Z
  const assignedOneMicrosLater = '2026-09-01T18:05:05.500001Z';
  t('CASE 3a : assigned_at 1 µs plus tardif gagne à travers un offset de fuseau équivalent',
    deriveFinalKnowledgeCutoff(floorSameInstant, assignedOneMicrosLater) === assignedOneMicrosLater);

  const floorOneMicrosLater = '2026-09-01T20:05:05.500002+02:00'; // == 18:05:05.500002Z, 1 µs après assigned
  t('CASE 3b : le floor décalé en fuseau horaire gagne quand il représente réellement l\'instant le plus tardif',
    deriveFinalKnowledgeCutoff(floorOneMicrosLater, assignedOneMicrosLater) === floorOneMicrosLater);
}
{
  // CASE 4 — timestamps millisecondes ordinaires : comportement pré-existant inchangé.
  const floor = '2026-09-01T18:05:05.000Z';
  const assignedEarlier = '2026-09-01T18:05:03.000Z';
  const assignedLater = '2026-09-01T19:00:05.000Z';
  t('CASE 4a : floor ordinaire l\'emporte quand plus tardif (comportement inchangé)', deriveFinalKnowledgeCutoff(floor, assignedEarlier) === floor);
  t('CASE 4b : assigned_at ordinaire l\'emporte quand plus tardif (comportement inchangé)', deriveFinalKnowledgeCutoff(floor, assignedLater) === assignedLater);
}
{
  // CASE 5 — timestamps malformés : échec fermé, jamais un NaN/Invalid Date silencieux.
  const expectDeriveThrow = (floor, assigned, expectedCode, label) => {
    try {
      deriveFinalKnowledgeCutoff(floor, assigned);
      t(label, false, 'expected a throw, none occurred');
    } catch (e) {
      t(label, e instanceof EventShadowInvariantError && e.code === expectedCode, e?.code);
    }
  };
  expectDeriveThrow('not-a-timestamp', '2026-09-01T18:05:05.000Z', 'INVALID_KNOWLEDGE_CUTOFF_FLOOR',
    'CASE 5a : knowledgeCutoffFloor malformé rejeté (INVALID_KNOWLEDGE_CUTOFF_FLOOR)');
  expectDeriveThrow('2026-09-01T18:05:05.000Z', 'not-a-timestamp', 'INVALID_ASSIGNED_AT',
    'CASE 5b : assigned_at malformé rejeté (INVALID_ASSIGNED_AT)');
  expectDeriveThrow('2026-09-01T18:05:05.000+25:00', '2026-09-01T18:05:05.000Z', 'INVALID_KNOWLEDGE_CUTOFF_FLOOR',
    'CASE 5c : offset numérique hors plage (+25:00) rejeté');
  expectDeriveThrow('2026-13-01T18:05:05.000Z', '2026-09-01T18:05:05.000Z', 'INVALID_KNOWLEDGE_CUTOFF_FLOOR',
    'CASE 5d : date civile invalide (mois 13) rejetée');
  expectDeriveThrow('2026-09-01T18:05:05.000', '2026-09-01T18:05:05.000Z', 'INVALID_KNOWLEDGE_CUTOFF_FLOOR',
    'CASE 5e : timestamp sans timezone explicite rejeté');
}
{
  // Preuve d'intégration : le corps RPC RÉEL envoyé à
  // fn_event_create_event_version porte p_knowledge_cutoff à précision
  // microseconde EXACTE, jamais tronqué à la milliseconde — c'est
  // précisément le predicate d'évidence assigned_at <= p_knowledge_cutoff
  // qui a été violé en live (4x HTTP 400 sur ECB/Fed/Treasury/OFAC).
  const preciseAssignedAt = '2026-09-15T20:54:12.981066+00:00';
  const { db, calls } = makeFakeDb(happyPathHandlers({}, { assigned_at: preciseAssignedAt }));
  const result = await processEventShadowObservation(db, makeRawRow().id);
  const evCall = calls.find((c) => c.path === 'rpc/fn_event_create_event_version');
  t('intégration : p_knowledge_cutoff préserve les 6 chiffres de microseconde de assigned_at (981066)',
    evCall.body.p_knowledge_cutoff === preciseAssignedAt);
  t('intégration : p_knowledge_cutoff n\'est PAS tronqué à la milliseconde (regression exacte du bug live)',
    evCall.body.p_knowledge_cutoff !== '2026-09-15T20:54:12.981Z' && evCall.body.p_knowledge_cutoff !== '2026-09-15T20:54:12.981+00:00');
  t('intégration : invariant RPC assigned_at <= p_knowledge_cutoff préservé (égalité exacte, jamais antérieur)',
    result.kind === 'PROCESSED' && evCall.body.p_knowledge_cutoff === result.finalKnowledgeCutoff && result.finalKnowledgeCutoff === preciseAssignedAt);
}

// ---------------------------------------------------------------------
// 6. Event Version — appelé seulement après validation de membership,
//    payload exact, validation de réponse stricte V1.
// ---------------------------------------------------------------------
{
  const { db, calls } = makeFakeDb(happyPathHandlers());
  const result = await processEventShadowObservation(db, makeRawRow().id);

  const membershipCallIdx = calls.findIndex((c) => c.path.startsWith('event_observation_memberships?'));
  const eventVersionCallIdx = calls.findIndex((c) => c.path === 'rpc/fn_event_create_event_version');
  t('Event Version appelé seulement APRÈS la validation réussie de membership', membershipCallIdx > -1 && eventVersionCallIdx > membershipCallIdx);

  const evCall = calls[eventVersionCallIdx];
  t('p_cluster_id = assignment.cluster_id', evCall.body.p_cluster_id === CLUSTER_ID);
  t('p_transition_type = NOVELTY', evCall.body.p_transition_type === 'NOVELTY');
  t('p_effective_time = null', evCall.body.p_effective_time === null);
  t('p_effective_time_precision = null', evCall.body.p_effective_time_precision === null);
  t('p_canonical_event_state_schema_version = 1', evCall.body.p_canonical_event_state_schema_version === 1);
  t('p_canonical_event_state forwarded exactly (event_type/subject/detail)',
    evCall.body.p_canonical_event_state.event_type === 'MONETARY_POLICY_COMMUNICATION'
    && evCall.body.p_canonical_event_state.subject === 'Federal Reserve issues FOMC statement'
    && evCall.body.p_canonical_event_state.detail === 'The Committee decided to maintain the target range.');
  t('p_official_confirmation_state = OFFICIALLY_CONFIRMED (première version)', evCall.body.p_official_confirmation_state === 'OFFICIALLY_CONFIRMED');
  t('p_source_independence_state forwarded from plan', evCall.body.p_source_independence_state === 'SINGLE_EDITORIAL_ORIGIN');
  t('p_supersedes_version_id = null', evCall.body.p_supersedes_version_id === null);
  t('p_decision_actor = OPS023_EVENT_SHADOW_DECISION_ACTOR', evCall.body.p_decision_actor === mod.OPS023_EVENT_SHADOW_DECISION_ACTOR);
  t('p_idempotency_fingerprint est une chaîne hex de 64 caractères', /^[0-9a-f]{64}$/.test(evCall.body.p_idempotency_fingerprint));
  t('résultat PROCESSED expose eventVersionId', result.eventVersionId === EVENT_VERSION_ID);
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ version_number: 2 })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'version_number != 1 rejeté (chemin première-version V1)');
  t('erreur version_number != 1 est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'EVENT_VERSION_SHAPE_INVARIANT');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ evidence_count: 0 })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'evidence_count < 1 rejeté');
  t('erreur evidence_count < 1 est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'EVENT_VERSION_SHAPE_INVARIANT');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ source_independence_state: 'INDEPENDENTLY_CORROBORATED' })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'source_independence_state divergent du plan rejeté');
  t('erreur source_independence_state divergent est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'SOURCE_INDEPENDENCE_MISMATCH');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ outcome: 'NO_MATERIAL_CHANGE', replayed: false })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'NO_MATERIAL_CHANGE inattendu rejeté (jamais réinterprété)');
  t('erreur NO_MATERIAL_CHANGE inattendu est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'EVENT_VERSION_SHAPE_INVARIANT');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ transition_type: 'CONFIRMATION' })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'transition_type != NOVELTY rejeté');
  t('erreur transition_type != NOVELTY est une EventShadowInvariantError', err instanceof EventShadowInvariantError && err.code === 'EVENT_VERSION_SHAPE_INVARIANT');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ state_fingerprint: undefined })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'state_fingerprint manquant/undefined rejeté');
  t('erreur state_fingerprint manquant est une EventShadowInvariantError MALFORMED_RPC_RESPONSE', err instanceof EventShadowInvariantError && err.code === 'MALFORMED_RPC_RESPONSE');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ state_fingerprint: null })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'state_fingerprint null rejeté');
  t('erreur state_fingerprint null est une EventShadowInvariantError MALFORMED_RPC_RESPONSE', err instanceof EventShadowInvariantError && err.code === 'MALFORMED_RPC_RESPONSE');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ state_fingerprint: '   ' })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'state_fingerprint vide/blanc rejeté');
  t('erreur state_fingerprint vide est une EventShadowInvariantError MALFORMED_RPC_RESPONSE', err instanceof EventShadowInvariantError && err.code === 'MALFORMED_RPC_RESPONSE');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ state_fingerprint: 'a-valid-non-empty-fingerprint' })] });
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('state_fingerprint non-vide valide accepté => PROCESSED', result.kind === 'PROCESSED');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ outcome: 'CREATED', replayed: true })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'incohérence outcome=CREATED avec replayed=true rejetée');
  t('erreur incohérence CREATED/replayed=true est une EventShadowInvariantError EVENT_VERSION_SHAPE_INVARIANT', err instanceof EventShadowInvariantError && err.code === 'EVENT_VERSION_SHAPE_INVARIANT');
}
{
  const { db } = makeFakeDb({ ...happyPathHandlers(), eventVersion: () => [makeEventVersionResponseRow({ outcome: 'REPLAYED', replayed: false })] });
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'incohérence outcome=REPLAYED avec replayed=false rejetée');
  t('erreur incohérence REPLAYED/replayed=false est une EventShadowInvariantError EVENT_VERSION_SHAPE_INVARIANT', err instanceof EventShadowInvariantError && err.code === 'EVENT_VERSION_SHAPE_INVARIANT');
}

// ---------------------------------------------------------------------
// 6b. Garde-fou de lignage de membership — le lignage persisté DOIT
//     correspondre EXACTEMENT à ce que PR4 a planifié, AVANT toute
//     création d'Event Version (égalité exacte, null-safe).
// ---------------------------------------------------------------------
{
  // A) editorial_origin_key persisté différent du plan.
  const { db, calls } = makeFakeDb(happyPathHandlers({}, { editorial_origin_key: 'official:some_other_source' }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'A) editorial_origin_key persisté != plan => MEMBERSHIP_LINEAGE_MISMATCH');
  t('A) erreur est une EventShadowInvariantError MEMBERSHIP_LINEAGE_MISMATCH', err instanceof EventShadowInvariantError && err.code === 'MEMBERSHIP_LINEAGE_MISMATCH');
  t('A) ZÉRO appel fn_event_create_event_version', !calls.some((c) => c.path === 'rpc/fn_event_create_event_version'));
}
{
  // B) editorial_origin_key persisté null alors que le plan a résolu une origine officielle.
  const { db, calls } = makeFakeDb(happyPathHandlers({}, { editorial_origin_key: null }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'B) editorial_origin_key persisté null alors que le plan a résolu une origine officielle => MEMBERSHIP_LINEAGE_MISMATCH');
  t('B) erreur est une EventShadowInvariantError MEMBERSHIP_LINEAGE_MISMATCH', err instanceof EventShadowInvariantError && err.code === 'MEMBERSHIP_LINEAGE_MISMATCH');
  t('B) ZÉRO appel fn_event_create_event_version', !calls.some((c) => c.path === 'rpc/fn_event_create_event_version'));
}
{
  // C) wire_lineage_key persisté différent du plan (null attendu pour une source officielle directe).
  const { db, calls } = makeFakeDb(happyPathHandlers({}, { wire_lineage_key: 'wire:some-syndication-key' }));
  const err = await expectThrow(() => processEventShadowObservation(db, makeRawRow().id), 'C) wire_lineage_key persisté != plan => MEMBERSHIP_LINEAGE_MISMATCH');
  t('C) erreur est une EventShadowInvariantError MEMBERSHIP_LINEAGE_MISMATCH', err instanceof EventShadowInvariantError && err.code === 'MEMBERSHIP_LINEAGE_MISMATCH');
  t('C) ZÉRO appel fn_event_create_event_version', !calls.some((c) => c.path === 'rpc/fn_event_create_event_version'));
}
{
  // D) lignage persisté exactement égal au plan => succès normal.
  const { db, calls } = makeFakeDb(happyPathHandlers());
  const result = await processEventShadowObservation(db, makeRawRow().id);
  t('D) lignage exact persisté = plan => PROCESSED', result.kind === 'PROCESSED');
  t('D) exactement UN appel fn_event_create_event_version', calls.filter((c) => c.path === 'rpc/fn_event_create_event_version').length === 1);
}

// ---------------------------------------------------------------------
// 7. Rejeu (retry) — première exécution, rejeu exact avec empreintes
//    identiques, récupération après perte de réponse HTTP.
// ---------------------------------------------------------------------
{
  const observation = makeRawRow({ id: '50505050-5050-4050-8050-505050505050' });
  let assignCallCount = 0;
  let eventVersionCallCount = 0;
  const { db, calls } = makeFakeDb({
    newsArticles: () => [observation],
    assignObservation: () => {
      assignCallCount++;
      return [makeAssignResponseRow({ cluster_created_now: assignCallCount === 1, replayed: assignCallCount > 1 })];
    },
    membership: () => [makeMembershipRow({ observation_id: observation.id })],
    eventVersion: () => {
      eventVersionCallCount++;
      return [makeEventVersionResponseRow({ outcome: eventVersionCallCount === 1 ? 'CREATED' : 'REPLAYED', replayed: eventVersionCallCount > 1 })];
    },
  });

  const result1 = await processEventShadowObservation(db, observation.id);
  t('première exécution : PROCESSED', result1.kind === 'PROCESSED');
  t('première exécution : clusterCreatedNow=true, membershipReplayed=false', result1.clusterCreatedNow === true && result1.membershipReplayed === false);
  t('première exécution : eventVersionReplayed=false', result1.eventVersionReplayed === false);

  const result2 = await processEventShadowObservation(db, observation.id);
  t('rejeu exact : PROCESSED', result2.kind === 'PROCESSED');
  t('rejeu exact : membershipReplayed=true', result2.membershipReplayed === true);
  t('rejeu exact : eventVersionReplayed=true', result2.eventVersionReplayed === true);
  t('rejeu exact : même cluster_id/decision_id/event_version_id retournés', result2.clusterId === result1.clusterId && result2.decisionId === result1.decisionId && result2.eventVersionId === result1.eventVersionId);
  t('rejeu exact : assigned_at persisté reste la valeur d\'origine (jamais recalculée)', result2.finalKnowledgeCutoff === result1.finalKnowledgeCutoff);

  const assignCalls = calls.filter((c) => c.path === 'rpc/fn_event_assign_observation');
  const eventVersionCalls = calls.filter((c) => c.path === 'rpc/fn_event_create_event_version');
  t('la seconde exécution envoie EXACTEMENT la même empreinte d\'idempotence d\'assignation',
    assignCalls.length === 2 && assignCalls[0].body.p_idempotency_fingerprint === assignCalls[1].body.p_idempotency_fingerprint);
  t('la seconde exécution envoie EXACTEMENT la même empreinte d\'idempotence Event Version',
    eventVersionCalls.length === 2 && eventVersionCalls[0].body.p_idempotency_fingerprint === eventVersionCalls[1].body.p_idempotency_fingerprint);
}

// ---------------------------------------------------------------------
// 8. Récupération après perte de réponse HTTP (assignation committée,
//    Event Version jamais atteint) : le rejeu réutilise le même
//    cluster/decision, aucune seconde intention de cluster n'est émise.
// ---------------------------------------------------------------------
{
  const observation = makeRawRow({ id: '60606060-6060-4060-8060-606060606060' });
  let assignCallCount = 0;
  let eventVersionCallCount = 0;
  const { db, calls } = makeFakeDb({
    newsArticles: () => [observation],
    assignObservation: () => {
      assignCallCount++;
      return [makeAssignResponseRow({ cluster_created_now: assignCallCount === 1, replayed: assignCallCount > 1 })];
    },
    membership: () => [makeMembershipRow({ observation_id: observation.id })],
    eventVersion: () => {
      eventVersionCallCount++;
      if (eventVersionCallCount === 1) {
        throw new Error('simulated lost HTTP response / network failure before Event Version RPC completed');
      }
      return [makeEventVersionResponseRow({ outcome: 'CREATED', replayed: false })];
    },
  });

  let firstError = null;
  try {
    await processEventShadowObservation(db, observation.id);
  } catch (err) {
    firstError = err;
  }
  t('première tentative échoue (Event Version jamais atteint, réponse perdue simulée)', firstError !== null);

  const result = await processEventShadowObservation(db, observation.id);
  t('récupération : la seconde tentative réussit PROCESSED', result.kind === 'PROCESSED');

  const assignCalls = calls.filter((c) => c.path === 'rpc/fn_event_assign_observation');
  t('récupération : l\'assignation est appelée deux fois avec EXACTEMENT la même empreinte (aucune intention de cluster changée/dupliquée)',
    assignCalls.length === 2 && assignCalls[0].body.p_idempotency_fingerprint === assignCalls[1].body.p_idempotency_fingerprint);
  t('récupération : le résultat réutilise le cluster/decision déjà committés (aucun second cluster demandé)',
    result.clusterId === CLUSTER_ID && result.decisionId === DECISION_ID);
}

// ---------------------------------------------------------------------
// 8b. Perte RÉELLE de la réponse HTTP d'ASSIGNATION elle-même (pas
//     seulement Event Version) : le premier appel fn_event_assign_observation
//     est commis côté "serveur" (fake DB) mais l'application ne reçoit
//     JAMAIS la réponse HTTP (throw simulé). La lecture de membership et
//     l'appel Event Version NE DOIVENT PAS avoir lieu suite à cette perte.
//     Le rejeu suivant, avec l'EXACTE MÊME empreinte d'idempotence F,
//     reçoit le cluster/decision déjà committés en mode replayed=true,
//     cluster_created_now=false, puis poursuit normalement jusqu'à
//     l'Event Version.
// ---------------------------------------------------------------------
{
  const observation = makeRawRow({ id: 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0' });
  let assignAttempt = 0;
  let committed = null;
  let membershipCallCount = 0;
  let eventVersionCallCount = 0;
  const capturedAssignFingerprints = [];
  const { db, calls } = makeFakeDb({
    newsArticles: () => [observation],
    assignObservation: (method, path, body) => {
      assignAttempt++;
      capturedAssignFingerprints.push(body.p_idempotency_fingerprint);
      if (assignAttempt === 1) {
        // Le "serveur" commet l'assignation en interne, mais la réponse
        // HTTP vers l'application est perdue avant d'avoir pu être lue.
        committed = { cluster_id: CLUSTER_ID, decision_id: DECISION_ID };
        throw new Error('simulated network/HTTP-response-loss error: the RPC response never reached the application, even though the assignment committed server-side');
      }
      // Rejeu : le "serveur" reconnaît la MÊME empreinte d'idempotence et
      // rejoue la ligne déjà committée — aucune seconde intention de cluster.
      return [makeAssignResponseRow({ cluster_id: committed.cluster_id, decision_id: committed.decision_id, cluster_created_now: false, replayed: true })];
    },
    membership: () => {
      membershipCallCount++;
      return [makeMembershipRow({ observation_id: observation.id })];
    },
    eventVersion: () => {
      eventVersionCallCount++;
      return [makeEventVersionResponseRow({ outcome: 'CREATED', replayed: false })];
    },
  });

  let firstError = null;
  try {
    await processEventShadowObservation(db, observation.id);
  } catch (err) {
    firstError = err;
  }
  t('première invocation : la perte de réponse HTTP d\'assignation lève une erreur (aucun cluster_id/decision_id reçu)', firstError !== null);
  t('première invocation : AUCUNE lecture de membership (jamais atteinte suite à la perte de réponse)', membershipCallCount === 0);
  t('première invocation : AUCUN appel Event Version (jamais atteint suite à la perte de réponse)', eventVersionCallCount === 0);

  const result = await processEventShadowObservation(db, observation.id);
  t('seconde invocation (même observation) après la perte de réponse : PROCESSED', result.kind === 'PROCESSED');
  t('empreinte d\'assignation première tentative === empreinte seconde tentative (même intention logique CREATE_AND_ASSIGN)',
    capturedAssignFingerprints.length === 2 && capturedAssignFingerprints[0] === capturedAssignFingerprints[1]);
  t('la seconde tentative réutilise le cluster_id/decision_id déjà committés (aucune seconde intention de cluster générée)',
    result.clusterId === CLUSTER_ID && result.decisionId === DECISION_ID);

  const eventVersionCalls = calls.filter((c) => c.path === 'rpc/fn_event_create_event_version');
  t('exactement UN appel Event Version a eu lieu sur l\'ensemble du scénario (jamais après la première perte)', eventVersionCalls.length === 1 && eventVersionCallCount === 1);
}

// ---------------------------------------------------------------------
// 8c. Récupération live EXACTE post-hotfix (fixture PR7) : la membership
//     fondatrice est DÉJÀ committée à précision microseconde (replayed=true
//     dès le premier appel visible par l'orchestrateur — même topologie que
//     les 4 event_clusters/memberships déjà persistés en live), AUCUN Event
//     Version n'existe encore. L'orchestrateur doit relire cette membership,
//     dériver un p_knowledge_cutoff à précision microseconde EXACTE, puis
//     réussir fn_event_create_event_version (CREATED, pas replayed).
// ---------------------------------------------------------------------
{
  const observation = makeRawRow({ id: 'c0ffeec0-ffee-4c0f-8fee-c0ffeec0ffee' });
  const preciseAssignedAt = '2026-09-15T20:54:13.472031+00:00'; // OFAC live fixture
  let eventVersionCallCount = 0;
  const { db, calls } = makeFakeDb({
    newsArticles: () => [observation],
    // La membership fondatrice a déjà été committée server-side (comme les
    // 4 clusters live) : l'assignation revient donc en replayed=true dès
    // ce premier appel visible par l'orchestrateur.
    assignObservation: () => [makeAssignResponseRow({ cluster_created_now: false, replayed: true })],
    membership: () => [makeMembershipRow({ observation_id: observation.id, assigned_at: preciseAssignedAt })],
    eventVersion: () => {
      eventVersionCallCount++;
      return [makeEventVersionResponseRow({ outcome: 'CREATED', replayed: false })];
    },
  });

  const result = await processEventShadowObservation(db, observation.id);

  t('récupération live PR7 : résultat PROCESSED', result.kind === 'PROCESSED', JSON.stringify(result));
  t('récupération live PR7 : membershipReplayed=true (membership déjà committée)', result.membershipReplayed === true);
  t('récupération live PR7 : eventVersionReplayed=false (Event Version créée pour la première fois)', result.eventVersionReplayed === false);
  t('récupération live PR7 : exactement UN appel Event Version', eventVersionCallCount === 1);

  const evCall = calls.find((c) => c.path === 'rpc/fn_event_create_event_version');
  t('récupération live PR7 : p_knowledge_cutoff inclut la membership à précision microseconde exacte (472031)',
    evCall.body.p_knowledge_cutoff === preciseAssignedAt);
  t('récupération live PR7 : invariant RPC assigned_at <= p_knowledge_cutoff satisfait (égalité exacte)',
    result.finalKnowledgeCutoff === preciseAssignedAt);
}

// ---------------------------------------------------------------------
// 9. Corrélation d'empreinte Event Version (observationId / decisionId).
// ---------------------------------------------------------------------
{
  // observationId identique en tout point sauf l'id -> empreintes Event
  // Version DIFFÉRENTES (le cluster/decision est forcé identique dans le
  // faux DB pour isoler UNIQUEMENT la variation d'observationId).
  const rowA = makeRawRow({ id: '70707070-7070-4070-8070-707070707070' });
  const rowB = makeRawRow({ id: '80808080-8080-4080-8080-808080808080' });
  async function runFixedClusterDecision(row) {
    const { db, calls } = makeFakeDb({
      newsArticles: () => [row],
      assignObservation: () => [makeAssignResponseRow({ cluster_id: CLUSTER_ID, decision_id: DECISION_ID })],
      membership: () => [makeMembershipRow({ observation_id: row.id })],
      eventVersion: () => [makeEventVersionResponseRow()],
    });
    await processEventShadowObservation(db, row.id);
    return calls.find((c) => c.path === 'rpc/fn_event_create_event_version').body.p_idempotency_fingerprint;
  }
  const fpA = await runFixedClusterDecision(rowA);
  const fpB = await runFixedClusterDecision(rowB);
  t('la corrélation observationId change l\'empreinte Event Version (même cluster/decision, observationId différent)', fpA !== fpB);
}
{
  // decisionId identique... sauf le decisionId : forcer deux decisionId
  // différents pour la MÊME observation (scénario synthétique isolant
  // uniquement la corrélation decisionId).
  const row = makeRawRow({ id: '90909090-9090-4090-8090-909090909090' });
  async function runWithDecisionId(decisionId) {
    const { db, calls } = makeFakeDb({
      newsArticles: () => [row],
      assignObservation: () => [makeAssignResponseRow({ cluster_id: CLUSTER_ID, decision_id: decisionId })],
      membership: () => [makeMembershipRow({ observation_id: row.id, decision_id: decisionId })],
      eventVersion: () => [makeEventVersionResponseRow()],
    });
    await processEventShadowObservation(db, row.id);
    return calls.find((c) => c.path === 'rpc/fn_event_create_event_version').body.p_idempotency_fingerprint;
  }
  const fp1 = await runWithDecisionId('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1');
  const fp2 = await runWithDecisionId('a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2');
  t('la corrélation membershipDecisionId change l\'empreinte Event Version (même observation/cluster, decisionId différent)', fp1 !== fp2);
}

// ---------------------------------------------------------------------
// 10. Empreinte de membership — stabilité/sensibilité sémantique.
// ---------------------------------------------------------------------
{
  async function runAndGetAssignFingerprint(row) {
    const { db, calls } = makeFakeDb(happyPathHandlers(row));
    await processEventShadowObservation(db, row.id);
    return calls.find((c) => c.path === 'rpc/fn_event_assign_observation').body.p_idempotency_fingerprint;
  }
  const base = makeRawRow({ id: 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0' });
  const changedCategory = makeRawRow({ id: 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0', provider_category: 'speech' });
  const fpBase = await runAndGetAssignFingerprint(base);
  const fpChanged = await runAndGetAssignFingerprint(changedCategory);
  t('un changement sémantique (providerCategory -> clusterCategory) change l\'empreinte d\'idempotence de membership', fpBase !== fpChanged);
}

// ---------------------------------------------------------------------
// 11. Isolation legacy/shadow — aucune référence, aucune RPC hors
//     allowlist, aucun UPDATE/DELETE.
// ---------------------------------------------------------------------
const liveOrchestratorSource = orchestratorSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

const FORBIDDEN_LEGACY_TOKENS = ['news_events', 'notifications', 'ai_committee', 'committee', 'ScoredEvent', 'scoreArticle', 'dispatchActions', 'frontend'];
for (const token of FORBIDDEN_LEGACY_TOKENS) {
  t(`aucune référence exécutable à "${token}"`, !new RegExp(token, 'i').test(liveOrchestratorSource));
}
t('aucun UPDATE exécutable', !/\bUPDATE\b/i.test(liveOrchestratorSource));
t('aucun DELETE exécutable', !/\bDELETE\b/i.test(liveOrchestratorSource));
t('aucune référence à backend/ingest', !/backend\/ingest/.test(liveOrchestratorSource));
t('aucun import Supabase', !/@supabase/.test(liveOrchestratorSource));
t('aucune lecture de variable d\'environnement (process.env)', !/process\.env/.test(liveOrchestratorSource));

const RPC_CALLS_FOUND = [...liveOrchestratorSource.matchAll(/rpc\/([a-z_]+)/g)].map((m) => m[1]);
const UNIQUE_RPC_CALLS = [...new Set(RPC_CALLS_FOUND)];
t('les seules RPC appelées sont fn_event_assign_observation et fn_event_create_event_version',
  UNIQUE_RPC_CALLS.length === 2 && UNIQUE_RPC_CALLS.includes('fn_event_assign_observation') && UNIQUE_RPC_CALLS.includes('fn_event_create_event_version'));

for (const rpc of ['fn_event_assert_identity_claim', 'fn_event_reassign_membership', 'fn_event_supersede_membership', 'fn_event_create_cluster_relation']) {
  t(`${rpc} n'est jamais appelée dans PR5 V1`, !liveOrchestratorSource.includes(rpc));
}
t('aucune modification de backend/worker.ts/wrangler.toml/run_lock.ts référencée (aucun import de ces modules)',
  !/worker\.ts|wrangler|run_lock/.test(liveOrchestratorSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
