// Preuve par lecture de source + exécution réelle isolée : le correctif
// XAU-V2-OPS-004 ajoute la journalisation du code HTTP exact (et une
// catégorie fixe) quand postNotification() reçoit une réponse non-2xx,
// sans jamais toucher à l'authentification, aux en-têtes, au corps ou à
// l'URL. Même philosophie que test_ofac_raw_integration.mjs (lecture de
// backend/ingest.ts), étendue ici par une exécution réelle des fonctions
// extraites verbatim de la source (via le "type stripping" natif de
// Node >= 22.6 sur des fonctions autonomes, sans classes à propriétés de
// paramètres — donc sans dépendre d'un pipeline de build).
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const source = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');

function extractFunction(src, signatureRegex) {
  const m = signatureRegex.exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0;
  let i = src.indexOf('{', start);
  const braceStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const categorizeSrc = extractFunction(source, /function categorizeHttpFailure\(status: number\)/);
const postNotificationSrc = extractFunction(source, /async function postNotification\(/);
const errorMessageSrc = extractFunction(source, /function errorMessage\(err: unknown\)/);
const redactStringSrc = extractFunction(source, /function redactString\(value: string\)/);

console.log('--- CONTRAT STATIQUE (lecture de source) ---');
{
  t('categorizeHttpFailure() présente dans ingest.ts', !!categorizeSrc);
  t('postNotification() présente dans ingest.ts', !!postNotificationSrc);
  t('le retour response.ok est préservé tel quel', /return response\.ok;/.test(postNotificationSrc));
  t('le bloc catch (exception fetch) est inchangé : reason: errorMessage(err) uniquement',
    /catch \(err\) \{\s*log\.warn\('Notification du moteur IA en échec', \{ reason: errorMessage\(err\) \}\);/.test(postNotificationSrc));
  t('le nouveau log ne se déclenche que sur !response.ok', /if \(!response\.ok\) \{[\s\S]*?log\.warn\(/.test(postNotificationSrc));
  t('le nouveau log transmet http_status', /http_status:\s*response\.status/.test(postNotificationSrc));
  t('le nouveau log transmet une catégorie dérivée du statut', /http_status_category:\s*categorizeHttpFailure\(response\.status\)/.test(postNotificationSrc));

  // La requête sortante elle-même (méthode, en-têtes, authentification,
  // corps) ne doit strictement rien avoir changé par rapport à l'existant.
  t('méthode POST inchangée', /method: 'POST'/.test(postNotificationSrc));
  t('en-tête authorization inchangé (Bearer AI_ENGINE_TOKEN, coupling existant)',
    /authorization: `Bearer \$\{env\.AI_ENGINE_TOKEN\}`/.test(postNotificationSrc));
  t('corps JSON.stringify(notification) inchangé', /body: JSON\.stringify\(notification\)/.test(postNotificationSrc));
  t('AbortController / timeout inchangés', /new AbortController\(\)/.test(postNotificationSrc) && /CONFIG\.HTTP_TIMEOUT_MS/.test(postNotificationSrc));

  // Rien de sensible ne doit apparaître dans l'objet passé au nouveau log.
  const newLogBlockMatch = /if \(!response\.ok\) \{([\s\S]*?)\}\s*\n\s*return response\.ok;/.exec(postNotificationSrc);
  const newLogBlock = newLogBlockMatch ? newLogBlockMatch[1] : '';
  t('bloc du nouveau log isolé pour inspection', newLogBlock.length > 0);
  for (const forbidden of ['body', 'headers', 'authorization', 'Authorization', 'AI_ENGINE_TOKEN', 'COMMITTEE_TOKEN', 'response.text', 'response.json', 'env.AI_ENGINE_URL', 'notification']) {
    t(`le nouveau log ne référence jamais "${forbidden}"`, !newLogBlock.includes(forbidden));
  }
}

console.log('--- EXECUTION REELLE (fonctions extraites verbatim, mockées) ---');
const dir = mkdtempSync(join(tmpdir(), 'xau-ops004-'));
const harnessPath = join(dir, 'harness.ts');
const CONFIG_TIMEOUT = Number(/HTTP_TIMEOUT_MS:\s*([\d_]+)/.exec(source)[1].replace(/_/g, ''));

const harness = `
const CONFIG = { HTTP_TIMEOUT_MS: ${CONFIG_TIMEOUT} };

${redactStringSrc}
${errorMessageSrc}
${categorizeSrc}
${postNotificationSrc}

const calls = [];
function makeLog() {
  return {
    warn(message, context) { calls.push({ level: 'warn', message, context }); },
    info() {}, debug() {}, error() {},
  };
}

const FAKE_TOKEN = 'unit-test-fake-token-not-a-secret';
const FAKE_URL = 'https://example.invalid/committee';
const notification = {
  event_id: 'news:test:RECALC_H1_H2', event_type: 'RECALC_H1_H2', source: 'test',
  triggered_at: new Date().toISOString(), news_event_id: 'test-id', news_score: 90,
};
const env = { AI_ENGINE_URL: FAKE_URL, AI_ENGINE_TOKEN: FAKE_TOKEN };

const originalFetch = globalThis.fetch;
async function withMockedFetch(impl, fn) {
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = originalFetch; }
}

const results = {};

for (const status of [200, 400, 401, 503, 500]) {
  calls.length = 0;
  const ok = await withMockedFetch(
    async () => new Response(null, { status }),
    () => postNotification(notification, env, makeLog()),
  );
  results['status_' + status] = { ok, calls: JSON.parse(JSON.stringify(calls)) };
}

calls.length = 0;
const thrownResult = await withMockedFetch(
  async () => { throw new TypeError('network unreachable (simulated)'); },
  () => postNotification(notification, env, makeLog()),
);
results.thrown = { ok: thrownResult, calls: JSON.parse(JSON.stringify(calls)) };

process.stdout.write(JSON.stringify({ results, FAKE_TOKEN, FAKE_URL }));
`;

writeFileSync(harnessPath, harness, 'utf8');

let output;
try {
  const { execFileSync } = await import('node:child_process');
  const raw = execFileSync(process.execPath, [harnessPath], { encoding: 'utf8' });
  output = JSON.parse(raw);
} catch (err) {
  t('exécution du harnais isolé (fonctions réelles extraites de ingest.ts)', false, String(err));
  console.log(`\nRESULT: ${p} passed, ${f} failed`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const { results, FAKE_TOKEN, FAKE_URL } = output;

const expect = {
  status_200: { ok: true, warned: false },
  status_400: { ok: false, warned: true, status: 400, category: 'client_error' },
  status_401: { ok: false, warned: true, status: 401, category: 'client_error' },
  status_503: { ok: false, warned: true, status: 503, category: 'server_error' },
  status_500: { ok: false, warned: true, status: 500, category: 'server_error' },
};

for (const [key, exp] of Object.entries(expect)) {
  const r = results[key];
  t(`${key} -> retour ${exp.ok}`, r.ok === exp.ok, `got ${r.ok}`);
  if (!exp.warned) {
    t(`${key} -> aucun log.warn émis`, r.calls.length === 0, JSON.stringify(r.calls));
  } else {
    const call = r.calls[0];
    t(`${key} -> un seul log.warn émis`, r.calls.length === 1, String(r.calls.length));
    t(`${key} -> message opérationnel fixe`, call && call.message === 'Notification du moteur IA rejetée par le comité');
    t(`${key} -> http_status = ${exp.status}`, call && call.context && call.context.http_status === exp.status);
    t(`${key} -> catégorie = ${exp.category}`, call && call.context && call.context.http_status_category === exp.category);
  }
}

console.log('--- FETCH LEVE UNE EXCEPTION : comportement existant préservé ---');
{
  const r = results.thrown;
  t('exception fetch -> retour false (inchangé)', r.ok === false);
  t('exception fetch -> un seul log.warn (chemin existant)', r.calls.length === 1);
  t('exception fetch -> message existant inchangé', r.calls[0] && r.calls[0].message === 'Notification du moteur IA en échec');
  t('exception fetch -> pas de champ http_status (chemin distinct du nouveau code)',
    r.calls[0] && !Object.prototype.hasOwnProperty.call(r.calls[0].context ?? {}, 'http_status'));
}

console.log('--- AUCUNE DONNEE SENSIBLE DANS AUCUN LOG (sur les 6 scenarios) ---');
{
  const allCalls = Object.values(results).flatMap((r) => r.calls);
  t('au moins un log capturé pour l\'assertion', allCalls.length > 0);
  const serialized = JSON.stringify(allCalls);
  t('le token AI_ENGINE_TOKEN n\'apparaît dans aucun log', !serialized.includes(FAKE_TOKEN));
  t('le mot "Bearer" n\'apparaît dans aucun log', !serialized.includes('Bearer'));
  t('l\'URL complète n\'apparaît dans aucun log', !serialized.includes(FAKE_URL));
  t('aucune clé "headers" dans aucun contexte de log', !serialized.includes('"headers"'));
  t('aucune clé "body" dans aucun contexte de log', !serialized.includes('"body"'));
  t('aucune clé "authorization" dans aucun contexte de log', !/authorization/i.test(serialized));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
