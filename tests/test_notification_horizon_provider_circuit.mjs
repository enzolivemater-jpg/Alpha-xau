// XAU-V2-OPS-015 — couverture dédiée de la vue horizon (P0-A) et de la
// classification structurelle des échecs Anthropic (P0-B).
//
// Complète (et ne duplique pas) :
//   - tests/test_committee_internal_transport.mjs : isNotificationWithinHorizon()
//     et isProviderCircuitOpen() exercées à l'intérieur de notifyAiEngine()
//     (bornes 4h/24h, circuit 75min/20min, non-consommation du budget).
//   - tests/test_committee_event_retry_idempotency.mjs : propagation
//     AnthropicError.failureKind -> EventResult.providerFailure ->
//     releaseLock(providers.anthropic.failure_kind).
//
// Ce fichier prouve ce que les deux autres ne couvrent pas :
//   - database/migrations/0011_notification_horizon_guard.sql préserve EXACTEMENT
//     les prédicats/colonnes/tri de la migration 0003 et ajoute le bon garde-fou ;
//   - classifyAnthropicHttpFailure() (committee_orchestrator.ts) classe
//     correctement chaque forme de corps HTTP 400 ;
//   - callClaude() (globalThis.fetch remplacé par un stub synchrone,
//     déterministe) construit l'AnthropicError avec le failureKind attendu
//     pour 429 / 408 / 5xx / 529, et ne retente jamais un 400 déterministe ;
//   - XAU-V2-OPS-015 PR review, BLOCKER 1 : un abandon local (AbortError) ou
//     un échec de transport fetch (TypeError) sont classés
//     TEMPORARILY_UNAVAILABLE au même titre, jamais laissés fuir comme une
//     Error générique non typée, ET le retry/backoff normal reste préservé.
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const migration0011 = readFileSync(new URL('../database/migrations/0011_notification_horizon_guard.sql', import.meta.url), 'utf8');
const migration0003 = readFileSync(new URL('../database/migrations/0003_news_notification_tracking.sql', import.meta.url), 'utf8');
const committeeSource = readFileSync(new URL('../backend/ai_engine/committee_orchestrator.ts', import.meta.url), 'utf8');

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

/* ========================================================================
 * PARTIE 1 — MIGRATION 0011 : LA VUE PRÉSERVE 0003 ET AJOUTE L'HORIZON
 * ======================================================================== */
console.log('--- VIEW : migration 0011 préserve les prédicats/colonnes/tri de 0003 ---');
{
  const outputColumns0003 = /SELECT id, title, action, news_score, classification, ts, notify_attempts/;
  t('0003 expose bien la liste de colonnes de référence (fixture de test valide)',
    outputColumns0003.test(migration0003));
  t('0011 CREATE OR REPLACE la même vue (idempotente, pas de nouvelle table)',
    /CREATE OR REPLACE VIEW v_news_pending_notification AS/.test(migration0011));
  t('0011 préserve EXACTEMENT la liste de colonnes de sortie de 0003',
    outputColumns0003.test(migration0011));
  t('0011 préserve le prédicat action <> \'ARCHIVE_ONLY\'',
    /action <> 'ARCHIVE_ONLY'/.test(migration0011));
  t('0011 préserve le prédicat notified_at IS NULL',
    /notified_at IS NULL/.test(migration0011));
  t('0011 préserve la fenêtre de grâce ts < now() - interval \'90 seconds\'',
    /ts < now\(\) - INTERVAL '90 seconds'/.test(migration0011));
  t('0011 préserve le plafond notify_attempts < 10',
    /notify_attempts < 10/.test(migration0011));
  t('0011 préserve le tri ORDER BY news_score DESC, ts ASC',
    /ORDER BY news_score DESC, ts ASC/.test(migration0011));
  t('0011 réaffirme le GRANT SELECT existant (service_role, authenticated)',
    /GRANT SELECT ON v_news_pending_notification TO service_role, authenticated/.test(migration0011));
  t('0011 n\'introduit aucune nouvelle table (CREATE TABLE absent)',
    !/CREATE TABLE/i.test(migration0011));
  t('0011 n\'introduit aucun nouvel enum (CREATE TYPE absent)',
    !/CREATE TYPE/i.test(migration0011));
  t('0011 ne contient aucun UPDATE historique sur news_events',
    !/UPDATE\s+news_events/i.test(migration0011));
}

