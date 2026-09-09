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
  const braceStart = src.indexOf('{', searchFrom);
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
  __handleCommitteeEventImpl = async (notification) => ({ status: 'PROCESSED', event_id: notification.event_id, event_type: notification.event_type, scope: 'H1_H2', horizons_recalculated: [], analysis_id: 'a-only', errors: [] });
  const log = makeLog();
  const events = [
    { id: 'low', action: 'REEVALUATE_H3', score: 65 },
    { id: 'high', action: 'RECALC_H1_H2', score: 95 },
    { id: 'mid', action: 'RECALC_H1_H2', score: 80 },
  ];
  const outcome = await notifyAiEngine(events, baseEnv, log);
  results.cost_guard = { outcome, callCount: __handleCommitteeEventCallCount };
}

// 11. notifyAiEngine : tentative unique en échec -> attempted mais pas delivered ;
//     le reste toujours différé (jamais confondu avec un échec).
{
  __handleCommitteeEventCallCount = 0;
  __handleCommitteeEventImpl = async () => ({ status: 'FAILED', event_id: 'x', event_type: 'RECALC_H1_H2', scope: 'H1_H2', horizons_recalculated: [], analysis_id: null, errors: ['simulé'] });
  const log = makeLog();
  const events = [
    { id: 'best', action: 'RECALC_H1_H2', score: 90 },
    { id: 'second', action: 'RECALC_H1_H2', score: 85 },
  ];
  const outcome = await notifyAiEngine(events, baseEnv, log);
  results.cost_guard_failed = { outcome, callCount: __handleCommitteeEventCallCount };
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
t('ANTHROPIC_API_KEY absente -> non délivré', results.no_anthropic_key.ok === false);
t('ANTHROPIC_API_KEY absente -> handleCommitteeEvent jamais appelé', results.no_anthropic_key.callCount === 0);
t('ANTHROPIC_API_KEY absente -> avertissement journalisé', results.no_anthropic_key.calls.some((c) => c.level === 'warn'));

console.log('--- MAPPING STATUT -> ACQUITTEMENT (jamais un proxy HTTP) ---');
const expectDelivered = { PROCESSED: true, ALREADY_PROCESSED: true, ALREADY_RUNNING: false, FAILED: false, DATA_UNAVAILABLE: false, INVALID_EVENT: false };
for (const [status, expected] of Object.entries(expectDelivered)) {
  const r = results['status_' + status];
  t(`${status} -> ${expected ? 'délivré' : 'NON délivré'}`, r.ok === expected, `got ${r.ok}`);
}

console.log('--- EXCEPTION COMITE : NON DELIVRE, AUCUNE FUITE ---');
t('exception levée -> non délivré', results.thrown.ok === false);
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
