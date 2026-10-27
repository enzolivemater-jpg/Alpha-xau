// A-C2 + A-C3: one freshness decision on every path, at every threshold edge.
//
// The four TypeScript paths that classify a market value's freshness must give
// the same class for the same exact age, and that class must follow the
// existing SYMBOL_RULES edge (strictly beyond a threshold crosses it):
//   1. ingestion   validatePoint(raw, now)
//   2. runtime     buildSnapshot(rows of v_market_latest), exact staleness_us
//   3. replay      replayMarketEvidence(archive, cutoff)        (DATA-1, 1.3.0)
//   4. CHAIN-0     runDecisionChainDryRun(input, cutoff)         (1.1.0)
// The SQL view itself is checked by tests/test_market_latest_exact_staleness_postgres.mjs.
// Offsets around each threshold: -1 ms, equality, +1 ms, +499 ms, +500 ms, +999 ms.
// Values are synthetic. HOLD / FORBIDDEN is asserted on every CHAIN-0 run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { SYMBOL_RULES, validatePoint, FUTURE_TOLERANCE_S } = await loadBackendModule('market_engine/validate.ts');
const context = await loadBackendModule('market_engine/context.ts');
const ev = await loadBackendModule('market_engine/evidence_archive.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url), 'utf8'));
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));

const CUTOFF = '2026-10-01T14:15:00.000Z';
const CUTOFF_MS = Date.parse(CUTOFF);
const iso = (ms) => new Date(ms).toISOString();
// Synthetic in-range values and the field each symbol feeds.
const SYMBOLS = {
  XAUUSD: { field: 'spot', value: 3900, source: 'twelve_data' },
  US10Y: { field: 'us10y', value: 4.1, source: 'fred' },
  US10YR: { field: 'realYield', value: 1.7, source: 'fred' },
  VIX: { field: 'vix', value: 17.2, source: 'fred' },
  WTI: { field: 'wti', value: 66.4, source: 'fred' },
};
const OFFSETS_MS = [-1, 0, 1, 499, 500, 999];

// v_market_latest before A-C3: EXTRACT(EPOCH ...)::INTEGER rounds half away from zero.
const sqlRoundedSeconds = (ageMs) => Math.sign(ageMs) * Math.round(Math.abs(ageMs) / 1000);
const latestRow = (symbol, ageMs, overrides = {}) => ({
  symbol, bid: null, ask: null, close: String(SYMBOLS[symbol].value), dxy_value: null, us10y_yield: null,
  real_yield: null, vix: null, wti: null, source: SYMBOLS[symbol].source, ts: iso(CUTOFF_MS - ageMs),
  staleness_seconds: sqlRoundedSeconds(ageMs), staleness_us: ageMs * 1000, ...overrides,
});

function viaIngestion(symbol, ageMs) {
  const { value, source } = SYMBOLS[symbol];
  const outcome = validatePoint({ symbol, source, value, observedAt: iso(CUTOFF_MS - ageMs) }, new Date(CUTOFF_MS));
  return outcome.ok ? outcome.point.freshness : 'UNAVAILABLE';
}

function viaRuntime(symbol, ageMs) {
  const rows = symbol === 'XAUUSD' ? [latestRow('XAUUSD', ageMs)] : [latestRow('XAUUSD', 0), latestRow(symbol, ageMs)];
  return context.buildSnapshot(rows)[SYMBOLS[symbol].field].status;
}

async function viaReplay(symbol, ageMs) {
  const { field, value } = SYMBOLS[symbol];
  const observedAt = iso(CUTOFF_MS - ageMs);
  const archive = { ...structuredClone(fixture), coverage: { ...fixture.coverage, from: observedAt, to: CUTOFF },
    records: [{ ...structuredClone(fixture.records.find((r) => r.field === field)), observedAt, ingestedAt: observedAt, value, supersedes: null }] };
  if (field !== 'spot') archive.records.push({ ...structuredClone(fixture.records[1]), observedAt: CUTOFF, ingestedAt: CUTOFF });
  const r = await ev.replayMarketEvidence(archive, CUTOFF);
  return r.observations[field].freshnessAtCutoff;
}

function viaChain(symbol, ageMs) {
  const { field } = SYMBOLS[symbol];
  const input = structuredClone(golden.input);
  const observedAt = iso(CUTOFF_MS - ageMs);
  const names = field === 'spot' ? ['spot', 'bid', 'ask'] : [field];
  for (const name of names) input.marketSnapshot[name] = { ...input.marketSnapshot[name], status: 'LIVE', observedAt, ageSeconds: 0 };
  if (field === 'spot') input.marketSnapshot.capturedAt = observedAt;
  const run = chain.runDecisionChainDryRun(input, CUTOFF);
  assert.deepEqual([run.chainState, run.execution], ['HOLD', 'FORBIDDEN']);
  return run.stages.marketPricing.fields[field].status;
}

