/**
 * PostgREST clients: the request timeout must cover the response BODY, not only
 * the headers. A server that sends the status line and headers and then stalls
 * the body would otherwise hang the caller for ever, and with it the run lock
 * (released only by the 15-minute stale reclaim). The clock is simulated
 * (node:test mock timers) and the response body is a stream that never ends and
 * errors only when the request is aborted. For each client, on a 200 and on an
 * error status, the call must settle (reject) once the timeout elapses.
 * Offline: no network, no real clock.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ei = await loadBackendModule('event_impact/shadow_runtime.ts');
const gt = await loadBackendModule('gold_transmission/shadow_runtime.ts');
const es = await loadBackendModule('event_engine/shadow_runtime.ts');
const market = await loadBackendModule('market_engine/ingest_market.ts');

const env = {
  SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-ZZ', INGEST_TOKEN: 'ingest-secret-ZZ',
  ANTHROPIC_API_KEY: 'x', COMMITTEE_TOKEN: 'y',
};
const CLIENTS = [
  ['event impact shadow', () => new ei.PostgrestEventImpactShadowDb(env)],
  ['gold transmission shadow', () => new gt.PostgrestGoldTransmissionShadowDb(env)],
  ['event shadow', () => new es.PostgrestEventShadowDb(env)],
  ['market engine', () => new market.MarketDb(env)],
];
const STATUSES = [200, 400];

const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init = {}) => {
  const status = globalThis.__stalledStatus;
  const body = new ReadableStream({
    start(controller) {
      // Never delivers a byte; errors only when the caller's timeout aborts the request.
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
};
mock.timers.enable({ apis: ['setTimeout'] });

const flush = () => new Promise((resolve) => setImmediate(resolve));
let lastSteps = 0;
async function settle(promise, maxSteps = 40) {
  let state = 'PENDING';
  promise.then(() => { state = 'RESOLVED'; }, () => { state = 'REJECTED'; });
  // Advance the simulated clock in 20 s steps, covering the timeout and any retry back-off.
  let step = 0;
  for (; step < maxSteps && state === 'PENDING'; step += 1) {
    await flush();
    mock.timers.tick(20_000);
    await flush();
  }
  lastSteps = step;
  await flush();
  return state;
}

const failures = [];
for (const [name, make] of CLIENTS) {
  for (const status of STATUSES) {
    globalThis.__stalledStatus = status;
    const state = await settle(make().request('POST', 'ingestion_runs?select=id', [{ engine: 'x' }], { prefer: 'return=representation' }));
    if (state !== 'REJECTED') failures.push(`${name}, HTTP ${status} with a stalled body: ${state} (the timeout does not cover the body)`);
  }
}

// The real Worker jobs (their own private clients and external-provider calls) must settle too.
const worker = await loadBackendModule('worker.ts');
const realLog = console.log;
console.log = () => {};
const jobEnv = { ...env, FRED_API_KEY: 'fred-key-ZZ', TWELVE_DATA_KEY: 'td-key-ZZ', NEWSAPI_KEY: 'news-key-ZZ', LOG_LEVEL: 'error' };
const stall = (init) => new Response(new ReadableStream({
  start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))); },
}), { status: 200, headers: { 'content-type': 'application/json' } });
const SCENARIOS = {
  'every response body stalls': (url, init) => stall(init),
  // The database answers; only the external providers (FRED, Twelve Data, GDELT, NewsAPI, feeds, Anthropic) stall.
  'external provider bodies stall, database healthy': (url, init) => {
    if (!String(url).startsWith('https://db.example.invalid')) return stall(init);
    if (init.method === 'POST' && String(url).includes('ingestion_runs')) return new Response('[{"id":"run-1"}]', { status: 201 });
    return new Response('[]', { status: 200 });
  },
};
for (const [scenario, respond] of Object.entries(SCENARIOS)) {
  globalThis.fetch = async (url, init = {}) => respond(url, init);
  for (const job of ['market_engine', 'news_engine', 'ai_committee']) {
    const state = await settle(worker.runJob(job, jobEnv), 600);
    if (state === 'PENDING') failures.push(`job ${job}, ${scenario}: still running after the simulated timeouts (the timeout does not cover a body)`);
  }
}
console.log = realLog;

mock.timers.reset();
globalThis.fetch = realFetch;
delete globalThis.__stalledStatus;
assert.deepEqual(failures, [], `BODY TIMEOUT failures:\n${failures.join('\n')}`);
console.log(`PASS stalled response bodies: aborted by the request timeout for ${CLIENTS.length} database clients x ${STATUSES.length} statuses, `
  + `and the 3 Worker jobs settle when every body stalls or only the external providers stall`);