console.log('--- VIEW : garde-fou d\'horizon exact (RECALC_H1_H2 4h / REEVALUATE_H3 24h) ---');
{
  t('0011 ajoute le garde-fou RECALC_H1_H2 : ts >= now() - INTERVAL \'4 hours\'',
    /action = 'RECALC_H1_H2'[\s\S]{0,40}ts >= now\(\) - INTERVAL '4 hours'/.test(migration0011));
  t('0011 ajoute le garde-fou REEVALUATE_H3 : ts >= now() - INTERVAL \'24 hours\'',
    /action = 'REEVALUATE_H3'[\s\S]{0,40}ts >= now\(\) - INTERVAL '24 hours'/.test(migration0011));
  t('les deux branches d\'horizon sont combinées par OR (l\'une ou l\'autre suffit selon l\'action)',
    /RECALC_H1_H2'[\s\S]*?\)\s*\n\s*OR\s*\n\s*\(\s*\n\s*\(action = 'REEVALUATE_H3'/.test(migration0011)
    || /\)\s*OR\s*\(\s*action = 'REEVALUATE_H3'/.test(migration0011.replace(/\n/g, ' ').replace(/\s+/g, ' ')));
  t('aucun horizon codé en dur pour ARCHIVE_ONLY (déjà exclu par le prédicat existant, jamais un cas de la clause horizon)',
    !/action = 'ARCHIVE_ONLY'[\s\S]{0,60}INTERVAL/.test(migration0011));
}

/* ========================================================================
 * PARTIE 2 — CLASSIFICATION STRUCTURELLE DES ÉCHECS ANTHROPIC (P0-B)
 * ======================================================================== */