// --- 1. The cross matrix: 5 symbols x 2 thresholds x 6 offsets x 4 paths.
let cells = 0;
for (const [symbol] of Object.entries(SYMBOLS)) {
  const rule = SYMBOL_RULES[symbol];
  for (const [threshold, below, above] of [[rule.liveMaxAgeS, 'LIVE', 'STALE'], [rule.staleMaxAgeS, 'STALE', 'UNAVAILABLE']]) {
    for (const offset of OFFSETS_MS) {
      const ageMs = threshold * 1000 + offset;
      const expected = offset > 0 ? above : below;
      const got = {
        ingestion: viaIngestion(symbol, ageMs),
        runtime: viaRuntime(symbol, ageMs),
        replay: await viaReplay(symbol, ageMs),
        chain: viaChain(symbol, ageMs),
      };
      assert.deepEqual(got, { ingestion: expected, runtime: expected, replay: expected, chain: expected },
        `${symbol} ${threshold} s ${offset >= 0 ? '+' : ''}${offset} ms`);
      cells += 4;
    }
  }
}
assert.equal(cells, 5 * 2 * 6 * 4);
console.log(`PASS one freshness class on ingestion, runtime read, replay and CHAIN-0 at ${cells} edge cells`);

// --- 2. The runtime read decides on staleness_us only: the rounded staleness_seconds never moves a class.
{
  const live = SYMBOL_RULES.XAUUSD.liveMaxAgeS;
  // 360.4 s: SQL rounds to 360, exact is past the edge.
  assert.equal(context.buildSnapshot([latestRow('XAUUSD', live * 1000 + 400)]).spot.status, 'STALE');
  // A contradicting rounded value is ignored in both directions.
  assert.equal(context.buildSnapshot([latestRow('XAUUSD', live * 1000, { staleness_seconds: live + 1 })]).spot.status, 'LIVE');
  assert.equal(context.buildSnapshot([latestRow('XAUUSD', live * 1000 + 1, { staleness_seconds: 0 })]).spot.status, 'STALE');
  // The reported age stays whole seconds elapsed (an integer), not the rounded view value.
  const s = context.buildSnapshot([latestRow('XAUUSD', live * 1000 + 999)]).spot;
  assert.equal(s.ageSeconds, live);
  assert.ok(Number.isInteger(s.ageSeconds));
  console.log('PASS the runtime read classifies the exact staleness_us; the integer age is whole seconds elapsed');
}

// --- 3. Invalid or missing exact staleness fails closed: UNAVAILABLE, never a rounded fallback, never 0.
for (const bad of [null, undefined, '', ' ', '1.5', '360000000.5', 'abc', '0x10', '1e3', Number.NaN, Infinity, 1.5]) {
  const row = latestRow('XAUUSD', 0, { staleness_us: bad });
  const snap = context.buildSnapshot([row]);
  assert.equal(snap.spot.status, 'UNAVAILABLE', `staleness_us ${String(bad)}`);
  assert.equal(snap.available, false, `staleness_us ${String(bad)}`);
}
// PostgREST serialises BIGINT as a JSON number; a decimal integer string is also exact.
assert.equal(context.buildSnapshot([latestRow('XAUUSD', 0, { staleness_us: '360000000' })]).spot.status, 'LIVE');
assert.equal(context.buildSnapshot([latestRow('XAUUSD', 0, { staleness_us: '360000001' })]).spot.status, 'STALE');
// A row slightly ahead of the database clock is classified at age 0 (LIVE), as before.
assert.equal(context.buildSnapshot([latestRow('XAUUSD', -400)]).spot.status, 'LIVE');
assert.equal(context.buildSnapshot([latestRow('XAUUSD', -400)]).spot.ageSeconds, -1, 'floor: a row ahead of the database clock keeps a negative age, which MP-0 refuses');
// Not a loosening: MP-0 still refuses that negative age (INVALID_FIELD_CONTRACT). Before A-C3 the view rounded
// -0.4 s to 0 and MP-0 accepted it; the floor now refuses any row dated after the database clock.
{
  const mp0 = await loadBackendModule('market_engine/institutional_snapshot.ts');
  const ahead = mp0.buildInstitutionalMarketPricingSnapshot(context.buildSnapshot([latestRow('XAUUSD', -400)]), CUTOFF);
  assert.ok(ahead.reasonCodes.includes('INVALID_FIELD_CONTRACT'));
  const exact = mp0.buildInstitutionalMarketPricingSnapshot(context.buildSnapshot([latestRow('XAUUSD', 0)]), CUTOFF);
  assert.ok(!exact.reasonCodes.includes('INVALID_FIELD_CONTRACT'));
}
console.log('PASS a missing, non-integer or malformed staleness_us is UNAVAILABLE, never a rounded fallback; MP-0 refuses negative ages');

