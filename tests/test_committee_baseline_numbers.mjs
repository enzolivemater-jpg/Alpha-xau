/**
 * Committee partial-recalculation baseline (fetchBaselineScenarios): the stored
 * scenarios come from a jsonb column, so a missing or null figure must make the
 * baseline unavailable. `Number(null)`, `Number("")` and `Number([])` are all 0:
 * a null target would otherwise become a baseline target of 0, as if it had been
 * stored. Mock database; no network, no provider, no clock.
 */
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const committee = await loadBackendModule('ai_engine/committee_orchestrator.ts');
const HORIZONS = ['H1', 'H2', 'H3', 'H4', 'H5'];
const scenario = (overrides = {}) => ({
  direction: 'neutral', probability: 0.2, target: 3900.5, invalidation: 3850, confidence: 0.4,
  activation_condition: 'condition', reasoning: 'reason', ...overrides,
});
const baselineWith = (mutate) => {
  const scenarios = Object.fromEntries(HORIZONS.map((h) => [h, scenario()]));
  mutate(scenarios);
  return scenarios;
};
const run = (scenarios) => committee.fetchBaselineScenarios({
  select: async () => [{ id: 'x', market_regime: 'range', regime_confidence: 0.5, spot_reference: 3900, scenarios }],
});

const honest = await run(baselineWith(() => {}));
assert.ok(honest !== null, 'an honest stored baseline is available');
assert.equal(honest.H1.target, 3900.5);
assert.equal(honest.H1.probability, 20);
assert.equal((await run(baselineWith((s) => { s.H1.target = '3901.25'; })))?.H1.target, 3901.25, 'NUMERIC text is read');

const failures = [];
for (const field of ['target', 'invalidation', 'probability']) {
  for (const value of [null, '', ' ', [], {}, true, false, '0x10', '1,5', 'abc', undefined, NaN, Infinity]) {
    const result = await run(baselineWith((s) => { s.H3[field] = value; }));
    if (result !== null) failures.push(`${field} = ${JSON.stringify(value)} gave a baseline (${field} ${result.H3[field]})`);
  }
}
assert.deepEqual(failures, [], `baseline failures:\n${failures.join('\n')}`);
assert.equal(await run(baselineWith((s) => { delete s.H2; })), null, 'a missing horizon makes the baseline unavailable');
console.log('PASS committee baseline: a null, empty or non-decimal stored figure makes the baseline unavailable, never 0');

// Confidence and probability are stored in [0,1]: a missing confidence is not 0, and a
// figure outside the unit interval (a percentage written by mistake) is not a baseline.
const rangeFailures = [];
for (const field of ['probability', 'confidence']) {
  for (const value of [null, '', [], true, 'abc', undefined, NaN, Infinity, -0.1, 1.01, 50, '50']) {
    const result = await run(baselineWith((s) => { s.H4[field] = value; }));
    if (result !== null) rangeFailures.push(`${field} = ${JSON.stringify(value)} gave a baseline (${field} ${result.H4[field]})`);
  }
  for (const edge of [0, 1, '0', '1', '0.5']) {
    assert.ok(await run(baselineWith((s) => { s.H4[field] = edge; })) !== null, `${field} = ${edge} is a valid stored figure`);
  }
}
assert.deepEqual(rangeFailures, [], `baseline range failures:\n${rangeFailures.join('\n')}`);
console.log('PASS committee baseline: probability and confidence must be present and within [0,1]');
