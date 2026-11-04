/**
 * Committee market context: an unknown or non-finite spot age must never read as
 * "fresh" (0 s). renderMarketContext flags it; the source no longer defaults the
 * age to 0 nor the capture time to the current clock. No network, no provider.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const committee = await loadBackendModule('ai_engine/committee_orchestrator.ts');
const base = {
  symbol: 'XAUUSD', spot: 3900, bid: 3899.9, ask: 3900.1, dxy: null, us10y: null,
  realYield: null, vix: null, wti: null, atr: null, capturedAt: '2026-01-01T00:00:00.000Z',
};
const render = (stalenessSeconds) => committee.__internals.renderMarketContext({ ...base, stalenessSeconds });

assert.match(render(12), /Fraîcheur\s+: 12s$/m);
assert.match(render(901), /DONNÉE PÉRIMÉE/);
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
  const out = render(bad);
  assert.match(out, /DONNÉE NON DATÉE/, `non-finite age ${bad} is flagged`);
  assert.doesNotMatch(out, /NaNs|Infinitys/);
}

const source = readFileSync(new URL('../backend/ai_engine/committee_orchestrator.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /ageSeconds \?\? 0/, 'unknown age must not default to 0');
assert.doesNotMatch(source, /capturedAt \?\? new Date\(\)/, 'unknown capture time must not default to now');
console.log('committee market-context staleness: OK');
