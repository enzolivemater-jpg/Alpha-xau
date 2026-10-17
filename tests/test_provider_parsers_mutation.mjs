/**
 * Provider response parsers (FRED, Twelve Data) under hostile bodies. A
 * provider can answer with any JSON, valid or not: the parsers must never
 * throw, and a point they return as available must carry a finite value and a
 * strict RFC3339 observation time. Anything else must be an explicit
 * unavailable point, never a value with a fabricated or unusable timestamp.
 * Offline and deterministic: bodies are synthetic; no network or clock.
 */
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { HOSTILE_VALUES, mutationCases } from './lib/mutation_cases.mjs';

const providers = await loadBackendModule('market_engine/providers.ts');
const strict = await loadBackendModule('shared/strict_timestamp.ts');

const fred = {
  realtime_start: '2026-10-01', realtime_end: '2026-10-01', observation_start: '2026-09-28', units: 'lin', file_type: 'json',
  observations: [
    { realtime_start: '2026-10-01', realtime_end: '2026-10-01', date: '2026-09-29', value: '.' },
    { realtime_start: '2026-10-01', realtime_end: '2026-10-01', date: '2026-09-30', value: '4.10' },
  ],
};
const twelve = {
  symbol: 'XAU/USD', close: '3900.55', open: '3890', high: '3910', low: '3880', volume: '12',
  last_quote_at: 1790864040, timestamp: 1790812800, datetime: '2026-10-01 14:14:00', is_market_open: true,
};
const JSON_TEXT_HOSTILE = ['', ' ', 'null', '[]', '"x"', '123', 'true', '{', '{"observations":', '\u0000', '{"observations":[null]}',
  '{"observations":[1,"x",true,[],{}]}', '{"observations":{"length":3}}', '{"__proto__":{"observations":[]}}'];

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { available: 0, unavailable: 0 };

function checkPoint(label, point, symbol, source) {
  if (point === null || typeof point !== 'object') { note(label, 'not a point'); return; }
  if (point.symbol !== symbol || point.source !== source) note(label, 'wrong symbol/source');
  if (point.value === null) {
    tally.unavailable += 1;
    if (point.observedAt !== null) note(label, 'unavailable value with a timestamp');
    if (typeof point.unavailableReason !== 'string' || point.unavailableReason.length === 0) note(label, 'unavailable without a reason');
    return;
  }
  tally.available += 1;
  if (typeof point.value !== 'number' || !Number.isFinite(point.value)) note(label, `non-finite value ${point.value}`);
  if (strict.parseStrictTimestamp(point.observedAt) === null) note(label, `unusable observedAt ${JSON.stringify(point.observedAt)}`);
  for (const field of ['open', 'high', 'low', 'bid', 'ask', 'volume']) {
    if (point[field] != null && (typeof point[field] !== 'number' || !Number.isFinite(point[field]))) note(label, `non-finite ${field}`);
  }
}

const sweeps = [
  ['FRED', fred, (body) => {
    const single = providers.parseFred(body, 'US10Y');
    return { single, many: providers.parseFredObservations(body, 'US10Y') };
  }],
  ['Twelve Data', twelve, (body) => ({ single: providers.parseTwelveData(body, 'XAUUSD'), many: [] })],
];
for (const [name, base, run] of sweeps) {
  const source = name === 'FRED' ? 'fred' : 'twelve_data';
  const symbol = name === 'FRED' ? 'US10Y' : 'XAUUSD';
  const bodies = [
    ['<base>', JSON.stringify(base)],
    ...mutationCases(base).map(([label, mutated]) => [label, JSON.stringify(mutated)]),
    ...JSON_TEXT_HOSTILE.map((text, i) => [`text#${i}`, text]),
    ...HOSTILE_VALUES.map((value, i) => [`non-text hostile#${i}`, value]),
  ];
  for (const [label, body] of bodies) {
    const full = `${name} ${label}`;
    try {
      const out = run(body);
      checkPoint(full, out.single, symbol, source);
      if (!Array.isArray(out.many)) note(full, 'observations not an array');
      for (const point of out.many) checkPoint(`${full} (many)`, point, symbol, source);
    } catch (error) {
      note(full, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
    }
  }
}

// Regressions: a numeric FRED date, and quote times whose ISO form is not RFC3339 (year > 9999 or < 0).
assert.equal(providers.parseFredObservations(JSON.stringify({ observations: [{ date: 20260930, value: '4.1' }] }), 'US10Y').length, 0);
assert.equal(providers.parseFred(JSON.stringify({ observations: [{ date: { y: 2026 }, value: '4.1' }] }), 'US10Y').value, null);
for (const seconds of [8.64e12, -62198755200, -1e12]) {
  const point = providers.parseTwelveData(JSON.stringify({ ...twelve, last_quote_at: seconds }), 'XAUUSD');
  assert.equal(point.value, null, `last_quote_at ${seconds}`);
  assert.equal(point.observedAt, null, `last_quote_at ${seconds}`);
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.available > 100 && tally.unavailable > 100, `the sweep exercises both outcomes ${JSON.stringify(tally)}`);
console.log(`PASS provider parsers: hostile FRED/Twelve Data bodies never thrown; ${tally.available} available points all finite with strict timestamps, `
  + `${tally.unavailable} explicit unavailable points`);
