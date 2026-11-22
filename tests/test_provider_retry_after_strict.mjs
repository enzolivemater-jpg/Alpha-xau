/**
 * market_engine/providers.ts fetchText : l'en-tête Retry-After suit RFC 9110
 * (delta-seconds = 1*DIGIT, ou date HTTP). `Number()` lisait "0x16" comme 22 s
 * (> plafond 20 s) et abandonnait au lieu d'un retry ordinaire, et "" / " "
 * comme 0. Un en-tête illisible doit être traité comme absent (retry normal) ;
 * un délai lisible au-delà du plafond reste un abandon immédiat.
 * Offline : fetch simulé, horloge simulée (node:test mock timers).
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const providers = await loadBackendModule('market_engine/providers.ts');
const realFetch = globalThis.fetch;
mock.timers.enable({ apis: ['setTimeout'] });
// Math.random fixe : backoff déterministe, borné.
const realRandom = Math.random; Math.random = () => 0;

async function attempts(retryAfter) {
  let hits = 0;
  globalThis.fetch = async () => {
    hits++;
    return new Response('x', { status: 429, headers: retryAfter === null ? {} : { 'retry-after': retryAfter } });
  };
  const p = providers.fetchText('https://provider.example.invalid/q').catch((e) => e);
  for (let i = 0; i < 200; i++) { await Promise.resolve(); await new Promise((r) => setImmediate(r)); mock.timers.tick(30000); }
  const err = await p;
  assert.ok(err instanceof Error, 'fetchText must reject on persistent 429');
  return hits;
}

try {
  const longHits = await attempts('600');
  assert.equal(longHits, 1, 'readable 600 s Retry-After: immediate abandon');
  for (const bad of ['0x16', '1e3', '-5', '1.5', 'abc']) {
    const h = await attempts(bad);
    assert.ok(h > 1, `unreadable Retry-After ${JSON.stringify(bad)} must be treated as absent (retry), got ${h} attempt(s)`);
  }
  const absent = await attempts(null);
  assert.ok(absent > 1, 'absent Retry-After: ordinary retry');
  console.log('provider Retry-After strict: ok');
} finally {
  globalThis.fetch = realFetch; Math.random = realRandom; mock.timers.reset();
}
