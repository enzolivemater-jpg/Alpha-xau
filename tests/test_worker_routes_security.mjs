/**
 * Worker HTTP surface, behavioural. backend/worker.ts routes every manual
 * endpoint to an engine that checks its own token. Static tests already pin the
 * wiring; this one RUNS the real `fetch` handler. For each route and each HTTP
 * method, a request with no token, an empty token, a wrong token, the other
 * engine's token or a token header on an engine whose own token is unset must
 * be refused (never 2xx, never a server error), must make no outbound request
 * (global fetch is replaced by a counter that throws), and must not echo a
 * secret. Exact routes stay exact, /health leaks nothing, an unknown cron runs
 * nothing. Offline: no network, database, provider or clock.
 */
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const worker = await loadBackendModule('worker.ts');
const handler = worker.default;

const INGEST = 'ingest-secret-ZZ-do-not-leak-1a2b3c';
const COMMITTEE = 'committee-secret-ZZ-do-not-leak-4d5e6f';
const SERVICE = 'service-role-secret-ZZ-do-not-leak-7a8b9c';
const ANTHROPIC = 'anthropic-secret-ZZ-do-not-leak-0d1e2f';
const SECRETS = [INGEST, COMMITTEE, SERVICE, ANTHROPIC];
const env = (overrides = {}) => ({
  SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: SERVICE, ANTHROPIC_API_KEY: ANTHROPIC,
  INGEST_TOKEN: INGEST, COMMITTEE_TOKEN: COMMITTEE, LOG_LEVEL: 'info', ...overrides,
});

let outbound = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { outbound += 1; throw new Error(`unexpected outbound request ${String(args[0])}`); };
const realLog = console.log;
console.log = () => {}; // the worker logs JSON lines; keep the test output readable

const ROUTES = ['/committee', '/committee/', '/committeeX', '/news', '/news/reconcile', '/news/x',
  '/event-shadow', '/event-shadow/discover', '/event-impact-shadow', '/gold-transmission-shadow'];
const METHODS = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'];
const AUTH_ATTEMPTS = [
  ['no token', {}],
  ['empty x-ingest-token', { 'x-ingest-token': '' }],
  ['empty x-committee-token', { 'x-committee-token': '' }],
  ['empty bearer', { authorization: 'Bearer ' }],
  ['wrong token', { 'x-ingest-token': 'nope', 'x-committee-token': 'nope', authorization: 'Bearer nope' }],
  ['near miss (prefix)', { 'x-ingest-token': INGEST.slice(0, -1), 'x-committee-token': COMMITTEE.slice(0, -1) }],
  ['near miss (extra char)', { 'x-ingest-token': `${INGEST}x`, 'x-committee-token': `${COMMITTEE}x` }],
  ['case change', { 'x-ingest-token': INGEST.toUpperCase(), 'x-committee-token': COMMITTEE.toUpperCase() }],
  // `Bearer  <token>` (extra spaces) carries the REAL token and is rightly accepted, so it is not listed here.
  ['basic scheme', { authorization: `Basic ${INGEST}` }],
  ['token inside a longer value', { authorization: `Bearer prefix ${INGEST}` }],
];
// The committee token on ingest-protected routes and the ingest token on the committee route.
const CROSS = { '/committee': { 'x-committee-token': INGEST, authorization: `Bearer ${INGEST}` } };
const WRONG_ENGINE = (route) => (route.startsWith('/committee')
  ? { 'x-committee-token': INGEST, authorization: `Bearer ${INGEST}` }
  : { 'x-ingest-token': COMMITTEE, authorization: `Bearer ${COMMITTEE}` });

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
let checked = 0;

async function attempt(label, route, method, headers, environment, body) {
  const before = outbound;
  let response;
  try {
    response = await handler.fetch(new Request(`https://worker.example.invalid${route}`, {
      method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: body ?? '{}' }),
    }), environment);
  } catch (error) {
    note(label, `the handler threw ${String(error).slice(0, 100)}`);
    return;
  }
  checked += 1;
  const text = await response.text();
  if (response.status >= 200 && response.status < 300) note(label, `answered ${response.status} without a valid token`);
  if (response.status >= 500) note(label, `server error ${response.status}`);
  if (outbound !== before) note(label, `${outbound - before} outbound request(s) before authorization`);
  for (const secret of SECRETS) if (text.includes(secret)) note(label, 'a secret appears in the body');
  for (const [name, value] of response.headers) {
    if (SECRETS.some((secret) => value.includes(secret))) note(label, `a secret appears in header ${name}`);
  }
}

