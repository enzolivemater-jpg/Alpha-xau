/**
 * Market and positioning ingest surfaces under hostile input: persisted RPC row
 * normalizers (MP-2 / P-1), MP-1 as-of selection, P-0 positioning envelope,
 * point validation, capture append and capture merge. An internal error
 * (TypeError, RangeError...) is a defect; the named refusals these modules use
 * are plain `Error`s. A value read from a text field must be a plain decimal
 * (never hex, binary, octal or a coerced object). Offline and deterministic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { HOSTILE_VALUES, mutationCases } from './lib/mutation_cases.mjs';

const persistedMarket = await loadBackendModule('market_engine/persisted_as_of.ts');
const persistedPositioning = await loadBackendModule('positioning_engine/persisted_evidence.ts');
const asOf = await loadBackendModule('market_engine/as_of_snapshot.ts');
const positioning = await loadBackendModule('positioning_engine/evidence_contract.ts');
const validate = await loadBackendModule('market_engine/validate.ts');
const capture = await loadBackendModule('market_engine/evidence_capture.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const canonical = await loadBackendModule('shared/canonical_json.ts');
const strict = await loadBackendModule('shared/strict_timestamp.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));

const cutoff = '2026-10-01T14:15:00.000Z';
const marketRow = {
  candidate_id: '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b', field: 'spot', value: '3900.550000', source: 'twelve_data',
  observed_at: '2026-10-01T14:14:00.000Z', ingested_at: '2026-10-01T14:14:03.000Z', evidence_revision: 'r1',
};
const positioningRow = {
  evidence_id: '3f2b8c1e-5a4d-4e6f-8a7b-9c0d1e2f3a4b', source_authority: 'cftc', dataset_code: 'cot-disaggregated',
  instrument_code: 'GOLD', metric_code: 'managed-money-net', value: '12345', unit: 'CONTRACTS', period_end: '2026-09-29',
  published_at: '2026-10-02T19:30:00.000Z', observed_at: '2026-10-02T19:31:00.000Z', artifact_id: 'artifact-1', revision: null,
};
const candidate = persistedMarket.normalizeMarketPricingAsOfRows([marketRow])[0];
const point = { symbol: 'XAUUSD', source: 'twelve_data', value: 3900, observedAt: '2026-10-01T14:14:00.000Z',
  open: null, high: null, low: null, bid: null, ask: null, volume: null };
const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
const fredBody = JSON.stringify({ realtime_start: '2026-10-01', realtime_end: '2026-10-01', observation_start: '2026-09-30', units: 'lin',
  file_type: 'json', observations: [{ realtime_start: '2026-10-01', realtime_end: '2026-10-01', date: '2026-09-30', value: '4.10' }] });
const archive = capture.createEvidenceArchive({ archiveId: 'mutation-log', provenanceClass: 'SYNTHETIC_FIXTURE',
  createdAt: '2026-09-29T00:00:00.000Z', fields: capture.CAPTURABLE_FIELDS, statement: 'mutation sweep log' });
const providerCapture = { provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10', body: fredBody, ingestedAt: '2026-10-01T06:00:00.000Z' };
const appended = await capture.appendProviderCapture(archive, providerCapture, parsers);
assert.equal(appended.outcome, 'APPENDED');

// Sanity: the bases work, so the sweeps do not only test refusals.
assert.equal(persistedMarket.buildPersistedMarketPricingAsOf([marketRow], cutoff).selection.fields.spot.value, 3900.55);
assert.ok(persistedPositioning.buildPersistedPositioningEvidence([positioningRow], cutoff).evidence);
assert.equal(validate.validatePoint(point, new Date('2026-10-01T14:15:00.000Z')).ok, true);

const failures = [];
const note = (label, message) => { if (failures.length < 30) failures.push(`${label}: ${message}`); };
const tally = { returned: 0, refused: 0 };
const INTERNAL = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError']);

async function probe(label, run, check = () => {}, { hashable = true } = {}) {
  try {
    const out = await run();
    tally.returned += 1;
    if (out !== null && typeof out === 'object') {
      if (out.execution !== undefined && out.execution !== 'FORBIDDEN') note(label, `execution ${out.execution}`);
      if (out.decision !== undefined && out.decision !== 'HOLD') note(label, `decision ${out.decision}`);
      if (hashable) {
        try { canonical.canonicalJson(out); } catch (error) { note(label, `unhashable result: ${error.message}`); }
      }
    }
    check(out);
  } catch (error) {
    if (error instanceof Error && !INTERNAL.has(error.name)) tally.refused += 1;
    else note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

// MP-2 / P-1 persisted rows.
for (const [label, rows] of mutationCases([marketRow]).map(([l, m]) => [l, m])) {
  await probe(`market rows ${label}`, () => persistedMarket.buildPersistedMarketPricingAsOf(rows, cutoff));
}
for (const [label, rows] of mutationCases([positioningRow])) {
  await probe(`positioning rows ${label}`, () => persistedPositioning.buildPersistedPositioningEvidence(rows, cutoff));
}
for (const [i, value] of HOSTILE_VALUES.entries()) {
  await probe(`market cutoff hostile#${i}`, () => persistedMarket.buildPersistedMarketPricingAsOf([marketRow], structuredClone(value)));
  await probe(`positioning cutoff hostile#${i}`, () => persistedPositioning.buildPersistedPositioningEvidence([positioningRow], structuredClone(value)));
  await probe(`market rows hostile#${i}`, () => persistedMarket.buildPersistedMarketPricingAsOf(structuredClone(value), cutoff));
  await probe(`positioning rows hostile#${i}`, () => persistedPositioning.buildPersistedPositioningEvidence(structuredClone(value), cutoff));
}
// A text value must be a plain decimal: Number() would also read these.
for (const text of ['0x10', '0X1f', '0b11', '0o7', '  0x10  ', '1_000', 'Infinity', '-Infinity', 'NaN', '', ' ', '1e999']) {
  for (const [name, build] of [
    ['market', () => persistedMarket.normalizeMarketPricingAsOfRows([{ ...marketRow, value: text }])],
    ['positioning', () => persistedPositioning.normalizePositioningEvidenceRows([{ ...positioningRow, value: text }])],
  ]) {
    try {
      const out = build();
      note(`${name} value ${JSON.stringify(text)}`, `accepted as ${out[0].value}`);
    } catch (error) {
      if (!(error instanceof Error) || INTERNAL.has(error.name)) note(`${name} value ${JSON.stringify(text)}`, `internal ${error}`);
    }
  }
}
for (const text of ['3900.55', ' 3900.55 ', '-12.5', '+7', '.5', '5.', '1e3', '1E-2', '0', '12345678901234567890.123456']) {
  assert.doesNotThrow(() => persistedMarket.normalizeMarketPricingAsOfRows([{ ...marketRow, value: text }]), `market ${text}`);
  assert.doesNotThrow(() => persistedPositioning.normalizePositioningEvidenceRows([{ ...positioningRow, value: text }]), `positioning ${text}`);
}

// Database read path (v_market_latest): a NUMERIC arrives as text and must never turn into a number by accident.
{
  const context = await loadBackendModule('market_engine/context.ts');
  const goldRow = (overrides) => ({
    symbol: 'XAUUSD', bid: '3899.90', ask: '3900.10', close: '3900.00', dxy_value: null, us10y_yield: null,
    real_yield: null, vix: null, wti: null, source: 'twelve_data', ts: '2026-10-01T14:14:00.000Z', staleness_seconds: '60', ...overrides,
  });
  assert.equal(context.buildSnapshot([goldRow({})]).spot.value, 3900, 'a plain decimal text is read');
  assert.equal(context.buildSnapshot([goldRow({ close: ' 3900.5 ' })]).spot.value, 3900.5, 'surrounding spaces are tolerated');
  assert.equal(context.buildSnapshot([goldRow({ close: '1e3' })]).spot.value, 1000, 'an exponent is still a decimal');
  for (const text of ['', ' ', '\n', '0x10', '0b11', '0o7', '1_000', 'Infinity', '-Infinity', 'NaN', 'null', '1,5', '.', '+', '--1']) {
    const snapshot = context.buildSnapshot([goldRow({ close: text })]);
    if (snapshot.available !== false || snapshot.spot.value !== null) note(`context close ${JSON.stringify(text)}`, `read as ${snapshot.spot.value}`);
    const aged = context.buildSnapshot([goldRow({ staleness_seconds: text })]);
    if (aged.spot.value !== null) note(`context staleness ${JSON.stringify(text)}`, `an unreadable age still gave a value (${aged.spot.value})`);
    const bid = context.buildSnapshot([goldRow({ bid: text })]);
    if (bid.bid.value !== null) note(`context bid ${JSON.stringify(text)}`, `read as ${bid.bid.value}`);
  }
}

// MP-1 selection, P-0 envelope.
for (const [label, candidates] of mutationCases([candidate])) {
  await probe(`candidates ${label}`, () => asOf.selectMarketPricingAsOf(candidates, cutoff));
}
for (const [i, value] of HOSTILE_VALUES.entries()) {
  await probe(`as-of cutoff hostile#${i}`, () => asOf.selectMarketPricingAsOf([candidate], structuredClone(value)));
  await probe(`positioning envelope cutoff hostile#${i}`, () => positioning.buildPositioningEvidenceEnvelope(golden.input.positioningEvidence, structuredClone(value)));
}
for (const [label, inputs] of mutationCases(golden.input.positioningEvidence)) {
  await probe(`positioning inputs ${label}`, () => positioning.buildPositioningEvidenceEnvelope(inputs, cutoff));
}

// Point validation. Its input is a RawDataPoint built by the parsers (always an object), and its
// rejections are log records rather than hashed envelopes, so only field-level mutations apply.
const now = new Date('2026-10-01T14:15:00.000Z');
for (const [label, raw] of mutationCases(point).filter(([, mutated]) => mutated !== null && typeof mutated === 'object')) {
  await probe(`point ${label}`, () => validate.validatePoint(raw, now), (out) => {
    if (out.ok === true && !(Number.isFinite(out.point?.value ?? out.value))) note(`point ${label}`, 'accepted a non-finite value');
  }, { hashable: false });
}

// Capture append and merge.
for (const [label, hostile] of mutationCases(providerCapture)) {
  await probe(`capture ${label}`, () => capture.appendProviderCapture(archive, hostile, parsers), (out) => {
    if (!['APPENDED', 'ALREADY_CAPTURED', 'NO_NEW_VALUE', 'REJECTED'].includes(out.outcome)) note(`capture ${label}`, `outcome ${out.outcome}`);
    if (out.outcome === 'APPENDED') {
      for (const record of out.archive.records) {
        if (strict.parseStrictTimestamp(record.ingestedAt) === null || strict.parseStrictTimestamp(record.observedAt) === null || !Number.isFinite(record.value)) {
          note(`capture ${label}`, 'appended an unusable record');
        }
      }
    }
  });
}
for (const [label, hostile] of mutationCases(appended.archive)) {
  // A REJECTED result returns the caller's archive unchanged, hostile content included; only an
  // accepted result (APPENDED / ALREADY_CAPTURED) must hold a clean, hashable archive.
  await probe(`capture into archive ${label}`, () => capture.appendProviderCapture(hostile, providerCapture, parsers), (out) => {
    if (out.outcome === 'REJECTED') return;
    try { canonical.canonicalJson(out.archive); } catch (error) { note(`capture into archive ${label}`, `accepted an unhashable archive: ${error.message}`); }
  }, { hashable: false });
  await probe(`merge ${label}`, () => capture.mergeCaptureArchives([hostile], { archiveId: 'merged', parsers }));
}
for (const [i, value] of HOSTILE_VALUES.entries()) {
  await probe(`merge sources hostile#${i}`, () => capture.mergeCaptureArchives(structuredClone(value), { archiveId: 'merged', parsers }));
  await probe(`capture parsers hostile#${i}`, () => capture.appendProviderCapture(archive, providerCapture, structuredClone(value)));
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.returned > 300 && tally.refused > 300, `the sweep exercises results and refusals ${JSON.stringify(tally)}`);
console.log(`PASS market/positioning ingest: ${tally.returned + tally.refused} hostile calls, no internal error, `
  + `${tally.returned} results, ${tally.refused} named refusals; text values are plain decimals only`);