const classifySrc = extractBlock(committeeSource, /function classifyAnthropicHttpFailure\(bodyText: string\)/);
const callClaudeSrc = extractBlock(committeeSource, /async function callClaude\(/);
// callClaude() appelle errorMessage() (message de log ET, depuis BLOCKER 1,
// construction du message de l'AnthropicError classant une panne réseau) :
// requis dans le harnais, sans quoi son absence lève une ReferenceError
// interne au catch de callClaude, masquant le vrai test derrière un échec
// non lié à la classification.
const errorMessageSrc = extractBlock(committeeSource, /function errorMessage\(err: unknown\)/);
// AnthropicError utilise des "parameter properties" TypeScript
// (`constructor(message, readonly status, ...)`), syntaxe NON supportée par
// le mode "strip-only" de Node (cf. test_committee_event_retry_idempotency.mjs,
// même contrainte) : reproduite ici comme classe JS plate équivalente, jamais
// extraite verbatim pour cette seule raison mécanique.
const anthropicErrorClassSrc = `
class AnthropicError extends Error {
  constructor(message, status, retryable, retryAfterMs, failureKind) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status; this.retryable = retryable;
    this.retryAfterMs = retryAfterMs; this.failureKind = failureKind;
  }
}`;
const backoffDelaySrc = extractBlock(committeeSource, /function backoffDelay\(attempt: number\)/);
const parseRetryAfterSrc = extractBlock(committeeSource, /function parseRetryAfter\(header: string \| null\)/);
const redactStringSrc = extractBlock(committeeSource, /function redactString\(value: string\)/);
const sleepMatch = /const sleep = .*;/.exec(committeeSource);
if (!sleepMatch) throw new Error('sleep introuvable.');

console.log('--- PROVIDER CLASSIFICATION : classifyAnthropicHttpFailure() (fonction réelle, exécutée) ---');
const dir1 = mkdtempSync(join(tmpdir(), 'xau-ops015-classify-'));
const harnessPath1 = join(dir1, 'harness1.ts');
const harness1 = `
${redactStringSrc}
${classifySrc}

const results = {
  known_credit_balance: classifyAnthropicHttpFailure(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.' } })),
  known_credit_balance_variant: classifyAnthropicHttpFailure(JSON.stringify({ error: { type: 'invalid_request_error', message: 'insufficient credit balance for this request' } })),
  other_invalid_request: classifyAnthropicHttpFailure(JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens: 999999999 is too large for this model.' } })),
  wrong_error_type: classifyAnthropicHttpFailure(JSON.stringify({ error: { type: 'authentication_error', message: 'credit balance is too low' } })),
  non_json_body: classifyAnthropicHttpFailure('<html>not json</html>'),
  empty_body: classifyAnthropicHttpFailure(''),
};
process.stdout.write(JSON.stringify(results));
`;
writeFileSync(harnessPath1, harness1, 'utf8');
let classifyResults;
try {
  classifyResults = JSON.parse(execFileSync(process.execPath, [harnessPath1], { encoding: 'utf8' }));
} finally {
  rmSync(dir1, { recursive: true, force: true });
}

t('HTTP 400, invalid_request_error, message de solde de crédit connu -> ACCOUNT_BLOCKED',
  classifyResults.known_credit_balance === 'ACCOUNT_BLOCKED');
t('variante "insufficient credit" -> ACCOUNT_BLOCKED',
  classifyResults.known_credit_balance_variant === 'ACCOUNT_BLOCKED');
t('HTTP 400 invalid_request_error déterministe SANS rapport avec le crédit -> INVALID_REQUEST',
  classifyResults.other_invalid_request === 'INVALID_REQUEST');
t('message de crédit mais error.type différent de invalid_request_error -> INVALID_REQUEST (jamais supposé sans la structure exacte)',
  classifyResults.wrong_error_type === 'INVALID_REQUEST');
t('corps non-JSON -> INVALID_REQUEST (jamais ACCOUNT_BLOCKED sans preuve structurelle)',
  classifyResults.non_json_body === 'INVALID_REQUEST');
t('corps vide -> INVALID_REQUEST', classifyResults.empty_body === 'INVALID_REQUEST');

/* ========================================================================
 * PARTIE 3 — callClaude() AVEC globalThis.fetch REMPLACÉ (déterministe)
 * ======================================================================== */
console.log('--- PROVIDER CLASSIFICATION : callClaude() (fetch stubbé, 429/408/5xx/529/400) ---');

const dir2 = mkdtempSync(join(tmpdir(), 'xau-ops015-callclaude-'));
const harnessPath2 = join(dir2, 'harness2.ts');
const harness2 = `
// MAX_RETRIES=0 et MAX_JSON_REPAIRS=0 : on ne teste ici que la classification
// du PREMIER échec HTTP, jamais le comportement de retry (déjà hors périmètre
// de ce fichier) -- garde le test rapide et déterministe.
const CONFIG = {
  ANTHROPIC_URL: 'https://api.anthropic.invalid/v1/messages',
  ANTHROPIC_VERSION: '2023-06-01',
  HTTP_TIMEOUT_MS: 5000,
  MAX_RETRIES: 0,
  BACKOFF_BASE_MS: 1,
  BACKOFF_MAX_MS: 1,
  MAX_RETRY_AFTER_MS: 30000,
  MAX_JSON_REPAIRS: 0,
};
const AGENT_PROMPTS = { macro_analyst: 'system prompt de test' };
${sleepMatch[0]}
${redactStringSrc}
${errorMessageSrc}
${parseRetryAfterSrc}
${backoffDelaySrc}
${anthropicErrorClassSrc}
${classifySrc}
const Logger_calls = [];
class Logger {
  warn(m, c) { Logger_calls.push({ level: 'warn', m, c }); }
  info() {}
  error(m, c) { Logger_calls.push({ level: 'error', m, c }); }
}

// callClaude() n'appelle QUE globalThis.fetch (jamais node:http) : le
// remplacer directement est fidèle au chemin réel, sans I/O réseau ni
// serveur à faire vivre entre deux processus -- déterministe et rapide.
const RESPONSES = {
  ratelimit: { status: 429, body: { error: { type: 'rate_limit_error', message: 'rate limited' } } },
  timeout_like_408: { status: 408, body: { error: { type: 'timeout_error', message: 'request timeout' } } },
  server_error: { status: 500, body: { error: { type: 'api_error', message: 'internal' } } },
  overloaded_529: { status: 529, body: { error: { type: 'overloaded_error', message: 'overloaded' } } },
  credit_400: { status: 400, body: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.' } } },
  other_400: { status: 400, body: { error: { type: 'invalid_request_error', message: 'max_tokens is too large' } } },
};
// XAU-V2-OPS-015 PR review, BLOCKER 1 : fetch() ne renvoie PAS une réponse
// HTTP pour ces deux cas -- il REJETTE. AbortError provient de
// controller.abort() (timeout local) ; TypeError est la valeur de rejet
// IMPOSÉE par la spec WHATWG fetch pour toute "network error" (DNS,
// connexion refusée, etc. -- jamais un autre type de valeur).
const THROWERS = {
  abort_error: () => {
    const e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    throw e;
  },
  network_type_error: () => { throw new TypeError('fetch failed'); },
};
let __fetchMode = null;
let __fetchCallCount = 0;
globalThis.fetch = async (_url, _opts) => {
  __fetchCallCount++;
  if (THROWERS[__fetchMode]) return THROWERS[__fetchMode]();
  const fixture = RESPONSES[__fetchMode];
  return new Response(JSON.stringify(fixture.body), {
    status: fixture.status,
    headers: { 'content-type': 'application/json' },
  });
};

${callClaudeSrc}

const env = { ANTHROPIC_API_KEY: 'test-key' };
const results = {};
for (const name of Object.keys(RESPONSES)) {
  __fetchMode = name;
  try {
    await callClaude('macro_analyst', 'claude-test', 'ping', 16, env, new Logger());
    results[name] = { threw: false };
  } catch (err) {
    results[name] = {
      threw: true,
      status: err.status,
      retryable: err.retryable,
      failureKind: err.failureKind,
      isAnthropicError: err.name === 'AnthropicError',
    };
  }
}

// AbortError / TypeError réseau : mêmes assertions, avec MAX_RETRIES=0 (le
// premier échec suffit à prouver la classification).
for (const name of Object.keys(THROWERS)) {
  __fetchMode = name;
  __fetchCallCount = 0;
  try {
    await callClaude('macro_analyst', 'claude-test', 'ping', 16, env, new Logger());
    results[name] = { threw: false };
  } catch (err) {
    results[name] = {
      threw: true,
      status: err.status,
      retryable: err.retryable,
      failureKind: err.failureKind,
      isAnthropicError: err.name === 'AnthropicError',
      fetchCallCount: __fetchCallCount,
    };
  }
}

// Préserve le comportement normal de retry/backoff : une panne réseau
// classée TEMPORARILY_UNAVAILABLE continue de réessayer MAX_RETRIES fois
// avant d'abandonner (jamais un abandon immédiat introduit par ce correctif).
{
  __fetchMode = 'network_type_error';
  __fetchCallCount = 0;
  CONFIG.MAX_RETRIES = 2;
  try {
    await callClaude('macro_analyst', 'claude-test', 'ping', 16, env, new Logger());
    results.network_retry_preserved = { threw: false };
  } catch (err) {
    results.network_retry_preserved = {
      threw: true,
      fetchCallCount: __fetchCallCount,
      failureKind: err.failureKind,
      isAnthropicError: err.name === 'AnthropicError',
    };
  }
  CONFIG.MAX_RETRIES = 0;
}

process.stdout.write(JSON.stringify(results));
process.exit(0);
`;
writeFileSync(harnessPath2, harness2, 'utf8');

let callClaudeResults;
try {
  callClaudeResults = JSON.parse(execFileSync(process.execPath, [harnessPath2], { encoding: 'utf8', timeout: 20000 }));
} finally {
  rmSync(dir2, { recursive: true, force: true });
}

t('429 (rate limit) -> AnthropicError retryable, failureKind=TEMPORARILY_UNAVAILABLE',
  callClaudeResults.ratelimit.threw && callClaudeResults.ratelimit.status === 429
  && callClaudeResults.ratelimit.retryable === true
  && callClaudeResults.ratelimit.failureKind === 'TEMPORARILY_UNAVAILABLE');
t('408 (timeout serveur) -> failureKind=TEMPORARILY_UNAVAILABLE',
  callClaudeResults.timeout_like_408.status === 408
  && callClaudeResults.timeout_like_408.failureKind === 'TEMPORARILY_UNAVAILABLE');
t('500 (erreur serveur) -> failureKind=TEMPORARILY_UNAVAILABLE',
  callClaudeResults.server_error.status === 500
  && callClaudeResults.server_error.failureKind === 'TEMPORARILY_UNAVAILABLE');
t('529 (surcharge) -> failureKind=TEMPORARILY_UNAVAILABLE',
  callClaudeResults.overloaded_529.status === 529
  && callClaudeResults.overloaded_529.failureKind === 'TEMPORARILY_UNAVAILABLE');
t('400 crédit épuisé (signature exacte production) -> failureKind=ACCOUNT_BLOCKED, NON rejouable',
  callClaudeResults.credit_400.status === 400
  && callClaudeResults.credit_400.retryable === false
  && callClaudeResults.credit_400.failureKind === 'ACCOUNT_BLOCKED');
t('400 déterministe SANS rapport avec le crédit -> failureKind=INVALID_REQUEST, NON rejouable',
  callClaudeResults.other_400.status === 400
  && callClaudeResults.other_400.retryable === false
  && callClaudeResults.other_400.failureKind === 'INVALID_REQUEST');
t('tous les échecs restent des instances AnthropicError (jamais une exception générique)',
  Object.values(callClaudeResults).every((r) => r.isAnthropicError === true));

console.log('--- PROVIDER CLASSIFICATION (BLOCKER 1) : ABORT / RESEAU RESTENT AnthropicError, TEMPORARILY_UNAVAILABLE ---');
t('AbortError (timeout local) -> reste AnthropicError, failureKind=TEMPORARILY_UNAVAILABLE, status=0 (sentinel, aucune réponse HTTP)',
  callClaudeResults.abort_error.threw
  && callClaudeResults.abort_error.isAnthropicError === true
  && callClaudeResults.abort_error.status === 0
  && callClaudeResults.abort_error.retryable === true
  && callClaudeResults.abort_error.failureKind === 'TEMPORARILY_UNAVAILABLE');
t('TypeError réseau (fetch échoué) -> reste AnthropicError, failureKind=TEMPORARILY_UNAVAILABLE, status=0',
  callClaudeResults.network_type_error.threw
  && callClaudeResults.network_type_error.isAnthropicError === true
  && callClaudeResults.network_type_error.status === 0
  && callClaudeResults.network_type_error.retryable === true
  && callClaudeResults.network_type_error.failureKind === 'TEMPORARILY_UNAVAILABLE');
t('panne réseau -> le retry/backoff normal reste préservé (MAX_RETRIES=2 -> 3 tentatives fetch), échec final toujours classé',
  callClaudeResults.network_retry_preserved.threw
  && callClaudeResults.network_retry_preserved.fetchCallCount === 3
  && callClaudeResults.network_retry_preserved.isAnthropicError === true
  && callClaudeResults.network_retry_preserved.failureKind === 'TEMPORARILY_UNAVAILABLE');

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
