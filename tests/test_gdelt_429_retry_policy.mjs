// XAU-V2-OPS-020 — GDELT 429 doit échouer sur la première tentative, sans
// retry ni backoff dans le cycle courant (le quota par IP GDELT est un état
// normal, pas une panne transitoire ; la cadence cron de 15 min est déjà le
// mécanisme de nouvel essai adapté). Tous les autres échecs (5xx/408/réseau/
// timeout/JSON invalide) et TOUS les autres collecteurs (NewsAPI en
// particulier) doivent conserver EXACTEMENT leur comportement de retry
// historique — c'est le point précis que ce fichier prouve par exécution
// réelle, pas par lecture de source seule.
//
// Fonctions RÉELLEMENT exercées (extraites verbatim de backend/ingest.ts,
// exécutées via le "type stripping" natif de Node >= 22.6, même philosophie
// que tests/test_notification_horizon_provider_circuit.mjs) :
//   - fetchJsonWithRetry() (le mécanisme partagé modifié par OPS-020)
//   - collectGdelt() / collectNewsApi() (les deux seuls appelants)
//   - parseRetryAfter() / backoffDelay() / cleanText() / dedupKeyOf() /
//     stripPublisherSuffix() / parseTimestamp() / extractDomain() /
//     errorMessage() / redact() / redactString()
//
// globalThis.fetch est remplacé par un stub synchrone et déterministe
// (jamais de vrai réseau ni de serveur HTTP à faire vivre entre deux
// processus) : mêmes leçons que le correctif OPS-015 (callClaude).
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const ingestSource = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');

