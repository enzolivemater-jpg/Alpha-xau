// Contrat BEHAVIORAL (pas seulement statique) du shadow batch runner
// OPS-023 PR6 (backend/event_engine/shadow_batch.ts). Comme pour
// tests/test_event_shadow_orchestrator.mjs, ce fichier transpile le
// TypeScript source avec `typescript` (déjà présent en devDependency,
// aucune nouvelle dépendance) et exécute les QUATRE modules réellement
// compilés — shadow_batch.ts, sa dépendance réelle shadow_orchestrator.ts,
// la dépendance réelle de celle-ci deterministic_processor.ts, ET la
// vraie implémentation de verrou backend/shared/run_lock.ts. Aucun de ces
// quatre modules n'est jamais remplacé par une version factice — seul le
// port DB structurel (EventShadowBatchDb) est un faux déterministe.
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BATCH_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_batch.ts');
const ORCHESTRATOR_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'shadow_orchestrator.ts');
const PROCESSOR_PATH = path.join(__dirname, '..', 'backend', 'event_engine', 'deterministic_processor.ts');
const RUN_LOCK_PATH = path.join(__dirname, '..', 'backend', 'shared', 'run_lock.ts');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('backend/event_engine/shadow_batch.ts existe', existsSync(BATCH_PATH));