const protectedRoutes = ROUTES;
for (const route of protectedRoutes) {
  for (const method of METHODS) {
    for (const [name, headers] of AUTH_ATTEMPTS) await attempt(`${method} ${route} ${name}`, route, method, headers, env());
    await attempt(`${method} ${route} other engine's token`, route, method, WRONG_ENGINE(route), env());
    // The engine's own token is unset or empty on the server: a client header must never match it.
    for (const unset of [undefined, '']) {
      await attempt(`${method} ${route} server token ${JSON.stringify(unset)} + empty header`, route, method,
        { 'x-ingest-token': '', 'x-committee-token': '' }, env({ INGEST_TOKEN: unset, COMMITTEE_TOKEN: unset }));
      await attempt(`${method} ${route} server token ${JSON.stringify(unset)} + any header`, route, method,
        { 'x-ingest-token': 'undefined', 'x-committee-token': 'undefined', authorization: 'Bearer undefined' },
        env({ INGEST_TOKEN: unset, COMMITTEE_TOKEN: unset }));
    }
    // Hostile bodies never reach the engine without a token.
    for (const body of ['', 'null', '[]', '{"eventVersionIds":["x"]}', '{"observationIds":[]}', 'x'.repeat(100_000), '\u0000']) {
      await attempt(`${method} ${route} body ${JSON.stringify(body.slice(0, 20))}`, route, method, {}, env(), body);
    }
  }
}

// Exact routes stay exact: no sub-route, no trailing slash, no case change reaches the manual engines.
for (const route of ['/event-shadow/', '/event-shadow/x', '/event-impact-shadow/', '/event-impact-shadow/discover',
  '/gold-transmission-shadow/', '/gold-transmission-shadow/x', '/Event-Shadow', '/EVENT-IMPACT-SHADOW', '/gold-transmission-shadows',
  '/event-impact-shadowx', '//event-shadow', '/x/event-shadow', '/']) {
  const response = await handler.fetch(new Request(`https://worker.example.invalid${route}`, { method: 'POST', headers: { 'x-ingest-token': INGEST }, body: '{}' }), env());
  if (response.status !== 404) note(`exact route ${route}`, `status ${response.status} (expected 404 Route inconnue)`);
  await response.text();
}

// /health: public by design, no secret and no environment value.
{
  const response = await handler.fetch(new Request('https://worker.example.invalid/health'), env());
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['jobs', 'status']);
  for (const secret of [...SECRETS, 'example.invalid']) assert.ok(!text.includes(secret), '/health leaks nothing');
}
{
  const response = await handler.fetch(new Request('https://worker.example.invalid/nothing'), env());
  assert.equal(response.status, 404);
  assert.equal(JSON.parse(await response.text()).error, 'Route inconnue');
}

// Cron dispatch: exact expressions only, an unknown one runs nothing.
assert.equal(worker.resolveJob('*/5 * * * *'), 'market_engine');
assert.equal(worker.resolveJob('7-59/15 * * * *'), 'news_engine');
assert.equal(worker.resolveJob('0 * * * *'), 'ai_committee');
for (const cron of [undefined, '', ' ', '*/5 * * * * ', ' */5 * * * *', '*/10 * * * *', '0 * * * 0', '0 0 * * *', '* * * * *', 'market_engine', '__proto__', null]) {
  assert.equal(worker.resolveJob(cron), null, `unknown cron ${JSON.stringify(cron)} runs nothing`);
}
{
  const queued = [];
  const before = outbound;
  await handler.scheduled({ cron: '*/7 * * * *' }, env(), { waitUntil: (promise) => queued.push(promise) });
  await handler.scheduled({}, env(), { waitUntil: (promise) => queued.push(promise) });
  assert.equal(queued.length, 0, 'an unknown cron schedules nothing');
  assert.equal(outbound, before, 'and makes no request');
}

console.log = realLog;
globalThis.fetch = realFetch;
assert.deepEqual(failures, [], `WORKER ROUTE failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(checked > 1000,`the sweep covers the surface (${checked})`);
console.log(`PASS worker routes: ${checked} unauthenticated or mis-authenticated requests refused with no outbound call and no secret; exact routes, /health and cron dispatch hold`);
