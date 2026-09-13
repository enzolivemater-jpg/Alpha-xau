// XAU-V2-OPS-009 — preuve par exécution réelle du correctif d'idempotence
// event-driven (claimEvent/closeEvent/handleCommitteeEvent).
//
// Ce qui est RÉELLEMENT exercé (extrait verbatim de
// backend/ai_engine/committee_orchestrator.ts, exécuté via le "type
// stripping" natif de Node >= 22.6 -- sans pipeline de build, même
// philosophie que test_committee_http_observability.mjs) :
//   - claimEvent()  (les 4 cas A/B/C/D du contrat)
//   - closeEvent() / closeTerminalSuccessOrFail()
//   - handleCommitteeEvent() dans son intégralité
//   - handleRequest(), isAuthorized(), jsonResponse() (mapping HTTP)
//   - validateCommitteeEvent(), asRecord(), redact()/redactString()/errorMessage()
//
// Ce qui reste MOCKÉ (hors périmètre OPS-009, déjà couvert ailleurs) :
//   - PostgREST : un faux magasin en mémoire qui reproduit fidèlement la
//     sémantique des filtres utilisés (eq./in.(...), Prefer: return=representation)
//   - acquireLock()/releaseLock() (verrou réel testé par test_committee_lock.mjs)
//   - runCommittee() (appel LLM réel hors périmètre ; contrôlé par test)
//   - Logger (même contrat, sans le champ privé de constructeur qui bloque
//     le "strip-only mode" de Node -- voir OPS-004)
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const source = readFileSync(new URL('../backend/ai_engine/committee_orchestrator.ts', import.meta.url), 'utf8');
const lockSource = readFileSync(new URL('../backend/shared/run_lock.ts', import.meta.url), 'utf8');

function extractBlock(src, startRegex) {
  const m = startRegex.exec(src);
  if (!m) throw new Error(`extraction introuvable pour ${startRegex}`);
  const start = m.index;
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  let end = i + 1;
  // Statement de type `const X = {...};` : inclure le point-virgule final.
  while (src[end] === ';') end++;
  return src.slice(start, end);
}

console.log('--- CONTRAT STATIQUE (lecture de source) ---');
{
  t('claimEvent() ne retourne plus un booléen (contrat ClaimOutcome)',
    /type ClaimOutcome =/.test(source));
  t('claimEvent() tente une reprise CAS FAILED/DATA_UNAVAILABLE (sur le statut exact observé) avant de conclure ALREADY_PROCESSED',
    /snapshot\?\.status === 'FAILED' \|\| snapshot\?\.status === 'DATA_UNAVAILABLE'/.test(source)
    && /status=eq\.\$\{snapshot\.status\}/.test(source));
  t('claimEvent() tente une reprise CAS du RUNNING orphelin, guardée sur started_at (vrai CAS)',
    /status=eq\.RUNNING&started_at=eq\.\$\{encodeURIComponent\(snapshot\.started_at\)\}/.test(source));
  t('claimEvent() ne tente jamais une seconde branche après un CAS perdu (une seule reprise par appel)',
    /Anomalie : un CAS attendu comme gagnant a été perdu/.test(source));
  t('claimEvent() lit l\'état réel (status,analysis_id) avant de rendre ALREADY_PROCESSED',
    /db\.select<\{ status: string; analysis_id: string \| null \}>/.test(source));
  t('closeEvent() ne catch/avale plus sa propre erreur d\'écriture',
    !/closeEvent[\s\S]{0,10}\.catch\(\(\) => undefined\)/.test(source));
  t('closeTerminalSuccessOrFail() existe et journalise sans avaler',
    /async function closeTerminalSuccessOrFail/.test(source));
  t('VALID_SETUP + analysis_id null => FAILED explicite (jamais SKIPPED_NO_CHANGE)',
    /Setup valide CALCULÉ mais jamais PERSISTÉ/.test(source));
  t('handleRequest mappe ALREADY_RUNNING sur 409 (non-2xx)',
    /result\.status === 'ALREADY_RUNNING' \? 409/.test(source));
}

