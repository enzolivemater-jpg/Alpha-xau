// XAU-V2-OPS-010 — remplace test_committee_http_observability.mjs (OPS-004),
// obsolète : le transport HTTP self-fetch qu'il observait a été retiré
// (fetch(AI_ENGINE_URL) -> même Worker /committee produisait un 404
// plateforme avant même le routage applicatif, cf. audit XAU-V2-OPS-007).
// La renommer via `git mv` conserve l'historique ; son contenu est
// entièrement réécrit pour prouver le nouveau transport in-process.
//
// Ce qui est RÉELLEMENT exercé (extrait verbatim de backend/ingest.ts et
// backend/ai_engine/committee_orchestrator.ts, exécuté via le "type
// stripping" natif de Node >= 22.6, même philosophie que
// test_committee_http_observability.mjs / test_committee_event_retry_idempotency.mjs) :
//   - postNotification() / notifyAiEngine() / buildNotification() (ingest.ts)
//   - isAuthorized() / handleRequest() (committee_orchestrator.ts), pour la
//     surface HTTP externe inchangée
//
// Ce qui reste MOCKÉ (hors périmètre OPS-010, déjà couvert ailleurs) :
//   - handleCommitteeEvent() réel : contrôlé par test (le contrat
//     PROCESSED/ALREADY_PROCESSED/ALREADY_RUNNING/FAILED/DATA_UNAVAILABLE/
//     INVALID_EVENT lui-même est prouvé par test_committee_event_retry_idempotency.mjs,
//     OPS-009) — ici on prouve seulement que postNotification()/notifyAiEngine()
//     réagissent CORRECTEMENT à chaque statut, pas le comité lui-même.
//   - runCommittee()/Anthropic (hors périmètre du transport)
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const ingestSource = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');
const committeeSource = readFileSync(new URL('../backend/ai_engine/committee_orchestrator.ts', import.meta.url), 'utf8');

function extractBlock(src, startRegex) {
  const m = startRegex.exec(src);
  if (!m) throw new Error(`extraction introuvable pour ${startRegex}`);
  const start = m.index;
  // Une liste de paramètres peut contenir un type objet littéral avec ses
  // propres accolades (ex. `events: ReadonlyArray<{ id: string }>`) : il
  // faut balancer les PARENTHÈSES d'abord pour ne pas confondre cette
  // accolade avec celle du corps de la fonction.
  const parenIdx = src.indexOf('(', start);
  const braceCandidateIdx = src.indexOf('{', start);
  let searchFrom = start;
  if (parenIdx !== -1 && parenIdx < braceCandidateIdx) {
    let pdepth = 0, j = parenIdx;
    for (; j < src.length; j++) {
      if (src[j] === '(') pdepth++;
      else if (src[j] === ')') { pdepth--; if (pdepth === 0) break; }
    }
    searchFrom = j + 1;
  }
  // Le type de retour lui-même peut contenir ses propres accolades/chevrons
  // (ex. `Promise<{ swept: number }>`) : une accolade ne marque le début du
  // corps que si elle apparaît hors de tout groupe <...>/(...)/[...] encore
  // ouvert depuis la fin de la liste de paramètres.
  let nest = 0, braceStart = -1;
  for (let k = searchFrom; k < src.length; k++) {
    const c = src[k];
    if (c === '<' || c === '(' || c === '[') nest++;
    else if (c === '>' || c === ')' || c === ']') nest = Math.max(0, nest - 1);
    else if (c === '{' && nest === 0) { braceStart = k; break; }
  }
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  let end = i + 1;
  while (src[end] === ';') end++;
  return src.slice(start, end);
}

