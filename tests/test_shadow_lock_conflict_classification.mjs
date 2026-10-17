/**
 * Manual shadow routes: how a database error on the run-lock INSERT is
 * classified. Only a real unique violation (HTTP 409 carrying the 23505 error
 * code or the unique-constraint wording) means "a run is already active" and is
 * answered 409. Any other failure, even one whose text happens to contain
 * "already exists" or the digits 23505, must stay a server error: it must
 * never be reported as the nominal busy state. Database is a stub; offline.
 */
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const worker = await loadBackendModule('worker.ts');
const TOKEN = 'ingest-secret-ZZ-do-not-leak-1a2b3c';
const env = {
  SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-ZZ', ANTHROPIC_API_KEY: 'anthropic-ZZ',
  INGEST_TOKEN: TOKEN, COMMITTEE_TOKEN: 'committee-secret-ZZ', LOG_LEVEL: 'info',
};
const UUID = '10000000-0000-4000-8000-000000000001';
const ROUTES = [['/event-shadow', 'observationIds'], ['/event-impact-shadow', 'eventVersionIds'], ['/gold-transmission-shadow', 'eventVersionIds']];

/** [label, HTTP status of the lock INSERT, body, expected route status] */
const CASES = [
  ['unique violation with the error code', 409, '{"code":"23505","message":"duplicate key value violates unique constraint \\"uq_ingestion_runs_active\\""}', 409],
  ['unique violation, wording only', 409, '{"message":"duplicate key value violates unique constraint"}', 409],
  ['unique violation, short code form', 409, 'code=23505 duplicate key', 409],
  ['outage whose text contains "already exists"', 500, '{"message":"relation \\"ingestion_runs\\" already exists"}', 500],
  ['outage whose text contains bare digits 23505', 500, 'request id 1235057 timeout after 23505ms', 500],
  ['409 without any unique wording', 409, '{"message":"conflict"}', 500],
  ['409 about another relation already existing', 409, '{"code":"42P07","message":"relation already exists"}', 500],
  ['500 even with the unique wording', 500, '{"code":"23505","message":"duplicate key"}', 500],
  ['foreign key violation', 409, '{"code":"23503","message":"violates foreign key constraint"}', 500],
];

const failures = [];
const note = (label, message) => { if (failures.length < 20) failures.push(`${label}: ${message}`); };
const realFetch = globalThis.fetch;
const realLog = console.log;
console.log = () => {};
let checked = 0;

for (const [route, key] of ROUTES) {
  for (const [label, lockStatus, lockBody, expected] of CASES) {
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      if (target.includes('fn_reclaim_stale_runs')) return new Response('[]', { status: 200 });
      if (target.includes('ingestion_runs') && init.method === 'POST') return new Response(lockBody, { status: lockStatus });
      return new Response('[]', { status: 200 });
    };
    const response = await worker.default.fetch(new Request(`https://worker.example.invalid${route}`, {
      method: 'POST', headers: { 'x-ingest-token': TOKEN }, body: JSON.stringify({ [key]: [UUID] }),
    }), env);
    checked += 1;
    const text = await response.text();
    if (response.status !== expected) note(`${route} ${label}`, `status ${response.status}, expected ${expected}: ${text.slice(0, 120)}`);
    if (text.includes('service-role-secret-ZZ') || text.includes(TOKEN)) note(`${route} ${label}`, 'a secret appears in the body');
  }
}

console.log = realLog;
globalThis.fetch = realFetch;
assert.deepEqual(failures, [], `LOCK CLASSIFICATION failures:\n${failures.join('\n')}`);
console.log(`PASS shadow lock conflicts: ${checked} database errors on the run-lock insert classified; only a real unique violation is "already running"`);