const asRecordSrc = extractBlock(source, /function asRecord\(value: unknown\)/);
const validateSrc = extractBlock(source, /export function validateCommitteeEvent\(raw: unknown\)/);
const scopeHorizonsSrc = extractBlock(source, /export const SCOPE_HORIZONS:/);
const eventScopeSrc = extractBlock(source, /const EVENT_SCOPE:/);
const secretKeyPatternMatch = /const SECRET_KEY_PATTERN = .*;/.exec(source);
if (!secretKeyPatternMatch) throw new Error('SECRET_KEY_PATTERN introuvable dans la source.');
const secretKeyPatternSrc = secretKeyPatternMatch[0];
const redactStringSrc = extractBlock(source, /function redactString\(value: string\)/);
const redactSrc = extractBlock(source, /function redact\(input: unknown, depth = 0\)/);
const errorMessageSrc = extractBlock(source, /function errorMessage\(err: unknown\)/);
const claimEventSrc = extractBlock(source, /async function claimEvent\(/);
const closeEventSrc = extractBlock(source, /async function closeEvent\(/);
const closeTerminalSrc = extractBlock(source, /async function closeTerminalSuccessOrFail\(/);
const handleCommitteeEventSrc = extractBlock(source, /export async function handleCommitteeEvent\(/);
const jsonResponseSrc = extractBlock(source, /function jsonResponse\(body: unknown, status: number\)/);
const isAuthorizedSrc = extractBlock(source, /function isAuthorized\(request: Request, env: Env\)/);
const handleRequestSrc = extractBlock(source, /export async function handleRequest\(/);
const timingSafeEqualSrc = extractBlock(source, /function timingSafeEqual\(a: string, b: string\)/);
const isUniqueViolationSrc = extractBlock(lockSource, /export function isUniqueViolation\(message: string\)/);

const dir = mkdtempSync(join(tmpdir(), 'xau-ops009-'));
const harnessPath = join(dir, 'harness.ts');

const harness = `
${secretKeyPatternSrc}
${redactStringSrc}
${redactSrc}
${errorMessageSrc}
${asRecordSrc}
${scopeHorizonsSrc}
${eventScopeSrc}
${validateSrc}
${isUniqueViolationSrc}

// ---- FAKES : hors périmètre OPS-009 (voir en-tête du fichier de test) ----
class Logger {
  constructor(_level, runId) { this.runId = runId; this.calls = []; }
  _emit(level, message, context) {
    this.calls.push({ level, message, context: context ? redact(context) : undefined });
  }
  debug(m, c) { this._emit('debug', m, c); }
  info(m, c) { this._emit('info', m, c); }
  warn(m, c) { this._emit('warn', m, c); }
  error(m, c) { this._emit('error', m, c); }
}

class CommitteeBusyError extends Error {}
// Stub minimal (XAU-V2-OPS-015) : ce test ne porte pas sur la classification
// fournisseur elle-même (couverte par tests/test_notification_horizon_provider_circuit.mjs),
// mais handleCommitteeEvent() réel référence désormais AnthropicError dans
// son catch pour peupler EventResult.providerFailure. La plupart des
// scénarios levés ici n'en sont pas des instances : le test instanceof reste
// faux, providerFailure reste undefined, comportement inchangé pour ces
// cas. Les scénarios 17/18 (DETECTION INITIALE, plus bas) en construisent
// délibérément une pour prouver la propagation providerFailure/releaseLock.
class AnthropicError extends Error {
  constructor(message, status, retryable, retryAfterMs, failureKind) {
    super(message);
    this.status = status; this.retryable = retryable;
    this.retryAfterMs = retryAfterMs; this.failureKind = failureKind;
  }
}

let __lockAcquired = true;
const __releaseLockCalls = [];
async function acquireLock(_db, _engine, _triggerType) {
  return __lockAcquired ? { acquired: true, runRowId: 'fake-run-row' } : { acquired: false };
}
async function releaseLock(_db, runRowId, release) {
  __releaseLockCalls.push({ runRowId, ...release });
}

let __runCommitteeImpl = async () => { throw new Error('runCommittee non configuré pour ce cas de test'); };
let __runCommitteeCallCount = 0;
async function runCommittee(env, options) {
  __runCommitteeCallCount++;
  return __runCommitteeImpl(env, options);
}

// ---- Faux magasin PostgREST en mémoire (sémantique des filtres réels) ----
class FakeDb {
  constructor() { this.rows = new Map(); }
  // Filtre PostgREST générique : chaque paramètre (hors "select") est une
  // colonne, avec sémantique eq.X / in.(A,B). Reproduit fidèlement de quoi
  // évaluer n'importe quelle combinaison de filtres réellement émise par
  // claimEvent()/closeEvent(), y compris le CAS à deux colonnes du cas D
  // (event_id + status + started_at).
  matches(row, params) {
    for (const [col, raw] of params.entries()) {
      if (col === 'select') continue;
      if (raw.startsWith('in.(')) {
        const allowed = raw.slice(4, -1).split(',');
        if (!allowed.includes(String(row[col]))) return false;
      } else if (raw.startsWith('eq.')) {
        if (String(row[col]) !== raw.slice(3)) return false;
      }
    }
    return true;
  }
  async request(method, path, body, extraHeaders = {}) {
    const [table, qs] = path.split('?');
    if (table !== 'ai_events') throw new Error('FakeDb ne supporte que ai_events ici: ' + table);
    const params = new URLSearchParams(qs || '');
    const representation = extraHeaders.prefer === 'return=representation';

    if (method === 'POST') {
      const [row] = body;
      if (this.rows.has(row.event_id)) {
        throw new Error('duplicate key value violates unique constraint "ai_events_pkey"');
      }
      this.rows.set(row.event_id, { ...row });
      return representation ? [{ ...row }] : [];
    }

    if (method === 'GET') {
      const out = [];
      for (const row of this.rows.values()) {
        if (this.matches(row, params)) out.push({ ...row });
      }
      return out;
    }

    if (method === 'PATCH') {
      const matched = [];
      for (const row of this.rows.values()) {
        if (this.matches(row, params)) matched.push(row);
      }
      if (this.__failNextPatch) { this.__failNextPatch = false; throw new Error('Supabase HTTP 500 (simulé)'); }
      for (const row of matched) Object.assign(row, body);
      return representation ? matched.map((r) => ({ ...r })) : [];
    }
    throw new Error('méthode non supportée: ' + method);
  }
  async select(table, columns, filter) {
    return this.request('GET', table + '?select=' + columns + (filter ? '&' + filter : ''), undefined);
  }
}

${claimEventSrc}
${closeEventSrc}
${closeTerminalSrc}
${handleCommitteeEventSrc}
${jsonResponseSrc}
${isAuthorizedSrc}
${timingSafeEqualSrc}
${handleRequestSrc}

// ---- Helpers de test ----
function makeEnv(db, extra = {}) {
  return { LOG_LEVEL: 'debug', SUPABASE_URL: 'https://fake.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake', COMMITTEE_TOKEN: 'test-token', ...extra, __db: db };
}
// SupabaseClient est instancié PAR handleCommitteeEvent (new SupabaseClient(env, log)) :
// on l'intercepte en réécrivant le nom global.
class SupabaseClient {
  constructor(env, _log) { return env.__db; }
}
function fakeEvent(id, overrides = {}) {
  return {
    event_id: id, event_type: 'RECALC_H1_H2', source: 'test',
    triggered_at: new Date().toISOString(), news_event_id: null, news_score: 90,
    ...overrides,
  };
}
function makeRequest(bodyObj, headers = {}) {
  const h = { authorization: 'Bearer test-token', ...headers };
  return {
    method: 'POST',
    url: 'https://worker.invalid/committee',
    headers: { get: (k) => h[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(bodyObj),
  };
}
function committeeEventBody(id, overrides = {}) {
  return {
    event_id: id, event_type: 'RECALC_H1_H2', source: 'test_engine',
    triggered_at: new Date().toISOString(), ...overrides,
  };
}

const results = {};

// 1. Fresh event -> CLAIMED (via INSERT), runCommittee appelé une fois.
{
  const db = new FakeDb();
  const log = new Logger('debug', 'test');
  const claim = await claimEvent(db, fakeEvent('E-FRESH'), log);
  results.fresh_claim = claim;
}

// 2. Existing PROCESSED -> ALREADY_PROCESSED, aucun nouvel appel LLM.
{
  const db = new FakeDb();
  db.rows.set('E-PROCESSED', { event_id: 'E-PROCESSED', status: 'PROCESSED', analysis_id: 'analysis-123' });
  const log = new Logger('debug', 'test');
  const claim = await claimEvent(db, fakeEvent('E-PROCESSED'), log);
  results.processed_claim = claim;
}

// 3. Existing SKIPPED_NO_CHANGE -> ALREADY_PROCESSED (analysis_id peut être null).
{
  const db = new FakeDb();
  db.rows.set('E-SKIPPED', { event_id: 'E-SKIPPED', status: 'SKIPPED_NO_CHANGE', analysis_id: null });
  const log = new Logger('debug', 'test');
  const claim = await claimEvent(db, fakeEvent('E-SKIPPED'), log);
  results.skipped_claim = claim;
}

// 4. Existing FAILED -> reclamé atomiquement (RECLAIM_FAILED), champs réinitialisés.
{
  const db = new FakeDb();
  db.rows.set('E-FAILED', { event_id: 'E-FAILED', status: 'FAILED', analysis_id: null, error: 'ancienne erreur', finished_at: '2026-01-01T00:00:00Z' });
  const log = new Logger('debug', 'test');
  const claim = await claimEvent(db, fakeEvent('E-FAILED'), log);
  results.failed_claim = claim;
  results.failed_row_after = { ...db.rows.get('E-FAILED') };
}

// 5. Existing DATA_UNAVAILABLE -> reclamé atomiquement.
{
  const db = new FakeDb();
  db.rows.set('E-DU', { event_id: 'E-DU', status: 'DATA_UNAVAILABLE', analysis_id: null });
  const log = new Logger('debug', 'test');
  const claim = await claimEvent(db, fakeEvent('E-DU'), log);
  results.data_unavailable_claim = claim;
}

// 6. RUNNING orphelin (sous verrou global déjà tenu par NOUS) -> récupérable.
{
  const db = new FakeDb();
  db.rows.set('E-ORPHAN', { event_id: 'E-ORPHAN', status: 'RUNNING', analysis_id: null, finished_at: null });
  const log = new Logger('debug', 'test');
  const claim = await claimEvent(db, fakeEvent('E-ORPHAN'), log);
  results.orphan_claim = claim;
}

// 7. CAS concurrent : deux tentatives de reclaim FAILED simultanées sur la
//    MÊME ligne -> un seul gagnant (pas deux CLAIMED).
{
  const db = new FakeDb();
  db.rows.set('E-RACE', { event_id: 'E-RACE', status: 'FAILED', analysis_id: null });
  const log = new Logger('debug', 'test');
  const [a, b] = await Promise.all([
    claimEvent(db, fakeEvent('E-RACE'), log),
    claimEvent(db, fakeEvent('E-RACE'), log),
  ]);
  results.race = { a, b };
}

// 8. closeTerminalSuccessOrFail : écriture réussie -> true.
{
  const db = new FakeDb();
  db.rows.set('E-CLOSE-OK', { event_id: 'E-CLOSE-OK', status: 'RUNNING', analysis_id: null });
  const log = new Logger('debug', 'test');
  const ok = await closeTerminalSuccessOrFail(db, 'E-CLOSE-OK', 'PROCESSED', Date.now(), 'a-1', log);
  results.close_ok = { ok, row: { ...db.rows.get('E-CLOSE-OK') }, logs: log.calls };
}

// 9. closeTerminalSuccessOrFail : écriture en échec -> false, PAS de succès.
{
  const db = new FakeDb();
  db.rows.set('E-CLOSE-FAIL', { event_id: 'E-CLOSE-FAIL', status: 'RUNNING', analysis_id: null });
  db.__failNextPatch = true;
  const log = new Logger('debug', 'test');
  const ok = await closeTerminalSuccessOrFail(db, 'E-CLOSE-FAIL', 'PROCESSED', Date.now(), 'a-1', log);
  results.close_fail = { ok, row: { ...db.rows.get('E-CLOSE-FAIL') }, logs: log.calls };
}

// ---- handleCommitteeEvent() bout en bout ----

// 10. Verrou indisponible -> ALREADY_RUNNING, aucune réclamation, HTTP 409.
{
  __lockAcquired = false;
  const db = new FakeDb();
  const env = makeEnv(db);
  const before = db.rows.size;
  const result = await handleCommitteeEvent(committeeEventBody('E-LOCKED'), env);
  const httpRes = await handleRequest(makeRequest(committeeEventBody('E-LOCKED2')), env);
  __lockAcquired = true;
  results.lock_unavailable = { result, rowsCreated: db.rows.size - before, httpStatus: httpRes.status };
}

// 11. runCommittee FAILED (exception) -> status FAILED, ai_events=FAILED, HTTP 500.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __runCommitteeImpl = async () => { throw new Error('Anthropic HTTP 500 (simulé)'); };
  const body = committeeEventBody('E-WILLFAIL');
  const result = await handleCommitteeEvent(body, env);
  const httpRes = await handleRequest(makeRequest(committeeEventBody('E-WILLFAIL-2')), env);
  __runCommitteeImpl = async () => { throw new Error('Anthropic HTTP 500 (simulé)'); };
  const httpRes2 = await handleRequest(makeRequest(body), env); // même event_id -> reclaim -> refail
  results.runCommittee_failed = { result, row: { ...db.rows.get('E-WILLFAIL') }, httpStatus2: httpRes2.status };
}

// 12. runCommittee DATA_UNAVAILABLE -> status DATA_UNAVAILABLE, HTTP 503, non acquitté.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __runCommitteeImpl = async () => { throw new Error('DATA_UNAVAILABLE : aucun prix XAUUSD exploitable.'); };
  const result = await handleCommitteeEvent(committeeEventBody('E-DATAUNAV'), env);
  const httpRes = await handleRequest(makeRequest(committeeEventBody('E-DATAUNAV-2')), env);
  results.data_unavailable_result = { result, row: { ...db.rows.get('E-DATAUNAV') }, httpStatus: httpRes.status };
}

// 13. VALID_SETUP + analysis_id null (persistance ratée) -> FAILED, jamais PROCESSED.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __runCommitteeImpl = async () => ({ meta: { execution_status: 'VALID_SETUP', analysis_id: null, validation_errors: [] } });
  const result = await handleCommitteeEvent(committeeEventBody('E-NOPERSIST'), env);
  const httpRes = await handleRequest(makeRequest(committeeEventBody('E-NOPERSIST-2')), env);
  results.valid_setup_no_persist = { result, row: { ...db.rows.get('E-NOPERSIST') }, httpStatus: httpRes.status };
}

// 14. VALID_SETUP + analysis_id réel -> PROCESSED, HTTP 200, ai_events=PROCESSED.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __runCommitteeImpl = async () => ({ meta: { execution_status: 'VALID_SETUP', analysis_id: 'analysis-xyz', validation_errors: [] } });
  const result = await handleCommitteeEvent(committeeEventBody('E-OK'), env);
  const httpRes = await handleRequest(makeRequest(committeeEventBody('E-OK-2')), env);
  results.valid_setup_ok = { result, row: { ...db.rows.get('E-OK') }, httpStatus: httpRes.status };
}

// 15. Idempotence d'un PROCESSED réel : seconde livraison -> ALREADY_PROCESSED,
//     AUCUN second appel runCommittee, HTTP 200.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __runCommitteeImpl = async () => ({ meta: { execution_status: 'VALID_SETUP', analysis_id: 'analysis-once', validation_errors: [] } });
  __runCommitteeCallCount = 0;
  const body = committeeEventBody('E-IDEMP');
  const first = await handleCommitteeEvent(body, env);
  const callsAfterFirst = __runCommitteeCallCount;
  const second = await handleCommitteeEvent(body, env);
  const callsAfterSecond = __runCommitteeCallCount;
  const httpRes = await handleRequest(makeRequest(body), env);
  results.idempotent_processed = { first, second, callsAfterFirst, callsAfterSecond, httpStatus: httpRes.status };
}

// 16. closeEvent terminal write failure au sein de handleCommitteeEvent ->
//     FAILED renvoyé, jamais PROCESSED, malgré une analyse VALID_SETUP réussie.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __runCommitteeImpl = async () => ({ meta: { execution_status: 'VALID_SETUP', analysis_id: 'analysis-late-fail', validation_errors: [] } });
  const body = committeeEventBody('E-CLOSEFAIL');
  // Le PATCH de clôture (après l'INSERT initial de claimEvent) doit échouer.
  const originalRequest = db.request.bind(db);
  db.request = async (method, path, patchBody, headers) => {
    if (method === 'PATCH' && path.startsWith('ai_events?event_id=eq.E-CLOSEFAIL') && !path.includes('status=')) {
      throw new Error('Supabase HTTP 500 (simulé, clôture)');
    }
    return originalRequest(method, path, patchBody, headers);
  };
  const result = await handleCommitteeEvent(body, env);
  const httpRes = await handleRequest(makeRequest(committeeEventBody('E-CLOSEFAIL-2')), env);
  results.close_fail_integration = { result, row: { ...db.rows.get('E-CLOSEFAIL') }, httpStatus: httpRes.status };
}

// 17. XAU-V2-OPS-015 (P0-B), DETECTION INITIALE : runCommittee lève une
//     AnthropicError structurellement classée ACCOUNT_BLOCKED -> EventResult
//     la reporte (providerFailure), ET releaseLock persiste l'état durable
//     dans providers.anthropic.failure_kind -- seule trace exploitable par
//     le circuit fournisseur de notifyAiEngine() (backend/ingest.ts).
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __releaseLockCalls.length = 0;
  __runCommitteeImpl = async () => { throw new AnthropicError('compte bloqué (simulé)', 400, false, undefined, 'ACCOUNT_BLOCKED'); };
  const result = await handleCommitteeEvent(committeeEventBody('E-ACCOUNTBLOCKED'), env);
  results.account_blocked_first_detection = {
    result, row: { ...db.rows.get('E-ACCOUNTBLOCKED') },
    release: __releaseLockCalls[__releaseLockCalls.length - 1],
  };
}

// 18. Même contrat pour TEMPORARILY_UNAVAILABLE (429/5xx/529/réseau).
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __releaseLockCalls.length = 0;
  __runCommitteeImpl = async () => { throw new AnthropicError('indisponible (simulé)', 503, true, undefined, 'TEMPORARILY_UNAVAILABLE'); };
  const result = await handleCommitteeEvent(committeeEventBody('E-TEMPUNAVAIL'), env);
  results.temporarily_unavailable_first_detection = {
    result, row: { ...db.rows.get('E-TEMPUNAVAIL') },
    release: __releaseLockCalls[__releaseLockCalls.length - 1],
  };
}

// 19. Un run RÉUSSI relâche TOUJOURS providers:{} -- jamais d'état résiduel
//     d'un échec fournisseur précédent sur une ligne de succès (ce qui ferme
//     le circuit dès le prochain passage du cron horaire).
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __releaseLockCalls.length = 0;
  __runCommitteeImpl = async () => ({ meta: { execution_status: 'VALID_SETUP', analysis_id: 'analysis-clean', validation_errors: [] } });
  const result = await handleCommitteeEvent(committeeEventBody('E-CLEANSUCCESS'), env);
  results.success_clears_provider_state = {
    result, release: __releaseLockCalls[__releaseLockCalls.length - 1],
  };
}

// 20. XAU-V2-OPS-015 PR review, BLOCKER 1 : une panne de TRANSPORT
//     (abort local / échec réseau côté callClaude, status = sentinel 0 --
//     jamais un code HTTP reçu, cf. committee_orchestrator.ts) suit
//     EXACTEMENT le même contrat que le cas HTTP #18 ci-dessus une fois
//     classée par callClaude : EventResult.providerFailure la reporte, et
//     releaseLock persiste providers.anthropic.failure_kind. Preuve que la
//     distinction transport/HTTP disparaît correctement dès la frontière
//     AnthropicError -- rien de spécifique à coder plus loin dans la chaîne.
{
  const db = new FakeDb();
  const env = makeEnv(db);
  __releaseLockCalls.length = 0;
  __runCommitteeImpl = async () => { throw new AnthropicError('macro_analyst: timeout après 60000ms', 0, true, undefined, 'TEMPORARILY_UNAVAILABLE'); };
  const result = await handleCommitteeEvent(committeeEventBody('E-TRANSPORTFAIL'), env);
  results.transport_failure_first_detection = {
    result, row: { ...db.rows.get('E-TRANSPORTFAIL') },
    release: __releaseLockCalls[__releaseLockCalls.length - 1],
  };
}

process.stdout.write(JSON.stringify({ results }));
`;

writeFileSync(harnessPath, harness, 'utf8');

let output;
try {
  const raw = execFileSync(process.execPath, [harnessPath], { encoding: 'utf8' });
  output = JSON.parse(raw);
} catch (err) {
  t('exécution du harnais isolé (fonctions réelles extraites de committee_orchestrator.ts)', false, String(err));
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { results } = output;

console.log('--- A. FRESH EVENT_ID -> CLAIMED ---');
t('fresh -> claimed=true via INSERT', results.fresh_claim.claimed === true && results.fresh_claim.via === 'INSERT');

console.log('--- B. TERMINAL SUCCESS EXISTANT -> ALREADY_PROCESSED (aucun LLM) ---');
t('PROCESSED existant -> claimed=false', results.processed_claim.claimed === false);
t('PROCESSED existant -> analysisId réel restitué (pas null par supposition)', results.processed_claim.analysisId === 'analysis-123');
t('SKIPPED_NO_CHANGE existant -> claimed=false', results.skipped_claim.claimed === false);
t('SKIPPED_NO_CHANGE existant -> analysisId null fidèle à la ligne', results.skipped_claim.analysisId === null);

console.log('--- C. FAILED / DATA_UNAVAILABLE -> RECLAMATION ATOMIQUE ---');
t('FAILED existant -> claimed=true via RECLAIM_FAILED', results.failed_claim.claimed === true && results.failed_claim.via === 'RECLAIM_FAILED');
t('reclaim FAILED -> status remis à RUNNING en base', results.failed_row_after.status === 'RUNNING');
t('reclaim FAILED -> finished_at réinitialisé à null', results.failed_row_after.finished_at === null);
t('reclaim FAILED -> error réinitialisée à null', results.failed_row_after.error === null);
t('DATA_UNAVAILABLE existant -> claimed=true via RECLAIM_FAILED', results.data_unavailable_claim.claimed === true && results.data_unavailable_claim.via === 'RECLAIM_FAILED');

console.log('--- D. RUNNING ORPHELIN SOUS VERROU GLOBAL -> RECUPERABLE ---');
t('RUNNING orphelin -> claimed=true via RECLAIM_ORPHAN_RUNNING', results.orphan_claim.claimed === true && results.orphan_claim.via === 'RECLAIM_ORPHAN_RUNNING');

console.log('--- CAS CONCURRENT : PAS DEUX GAGNANTS ---');
{
  const winners = [results.race.a, results.race.b].filter((r) => r.claimed === true).length;
  t('reclaim concurrent sur la même ligne FAILED -> exactement un gagnant', winners === 1, `got ${winners}`);
}

console.log('--- CLOTURE TERMINALE DURABLE ---');
t('closeTerminalSuccessOrFail réussi -> true, ligne PROCESSED', results.close_ok.ok === true && results.close_ok.row.status === 'PROCESSED');
t('closeTerminalSuccessOrFail en échec -> false, PAS de succès renvoyé', results.close_fail.ok === false);
t('closeTerminalSuccessOrFail en échec -> ligne reste RUNNING (récupérable ensuite)', results.close_fail.row.status === 'RUNNING');
t('closeTerminalSuccessOrFail en échec -> log error émis sans exposer de détail DB brut',
  results.close_fail.logs.some((c) => c.level === 'error' && c.message.includes('NON acquitté')));

console.log('--- VERROU INDISPONIBLE -> ALREADY_RUNNING / 409 / AUCUNE RECLAMATION ---');
t('lock indisponible -> status ALREADY_RUNNING', results.lock_unavailable.result.status === 'ALREADY_RUNNING');
t('lock indisponible -> aucune ligne ai_events créée (event rejouable)', results.lock_unavailable.rowsCreated === 0);
t('lock indisponible -> HTTP 409 (jamais 200)', results.lock_unavailable.httpStatus === 409);

console.log('--- FAILED / DATA_UNAVAILABLE -> NON-2XX, JAMAIS ACQUITTE ---');
t('runCommittee en échec -> status FAILED', results.runCommittee_failed.result.status === 'FAILED');
t('runCommittee en échec -> ai_events.status = FAILED (rejouable)', results.runCommittee_failed.row.status === 'FAILED');
t('runCommittee en échec -> une 2e livraison est reclamée puis re-échoue -> HTTP 500 (jamais 200)',
  results.runCommittee_failed.httpStatus2 === 500);
t('DATA_UNAVAILABLE -> status DATA_UNAVAILABLE', results.data_unavailable_result.result.status === 'DATA_UNAVAILABLE');
t('DATA_UNAVAILABLE -> ai_events.status = DATA_UNAVAILABLE', results.data_unavailable_result.row.status === 'DATA_UNAVAILABLE');
t('DATA_UNAVAILABLE -> HTTP 503 (jamais 200)', results.data_unavailable_result.httpStatus === 503);

console.log('--- VALID_SETUP + ECHEC DE PERSISTANCE -> FAILED, JAMAIS PROCESSED ---');
t('analysis_id null malgré VALID_SETUP -> status FAILED', results.valid_setup_no_persist.result.status === 'FAILED');
t('analysis_id null malgré VALID_SETUP -> jamais SKIPPED_NO_CHANGE en base', results.valid_setup_no_persist.row.status === 'FAILED');
t('analysis_id null malgré VALID_SETUP -> HTTP 500 (jamais 200)', results.valid_setup_no_persist.httpStatus === 500);

console.log('--- VALID_SETUP + PERSISTANCE REUSSIE -> PROCESSED ---');
t('cas nominal -> status PROCESSED', results.valid_setup_ok.result.status === 'PROCESSED');
t('cas nominal -> ai_events.status = PROCESSED', results.valid_setup_ok.row.status === 'PROCESSED');
t('cas nominal -> HTTP 200', results.valid_setup_ok.httpStatus === 200);

console.log('--- IDEMPOTENCE D\'UN PROCESSED REEL ---');
t('1ère livraison -> PROCESSED, runCommittee appelé une fois', results.idempotent_processed.first.status === 'PROCESSED' && results.idempotent_processed.callsAfterFirst === 1);
t('2e livraison (même event_id) -> ALREADY_PROCESSED', results.idempotent_processed.second.status === 'ALREADY_PROCESSED');
t('2e livraison -> AUCUN second appel LLM', results.idempotent_processed.callsAfterSecond === 1);
t('2e livraison -> analysis_id réel restitué (pas null)', results.idempotent_processed.second.analysis_id === 'analysis-once');
t('3e livraison (HTTP) -> 200', results.idempotent_processed.httpStatus === 200);

console.log('--- ECHEC DE CLOTURE (INTEGRATION) -> FAILED MALGRE UNE ANALYSE VALIDE ---');
t('clôture PROCESSED en échec -> status FAILED renvoyé (jamais PROCESSED)', results.close_fail_integration.result.status === 'FAILED');
t('clôture en échec -> ligne ai_events reste RUNNING (récupérable comme orpheline)', results.close_fail_integration.row.status === 'RUNNING');
t('clôture en échec -> HTTP 500 (jamais 200) : news non acquittée', results.close_fail_integration.httpStatus === 500);

console.log('--- P0-B : DETECTION INITIALE D\'UNE PANNE FOURNISSEUR GLOBALE ---');
{
  const r = results.account_blocked_first_detection;
  t('ACCOUNT_BLOCKED -> EventResult.status = FAILED', r.result.status === 'FAILED');
  t('ACCOUNT_BLOCKED -> EventResult.providerFailure = ACCOUNT_BLOCKED', r.result.providerFailure === 'ACCOUNT_BLOCKED');
  t('ACCOUNT_BLOCKED -> ai_events.status = FAILED (rejouable, jamais un état EXPIRED)', r.row.status === 'FAILED');
  t('ACCOUNT_BLOCKED -> releaseLock persiste providers.anthropic.failure_kind = ACCOUNT_BLOCKED',
    r.release?.providers?.anthropic?.failure_kind === 'ACCOUNT_BLOCKED');
}
{
  const r = results.temporarily_unavailable_first_detection;
  t('TEMPORARILY_UNAVAILABLE -> EventResult.status = FAILED', r.result.status === 'FAILED');
  t('TEMPORARILY_UNAVAILABLE -> EventResult.providerFailure = TEMPORARILY_UNAVAILABLE', r.result.providerFailure === 'TEMPORARILY_UNAVAILABLE');
  t('TEMPORARILY_UNAVAILABLE -> releaseLock persiste providers.anthropic.failure_kind = TEMPORARILY_UNAVAILABLE',
    r.release?.providers?.anthropic?.failure_kind === 'TEMPORARILY_UNAVAILABLE');
}
{
  const r = results.success_clears_provider_state;
  t('run réussi -> EventResult.status = PROCESSED', r.result.status === 'PROCESSED');
  t('run réussi -> releaseLock relâche providers:{} (aucun état résiduel d\'un échec précédent)',
    r.release && Object.keys(r.release.providers ?? { x: 1 }).length === 0);
}

console.log('--- P0-B (BLOCKER 1) : PANNE DE TRANSPORT (status=0) SUIT LE MEME CONTRAT QU\'UN 429/5xx ---');
{
  const r = results.transport_failure_first_detection;
  t('panne transport -> EventResult.status = FAILED', r.result.status === 'FAILED');
  t('panne transport -> EventResult.providerFailure = TEMPORARILY_UNAVAILABLE', r.result.providerFailure === 'TEMPORARILY_UNAVAILABLE');
  t('panne transport -> ai_events.status = FAILED (rejouable)', r.row.status === 'FAILED');
  t('panne transport -> releaseLock persiste providers.anthropic.failure_kind = TEMPORARILY_UNAVAILABLE',
    r.release?.providers?.anthropic?.failure_kind === 'TEMPORARILY_UNAVAILABLE');
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