console.log('--- CONTRAT STATIQUE (lecture de source) ---');
{
  t('ingest.ts ne lit plus jamais env.AI_ENGINE_URL', !/env\.AI_ENGINE_URL/.test(ingestSource));
  t('ingest.ts ne lit plus jamais env.AI_ENGINE_TOKEN', !/env\.AI_ENGINE_TOKEN/.test(ingestSource));
  t('l\'interface Env de ingest.ts ne déclare plus AI_ENGINE_URL/AI_ENGINE_TOKEN',
    !/readonly AI_ENGINE_URL/.test(ingestSource) && !/readonly AI_ENGINE_TOKEN/.test(ingestSource));
  t('ingest.ts importe handleCommitteeEvent depuis committee_orchestrator.js',
    /import\s*\{\s*handleCommitteeEvent,\s*type\s+CommitteeRuntimeEnv\s*\}\s*from\s*['"]\.\/ai_engine\/committee_orchestrator\.js['"]/.test(ingestSource));

  const committeeRuntimeEnvSrc = extractBlock(committeeSource, /export interface CommitteeRuntimeEnv\b/);
  t('CommitteeRuntimeEnv (cœur du comité) ne déclare jamais COMMITTEE_TOKEN',
    !/COMMITTEE_TOKEN/.test(committeeRuntimeEnvSrc));
  const httpEnvSrc = extractBlock(committeeSource, /export interface Env extends CommitteeRuntimeEnv\b/);
  t('Env (HTTP externe) étend CommitteeRuntimeEnv et ajoute COMMITTEE_TOKEN',
    /readonly COMMITTEE_TOKEN: string;/.test(httpEnvSrc));
}

const postNotificationSrc = extractBlock(ingestSource, /async function postNotification\(/);
const notifyAiEngineSrc = extractBlock(ingestSource, /async function notifyAiEngine\(/);
const buildNotificationSrc = extractBlock(ingestSource, /export function buildNotification\(/);
const createNotifyBudgetSrc = extractBlock(ingestSource, /export function createNotifyBudget\(\)/);
// XAU-V2-OPS-015 (P0-A/P0-B) : horizon + circuit fournisseur, seul point
// d'application dans notifyAiEngine().
const notificationHorizonMsSrc = extractBlock(ingestSource, /const NOTIFICATION_HORIZON_MS: /);
const isNotificationWithinHorizonSrc = extractBlock(ingestSource, /export function isNotificationWithinHorizon\(/);
const circuitCooldownMsSrc = extractBlock(ingestSource, /const CIRCUIT_COOLDOWN_MS: /);
const isProviderCircuitOpenSrc = extractBlock(ingestSource, /export function isProviderCircuitOpen\(/);
const secretKeyPatternMatch = /const SECRET_KEY_PATTERN = .*;/.exec(ingestSource);
if (!secretKeyPatternMatch) throw new Error('SECRET_KEY_PATTERN introuvable.');
const redactStringSrc = extractBlock(ingestSource, /function redactString\(value: string\)/);
const redactSrc = extractBlock(ingestSource, /function redact\(input: unknown, depth = 0\)/);
const errorMessageSrc = extractBlock(ingestSource, /function errorMessage\(err: unknown\)/);

console.log('--- postNotification() : aucun fetch() ne subsiste dans ce chemin ---');
{
  t('postNotification() ne contient aucun appel fetch(', !/\bfetch\(/.test(postNotificationSrc));
  t('postNotification() appelle handleCommitteeEvent(notification, committeeEnv)',
    /await handleCommitteeEvent\(notification, committeeEnv\)/.test(postNotificationSrc));
  t('postNotification() ne construit aucun objet Request/Headers HTTP',
    !/new Request\(|new Headers\(|method:\s*'POST'/.test(postNotificationSrc));
  t('committeeEnv ne transmet jamais COMMITTEE_TOKEN', !/COMMITTEE_TOKEN/.test(postNotificationSrc));
}

console.log('--- COMPTABILITE notify_attempts : jamais sur les événements différés ou non imputables ---');
{
  const dispatchActionsSrc = extractBlock(ingestSource, /async function dispatchActions\(/);
  const reconcileNotificationsSrc = extractBlock(ingestSource, /export async function reconcileNotifications\(/);
  for (const [name, src] of [['dispatchActions', dispatchActionsSrc], ['reconcileNotifications', reconcileNotificationsSrc]]) {
    // XAU-V2-OPS-015 : failedAttempts = attempted - delivered a été retiré,
    // trop grossier pour distinguer un échec événement-spécifique d'une
    // panne fournisseur globale. notifyAiEngine() calcule désormais
    // directement chargeableFailed ; les appelants ne recalculent plus rien.
    t(`${name}() ne recalcule plus failedAttempts = attempted - delivered`,
      !/failedAttempts = attempted\.filter/.test(src));
    t(`${name}() appelle bumpNotifyAttempts(chargeableFailed) — jamais avec deferred`,
      /bumpNotifyAttempts\(chargeableFailed\)/.test(src) && !/bumpNotifyAttempts\(deferred\)/.test(src));
    t(`${name}() appelle markNotified(delivered) — jamais avec attempted ou deferred`,
      /markNotified\(delivered\)/.test(src) && !/markNotified\(attempted\)/.test(src) && !/markNotified\(deferred\)/.test(src));
  }
  t('reconcileNotifications() et runIngestion() acceptent un NotifyBudget partagé (défaut : un budget frais)',
    /reconcileNotifications\(\s*env: Env,\s*budget: NotifyBudget = createNotifyBudget\(\),/.test(ingestSource)
    && /export async function runIngestion\(\s*env: Env,\s*triggerType: string,\s*budget: NotifyBudget = createNotifyBudget\(\),/.test(ingestSource));
  t('worker.ts crée UN budget partagé pour tout le cycle news_engine (dispatch direct + réconciliation)',
    (() => {
      const workerSource = readFileSync(new URL('../backend/worker.ts', import.meta.url), 'utf8');
      return /const budget = createNotifyBudget\(\);\s*\n\s*await runNewsIngestion\(env, 'cron', budget\);\s*\n\s*await reconcileNotifications\(env, budget\);/.test(workerSource);
    })());
}

console.log('--- REGLE UNIQUE : horizon et circuit appliqués UNIQUEMENT dans notifyAiEngine() ---');
{
  const dispatchActionsSrc = extractBlock(ingestSource, /async function dispatchActions\(/);
  const reconcileNotificationsSrc = extractBlock(ingestSource, /export async function reconcileNotifications\(/);
  for (const [name, src] of [['dispatchActions', dispatchActionsSrc], ['reconcileNotifications', reconcileNotificationsSrc]]) {
    t(`${name}() ne réimplémente pas la règle d'horizon elle-même`,
      !/NOTIFICATION_HORIZON_MS/.test(src) && !/isNotificationWithinHorizon/.test(src.replace(/notifyAiEngine\([^)]*\)/, '')));
    t(`${name}() ne réimplémente pas le circuit fournisseur lui-même`,
      !/CIRCUIT_COOLDOWN_MS/.test(src) && !/isProviderCircuitOpen/.test(src));
  }
  const notifyAiEngineSig = extractBlock(ingestSource, /async function notifyAiEngine\(/);
  t('isNotificationWithinHorizon() est bien appelée depuis notifyAiEngine()',
    /isNotificationWithinHorizon\(/.test(notifyAiEngineSig));
  t('isProviderCircuitOpen() est bien appelée depuis notifyAiEngine()',
    /isProviderCircuitOpen\(/.test(notifyAiEngineSig));
}

console.log('--- EXECUTION REELLE (fonctions extraites verbatim, handleCommitteeEvent mocké) ---');
const dir = mkdtempSync(join(tmpdir(), 'xau-ops010-'));
const harnessPath = join(dir, 'harness.ts');

const harness = `
const CONFIG = { ENGINE_VERSION: 'news-engine-test' };

${secretKeyPatternMatch[0]}
${redactStringSrc}
${redactSrc}
${errorMessageSrc}
${buildNotificationSrc}
${createNotifyBudgetSrc}
${notificationHorizonMsSrc}
${isNotificationWithinHorizonSrc}
${circuitCooldownMsSrc}
${isProviderCircuitOpenSrc}

const calls = [];
function makeLog() {
  return {
    warn(m, c) { calls.push({ level: 'warn', message: m, context: c }); },
    info(m, c) { calls.push({ level: 'info', message: m, context: c }); },
    debug() {}, error(m, c) { calls.push({ level: 'error', message: m, context: c }); },
  };
}

let __handleCommitteeEventImpl = async () => { throw new Error('non configuré pour ce test'); };
let __handleCommitteeEventCallCount = 0;
let __lastCommitteeEnvSeen = null;
async function handleCommitteeEvent(notification, committeeEnv) {
  __handleCommitteeEventCallCount++;
  __lastCommitteeEnvSeen = committeeEnv;
  return __handleCommitteeEventImpl(notification, committeeEnv);
}

// Circuit fournisseur (XAU-V2-OPS-015, P0-B) : source unique de vérité
// durable pour notifyAiEngine(), simulée ici via une ligne ingestion_runs
// contrôlable par test. null = aucun run connu -> circuit fermé.
let __latestCommitteeRun = null;
let __getLatestCommitteeRunCallCount = 0;
const fakeDb = {
  async getLatestCommitteeRun() {
    __getLatestCommitteeRunCallCount++;
    return __latestCommitteeRun;
  },
};

${postNotificationSrc}
${notifyAiEngineSrc}

const FAKE_ANTHROPIC_KEY = 'unit-test-fake-anthropic-key-not-a-secret';
const baseEnv = {
  SUPABASE_URL: 'https://fake.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake-role-key',
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, LOG_LEVEL: 'debug',
};

const results = {};

// 1. Pas de clé Anthropic -> notification IGNOREE proprement, jamais d'appel.
{
  __handleCommitteeEventCallCount = 0;
  calls.length = 0;
  const log = makeLog();
  const ok = await postNotification(buildNotification('news-1', 'RECALC_H1_H2', 90), { ...baseEnv, ANTHROPIC_API_KEY: undefined }, log);
  results.no_anthropic_key = { ok, calls: JSON.parse(JSON.stringify(calls)), callCount: __handleCommitteeEventCallCount };
}

// 2-7. Chaque statut EventResult -> livré ou non.
for (const status of ['PROCESSED', 'ALREADY_PROCESSED', 'ALREADY_RUNNING', 'FAILED', 'DATA_UNAVAILABLE', 'INVALID_EVENT']) {
  calls.length = 0;
  __handleCommitteeEventImpl = async () => ({ status, event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: status === 'PROCESSED' ? 'a-1' : null, errors: [] });
  const log = makeLog();
  const ok = await postNotification(buildNotification('news-2', 'RECALC_H1_H2', 90), baseEnv, log);
  results['status_' + status] = { ok, calls: JSON.parse(JSON.stringify(calls)) };
}

// 7bis. FAILED + providerFailure -> DeliveryOutcome distingue ACCOUNT_BLOCKED
//       de TEMPORARILY_UNAVAILABLE (XAU-V2-OPS-015, P0-B), jamais confondus
//       avec un EVENT_FAILED événement-spécifique ordinaire.
for (const kind of ['ACCOUNT_BLOCKED', 'TEMPORARILY_UNAVAILABLE']) {
  calls.length = 0;
  __handleCommitteeEventImpl = async () => ({ status: 'FAILED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: null, errors: ['simulé'], providerFailure: kind });
  const log = makeLog();
  const ok = await postNotification(buildNotification('news-provider', 'RECALC_H1_H2', 90), baseEnv, log);
  results['provider_failure_' + kind] = { ok };
}

// 8. Exception levée par le comité -> non livré, pas de fuite de détail brut.
{
  calls.length = 0;
  __handleCommitteeEventImpl = async () => { throw new Error('Anthropic HTTP 500 (simulé) Bearer sk-ant-should-not-leak'); };
  const log = makeLog();
  const ok = await postNotification(buildNotification('news-3', 'RECALC_H1_H2', 90), baseEnv, log);
  results.thrown = { ok, calls: JSON.parse(JSON.stringify(calls)) };
}

// 9. event_id stable : même newsId+action -> même event_id, sur deux appels.
{
  const a = buildNotification('news-stable', 'RECALC_H1_H2', 77);
  const b = buildNotification('news-stable', 'RECALC_H1_H2', 99);
  results.stable_event_id = { a: a.event_id, b: b.event_id };
}

// 10. notifyAiEngine : au plus UN appel comité, plus fort score en premier,
//     le reste différé (jamais échoué), succès -> délivré.
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async (notification) => ({ status: 'PROCESSED', event_id: notification.event_id, event_type: notification.event_type, scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a-only', errors: [] });
  const log = makeLog();
  const now = new Date().toISOString();
  const events = [
    { id: 'low', action: 'REEVALUATE_H3', score: 65, ts: now },
    { id: 'high', action: 'RECALC_H1_H2', score: 95, ts: now },
    { id: 'mid', action: 'RECALC_H1_H2', score: 80, ts: now },
  ];
  const outcome = await notifyAiEngine(events, baseEnv, log, createNotifyBudget(), fakeDb);
  results.cost_guard = { outcome, callCount: __handleCommitteeEventCallCount };
}

// 11. notifyAiEngine : tentative unique en échec -> attempted mais pas delivered ;
//     le reste toujours différé (jamais confondu avec un échec).
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async () => ({ status: 'FAILED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: null, errors: ['simulé'] });
  const log = makeLog();
  const now = new Date().toISOString();
  const events = [
    { id: 'best', action: 'RECALC_H1_H2', score: 90, ts: now },
    { id: 'second', action: 'RECALC_H1_H2', score: 85, ts: now },
  ];
  const outcome = await notifyAiEngine(events, baseEnv, log, createNotifyBudget(), fakeDb);
  results.cost_guard_failed = { outcome, callCount: __handleCommitteeEventCallCount };
}

// 13. BUDGET PARTAGE SUR TOUT LE CYCLE : dispatch direct (1er appel) +
//     réconciliation (2e appel) partageant LE MÊME budget -> un seul
//     appel handleCommitteeEvent au total pour les DEUX appels combinés.
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async () => ({ status: 'PROCESSED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a-direct', errors: [] });
  const log = makeLog();
  const now = new Date().toISOString();
  const sharedBudget = createNotifyBudget();
  const directEvents = [{ id: 'direct-1', action: 'RECALC_H1_H2', score: 95, ts: now }];
  const reconcileEvents = [{ id: 'reconcile-1', action: 'RECALC_H1_H2', score: 90, ts: now }, { id: 'reconcile-2', action: 'REEVALUATE_H3', score: 70, ts: now }];
  const directOutcome = await notifyAiEngine(directEvents, baseEnv, log, sharedBudget, fakeDb);
  const reconcileOutcome = await notifyAiEngine(reconcileEvents, baseEnv, log, sharedBudget, fakeDb);
  results.shared_budget_direct_wins = {
    directOutcome, reconcileOutcome, totalCommitteeCalls: __handleCommitteeEventCallCount,
  };
}

// 14. Budget partagé, chemin direct SANS événement éligible (liste vide) :
//     ne consomme PAS le slot -> la réconciliation peut ensuite l'utiliser.
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async () => ({ status: 'PROCESSED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a-reconcile', errors: [] });
  const log = makeLog();
  const now = new Date().toISOString();
  const sharedBudget = createNotifyBudget();
  const directOutcome = await notifyAiEngine([], baseEnv, log, sharedBudget, fakeDb);
  const reconcileOutcome = await notifyAiEngine([{ id: 'reconcile-only', action: 'RECALC_H1_H2', score: 88, ts: now }], baseEnv, log, sharedBudget, fakeDb);
  results.shared_budget_direct_empty = {
    directOutcome, reconcileOutcome, totalCommitteeCalls: __handleCommitteeEventCallCount,
  };
}

// 15. Budget partagé, la tentative directe UNIQUE échoue : la réconciliation
//     ne doit PAS retenter un second comité dans le même cycle -- son
//     événement doit être différé, jamais tenté une seconde fois.
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async () => ({ status: 'FAILED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: null, errors: ['simulé'] });
  const log = makeLog();
  const now = new Date().toISOString();
  const sharedBudget = createNotifyBudget();
  const directOutcome = await notifyAiEngine([{ id: 'direct-fails', action: 'RECALC_H1_H2', score: 95, ts: now }], baseEnv, log, sharedBudget, fakeDb);
  const reconcileOutcome = await notifyAiEngine([{ id: 'reconcile-blocked', action: 'RECALC_H1_H2', score: 90, ts: now }], baseEnv, log, sharedBudget, fakeDb);
  results.shared_budget_direct_fails = {
    directOutcome, reconcileOutcome, totalCommitteeCalls: __handleCommitteeEventCallCount,
  };
}

// 16a. HORIZON — HELPER PUR isNotificationWithinHorizon(), BORNES EXACTES,
//      100% DÉTERMINISTE (XAU-V2-OPS-015 PR review, BLOCKER 2) : le MÊME
//      nowMs fixe et arbitraire (jamais Date.now()) sert à calculer le ts
//      ET à appeler la fonction -- aucune fenêtre d'horloge entre les deux,
//      contrairement à un test qui passerait par notifyAiEngine() (lequel
//      rappelle Date.now() en interne : une borne "exactement 4h" calculée
//      via Date.now() côté test peut alors basculer de quelques millisecondes
//      avant l'évaluation interne et rendre le test intermittent).
{
  const fixedNowMs = 1_800_000_000_000; // horodatage arbitraire fixe.
  const HOUR = 3600 * 1000;
  const isoAt = (ageMs) => new Date(fixedNowMs - ageMs).toISOString();
  results.horizon_pure_boundaries = {
    h12_exact_4h: isNotificationWithinHorizon('RECALC_H1_H2', isoAt(4 * HOUR), fixedNowMs),
    h12_over_4h_by_1ms: isNotificationWithinHorizon('RECALC_H1_H2', isoAt(4 * HOUR + 1), fixedNowMs),
    h3_exact_24h: isNotificationWithinHorizon('REEVALUATE_H3', isoAt(24 * HOUR), fixedNowMs),
    h3_over_24h_by_1ms: isNotificationWithinHorizon('REEVALUATE_H3', isoAt(24 * HOUR + 1), fixedNowMs),
  };
}

// 16b. HORIZON — INTÉGRATION notifyAiEngine() (XAU-V2-OPS-015, P0-A) :
//      événements éligibles/expirés jamais tentés/différés/comptés à tort,
//      jamais capables d'évincer un candidat plus frais. notifyAiEngine()
//      relit Date.now() en interne (P0-A défense en profondeur, cf.
//      isNotificationWithinHorizon appelée SANS nowMs explicite) : les bornes
//      testées ici utilisent donc une MARGE de sécurité de 1s de part et
//      d'autre de l'horizon (jamais la valeur exacte, réservée au test pur
//      16a ci-dessus) pour rester déterministes quelle que soit la charge de
//      la machine.
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async (notification) => ({ status: 'PROCESSED', event_id: notification.event_id, event_type: notification.event_type, scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a-horizon', errors: [] });
  const log = makeLog();
  const nowMs = Date.now();
  const iso = (ms) => new Date(nowMs - ms).toISOString();
  const HOUR = 3600 * 1000;
  const MARGIN = 1000; // 1s -- absorbe l'écart entre le nowMs de ce test et celui relu par notifyAiEngine().

  // H1/H2 : 4h - 1s (marge de sécurité côté éligible) -> éligible, délivré.
  {
    const outcome = await notifyAiEngine(
      [{ id: 'h12-eligible-margin', action: 'RECALC_H1_H2', score: 50, ts: iso(4 * HOUR - MARGIN) }],
      baseEnv, log, createNotifyBudget(), fakeDb,
    );
    results.horizon_h12_eligible_margin = outcome;
  }
  // H1/H2 : 4h + 1s (marge de sécurité côté expiré) -> expirée, jamais tentée/différée.
  {
    const outcome = await notifyAiEngine(
      [{ id: 'h12-expired-margin', action: 'RECALC_H1_H2', score: 50, ts: iso(4 * HOUR + MARGIN) }],
      baseEnv, log, createNotifyBudget(), fakeDb,
    );
    results.horizon_h12_expired_margin = outcome;
  }
  // H3 : 24h - 1s -> éligible.
  {
    const outcome = await notifyAiEngine(
      [{ id: 'h3-eligible-margin', action: 'REEVALUATE_H3', score: 50, ts: iso(24 * HOUR - MARGIN) }],
      baseEnv, log, createNotifyBudget(), fakeDb,
    );
    results.horizon_h3_eligible_margin = outcome;
  }
  // H3 : 24h + 1s -> expirée.
  {
    const outcome = await notifyAiEngine(
      [{ id: 'h3-expired-margin', action: 'REEVALUATE_H3', score: 50, ts: iso(24 * HOUR + MARGIN) }],
      baseEnv, log, createNotifyBudget(), fakeDb,
    );
    results.horizon_h3_expired_margin = outcome;
  }
  // Un événement expiré ne peut PAS évincer un candidat frais, même avec un
  // score bien plus élevé : il est retiré AVANT le tri par score.
  {
    __handleCommitteeEventCallCount = 0;
    const outcome = await notifyAiEngine(
      [
        { id: 'stale-high-score', action: 'RECALC_H1_H2', score: 99, ts: iso(4 * HOUR + MARGIN) },
        { id: 'fresh-low-score', action: 'RECALC_H1_H2', score: 10, ts: iso(HOUR) },
      ],
      baseEnv, log, createNotifyBudget(), fakeDb,
    );
    results.horizon_stale_cannot_evict_fresh = { outcome, callCount: __handleCommitteeEventCallCount };
  }
  // Un lot ENTIÈREMENT expiré ne consomme jamais le budget de cycle : l'autre
  // chemin du même cycle (direct ou réconciliation) doit pouvoir l'utiliser.
  {
    __handleCommitteeEventCallCount = 0;
    const sharedBudget = createNotifyBudget();
    const allExpiredOutcome = await notifyAiEngine(
      [{ id: 'all-expired', action: 'REEVALUATE_H3', score: 90, ts: iso(24 * HOUR + MARGIN) }],
      baseEnv, log, sharedBudget, fakeDb,
    );
    const otherPathOutcome = await notifyAiEngine(
      [{ id: 'other-path-fresh', action: 'RECALC_H1_H2', score: 60, ts: iso(HOUR) }],
      baseEnv, log, sharedBudget, fakeDb,
    );
    results.horizon_expired_never_consumes_budget = {
      allExpiredOutcome, otherPathOutcome, callCount: __handleCommitteeEventCallCount,
    };
  }
}

// 17. CIRCUIT FOURNISSEUR (XAU-V2-OPS-015, P0-B) : dérivé de la ligne
//     ingestion_runs(engine='ai_committee') la plus récente, jamais d'état
//     mémoire. Vérifié uniquement quand une tentative réelle serait sinon
//     lancée (budget disponible, candidat éligible).
{
  const log = makeLog();
  const nowMs = Date.now();
  const iso = (ms) => new Date(nowMs - ms).toISOString();
  const MIN = 60 * 1000;
  __handleCommitteeEventImpl = async (notification) => ({ status: 'PROCESSED', event_id: notification.event_id, event_type: notification.event_type, scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a-circuit', errors: [] });
  const oneEvent = () => [{ id: 'circuit-probe', action: 'RECALC_H1_H2', score: 77, ts: new Date().toISOString() }];

  // ACCOUNT_BLOCKED, 74 min (< 75 min) -> circuit OUVERT, tout différé.
  {
    __handleCommitteeEventCallCount = 0;
    __latestCommitteeRun = { started_at: iso(74 * MIN), status: 'failed', providers: { anthropic: { failure_kind: 'ACCOUNT_BLOCKED' } } };
    const outcome = await notifyAiEngine(oneEvent(), baseEnv, log, createNotifyBudget(), fakeDb);
    results.circuit_account_blocked_recent = { outcome, callCount: __handleCommitteeEventCallCount };
  }
  // ACCOUNT_BLOCKED, exactement 75 min -> recharge : une tentative normale autorisée.
  {
    __handleCommitteeEventCallCount = 0;
    __latestCommitteeRun = { started_at: iso(75 * MIN), status: 'failed', providers: { anthropic: { failure_kind: 'ACCOUNT_BLOCKED' } } };
    const outcome = await notifyAiEngine(oneEvent(), baseEnv, log, createNotifyBudget(), fakeDb);
    results.circuit_account_blocked_expired = { outcome, callCount: __handleCommitteeEventCallCount };
  }
  // TEMPORARILY_UNAVAILABLE, 19 min (< 20 min) -> circuit OUVERT, tout différé.
  {
    __handleCommitteeEventCallCount = 0;
    __latestCommitteeRun = { started_at: iso(19 * MIN), status: 'failed', providers: { anthropic: { failure_kind: 'TEMPORARILY_UNAVAILABLE' } } };
    const outcome = await notifyAiEngine(oneEvent(), baseEnv, log, createNotifyBudget(), fakeDb);
    results.circuit_temp_unavailable_recent = { outcome, callCount: __handleCommitteeEventCallCount };
  }
  // TEMPORARILY_UNAVAILABLE, exactement 20 min -> recharge : probe autorisé.
  {
    __handleCommitteeEventCallCount = 0;
    __latestCommitteeRun = { started_at: iso(20 * MIN), status: 'failed', providers: { anthropic: { failure_kind: 'TEMPORARILY_UNAVAILABLE' } } };
    const outcome = await notifyAiEngine(oneEvent(), baseEnv, log, createNotifyBudget(), fakeDb);
    results.circuit_temp_unavailable_expired = { outcome, callCount: __handleCommitteeEventCallCount };
  }
  // Dernière ligne ai_committee RÉUSSIE (providers:{}) -> circuit FERMÉ,
  // même très récente.
  {
    __handleCommitteeEventCallCount = 0;
    __latestCommitteeRun = { started_at: iso(1 * MIN), status: 'success', providers: {} };
    const outcome = await notifyAiEngine(oneEvent(), baseEnv, log, createNotifyBudget(), fakeDb);
    results.circuit_closed_after_success = { outcome, callCount: __handleCommitteeEventCallCount };
  }
  // Circuit OUVERT : le budget de cycle n'est JAMAIS consommé par le
  // déferrement -- l'autre chemin du même cycle peut encore l'utiliser.
  {
    __handleCommitteeEventCallCount = 0;
    __latestCommitteeRun = { started_at: iso(1 * MIN), status: 'failed', providers: { anthropic: { failure_kind: 'ACCOUNT_BLOCKED' } } };
    const sharedBudget = createNotifyBudget();
    const blockedOutcome = await notifyAiEngine(oneEvent(), baseEnv, log, sharedBudget, fakeDb);
    __latestCommitteeRun = null; // l'autre chemin relit la même vérité durable.
    const otherPathOutcome = await notifyAiEngine(
      [{ id: 'other-path-after-circuit', action: 'RECALC_H1_H2', score: 60, ts: new Date().toISOString() }],
      baseEnv, log, sharedBudget, fakeDb,
    );
    results.circuit_deferral_does_not_consume_budget = {
      blockedOutcome, otherPathOutcome, callCount: __handleCommitteeEventCallCount,
    };
  }
  __latestCommitteeRun = null;
}

// 18. TRANSPORT/RESEAU (XAU-V2-OPS-015 PR review, BLOCKER 1) : au niveau
//     notifyAiEngine(), une panne fournisseur de transport (abort local ou
//     échec réseau côté callClaude, classée TEMPORARILY_UNAVAILABLE comme
//     n'importe quel 429/5xx -- la distinction transport/HTTP n'existe plus
//     une fois EventResult.providerFailure peuplé) est tentée UNE fois
//     (consomme le budget de cycle), mais reste NON chargeable : jamais dans
//     chargeableFailed, donc jamais de bump de notify_attempts côté appelant
//     (dispatchActions/reconcileNotifications).
{
  __handleCommitteeEventCallCount = 0;
  __latestCommitteeRun = null;
  __handleCommitteeEventImpl = async () => ({ status: 'FAILED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: null, errors: ['échec réseau (simulé)'], providerFailure: 'TEMPORARILY_UNAVAILABLE' });
  const log = makeLog();
  const outcome = await notifyAiEngine(
    [{ id: 'transport-failure', action: 'RECALC_H1_H2', score: 80, ts: new Date().toISOString() }],
    baseEnv, log, createNotifyBudget(), fakeDb,
  );
  results.notify_transport_failure = { outcome, callCount: __handleCommitteeEventCallCount };
}

// 12. committeeEnv ne porte jamais COMMITTEE_TOKEN, même si présent sur env.
{
  __handleCommitteeEventImpl = async () => ({ status: 'PROCESSED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a', errors: [] });
  __lastCommitteeEnvSeen = null;
  const log = makeLog();
  await postNotification(buildNotification('news-4', 'RECALC_H1_H2', 90), { ...baseEnv, COMMITTEE_TOKEN: 'should-never-be-forwarded' }, log);
  results.env_split = { sawCommitteeToken: Object.prototype.hasOwnProperty.call(__lastCommitteeEnvSeen ?? {}, 'COMMITTEE_TOKEN') };
}

process.stdout.write(JSON.stringify({ results, FAKE_ANTHROPIC_KEY }));
`;

writeFileSync(harnessPath, harness, 'utf8');

let output;
try {
  const raw = execFileSync(process.execPath, [harnessPath], { encoding: 'utf8' });
  output = JSON.parse(raw);
} catch (err) {
  t('exécution du harnais isolé (fonctions réelles extraites de ingest.ts)', false, String(err));
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { results, FAKE_ANTHROPIC_KEY } = output;

console.log('--- CONFIGURATION MANQUANTE : DEGRADATION PROPRE ---');
t('ANTHROPIC_API_KEY absente -> non délivré', results.no_anthropic_key.ok.kind !== 'DELIVERED');
t('ANTHROPIC_API_KEY absente -> handleCommitteeEvent jamais appelé', results.no_anthropic_key.callCount === 0);
t('ANTHROPIC_API_KEY absente -> avertissement journalisé', results.no_anthropic_key.calls.some((c) => c.level === 'warn'));

console.log('--- MAPPING STATUT -> ACQUITTEMENT (jamais un proxy HTTP) ---');
const expectDelivered = { PROCESSED: true, ALREADY_PROCESSED: true, ALREADY_RUNNING: false, FAILED: false, DATA_UNAVAILABLE: false, INVALID_EVENT: false };
for (const [status, expected] of Object.entries(expectDelivered)) {
  const r = results['status_' + status];
  const delivered = r.ok.kind === 'DELIVERED';
  t(`${status} -> ${expected ? 'délivré' : 'NON délivré'}`, delivered === expected, `got kind=${r.ok.kind}`);
}
t('ALREADY_RUNNING -> DeliveryOutcome.kind = IN_PROGRESS (non-chargeable)', results.status_ALREADY_RUNNING.ok.kind === 'IN_PROGRESS');
t('FAILED événement-spécifique -> DeliveryOutcome.kind = EVENT_FAILED', results.status_FAILED.ok.kind === 'EVENT_FAILED');

console.log('--- CLASSIFICATION FOURNISSEUR (P0-B) : ACCOUNT_BLOCKED / TEMPORARILY_UNAVAILABLE JAMAIS CONFONDUS AVEC UN ECHEC ORDINAIRE ---');
t('providerFailure=ACCOUNT_BLOCKED -> DeliveryOutcome.kind = PROVIDER_ACCOUNT_BLOCKED', results.provider_failure_ACCOUNT_BLOCKED.ok.kind === 'PROVIDER_ACCOUNT_BLOCKED');
t('providerFailure=TEMPORARILY_UNAVAILABLE -> DeliveryOutcome.kind = PROVIDER_TEMPORARILY_UNAVAILABLE', results.provider_failure_TEMPORARILY_UNAVAILABLE.ok.kind === 'PROVIDER_TEMPORARILY_UNAVAILABLE');

console.log('--- EXCEPTION COMITE : NON DELIVRE, AUCUNE FUITE ---');
t('exception levée -> non délivré', results.thrown.ok.kind !== 'DELIVERED');
t('exception levée -> avertissement journalisé', results.thrown.calls.some((c) => c.level === 'warn'));
{
  const serialized = JSON.stringify(results.thrown.calls);
  t('exception levée -> aucun "Bearer sk-ant-" ne fuit dans les logs', !serialized.includes('Bearer sk-ant-should-not-leak'));
}

console.log('--- EVENT_ID STABLE (dérivation inchangée) ---');
t('même newsId+action -> même event_id malgré un score différent', results.stable_event_id.a === results.stable_event_id.b);
t('event_id au format news:<id>:<action>', /^news:news-stable:RECALC_H1_H2$/.test(results.stable_event_id.a));

console.log('--- GARDE-FOU COUT : AU PLUS UN COMITE PAR APPEL ---');
t('un seul appel handleCommitteeEvent pour 3 événements actionnables', results.cost_guard.callCount === 1);
t('le plus fort score est tenté en premier', results.cost_guard.outcome.attempted[0] === 'high');
t('les 2 autres sont différés, jamais échoués', results.cost_guard.outcome.deferred.length === 2 && results.cost_guard.outcome.deferred.includes('low') && results.cost_guard.outcome.deferred.includes('mid'));
t('événement tenté et réussi -> délivré', results.cost_guard.outcome.delivered.length === 1 && results.cost_guard.outcome.delivered[0] === 'high');

console.log('--- GARDE-FOU COUT : ECHEC DE LA TENTATIVE UNIQUE ---');
t('un seul appel handleCommitteeEvent même en échec', results.cost_guard_failed.callCount === 1);
t('tentative échouée -> attempted mais pas delivered', results.cost_guard_failed.outcome.attempted.includes('best') && !results.cost_guard_failed.outcome.delivered.includes('best'));
t('événement jamais tenté -> différé, PAS confondu avec un échec', results.cost_guard_failed.outcome.deferred.includes('second') && !results.cost_guard_failed.outcome.attempted.includes('second'));
t('échec événement-spécifique générique (sans providerFailure) -> reste chargeable (bump notify_attempts attendu, exactement une fois)',
  results.cost_guard_failed.outcome.chargeableFailed.length === 1 && results.cost_guard_failed.outcome.chargeableFailed[0] === 'best');

console.log('--- BUDGET DE CYCLE PARTAGE : DISPATCH DIRECT CONSOMME LE SLOT ---');
{
  const r = results.shared_budget_direct_wins;
  t('un seul appel handleCommitteeEvent pour TOUT le cycle (direct + réconciliation combinés)', r.totalCommitteeCalls === 1);
  t('le dispatch direct tente et délivre son événement', r.directOutcome.attempted.length === 1 && r.directOutcome.delivered.length === 1);
  t('la réconciliation ne tente RIEN : budget déjà consommé par le direct', r.reconcileOutcome.attempted.length === 0 && r.reconcileOutcome.delivered.length === 0);
  t('les 2 événements de réconciliation sont différés, jamais échoués', r.reconcileOutcome.deferred.length === 2 && r.reconcileOutcome.deferred.includes('reconcile-1') && r.reconcileOutcome.deferred.includes('reconcile-2'));
}

console.log('--- BUDGET DE CYCLE PARTAGE : AUCUN EVENEMENT DIRECT ELIGIBLE -> RECONCILIATION PEUT CONSOMMER LE SLOT ---');
{
  const r = results.shared_budget_direct_empty;
  t('le dispatch direct (liste vide) ne consomme pas le budget', r.directOutcome.attempted.length === 0 && r.directOutcome.deferred.length === 0);
  t('la réconciliation peut ensuite tenter son événement', r.reconcileOutcome.attempted.length === 1 && r.reconcileOutcome.delivered.length === 1);
  t('un seul appel handleCommitteeEvent au total (consommé par la réconciliation)', r.totalCommitteeCalls === 1);
}

console.log('--- BUDGET DE CYCLE PARTAGE : ECHEC DIRECT -> PAS DE 2E COMITE DANS LE MEME CYCLE ---');
{
  const r = results.shared_budget_direct_fails;
  t('le dispatch direct tente (et échoue) -- le slot est consommé par la TENTATIVE, pas par le succès', r.directOutcome.attempted.includes('direct-fails') && !r.directOutcome.delivered.includes('direct-fails'));
  t('la réconciliation NE retente PAS un second comité : son événement est différé', r.reconcileOutcome.attempted.length === 0 && r.reconcileOutcome.deferred.includes('reconcile-blocked'));
  t('un seul appel handleCommitteeEvent pour tout le cycle, même en échec', r.totalCommitteeCalls === 1);
}

console.log('--- HORIZON (P0-A) : BORNES EXACTES 4H/24H, DÉTERMINISTE (helper pur, nowMs injecté) ---');
{
  const b = results.horizon_pure_boundaries;
  t('H1/H2 exactement 4h -> éligible (isNotificationWithinHorizon, nowMs fixe)', b.h12_exact_4h === true);
  t('H1/H2 4h + 1ms -> expiré', b.h12_over_4h_by_1ms === false);
  t('H3 exactement 24h -> éligible', b.h3_exact_24h === true);
  t('H3 24h + 1ms -> expiré', b.h3_over_24h_by_1ms === false);
}

console.log('--- HORIZON (P0-A) : INTEGRATION notifyAiEngine() (marge de sécurité, jamais la borne exacte) ---');
{
  t('H1/H2 éligible (4h - 1s) -> délivré', results.horizon_h12_eligible_margin.delivered.includes('h12-eligible-margin'));
  t('H1/H2 expiré (4h + 1s) -> jamais tenté ni différé', !results.horizon_h12_expired_margin.attempted.includes('h12-expired-margin') && !results.horizon_h12_expired_margin.deferred.includes('h12-expired-margin'));
  t('H3 éligible (24h - 1s) -> délivré', results.horizon_h3_eligible_margin.delivered.includes('h3-eligible-margin'));
  t('H3 expiré (24h + 1s) -> jamais tenté ni différé', !results.horizon_h3_expired_margin.attempted.includes('h3-expired-margin') && !results.horizon_h3_expired_margin.deferred.includes('h3-expired-margin'));
  t('un événement expiré à score élevé ne peut pas évincer un candidat frais à score faible',
    results.horizon_stale_cannot_evict_fresh.outcome.delivered.includes('fresh-low-score')
    && !results.horizon_stale_cannot_evict_fresh.outcome.attempted.includes('stale-high-score')
    && !results.horizon_stale_cannot_evict_fresh.outcome.deferred.includes('stale-high-score'));
  t('un lot entièrement expiré ne consomme JAMAIS le budget de cycle : l\'autre chemin peut encore l\'utiliser',
    results.horizon_expired_never_consumes_budget.otherPathOutcome.delivered.includes('other-path-fresh')
    && results.horizon_expired_never_consumes_budget.callCount === 1);
}

console.log('--- CIRCUIT FOURNISSEUR (P0-B) : FENETRES DE RECHARGE 75MIN / 20MIN ---');
{
  t('ACCOUNT_BLOCKED < 75 min -> circuit OUVERT, tout différé, AUCUN appel comité',
    results.circuit_account_blocked_recent.callCount === 0
    && results.circuit_account_blocked_recent.outcome.deferred.includes('circuit-probe')
    && results.circuit_account_blocked_recent.outcome.attempted.length === 0);
  t('ACCOUNT_BLOCKED >= 75 min -> circuit rechargé, une tentative normale autorisée',
    results.circuit_account_blocked_expired.callCount === 1
    && results.circuit_account_blocked_expired.outcome.attempted.includes('circuit-probe'));
  t('TEMPORARILY_UNAVAILABLE < 20 min -> circuit OUVERT, tout différé, AUCUN appel comité',
    results.circuit_temp_unavailable_recent.callCount === 0
    && results.circuit_temp_unavailable_recent.outcome.deferred.includes('circuit-probe'));
  t('TEMPORARILY_UNAVAILABLE >= 20 min -> circuit rechargé, une tentative normale autorisée',
    results.circuit_temp_unavailable_expired.callCount === 1
    && results.circuit_temp_unavailable_expired.outcome.attempted.includes('circuit-probe'));
  t('dernière ligne ai_committee RÉUSSIE -> circuit FERMÉ, tentative normale autorisée',
    results.circuit_closed_after_success.callCount === 1
    && results.circuit_closed_after_success.outcome.attempted.includes('circuit-probe'));
  t('déferrement circuit -> ne consomme JAMAIS le budget de cycle : l\'autre chemin peut encore l\'utiliser',
    results.circuit_deferral_does_not_consume_budget.blockedOutcome.attempted.length === 0
    && results.circuit_deferral_does_not_consume_budget.otherPathOutcome.delivered.includes('other-path-after-circuit')
    && results.circuit_deferral_does_not_consume_budget.callCount === 1);
}

console.log('--- P0-B (BLOCKER 1) : PANNE TRANSPORT AU NIVEAU notifyAiEngine() -- TENTÉE UNE FOIS, NON CHARGEABLE ---');
{
  const r = results.notify_transport_failure;
  t('panne transport (TEMPORARILY_UNAVAILABLE) -> tentée une fois (consomme le budget)',
    r.callCount === 1 && r.outcome.attempted.includes('transport-failure'));
  t('panne transport -> non délivrée', !r.outcome.delivered.includes('transport-failure'));
  t('panne transport -> chargeableFailed VIDE (notify_attempts ne serait JAMAIS incrémenté)',
    r.outcome.chargeableFailed.length === 0);
}

console.log('--- SEPARATION DES ENVIRONNEMENTS (pas de COMMITTEE_TOKEN interne) ---');
t('committeeEnv transmis à handleCommitteeEvent ne porte jamais COMMITTEE_TOKEN', results.env_split.sawCommitteeToken === false);

console.log('--- AUCUNE FUITE DE LA CLE ANTHROPIC DANS AUCUN LOG ---');
{
  const allCalls = Object.values(results).flatMap((r) => (Array.isArray(r?.calls) ? r.calls : []));
  const serialized = JSON.stringify(allCalls);
  t('ANTHROPIC_API_KEY n\'apparaît dans aucun log capturé', !serialized.includes(FAKE_ANTHROPIC_KEY));
}

console.log('--- SURFACE HTTP EXTERNE /committee : AUTHENTIFICATION INCHANGEE ---');
{
  const isAuthorizedSrc = extractBlock(committeeSource, /function isAuthorized\(request: Request, env: Env\)/);
  const jsonResponseSrc = extractBlock(committeeSource, /function jsonResponse\(body: unknown, status: number\)/);
  const timingSafeEqualSrc = extractBlock(committeeSource, /function timingSafeEqual\(a: string, b: string\)/);
  const handleRequestSrc = extractBlock(committeeSource, /export async function handleRequest\(/);

  const dir2 = mkdtempSync(join(tmpdir(), 'xau-ops010-http-'));
  const harnessPath2 = join(dir2, 'harness2.ts');
  const harness2 = `
const CONFIG = { ENGINE_VERSION: 'ai-committee-test' };
class CommitteeBusyError extends Error {}
async function runCommittee() { throw new Error('non utilisé dans ce test'); }
async function handleCommitteeEvent() { throw new Error('non utilisé dans ce test'); }

${timingSafeEqualSrc}
${jsonResponseSrc}
${isAuthorizedSrc}
${handleRequestSrc}

function makeRequest(method, headers = {}, body = '', path = '/committee') {
  const h = { ...headers };
  return {
    method, url: 'https://worker.invalid' + path,
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const env = { COMMITTEE_TOKEN: 'real-committee-token', SUPABASE_URL: 'https://fake.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' };

const noToken = await handleRequest(makeRequest('POST', {}, '{}'), env);
const wrongToken = await handleRequest(makeRequest('POST', { authorization: 'Bearer wrong-token' }, '{}'), env);
const rightTokenBadJson = await handleRequest(makeRequest('POST', { authorization: 'Bearer real-committee-token' }, 'not-json{{'), env);
const health = await handleRequest(makeRequest('GET', {}, '', '/health'), env);

process.stdout.write(JSON.stringify({
  noTokenStatus: noToken.status, wrongTokenStatus: wrongToken.status,
  rightTokenBadJsonStatus: rightTokenBadJson.status, healthStatus: health.status,
}));
`;
  writeFileSync(harnessPath2, harness2, 'utf8');
  let out2;
  try {
    out2 = JSON.parse(execFileSync(process.execPath, [harnessPath2], { encoding: 'utf8' }));
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
  t('POST /committee sans jeton -> 401 (inchangé)', out2.noTokenStatus === 401);
  t('POST /committee avec jeton erroné -> 401 (inchangé)', out2.wrongTokenStatus === 401);
  t('POST /committee avec le bon jeton -> passe l\'auth (400 sur JSON invalide, jamais 401)', out2.rightTokenBadJsonStatus === 400);
  t('GET /health -> 200 (inchangé, sans authentification)', out2.healthStatus === 200);
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