const batchSource = existsSync(BATCH_PATH) ? readFileSync(BATCH_PATH, 'utf8') : '';
const orchestratorSource = existsSync(ORCHESTRATOR_PATH) ? readFileSync(ORCHESTRATOR_PATH, 'utf8') : '';
const processorSource = existsSync(PROCESSOR_PATH) ? readFileSync(PROCESSOR_PATH, 'utf8') : '';
const runLockSource = existsSync(RUN_LOCK_PATH) ? readFileSync(RUN_LOCK_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Transpilation + chargement ESM réel des QUATRE modules, avec la
//    MÊME structure de répertoires relative que le dépôt (event_engine/
//    + shared/) pour que les spécificateurs d'import relatifs
//    ('./shadow_orchestrator.js', '../shared/run_lock.js', etc.)
//    résolvent correctement une fois réécrits en .mjs.
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
  let batchTranspiled = transpile(batchSource);
  batchTranspiled = batchTranspiled
    .replace(/(['"])\.\/shadow_orchestrator\.js\1/, "$1./shadow_orchestrator.mjs$1")
    .replace(/(['"])\.\.\/shared\/run_lock\.js\1/, "$1../shared/run_lock.mjs$1");

  tmpDir = mkdtempSync(path.join(tmpdir(), 'ops023-shadow-batch-'));
  const eventEngineDir = path.join(tmpDir, 'event_engine');
  const sharedDir = path.join(tmpDir, 'shared');
  mkdirSync(eventEngineDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  writeFileSync(path.join(eventEngineDir, 'deterministic_processor.mjs'), processorTranspiled, 'utf8');
  writeFileSync(path.join(eventEngineDir, 'shadow_orchestrator.mjs'), orchestratorTranspiled, 'utf8');
  writeFileSync(path.join(sharedDir, 'run_lock.mjs'), runLockTranspiled, 'utf8');
  const batchTmpFile = path.join(eventEngineDir, 'shadow_batch.mjs');
  writeFileSync(batchTmpFile, batchTranspiled, 'utf8');

  mod = await import(pathToFileURL(batchTmpFile).href);
} catch (err) {
  console.error('FAILED TO TRANSPILE/LOAD shadow_batch.ts:', err);
} finally {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

t('les quatre modules transpilent et se chargent sans erreur', mod !== null);
t('OPS023_EVENT_SHADOW_BATCH_VERSION est exporté', typeof mod?.OPS023_EVENT_SHADOW_BATCH_VERSION === 'string' && mod.OPS023_EVENT_SHADOW_BATCH_VERSION.length > 0);
t('MAX_EVENT_SHADOW_BATCH_SIZE = 25', mod?.MAX_EVENT_SHADOW_BATCH_SIZE === 25);
t('runEventShadowBatch est exporté (fonction)', typeof mod?.runEventShadowBatch === 'function');
t('EventShadowBusyError est exporté (classe)', typeof mod?.EventShadowBusyError === 'function');
t('EventShadowBatchInvariantError est exporté (classe)', typeof mod?.EventShadowBatchInvariantError === 'function');

if (mod === null) {
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
}

const {
  runEventShadowBatch,
  EventShadowBusyError,
  EventShadowBatchInvariantError,
  OPS023_EVENT_SHADOW_BATCH_VERSION,
} = mod;

// ---------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------

/** Génère un UUID déterministe (jamais aléatoire) à partir d'un libellé
 *  de test lisible — un simple hachage MD5 formaté en 8-4-4-4-12. */
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

/** Une "fixture" d'observation complète : la ligne RAW + les identifiants
 *  cluster/decision/event-version stables que le faux DB doit renvoyer
 *  pour cette observation, plus des points d'extension optionnels
 *  (assignBehavior/membershipBehavior/eventVersionBehavior) pour les
 *  scénarios de rejeu/erreur/récupération. */
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
    membershipBehavior: overrides.membershipBehavior ?? null,
    eventVersionBehavior: overrides.eventVersionBehavior ?? null,
  };
}

/**
 * Faux EventShadowBatchDb complet : exécute le VRAI acquireLock/releaseLock
 * (run_lock.ts) ET le VRAI processEventShadowObservation (shadow_batch.ts
 * -> shadow_orchestrator.ts -> deterministic_processor.ts) au-dessus d'un
 * état déterministe en mémoire. Chaque appel est enregistré avec un
 * "owner" (id d'observation propriétaire, ou 'LOCK') pour permettre aux
 * tests de vérifier l'ordre séquentiel strict.
 */
function makeBatchFakeDb(observations, lockOptions = {}) {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const byDecisionId = new Map(observations.map((o) => [o.decisionId, o]));
  const byClusterId = new Map(observations.map((o) => [o.clusterId, o]));
  const calls = [];
  let runRowCounter = 0;
  let releaseCallCount = 0;
  const assignCallCounts = new Map();
  const eventVersionCallCounts = new Map();

  const db = {
    async request(method, reqPath, body, extraHeaders) {
      // ---- lock : reclaim stale runs ----
      if (reqPath === 'rpc/fn_reclaim_stale_runs') {
        calls.push({ method, path: reqPath, body, extraHeaders, owner: 'LOCK' });
        if (lockOptions.reclaimThrows) throw new Error('simulated fn_reclaim_stale_runs failure');
        return 0;
      }

      // ---- lock : acquire (insert running row) ----
      if (method === 'POST' && reqPath === 'ingestion_runs?select=id') {
        calls.push({ method, path: reqPath, body, extraHeaders, owner: 'LOCK' });
        if (lockOptions.forceAlreadyRunning) {
          throw new Error('duplicate key value violates unique constraint "uq_ingestion_runs_active"');
        }
        runRowCounter += 1;
        return [{ id: `run-row-${runRowCounter}` }];
      }

      // ---- lock : release (patch) ----
      if (method === 'PATCH' && reqPath.startsWith('ingestion_runs?id=eq.')) {
        calls.push({ method, path: reqPath, body, extraHeaders, owner: 'LOCK' });
        releaseCallCount += 1;
        if (lockOptions.forceReleaseFailure) {
          throw new Error('simulated network/HTTP failure releasing the event_shadow lock');
        }
        return undefined;
      }

      // ---- RAW fetch ----
      if (reqPath.startsWith('news_articles?')) {
        const m = /id=eq\.([^&]+)/.exec(reqPath);
        const id = m ? decodeURIComponent(m[1]) : null;
        calls.push({ method, path: reqPath, body, extraHeaders, owner: id });
        const obs = id ? byId.get(id) : null;
        return obs ? [obs.row] : [];
      }

      // ---- fn_event_assign_observation ----
      if (reqPath === 'rpc/fn_event_assign_observation') {
        const id = body?.p_observation_id;
        calls.push({ method, path: reqPath, body, extraHeaders, owner: id });
        const obs = byId.get(id);
        if (!obs) throw new Error(`fake DB: unknown observation for assign: ${id}`);
        const count = (assignCallCounts.get(id) ?? 0) + 1;
        assignCallCounts.set(id, count);
        if (obs.assignBehavior) return obs.assignBehavior({ method, path: reqPath, body, count });
        return [{
          cluster_id: obs.clusterId,
          decision_id: obs.decisionId,
          cluster_created_now: count === 1,
          replayed: count > 1,
        }];
      }

      // ---- membership read-back ----
      if (reqPath.startsWith('event_observation_memberships?')) {
        const m = /decision_id=eq\.([^&]+)/.exec(reqPath);
        const decisionId = m ? decodeURIComponent(m[1]) : null;
        const obs = decisionId ? byDecisionId.get(decisionId) : null;
        calls.push({ method, path: reqPath, body, extraHeaders, owner: obs?.id ?? null });
        if (!obs) throw new Error(`fake DB: unknown membership for decision_id: ${decisionId}`);
        if (obs.membershipBehavior) return obs.membershipBehavior({ method, path: reqPath, body });
        return [{
          decision_id: obs.decisionId,
          observation_id: obs.id,
          cluster_id: obs.clusterId,
          assigned_at: obs.assignedAt,
          decision_type: 'ASSIGN',
          editorial_origin_key: obs.editorialOriginKey,
          wire_lineage_key: obs.wireLineageKey,
        }];
      }

      // ---- fn_event_create_event_version ----
      if (reqPath === 'rpc/fn_event_create_event_version') {
        const clusterId = body?.p_cluster_id;
        const obs = byClusterId.get(clusterId);
        calls.push({ method, path: reqPath, body, extraHeaders, owner: obs?.id ?? null });
        const count = (eventVersionCallCounts.get(clusterId) ?? 0) + 1;
        eventVersionCallCounts.set(clusterId, count);
        if (obs?.eventVersionBehavior) return obs.eventVersionBehavior({ method, path: reqPath, body, count });
        return [{
          event_version_id: obs?.eventVersionId ?? uid(`unknown-cluster:${clusterId}`),
          version_number: 1,
          transition_type: 'NOVELTY',
          state_fingerprint: 'fingerprint-for-batch-tests',
          source_independence_state: 'SINGLE_EDITORIAL_ORIGIN',
          evidence_count: 1,
          outcome: count === 1 ? 'CREATED' : 'REPLAYED',
          replayed: count > 1,
        }];
      }

      throw new Error(`unexpected DB call reached the fake (isolation violation): ${method} ${reqPath}`);
    },
  };

  return { db, calls, getReleaseCallCount: () => releaseCallCount };
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
// 1. Validation d'entrée — AVANT tout appel DB.
// ---------------------------------------------------------------------
{
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, []), 'liste vide rejetée AVANT tout appel DB');
  t('erreur liste vide : EventShadowBatchInvariantError EMPTY_OBSERVATION_LIST', err instanceof EventShadowBatchInvariantError && err.code === 'EMPTY_OBSERVATION_LIST');
  t('liste vide : ZÉRO appel DB', calls.length === 0);
}
{
  const ids = Array.from({ length: 26 }, (_, i) => uid(`toomany-${i}`));
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, ids), '>25 IDs rejeté AVANT tout appel DB');
  t('erreur >25 IDs : EventShadowBatchInvariantError BATCH_SIZE_EXCEEDED', err instanceof EventShadowBatchInvariantError && err.code === 'BATCH_SIZE_EXCEEDED');
  t('>25 IDs : ZÉRO appel DB', calls.length === 0);
}
{
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, ['not-a-uuid']), 'UUID malformé rejeté AVANT tout appel DB');
  t('erreur UUID malformé : EventShadowBatchInvariantError MALFORMED_OBSERVATION_ID', err instanceof EventShadowBatchInvariantError && err.code === 'MALFORMED_OBSERVATION_ID');
  t('UUID malformé : ZÉRO appel DB', calls.length === 0);
}
{
  const dup = uid('duplicate-1');
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, [dup, dup]), 'ID dupliqué rejeté AVANT tout appel DB');
  t('erreur ID dupliqué : EventShadowBatchInvariantError DUPLICATE_OBSERVATION_ID', err instanceof EventShadowBatchInvariantError && err.code === 'DUPLICATE_OBSERVATION_ID');
  t('ID dupliqué : ZÉRO appel DB', calls.length === 0);
}
{
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, [uid('blank-trigger')], '   '), 'triggerType vide/blanc rejeté AVANT tout appel DB');
  t('erreur triggerType blanc : EventShadowBatchInvariantError BLANK_TRIGGER_TYPE', err instanceof EventShadowBatchInvariantError && err.code === 'BLANK_TRIGGER_TYPE');
  t('triggerType blanc : ZÉRO appel DB', calls.length === 0);
}
{
  const longTrigger = 'x'.repeat(65);
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, [uid('long-trigger')], longTrigger), 'triggerType >64 caractères rejeté AVANT tout appel DB');
  t('erreur triggerType trop long : EventShadowBatchInvariantError TRIGGER_TYPE_TOO_LONG', err instanceof EventShadowBatchInvariantError && err.code === 'TRIGGER_TYPE_TOO_LONG');
  t('triggerType trop long : ZÉRO appel DB', calls.length === 0);
}

