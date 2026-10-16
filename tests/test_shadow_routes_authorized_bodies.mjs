/**
 * Shadow manual routes with a VALID token and hostile bodies. A request that
 * passes authentication but carries a malformed, oversized or semantically
 * invalid envelope must be answered with a client error (never 2xx, never 5xx)
 * and must not reach the database: no lock, no read, no write. The database is a
 * counting fetch stub that answers every request with an empty PostgREST result,
 * so any outbound call is visible. Offline: no network, no clock.
 */
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const worker = await loadBackendModule('worker.ts');
const TOKEN = 'ingest-secret-ZZ-do-not-leak-1a2b3c';
const env = {
  SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-ZZ', ANTHROPIC_API_KEY: 'anthropic-ZZ',
  INGEST_TOKEN: TOKEN, COMMITTEE_TOKEN: 'committee-secret-ZZ', LOG_LEVEL: 'info',
};

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  calls.push(`${init.method ?? 'GET'} ${String(url).replace('https://db.example.invalid', '')}`);
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};
const realLog = console.log;
console.log = () => {};

const UUID = '10000000-0000-4000-8000-000000000001';
const ROUTES = [
  ['/event-shadow', 'observationIds'],
  ['/event-shadow/discover', null],
  ['/event-impact-shadow', 'eventVersionIds'],
  ['/gold-transmission-shadow', 'eventVersionIds'],
];
const hostileBodies = (key) => [
  ['empty', ''], ['blank', '   '], ['not json', '{'], ['null', 'null'], ['number', '42'], ['string', '"x"'], ['array', '[]'],
  ['empty object', '{}'], ['unknown key', '{"unexpected":1}'], ['proto key', '{"__proto__":{"x":1}}'],
  ['nul', '\u0000'], ['bom', `﻿{}`], ['huge', JSON.stringify({ [key ?? 'x']: ['a'.repeat(200_000)] })],
  ['deep', '['.repeat(50_000) + ']'.repeat(50_000)],
  ...(key === null ? [] : [
    [`${key} string`, JSON.stringify({ [key]: 'x' })], [`${key} null`, JSON.stringify({ [key]: null })],
    [`${key} object`, JSON.stringify({ [key]: {} })], [`${key} empty`, JSON.stringify({ [key]: [] })],
    [`${key} not uuid`, JSON.stringify({ [key]: ['not-a-uuid'] })], [`${key} numbers`, JSON.stringify({ [key]: [1, 2] })],
    [`${key} nested`, JSON.stringify({ [key]: [[UUID]] })], [`${key} duplicates`, JSON.stringify({ [key]: [UUID, UUID] })],
    [`${key} 26 ids`, JSON.stringify({ [key]: Array.from({ length: 26 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`) })],
    [`${key} extra key`, JSON.stringify({ [key]: [UUID], extra: true })],
    [`${key} injection`, JSON.stringify({ [key]: [`${UUID}&select=*`, `${UUID}' OR '1'='1`, `../${UUID}`] })],
  ]),
];

const failures = [];
const note = (label, message) => { if (failures.length < 30) failures.push(`${label}: ${message}`); };
let checked = 0;
const outcomes = {};

for (const [route, key] of ROUTES) {
  for (const [name, body] of hostileBodies(key)) {
    for (const contentLength of [null, '1']) {
      const label = `POST ${route} ${name}${contentLength ? ' (understated length)' : ''}`;
      calls.length = 0;
      let response;
      try {
        response = await worker.default.fetch(new Request(`https://worker.example.invalid${route}`, {
          method: 'POST', headers: { 'x-ingest-token': TOKEN, ...(contentLength ? { 'content-length': contentLength } : {}) }, body,
        }), env);
      } catch (error) {
        note(label, `the handler threw ${String(error).slice(0, 100)}`);
        continue;
      }
      checked += 1;
      const text = await response.text();
      outcomes[response.status] = (outcomes[response.status] ?? 0) + 1;
      if (response.status < 400) note(label, `answered ${response.status} to an invalid envelope`);
      if (response.status >= 500) note(label, `server error ${response.status}: ${text.slice(0, 120)}`);
      if (calls.length > 0) note(label, `reached the database (${calls.slice(0, 3).join(' | ')})`);
      if (text.includes(TOKEN) || text.includes('service-role-secret-ZZ')) note(label, 'a secret appears in the body');
    }
  }
}

console.log = realLog;
globalThis.fetch = realFetch;
assert.deepEqual(failures, [], `SHADOW BODY failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(checked > 150, `the sweep covers the surface (${checked})`);
console.log(`PASS shadow routes with a valid token: ${checked} hostile envelopes answered 4xx (${JSON.stringify(outcomes)}), none reached the database`);
