// Market provider parsers (FRED, Twelve Data) on hostile and degraded bodies.
// Pure functions: no network, no clock, no environment. A parser always
// returns a RawDataPoint; an unusable body yields value=null with a reason,
// never an exception and never a substituted number.
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const p = await loadBackendModule('market_engine/providers.ts');
const { validatePoint } = await loadBackendModule('market_engine/validate.ts');

function unavailable(point, reason) {
  assert.equal(point.value, null, reason.source);
  assert.equal(point.observedAt, null, reason.source);
  assert.match(point.unavailableReason, reason);
}

// --- toNumberOrNull: decimal notation only.
for (const [raw, expected] of [
  [4.21, 4.21], ['4.21', 4.21], [' 4.21 ', 4.21], ['-1.5', -1.5], ['+3', 3], ['5.', 5], ['.5', 0.5], ['1e3', 1000],
]) assert.equal(p.toNumberOrNull(raw), expected, JSON.stringify(raw));
for (const raw of [
  '', ' ', '.', 'N/D', 'n/a', 'NA', 'null', 'NaN', 'Infinity', '-Infinity', '0x1A', '0xD05', '0b101', '0o17',
  '1,5', '12abc', '1e', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, {}, [],
]) assert.equal(p.toNumberOrNull(raw), null, JSON.stringify(raw) ?? String(raw));
console.log('PASS toNumberOrNull reads decimal notation only and never substitutes a number');

// --- FRED.
const fred = (body) => p.parseFred(typeof body === 'string' ? body : JSON.stringify(body), 'US10Y');
const nominal = fred({ observations: [{ date: '2026-08-06', value: '4.21' }, { date: '2026-08-07', value: '.' }] });
assert.equal(nominal.value, 4.21);
assert.equal(nominal.observedAt, '2026-08-06T00:00:00.000Z');
assert.equal(nominal.source, 'fred');
unavailable(fred('<html>not json</html>'), /non JSON/);
unavailable(fred(''), /non JSON/);
for (const body of ['null', '42', '"text"', '[]', 'true']) unavailable(fred(body), /objet JSON attendu/);
for (const body of [
  {}, { observations: null }, { observations: { 0: { date: '2026-08-06', value: '4.21' } } },
  { observations: [] }, { observations: [{ date: '2026-08-07', value: '.' }] },
  { observations: [{ date: '2026-08-07' }] }, { observations: [{ value: '4.2' }] },
  { observations: [{ date: '2026-02-30', value: '4.2' }] }, { observations: [{ date: '2026-08-07', value: '0x10' }] },
  { observations: [null, 7, 'x'] },
]) unavailable(fred(body), /Aucune observation numérique/);
console.log('PASS FRED parser degrades every malformed body to UNAVAILABLE with a reason');

// --- Twelve Data.
const td = (body) => p.parseTwelveData(typeof body === 'string' ? body : JSON.stringify(body), 'XAUUSD');
const quote = td({ close: '3401.55', open: '3395.2', high: '3405.1', low: '3392', last_quote_at: 1790848800, timestamp: 1790805600 });
assert.equal(quote.value, 3401.55);
assert.equal(quote.observedAt, '2026-10-01T10:00:00.000Z', 'last_quote_at wins over session timestamp');
assert.equal(quote.source, 'twelve_data');
assert.equal(td({ close: '3401.55', timestamp: 1790805600 }).observedAt, '2026-09-30T22:00:00.000Z');
assert.equal(td({ close: '3401.55', datetime: '2026-10-01 10:00:00' }).observedAt, '2026-10-01T10:00:00.000Z');
unavailable(td('not json'), /non JSON/);
for (const body of ['null', '1', '[]', '"quote"']) unavailable(td(body), /objet JSON attendu/);
unavailable(td({ status: 'error', code: 429, message: 'limit' }), /Erreur API \(code 429\)/);
for (const close of [undefined, null, '', 'N/D', '0x1A', 'NaN']) {
  unavailable(td({ close, last_quote_at: 1790848800 }), /close absent ou non numérique/);
}
for (const time of [{ last_quote_at: 1e17 }, { timestamp: -1e17 }, { datetime: '2026-02-30 10:00:00' },
  { datetime: '2026-10-01 25:00:00' }, { datetime: '2026-10-01T10:00:00 extra' }, {}]) {
  unavailable(td({ close: '3400', ...time }), /Horodatage source absent/);
}
console.log('PASS Twelve Data parser degrades errors, bad close and impossible times without throwing');

// --- End to end with validation: nothing unusable becomes a point.
const now = new Date('2026-10-01T10:02:00.000Z');
assert.equal(validatePoint(quote, now).ok, true);
for (const body of ['null', JSON.stringify({ close: '0xD05', last_quote_at: 1790848800 }),
  JSON.stringify({ close: '3400', last_quote_at: 1e17 })]) {
  assert.equal(validatePoint(td(body), now).ok, false, body);
}
console.log('PASS unusable provider bodies never pass validatePoint');