// ---------------------------------------------------------------------
// 1b. Contrat trigger_type — DOIT correspondre exactement au VRAI CHECK
//     de ingestion_runs.trigger_type (cron | manual | webhook | backfill),
//     vérifié en direct. Toute autre valeur DOIT être rejetée AVANT tout
//     appel DB, jamais normalisée/repliée silencieusement sur "manual".
// ---------------------------------------------------------------------
{
  const id = uid('trigger-default');
  const { db } = makeBatchFakeDb([makeObservation(id)]);
  const report = await runEventShadowBatch(db, [id]); // pas de 3e argument => défaut
  t('défaut "manual" accepté', report.triggerType === 'manual');
}
for (const trigger of ['cron', 'manual', 'webhook', 'backfill']) {
  const id = uid(`trigger-ok-${trigger}`);
  const { db, calls } = makeBatchFakeDb([makeObservation(id)]);
  const report = await runEventShadowBatch(db, [id], trigger);
  t(`trigger "${trigger}" accepté (valeur réelle du CHECK PostgreSQL)`, report.triggerType === trigger);
  const acquireCall = calls.find((c) => c.method === 'POST' && c.path === 'ingestion_runs?select=id');
  t(`trigger "${trigger}" propagé EXACTEMENT à ingestion_runs.trigger_type`, acquireCall.body[0].trigger_type === trigger);
}
{
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, [uid('trigger-scheduled-review')], 'scheduled_review'), '"scheduled_review" (non conforme au CHECK réel) rejeté AVANT tout appel DB');
  t('erreur : EventShadowBatchInvariantError UNSUPPORTED_TRIGGER_TYPE', err instanceof EventShadowBatchInvariantError && err.code === 'UNSUPPORTED_TRIGGER_TYPE');
  t('"scheduled_review" : ZÉRO appel DB (n\'atteint jamais acquireLock)', calls.length === 0);
}
{
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, [uid('trigger-foo')], 'foo'), 'trigger arbitraire "foo" rejeté AVANT tout appel DB');
  t('erreur "foo" : EventShadowBatchInvariantError UNSUPPORTED_TRIGGER_TYPE', err instanceof EventShadowBatchInvariantError && err.code === 'UNSUPPORTED_TRIGGER_TYPE');
  t('"foo" : ZÉRO appel DB (n\'atteint jamais acquireLock)', calls.length === 0);
}