function extractBlock(src, startRegex) {
  const m = startRegex.exec(src);
  if (!m) throw new Error(`extraction introuvable pour ${startRegex}`);
  const start = m.index;
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
  t('fetchJsonWithRetry() accepte un paramètre policy optionnel (RetryPolicy)',
    /policy: RetryPolicy = \{\}/.test(ingestSource));
  t('RetryPolicy.retryOn429 par défaut à true (aucun changement pour les appelants existants)',
    /const retryOn429 = policy\.retryOn429 \?\? true;/.test(ingestSource));
  t('collectGdelt() appelle fetchJsonWithRetry avec { retryOn429: false }',
    /'GDELT',\s*\n\s*CONFIG\.GDELT_TIMEOUT_MS,\s*\n[\s\S]{0,300}\{ retryOn429: false \}/.test(ingestSource));
  const collectNewsApiSrc = extractBlock(ingestSource, /async function collectNewsApi\(/);
  t('collectNewsApi() n\'utilise AUCUN policy override (comportement 429 inchangé)',
    !/retryOn429/.test(collectNewsApiSrc));
  t('la branche 5xx/408 ne référence jamais retryOn429 (seul le 429 est concerné)',
    !/response\.status >= 500[\s\S]{0,150}retryOn429/.test(ingestSource));
  const rawCollectorFiles = [
    '../backend/news_sources/federal_reserve.ts',
    '../backend/news_sources/ecb.ts',
    '../backend/news_sources/us_treasury.ts',
    '../backend/news_sources/ofac.ts',
  ];
  for (const relPath of rawCollectorFiles) {
    const src = readFileSync(new URL(relPath, import.meta.url), 'utf8');
    t(`${relPath.split('/').pop()} ne référence ni RetryPolicy ni retryOn429 (changement localisé à ingest.ts)`,
      !/RetryPolicy|retryOn429/.test(src));
  }
}

const fetchJsonWithRetrySrc = extractBlock(ingestSource, /async function fetchJsonWithRetry<T>\(/);
const collectGdeltSrc = extractBlock(ingestSource, /async function collectGdelt\(/);
const collectNewsApiSrc = extractBlock(ingestSource, /async function collectNewsApi\(/);
const parseRetryAfterSrc = extractBlock(ingestSource, /function parseRetryAfter\(header: string \| null\)/);
const backoffDelaySrc = extractBlock(ingestSource, /function backoffDelay\(attempt: number\)/);
const cleanTextSrc = extractBlock(ingestSource, /function cleanText\(/);
const stripPublisherSuffixSrc = extractBlock(ingestSource, /function stripPublisherSuffix\(/);
const dedupKeyOfSrc = extractBlock(ingestSource, /function dedupKeyOf\(/);
const parseTimestampSrc = extractBlock(ingestSource, /function parseTimestamp\(/);
const extractDomainSrc = extractBlock(ingestSource, /function extractDomain\(/);
const errorMessageSrc = extractBlock(ingestSource, /function errorMessage\(err: unknown\)/);
const redactStringSrc = extractBlock(ingestSource, /function redactString\(value: string\)/);
const redactSrc = extractBlock(ingestSource, /function redact\(input: unknown, depth = 0\)/);
const secretKeyPatternMatch = /const SECRET_KEY_PATTERN = .*;/.exec(ingestSource);
if (!secretKeyPatternMatch) throw new Error('SECRET_KEY_PATTERN introuvable.');

// GDELT_QUERY / NEWSAPI_QUERY sont des constantes CHAÎNE (aucune accolade) :
// extractBlock (conçu pour interface/function/const-objet, qui cherche une
// accolade `{` à balancer) ne s'applique pas ici -- il continuerait à
// chercher la première accolade venant APRÈS la chaîne, tombant sur le type
// de retour `Promise<{...}>` de collectGdelt et y capturant un fragment
// mêlé. Extraction dédiée, plus simple : jusqu'au premier `;` (aucune des
// deux chaînes ne contient de point-virgule littéral).
function extractConst(src, name) {
  const re = new RegExp(`const ${name} =[\\s\\S]*?;`);
  const m = re.exec(src);
  if (!m) throw new Error(`extraction introuvable pour ${name}`);
  return m[0];
}
const gdeltQuerySrc = extractConst(ingestSource, 'GDELT_QUERY');
const newsapiQuerySrc = extractConst(ingestSource, 'NEWSAPI_QUERY');
const configSrc = extractBlock(ingestSource, /^const CONFIG = \{/m);

console.log('--- EXECUTION REELLE (fonctions extraites verbatim, fetch stubbé) ---');
const dir = mkdtempSync(join(tmpdir(), 'xau-ops020-'));
const harnessPath = join(dir, 'harness.ts');

const harness = `
// Force le parsing ESM (top-level await utilisé plus bas) : aucune des
// fonctions extraites verbatim de ce fichier n'est "export"ée dans le
// source d'origine (toutes privées au module), donc rien ne déclenche
// naturellement la détection ESM de Node sur un .ts sans package.json.
export {};
${configSrc}
// Rapide et déterministe pour les tests : backoff quasi nul, plafond de
// Retry-After large (aucun scénario testé ici n'a l'intention de le
// déclencher), MAX_RETRIES inchangé (3, valeur réelle de production).
CONFIG.BACKOFF_BASE_MS = 1;
CONFIG.BACKOFF_MAX_MS = 1;
CONFIG.MAX_RETRY_AFTER_MS = 999999;

${secretKeyPatternMatch[0]}
${redactStringSrc}
${redactSrc}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${errorMessageSrc}
${extractDomainSrc}
${cleanTextSrc}
${stripPublisherSuffixSrc}
${dedupKeyOfSrc}
${parseTimestampSrc}
${parseRetryAfterSrc}
${backoffDelaySrc}

// HttpError utilise des "parameter properties" TypeScript (syntaxe NON
// supportée par le mode "strip-only" de Node) : reproduite ici comme classe
// JS plate équivalente, jamais extraite verbatim pour cette seule raison
// mécanique (même contrainte que AnthropicError, cf. OPS-015).
class HttpError extends Error {
  constructor(message, status, retryable, retryAfterMs) {
    super(message);
    this.name = 'HttpError';
    this.status = status; this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}
class TimeoutError extends Error {
  constructor(ms) {
    super('Timeout après ' + ms + 'ms');
    this.name = 'TimeoutError';
  }
}

const logCalls = [];
class Logger {
  constructor(_level, _runId) {}
  debug(m, c) { logCalls.push({ level: 'debug', m, c }); }
  info(m, c) { logCalls.push({ level: 'info', m, c }); }
  warn(m, c) { logCalls.push({ level: 'warn', m, c }); }
  error(m, c) { logCalls.push({ level: 'error', m, c }); }
}

${gdeltQuerySrc}
${newsapiQuerySrc}
${fetchJsonWithRetrySrc}
${collectGdeltSrc}
${collectNewsApiSrc}

// ---- fetch() stubbé : compte les appels, rejoue le scénario configuré ----
let __fetchCallCount = 0;
let __fetchScenario = null;
globalThis.fetch = async (_url, _opts) => {
  __fetchCallCount++;
  return __fetchScenario();
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const results = {};

// 1. GDELT 429 -> UNE seule tentative, AUCUN retry, report.ok=false, retries=0.
{
  __fetchCallCount = 0;
  __fetchScenario = () => jsonResponse(429, { error: 'rate limited' });
  const { report } = await collectGdelt({}, new Logger());
  results.gdelt_429 = { report, fetchCallCount: __fetchCallCount };
}

// 2. GDELT 500 -> comportement de retry HISTORIQUE préservé (MAX_RETRIES s'applique).
{
  __fetchCallCount = 0;
  __fetchScenario = () => jsonResponse(500, { error: 'internal' });
  const { report } = await collectGdelt({}, new Logger());
  results.gdelt_500 = { report, fetchCallCount: __fetchCallCount };
}

// 3. GDELT timeout/réseau -> retry HISTORIQUE préservé. On simule un échec de
//    transport fetch (TypeError, valeur de rejet imposée par la spec WHATWG
//    fetch pour une "network error") -- jamais une vraie attente de 20s.
{
  __fetchCallCount = 0;
  __fetchScenario = () => { throw new TypeError('fetch failed'); };
  const { report } = await collectGdelt({}, new Logger());
  results.gdelt_network = { report, fetchCallCount: __fetchCallCount };
}

// 3bis. GDELT réponse non-JSON en 200 -> retryable (comportement historique),
//       distinct du cas 429 : preuve que SEUL le 429 est désormais non-retryable.
{
  __fetchCallCount = 0;
  __fetchScenario = () => new Response('<html>captcha</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const { report } = await collectGdelt({}, new Logger());
  results.gdelt_non_json = { report, fetchCallCount: __fetchCallCount };
}

// 4. NewsAPI 429 -> comportement générique de retry HISTORIQUE préservé
//    (collectNewsApi ne passe AUCUN override de policy).
{
  __fetchCallCount = 0;
  __fetchScenario = () => jsonResponse(429, { status: 'error', code: 'rateLimited' });
  const { report } = await collectNewsApi({ NEWSAPI_KEY: 'test-key' }, new Logger());
  results.newsapi_429 = { report, fetchCallCount: __fetchCallCount };
}

// 5. GDELT succès nominal -> comportement inchangé (chemin non affecté par OPS-020).
{
  __fetchCallCount = 0;
  __fetchScenario = () => jsonResponse(200, {
    articles: [{ title: 'Gold rallies on Fed rate cut bets', seendate: '20260913T120000Z', url: 'https://reuters.com/x', domain: 'reuters.com' }],
  });
  const { articles, report } = await collectGdelt({}, new Logger());
  results.gdelt_success = { articleCount: articles.length, report, fetchCallCount: __fetchCallCount };
}

process.stdout.write(JSON.stringify(results));
process.exit(0);
`;

writeFileSync(harnessPath, harness, 'utf8');

let output;
try {
  const raw = execFileSync(process.execPath, [harnessPath], { encoding: 'utf8', timeout: 30000 });
  output = JSON.parse(raw);
} catch (err) {
  t('exécution du harnais isolé (fonctions réelles extraites de ingest.ts)', false, String(err));
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('--- GDELT 429 : UNE SEULE TENTATIVE, AUCUN RETRY (XAU-V2-OPS-020) ---');
{
  const r = output.gdelt_429;
  t('exactement 1 appel fetch() (aucun retry)', r.fetchCallCount === 1, `got ${r.fetchCallCount}`);
  t('report.ok = false', r.report.ok === false);
  t('report.retries = 0 (jamais un faux compte de tentatives)', r.report.retries === 0, `got ${r.report.retries}`);
  t('report.error mentionne le rate limit', /rate limited/i.test(r.report.error ?? ''));
}

console.log('--- GDELT 500 : RETRY HISTORIQUE PRESERVE ---');
{
  const r = output.gdelt_500;
  t('4 appels fetch() au total (1 + 3 retries = CONFIG.MAX_RETRIES)', r.fetchCallCount === 4, `got ${r.fetchCallCount}`);
  t('report.ok = false', r.report.ok === false);
}

console.log('--- GDELT RESEAU/TIMEOUT : RETRY HISTORIQUE PRESERVE ---');
{
  const r = output.gdelt_network;
  t('4 appels fetch() au total (retry réseau inchangé)', r.fetchCallCount === 4, `got ${r.fetchCallCount}`);
  t('report.ok = false', r.report.ok === false);
}

console.log('--- GDELT NON-JSON (200) : RETRY HISTORIQUE PRESERVE (distinct du 429) ---');
{
  const r = output.gdelt_non_json;
  t('4 appels fetch() au total (JSON invalide toujours retryable)', r.fetchCallCount === 4, `got ${r.fetchCallCount}`);
  t('report.ok = false', r.report.ok === false);
}

console.log('--- NEWSAPI 429 : COMPORTEMENT GENERIQUE INCHANGE (retryable) ---');
{
  const r = output.newsapi_429;
  t('4 appels fetch() au total (NewsAPI 429 reste retryable, comportement historique)', r.fetchCallCount === 4, `got ${r.fetchCallCount}`);
  t('report.ok = false', r.report.ok === false);
}

console.log('--- GDELT SUCCES NOMINAL : CHEMIN NON AFFECTE ---');
{
  const r = output.gdelt_success;
  t('1 seul appel fetch() (succès du premier coup)', r.fetchCallCount === 1);
  t('report.ok = true', r.report.ok === true);
  t('1 article conservé', r.articleCount === 1);
  t('report.retries = 0', r.report.retries === 0);
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
