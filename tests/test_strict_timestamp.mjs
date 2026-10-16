import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { parseStrictTimestamp, isStrictTimestamp } = await loadBackendModule('shared/strict_timestamp.ts');

// Accepted shapes keep their Date.parse value.
for (const value of [
  '2026-10-01T14:15:00Z', '2026-10-01T14:15:00.000Z', '2026-10-01T14:15:00.123456789Z',
  '2026-10-01T16:15:00+02:00', '2026-10-01T09:15:00-05:00', '2024-02-29T00:00:00Z',
  '2000-02-29T23:59:59Z', '2026-12-31T23:59:59.999Z', '2026-10-01T00:00:00+14:00',
  '2026-10-01T00:00:00-12:00', '0001-01-01T00:00:00Z',
]) {
  assert.equal(parseStrictTimestamp(value), Date.parse(value), value);
  assert.equal(isStrictTimestamp(value), true, value);
}

// Impossible civil times that Date.parse silently shifts are rejected.
for (const value of [
  '2026-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T12:00:00Z', '1900-02-29T00:00:00Z',
  '2026-10-01T24:00:00Z', '2026-10-01T23:60:00Z', '2026-10-01T23:59:60Z', '2026-00-10T00:00:00Z',
  '2026-13-01T00:00:00Z', '2026-10-00T00:00:00Z', '2026-10-01T10:00:00+24:00',
  '2026-10-01T10:00:00+05:60',
  // Zone and year policy shared with TIME-0: no impossible offsets, no unknown
  // local offset (-00:00), no year 0000.
  '2026-10-01T00:00:00+23:59', '2026-10-01T00:00:00+14:01', '2026-10-01T00:00:00-14:30',
  '2026-10-01T00:00:00+15:00', '2026-10-01T00:00:00-00:00', '0000-01-01T00:00:00Z',
]) {
  assert.equal(parseStrictTimestamp(value), null, value);
}
assert.notEqual(parseStrictTimestamp('2026-10-01T00:00:00+00:00'), null, '+00:00 stays valid');

// One timestamp policy across both shared parsers: CHAIN-0's parser and TIME-0
// must accept exactly the same strings and agree on the millisecond instant.
const temporal = await loadBackendModule('shared/temporal_contract.ts');
const probes = [];
for (const year of ['0000', '0001', '1900', '2000', '2024', '2026', '9999']) {
  for (const md of ['01-01', '02-28', '02-29', '02-30', '04-31', '12-31', '13-01', '00-10']) {
    for (const hms of ['00:00:00', '23:59:59', '24:00:00', '23:60:00', '12:00:60']) {
      for (const tail of ['Z', '.5Z', '.123456789Z', '+00:00', '-00:00', '+05:30', '-12:00', '+14:00',
        '+14:01', '-14:30', '+23:59', '-23:59', '+24:00', '+05:60', 'z', '']) {
        probes.push(`${year}-${md}T${hms}${tail}`);
      }
    }
  }
}
let accepted = 0;
for (const value of probes) {
  const strict = parseStrictTimestamp(value);
  const instant = temporal.parseStrictInstant(value);
  assert.equal(strict !== null, instant !== null, `parsers disagree on ${value}`);
  if (instant !== null) {
    accepted += 1;
    assert.equal(strict, Number(instant.epochNanoseconds / 1_000_000n
      - (instant.epochNanoseconds % 1_000_000n < 0n ? 1n : 0n)), `millisecond instant differs on ${value}`);
  }
}
assert.ok(accepted > 200 && accepted < probes.length / 2, `the sweep exercises both outcomes (${accepted}/${probes.length})`);

// Shape is unchanged: zone required, fraction 1-9 digits, colon offsets only.
for (const value of [
  '2026-10-01T14:15:00', '2026-10-01 14:15:00Z', '2026-10-01', '2026-10-01T14:15Z',
  '2026-10-01T14:15:00.Z', '2026-10-01T14:15:00.1234567890Z', '2026-10-01T14:15:00+0200',
  ' 2026-10-01T14:15:00Z', '2026-10-01T14:15:00z', '',
]) {
  assert.equal(parseStrictTimestamp(value), null, JSON.stringify(value));
}
for (const value of [null, undefined, 0, 1727791200000, {}, [], new Date(0)]) {
  assert.equal(parseStrictTimestamp(value), null);
}

