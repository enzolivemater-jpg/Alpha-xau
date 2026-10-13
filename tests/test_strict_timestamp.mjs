import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { parseStrictTimestamp, isStrictTimestamp } = await loadBackendModule('shared/strict_timestamp.ts');

// Accepted shapes keep their Date.parse value.
for (const value of [
  '2026-10-01T14:15:00Z', '2026-10-01T14:15:00.000Z', '2026-10-01T14:15:00.123456789Z',
  '2026-10-01T16:15:00+02:00', '2026-10-01T09:15:00-05:00', '2024-02-29T00:00:00Z',
  '2000-02-29T23:59:59Z', '2026-12-31T23:59:59.999Z', '2026-10-01T00:00:00+23:59',
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
]) {
  assert.equal(parseStrictTimestamp(value), null, value);
}

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

console.log('PASS strict timestamps reject impossible civil times at every V2 boundary');