// --- 4. Ingestion: the future guard mirrors chk_market_ticks_no_future (ts <= created_at + 5 min) exactly.
{
  const point = (observedAt) => validatePoint({ symbol: 'XAUUSD', source: 'twelve_data', value: 3900, observedAt }, new Date(CUTOFF_MS));
  const ahead = (ms) => iso(CUTOFF_MS + ms);
  assert.equal(point(ahead(FUTURE_TOLERANCE_S * 1000)).ok, true, 'exactly 5 min ahead: accepted, as the SQL CHECK');
  for (const ms of [1, 499, 500, 999]) {
    const v = point(ahead(FUTURE_TOLERANCE_S * 1000 + ms));
    assert.equal(v.ok, false, `5 min + ${ms} ms ahead`);
    assert.match(v.rejection.reason, /futur/);
  }
  // Sub-millisecond: the observation timestamp is exact to the nanosecond.
  assert.equal(point(ahead(FUTURE_TOLERANCE_S * 1000).replace(/Z$/, '000001Z')).ok, false, '1 ns beyond the tolerance');
  // An observation ahead of the clock but within the tolerance is age 0 and LIVE.
  const near = point(ahead(1000));
  assert.deepEqual([near.ok, near.point.freshness, near.point.ageSeconds], [true, 'LIVE', 0]);
  // Integer age reported downstream: whole seconds elapsed.
  const old = point(iso(CUTOFF_MS - 360_999));
  assert.deepEqual([old.point.freshness, old.point.ageSeconds], ['STALE', 360]);
  console.log('PASS ingestion future guard equals the SQL CHECK to the nanosecond; ages are whole seconds elapsed');
}

// --- 5. Time zones and timestamp validity: the same instant gives the same class; invalid stamps are refused.
{
  const live = SYMBOL_RULES.XAUUSD.liveMaxAgeS;
  const v = (observedAt) => validatePoint({ symbol: 'XAUUSD', source: 'twelve_data', value: 3900, observedAt }, new Date(CUTOFF_MS));
  // 14:15:00Z - 360.001 s = 14:08:59.999Z = 16:08:59.999+02:00 = 09:08:59.999-05:00.
  for (const stamp of ['2026-10-01T14:08:59.999Z', '2026-10-01T16:08:59.999+02:00', '2026-10-01T09:08:59.999-05:00']) {
    assert.equal(v(stamp).point.freshness, 'STALE', stamp);
  }
  for (const stamp of ['2026-10-01T14:09:00Z', '2026-10-01T16:09:00.000+02:00', '2026-10-01T09:09:00-05:00']) {
    assert.equal(v(stamp).point.freshness, 'LIVE', stamp);
  }
  // 1 ns past the live edge.
  assert.equal(v('2026-10-01T14:08:59.999999999Z').point.freshness, 'STALE');
  for (const bad of ['2026-02-30T00:00:00Z', '2026-10-01T14:09:00', '2026-10-01 14:09:00Z', '2026-10-01T24:00:00Z',
    '2026-10-01T14:09:00-00:00', '2026-10-01T14:09:00.1234567890Z', 'yesterday', '']) {
    const out = v(bad);
    assert.equal(out.ok, false, bad);
  }
  assert.ok(Number.isInteger(live));
  console.log('PASS offsets and zones give the same class for the same instant; invalid stamps are rejected');
}

// --- 6. No lookahead: an observation 1 ms after the cutoff is never used by the replay or CHAIN-0.
{
  const r = await ev.replayMarketEvidence({ ...structuredClone(fixture), records: fixture.records.map((rec) => (
    rec.field === 'spot' ? { ...rec, observedAt: iso(CUTOFF_MS + 1), ingestedAt: iso(CUTOFF_MS + 1) } : rec)) }, CUTOFF);
  assert.notEqual(r.observations.spot?.observedAt, iso(CUTOFF_MS + 1));
  const input = structuredClone(golden.input);
  for (const name of ['spot', 'bid', 'ask']) input.marketSnapshot[name] = { ...input.marketSnapshot[name], observedAt: iso(CUTOFF_MS + 1) };
  const run = chain.runDecisionChainDryRun(input, CUTOFF);
  assert.equal(run.stages.marketPricing.state, 'ABSTAIN');
  assert.deepEqual([run.chainState, run.execution], ['HOLD', 'FORBIDDEN']);
  console.log('PASS no path uses an observation made after the cutoff; HOLD / FORBIDDEN');
}