// ---------------------------------------------------------------------
// 1c. Sémantique de doublon UUID — insensible à la casse hexadécimale
//     (identité PostgreSQL UUID), sans jamais réécrire le tableau
//     observationIds, l'ordre de l'appelant, ni l'ID exact transmis à
//     PR5.
// ---------------------------------------------------------------------
{
  const base = uid('case-dup-1'); // toujours en minuscules (sortie hex de createHash)
  const upper = base.toUpperCase();
  const { db, calls } = makeBatchFakeDb([]);
  const err = await expectThrow(() => runEventShadowBatch(db, [base, upper]), 'même UUID en minuscules PUIS majuscules => doublon');
  t('doublon insensible à la casse : EventShadowBatchInvariantError DUPLICATE_OBSERVATION_ID', err instanceof EventShadowBatchInvariantError && err.code === 'DUPLICATE_OBSERVATION_ID');
  t('doublon insensible à la casse : ZÉRO appel DB', calls.length === 0);
}

// ---------------------------------------------------------------------
// 2. Verrou — reclaim/acquire avant tout traitement, engine exact,
//    trigger propagé, occupé => EventShadowBusyError, aucune libération
//    si le verrou n'a jamais été acquis.
// ---------------------------------------------------------------------
{
  const id = uid('lock-order-1');
  const { db, calls } = makeBatchFakeDb([makeObservation(id)]);
  await runEventShadowBatch(db, [id], 'backfill');

  const reclaimIdx = calls.findIndex((c) => c.path === 'rpc/fn_reclaim_stale_runs');
  const acquireIdx = calls.findIndex((c) => c.method === 'POST' && c.path === 'ingestion_runs?select=id');
  const rawFetchIdx = calls.findIndex((c) => c.path.startsWith('news_articles?'));
  t('reclaim précède acquire, acquire précède le premier fetch RAW', reclaimIdx > -1 && acquireIdx > reclaimIdx && rawFetchIdx > acquireIdx);

  const acquireCall = calls[acquireIdx];
  t('engine = event_shadow dans la ligne insérée', acquireCall.body[0].engine === 'event_shadow');
  t('trigger_type propagé exactement ("backfill", valeur réelle du CHECK)', acquireCall.body[0].trigger_type === 'backfill');
}
{
  const id = uid('lock-busy-1');
  const { db, calls, getReleaseCallCount } = makeBatchFakeDb([makeObservation(id)], { forceAlreadyRunning: true });
  const err = await expectThrow(() => runEventShadowBatch(db, [id]), 'verrou déjà pris => EventShadowBusyError');
  t('erreur occupé est une EventShadowBusyError', err instanceof EventShadowBusyError);
  t('occupé : AUCUN traitement d\'observation (aucun fetch RAW/assign/membership/event-version)',
    !calls.some((c) => c.path.startsWith('news_articles?') || c.path === 'rpc/fn_event_assign_observation' || c.path.startsWith('event_observation_memberships?') || c.path === 'rpc/fn_event_create_event_version'));
  t('occupé : AUCUNE libération de verrou tentée (verrou jamais acquis)', getReleaseCallCount() === 0);
}