// Every stage of the chain rejects an impossible cutoff instead of shifting it.
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const shifted = '2026-02-30T14:15:00.000Z';
const golden = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const run = chain.runDecisionChainDryRun(golden.input, shifted);
assert.equal(run.chainState, 'HOLD');
for (const item of run.trace) {
  assert.ok(item.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'), item.stage);
}
assert.equal(run.trace.length, 12);

// Market and positioning observations at impossible times are invalid, not shifted.
const market = await loadBackendModule('market_engine/institutional_snapshot.ts');
const snapshot = structuredClone(golden.input.marketSnapshot);
snapshot.vix = { ...snapshot.vix, observedAt: '2026-09-31T00:00:00Z' };
const envelope = market.buildInstitutionalMarketPricingSnapshot(snapshot, golden.knowledgeCutoff);
assert.equal(envelope.state, 'ABSTAIN');
assert.ok(envelope.reasonCodes.includes('INVALID_FIELD_CONTRACT'));

const positioning = await loadBackendModule('positioning_engine/evidence_contract.ts');
const evidence = { ...golden.input.positioningEvidence[0], publishedAt: '2026-09-30T24:00:00Z' };
const positioned = positioning.buildPositioningEvidenceEnvelope([evidence], golden.knowledgeCutoff);
assert.equal(positioned.evidenceState, 'ABSTAIN');
assert.ok(positioned.reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));

const asOf = await loadBackendModule('market_engine/as_of_snapshot.ts');
const candidate = {
  candidateId: 'spot-1', field: 'spot', value: 3900, source: 'source-a',
  observedAt: '2026-10-01T09:55:00Z', ingestedAt: '2026-10-01T09:56:00Z',
};
assert.ok(!asOf.selectMarketPricingAsOf([candidate], '2026-10-01T10:00:00Z').reasonCodes
  .some((code) => code.startsWith('INVALID_')));
assert.ok(asOf.selectMarketPricingAsOf([candidate], '2026-10-01T24:00:00Z').reasonCodes
  .includes('INVALID_KNOWLEDGE_CUTOFF'));
assert.ok(asOf.selectMarketPricingAsOf([{ ...candidate, ingestedAt: '2026-02-30T09:56:00Z' }],
  '2026-10-01T10:00:00Z').reasonCodes.includes('INVALID_CANDIDATE_HISTORY'));

// Ingestion: provider dates are never shifted and malformed times are not midnight.
const providers = await loadBackendModule('market_engine/providers.ts');
assert.equal(providers.toUtcIso('2026-09-30'), '2026-09-30T00:00:00.000Z');
assert.equal(providers.toUtcIso('2026-09-30', '14:05'), '2026-09-30T14:05:00.000Z');
assert.equal(providers.toUtcIso('2026-09-30', '14:05:07'), '2026-09-30T14:05:07.000Z');
assert.equal(providers.toUtcIso('2024-02-29'), '2024-02-29T00:00:00.000Z');
assert.equal(providers.toUtcIso('2026-02-30'), null);
assert.equal(providers.toUtcIso('2026-09-31'), null);
assert.equal(providers.toUtcIso('2026-09-30', '24:00'), null);
assert.equal(providers.toUtcIso('2026-09-30', '25:99'), null);
assert.equal(providers.toUtcIso('2026-09-30', 'noon'), null);
assert.equal(providers.toUtcIso('.'), null);

const validate = await loadBackendModule('market_engine/validate.ts');
const point = (observedAt) => ({
  symbol: 'VIX', source: 'fred', value: 17.2, observedAt,
  open: null, high: null, low: null, bid: null, ask: null, volume: null,
});
const now = new Date('2026-10-01T12:00:00.000Z');
assert.equal(validate.validatePoint(point('2026-10-01T00:00:00.000Z'), now).ok, true);
const shiftedPoint = validate.validatePoint(point('2026-09-31T00:00:00.000Z'), now);
assert.equal(shiftedPoint.ok, false);
assert.equal(shiftedPoint.rejection.reason, 'Horodatage source invalide');

console.log('PASS strict timestamps reject impossible civil times at every V2 boundary');