// ---------------------------------------------------------------------
// 3. Traitement séquentiel — ordre de l'appelant préservé, un par un,
//    jamais Promise.all/allSettled.
// ---------------------------------------------------------------------
{
  const idA = uid('seq-A');
  const idB = uid('seq-B');
  const idC = uid('seq-C');
  const { db, calls } = makeBatchFakeDb([makeObservation(idA), makeObservation(idB), makeObservation(idC)]);
  await runEventShadowBatch(db, [idA, idB, idC]);

  const ownerSequence = calls.filter((c) => c.owner !== 'LOCK').map((c) => c.owner);
  const lastIdxA = ownerSequence.lastIndexOf(idA);
  const firstIdxB = ownerSequence.indexOf(idB);
  const lastIdxB = ownerSequence.lastIndexOf(idB);
  const firstIdxC = ownerSequence.indexOf(idC);
  t('toutes les requêtes de A précèdent toutes celles de B (aucun entrelacement Promise.all)', lastIdxA < firstIdxB);
  t('toutes les requêtes de B précèdent toutes celles de C (aucun entrelacement Promise.all)', lastIdxB < firstIdxC);
}
{
  // Ordre exact des items du rapport = ordre exact de l'appelant, y
  // compris quand cet ordre ne correspond à aucun tri naturel des UUID.
  const idZ = uid('order-zzz');
  const idA = uid('order-aaa');
  const { db } = makeBatchFakeDb([makeObservation(idZ), makeObservation(idA)]);
  const report = await runEventShadowBatch(db, [idZ, idA]);
  t('ordre des items = ordre exact de l\'appelant (Z puis A, jamais trié)',
    report.items.length === 2 && report.items[0].observationId === idZ && report.items[1].observationId === idA);
}
t('shadow_batch.ts ne référence jamais Promise.all( / Promise.allSettled(', !/Promise\.all\(|Promise\.allSettled\(/.test(batchSource));

// ---------------------------------------------------------------------
// 4. Résultats par item + agrégation.
// ---------------------------------------------------------------------
{
  const idA = uid('outcome-processed-A');
  const idB = uid('outcome-processed-B');
  const { db } = makeBatchFakeDb([makeObservation(idA), makeObservation(idB)]);
  const report = await runEventShadowBatch(db, [idA, idB]);
  t('agrégation PROCESSED : processed=2', report.processed === 2);
  t('les deux items sont PROCESSED avec les champs requis',
    report.items.every((it) => it.kind === 'PROCESSED'
      && typeof it.clusterId === 'string' && typeof it.decisionId === 'string' && typeof it.eventVersionId === 'string'
      && typeof it.clusterCreatedNow === 'boolean' && typeof it.membershipReplayed === 'boolean'
      && typeof it.eventVersionReplayed === 'boolean' && typeof it.finalKnowledgeCutoff === 'string'
      && typeof it.sourceIndependenceState === 'string'));
  t('status = success (zéro échec opérationnel)', report.status === 'success');
}
{
  const idAbstain = uid('outcome-abstained');
  const { db } = makeBatchFakeDb([makeObservation(idAbstain, { row: { source_code: 'unknown_source', provider: 'unknown', source_domain: null } })]);
  const report = await runEventShadowBatch(db, [idAbstain]);
  t('agrégation ABSTAINED : abstained=1', report.abstained === 1);
  t('item ABSTAINED expose observationId/abstention/reason',
    report.items[0].kind === 'ABSTAINED' && report.items[0].observationId === idAbstain
    && report.items[0].abstention === 'UNSUPPORTED_SOURCE' && typeof report.items[0].reason === 'string');
  t('ABSTAINED seul => status success', report.status === 'success');
}
{
  const idSkip = uid('outcome-skipped');
  const { db } = makeBatchFakeDb([]); // aucune fixture enregistrée => 0 ligne RAW
  const report = await runEventShadowBatch(db, [idSkip]);
  t('agrégation SKIPPED : skipped=1', report.skipped === 1);
  t('item SKIPPED expose observationId/reason',
    report.items[0].kind === 'SKIPPED' && report.items[0].observationId === idSkip && report.items[0].reason === 'OBSERVATION_NOT_FOUND');
  t('SKIPPED seul => status success', report.status === 'success');
}
{
  const idFail = uid('outcome-failed-1');
  const idOk = uid('outcome-failed-2');
  const { db } = makeBatchFakeDb([
    makeObservation(idFail, { assignBehavior: () => [{ cluster_id: 'not-a-uuid', decision_id: 'also-not-a-uuid', cluster_created_now: true, replayed: false }] }),
    makeObservation(idOk),
  ]);
  const report = await runEventShadowBatch(db, [idFail, idOk]);
  t('un item en échec => FAILED et le suivant continue normalement',
    report.items[0].kind === 'FAILED' && report.items[1].kind === 'PROCESSED');
  t('item FAILED expose observationId/errorCode/safeErrorMessage',
    typeof report.items[0].observationId === 'string' && typeof report.items[0].errorCode === 'string' && typeof report.items[0].safeErrorMessage === 'string');
  t('errorCode = err.code pour une EventShadowInvariantError (MALFORMED_RPC_RESPONSE)', report.items[0].errorCode === 'MALFORMED_RPC_RESPONSE');
  t('mixte (1 FAILED + 1 PROCESSED) => status partial', report.status === 'partial' && report.failed === 1 && report.processed === 1);
}
{
  const idFail1 = uid('all-failed-1');
  const idFail2 = uid('all-failed-2');
  const malformed = () => [{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }];
  const { db } = makeBatchFakeDb([
    makeObservation(idFail1, { assignBehavior: malformed }),
    makeObservation(idFail2, { assignBehavior: malformed }),
  ]);
  const report = await runEventShadowBatch(db, [idFail1, idFail2]);
  t('tous les items en échec => status failed', report.status === 'failed' && report.failed === report.requested);
}
{
  const idBoom = uid('unexpected-error');
  const { db } = makeBatchFakeDb([
    makeObservation(idBoom, { assignBehavior: () => { throw new Error('boom: unexpected non-invariant failure'); } }),
  ]);
  const report = await runEventShadowBatch(db, [idBoom]);
  t('erreur non-EventShadowInvariantError => errorCode UNEXPECTED_ERROR', report.items[0].kind === 'FAILED' && report.items[0].errorCode === 'UNEXPECTED_ERROR');
}

// ---------------------------------------------------------------------
// 5. Rejeu — métriques de rejeu correctes sur un second batch appelant
//    la MÊME observation déjà traitée.
// ---------------------------------------------------------------------
{
  const id = uid('replay-1');
  const { db } = makeBatchFakeDb([makeObservation(id)]);

  const report1 = await runEventShadowBatch(db, [id]);
  t('premier batch : clustersCreated=1, eventVersionsCreated=1, fullyReplayed=0', report1.clustersCreated === 1 && report1.eventVersionsCreated === 1 && report1.fullyReplayed === 0);

  const report2 = await runEventShadowBatch(db, [id]);
  t('second batch (même id) : membershipReplayed=1', report2.membershipReplayed === 1);
  t('second batch : eventVersionReplayed=1', report2.eventVersionReplayed === 1);
  t('second batch : fullyReplayed=1 (membership ET event version rejoués)', report2.fullyReplayed === 1);
  t('second batch : eventVersionsCreated=0 (exclut les rejouées)', report2.eventVersionsCreated === 0);
  t('second batch : clustersCreated=0 (aucun nouveau cluster)', report2.clustersCreated === 0);
}

// ---------------------------------------------------------------------
// 6. Récupération — assignation committée côté "serveur" + réponse
//    HTTP perdue lors d'un premier batch => FAILED ; un batch ULTÉRIEUR
//    avec le même id récupère via PR5 (rejeu), sans NOUVELLE logique
//    d'idempotence côté batch.
// ---------------------------------------------------------------------
{
  const id = uid('recovery-1');
  const obs = makeObservation(id);
  let attempt = 0;
  let committed = null;
  obs.assignBehavior = ({ body }) => {
    attempt += 1;
    if (attempt === 1) {
      committed = { cluster_id: obs.clusterId, decision_id: obs.decisionId };
      throw new Error('simulated network/HTTP-response-loss error after server-side commit');
    }
    return [{ cluster_id: committed.cluster_id, decision_id: committed.decision_id, cluster_created_now: false, replayed: true }];
  };
  const { db, calls } = makeBatchFakeDb([obs]);

  const report1 = await runEventShadowBatch(db, [id]);
  t('premier batch : l\'observation est FAILED (réponse d\'assignation perdue)', report1.items[0].kind === 'FAILED');
  t('premier batch : status failed (seul item, en échec)', report1.status === 'failed');

  const report2 = await runEventShadowBatch(db, [id]);
  t('batch ultérieur (même id) : récupère via PR5 => PROCESSED', report2.items[0].kind === 'PROCESSED');
  t('batch ultérieur : réutilise le cluster/decision déjà committés', report2.items[0].clusterId === obs.clusterId && report2.items[0].decisionId === obs.decisionId);

  const assignCalls = calls.filter((c) => c.path === 'rpc/fn_event_assign_observation');
  t('aucune nouvelle logique d\'idempotence côté batch : même empreinte d\'assignation PR5 sur les deux tentatives',
    assignCalls.length === 2 && assignCalls[0].body.p_idempotency_fingerprint === assignCalls[1].body.p_idempotency_fingerprint);
}

// ---------------------------------------------------------------------
// 7. Libération du verrou — toujours tentée, compteurs exacts,
//    providers.event_shadow exact, erreurs FAILED incluses, échec de
//    libération => EVENT_SHADOW_LOCK_RELEASE_FAILED, aucun rapport
//    "réussi" retourné dans ce cas.
// ---------------------------------------------------------------------
{
  const idOk = uid('release-mixed-ok');
  const idFail = uid('release-mixed-fail');
  const { db, calls, getReleaseCallCount } = makeBatchFakeDb([
    makeObservation(idOk),
    makeObservation(idFail, { assignBehavior: () => [{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }] }),
  ]);
  const report = await runEventShadowBatch(db, [idOk, idFail]);

  t('libération tentée exactement une fois après acquisition, même avec des échecs mixtes', getReleaseCallCount() === 1);
  const releaseCall = calls.find((c) => c.method === 'PATCH' && c.path.startsWith('ingestion_runs?id=eq.'));
  t('libération : status = partial (correspond au rapport)', releaseCall.body.status === 'partial' && report.status === 'partial');
  t('libération : compteurs exacts (fetched/rejected/persisted/duplicates)',
    releaseCall.body.fetched_count === 2
    && releaseCall.body.rejected_count === 0
    && releaseCall.body.persisted_count === report.eventVersionsCreated
    && releaseCall.body.duplicate_count === report.fullyReplayed);
  t('libération : providers.event_shadow exact',
    releaseCall.body.providers.event_shadow.batch_version === OPS023_EVENT_SHADOW_BATCH_VERSION
    && releaseCall.body.providers.event_shadow.requested === 2
    && releaseCall.body.providers.event_shadow.processed === 1
    && releaseCall.body.providers.event_shadow.failed === 1
    && releaseCall.body.providers.event_shadow.clusters_created === report.clustersCreated
    && releaseCall.body.providers.event_shadow.membership_replayed === report.membershipReplayed
    && releaseCall.body.providers.event_shadow.event_version_replayed === report.eventVersionReplayed
    && releaseCall.body.providers.event_shadow.fully_replayed === report.fullyReplayed
    && releaseCall.body.providers.event_shadow.event_versions_created === report.eventVersionsCreated);
  t('libération : errors contient une entrée pour l\'item FAILED', Array.isArray(releaseCall.body.errors) && releaseCall.body.errors.length === 1 && releaseCall.body.errors[0].includes(idFail));
}
{
  // Libération après un succès complet (aucun item en échec).
  const id = uid('release-success-1');
  const { calls, db, getReleaseCallCount } = makeBatchFakeDb([makeObservation(id)]);
  const report = await runEventShadowBatch(db, [id]);
  t('libération après succès complet : tentée exactement une fois', getReleaseCallCount() === 1);
  const releaseCall = calls.find((c) => c.method === 'PATCH' && c.path.startsWith('ingestion_runs?id=eq.'));
  t('libération après succès complet : status = success', releaseCall.body.status === 'success' && report.status === 'success');
}
{
  // Libération après échec TOTAL (tous les items en échec).
  const idFail1 = uid('release-all-failed-1');
  const idFail2 = uid('release-all-failed-2');
  const malformed = () => [{ cluster_id: 'bad', decision_id: 'bad', cluster_created_now: true, replayed: false }];
  const { calls, db, getReleaseCallCount } = makeBatchFakeDb([
    makeObservation(idFail1, { assignBehavior: malformed }),
    makeObservation(idFail2, { assignBehavior: malformed }),
  ]);
  const report = await runEventShadowBatch(db, [idFail1, idFail2]);
  t('libération après échec total : tentée exactement une fois', getReleaseCallCount() === 1);
  const releaseCall = calls.find((c) => c.method === 'PATCH' && c.path.startsWith('ingestion_runs?id=eq.'));
  t('libération après échec total : status = failed', releaseCall.body.status === 'failed' && report.status === 'failed');
}
{
  const id = uid('release-failure-1');
  const { db, getReleaseCallCount } = makeBatchFakeDb([makeObservation(id)], { forceReleaseFailure: true });
  const err = await expectThrow(() => runEventShadowBatch(db, [id]), 'échec de libération du verrou surface une erreur (pas de rapport "réussi" retourné)');
  t('erreur de libération : EventShadowBatchInvariantError EVENT_SHADOW_LOCK_RELEASE_FAILED', err instanceof EventShadowBatchInvariantError && err.code === 'EVENT_SHADOW_LOCK_RELEASE_FAILED');
  t('la libération a bien été tentée (pas juste ignorée) avant l\'échec', getReleaseCallCount() === 1);
}

// ---------------------------------------------------------------------
// 7b. Garde structurelle : la libération DOIT être couverte par un vrai
//     bloc try/finally après l'acquisition du verrou — pas seulement un
//     appel explicite placé après la construction du rapport. Ce test
//     échouerait si la libération était déplacée hors de la garantie
//     finally (retour à l'implémentation précédente PR6).
// ---------------------------------------------------------------------
{
  const liveBatchSourceForFinallyCheck = batchSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  t('releaseLock( apparaît exactement une fois dans le source (un seul point d\'appel)',
    (liveBatchSourceForFinallyCheck.match(/releaseLock\(/g) ?? []).length === 1);
  t('l\'unique appel releaseLock( est structurellement situé à l\'intérieur d\'un bloc finally { ... } (garantie réelle, pas une ligne libre après le rapport)',
    /finally\s*\{[\s\S]*?releaseLock\(/.test(liveBatchSourceForFinallyCheck));
}

// ---------------------------------------------------------------------
// 8. Isolation legacy/shadow — aucune référence, aucun appel RPC Event
//    direct dans shadow_batch.ts (tout reste dans PR5), aucune sélection
//    automatique de backlog.
// ---------------------------------------------------------------------
const liveBatchSource = batchSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

const FORBIDDEN_LEGACY_TOKENS = ['news_events', 'notifications', 'ai_committee', 'committee', 'ScoredEvent', 'scoreArticle', 'dispatchActions', 'frontend'];
for (const token of FORBIDDEN_LEGACY_TOKENS) {
  t(`aucune référence exécutable à "${token}"`, !new RegExp(token, 'i').test(liveBatchSource));
}
t('aucune référence à backend/ingest', !/backend\/ingest/.test(liveBatchSource));
t('aucun import Supabase', !/@supabase/.test(liveBatchSource));
t('aucune lecture de variable d\'environnement (process.env)', !/process\.env/.test(liveBatchSource));
t('aucune référence à worker.ts/wrangler (aucun import de ces modules)', !/worker\.ts|wrangler/.test(liveBatchSource));
t('shadow_batch.ts n\'appelle JAMAIS directement rpc/fn_event_assign_observation (délégué à PR5)', !liveBatchSource.includes('rpc/fn_event_assign_observation'));
t('shadow_batch.ts n\'appelle JAMAIS directement rpc/fn_event_create_event_version (délégué à PR5)', !liveBatchSource.includes('rpc/fn_event_create_event_version'));
t('shadow_batch.ts ne référence jamais news_articles (aucune sélection RAW automatique)', !liveBatchSource.includes('news_articles'));
t('shadow_batch.ts ne référence jamais un cursor/checkpoint de découverte automatique', !/cursor|checkpoint|backlog/i.test(liveBatchSource));
t('shadow_batch.ts n\'appelle jamais planEventProcessing directement (aucune réimplémentation PR4, tout passe par processEventShadowObservation)', !/planEventProcessing\s*\(/.test(liveBatchSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
