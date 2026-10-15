// A knowledge cutoff is exact to the nanosecond. Date.parse keeps only
// milliseconds, so evidence stamped 14:15:00.0005Z used to compare equal to a
// 14:15:00Z cutoff and pass as known. PostgreSQL timestamps carry
// microseconds, so such values are real; every gate must exclude them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ts = await loadBackendModule('shared/strict_timestamp.ts');
const mp0 = await loadBackendModule('market_engine/institutional_snapshot.ts');
const mp1 = await loadBackendModule('market_engine/as_of_snapshot.ts');
const p0 = await loadBackendModule('positioning_engine/evidence_contract.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));

// --- Helper.
const N = ts.parseStrictTimestampNanos;
assert.equal(N('1970-01-01T00:00:00Z'), 0n);
assert.equal(N('1970-01-01T00:00:00.000000001Z'), 1n);
assert.equal(N('1970-01-01T00:00:00.123456789Z'), 123456789n);
assert.equal(N('1970-01-01T00:00:00.5Z'), 500000000n);
assert.equal(N('1970-01-01T01:00:00.0005+01:00'), 500000n);
assert.equal(N('1969-12-31T23:59:59.9995Z'), -500000n);
for (const bad of [null, 1, '', '2026-02-30T00:00:00Z', '2026-10-01T14:15:00', '2026-10-01T14:15:00.1234567890Z']) {
  assert.equal(N(bad), null, String(bad));
}
assert.equal(ts.isStrictlyAfter('2026-10-01T14:15:00.0005Z', '2026-10-01T14:15:00Z'), true);
assert.equal(ts.isStrictlyAfter('2026-10-01T16:15:00.000000001+02:00', '2026-10-01T14:15:00Z'), true);
assert.equal(ts.isStrictlyAfter('2026-10-01T14:15:00.000Z', '2026-10-01T14:15:00Z'), false);
assert.equal(ts.isStrictlyAfter('2026-10-01T14:14:59.9999Z', '2026-10-01T14:15:00Z'), false);
assert.equal(ts.isStrictlyAfter('bad', '2026-10-01T14:15:00Z'), false);
console.log('PASS parseStrictTimestampNanos keeps every fractional digit; isStrictlyAfter is exact');

const CUTOFF = '2026-10-01T14:15:00Z';
const AFTER = '2026-10-01T14:15:00.000500Z';
const AT = '2026-10-01T14:15:00.000000Z';

// --- MP-0.
const field = (observedAt) => ({ value: 3900, status: 'LIVE', observedAt, ageSeconds: 0, source: 'twelve_data' });
const snapshot = (observedAt) => ({
  ...golden.input.marketSnapshot, spot: field(observedAt), bid: { ...field(observedAt), value: 3899.8 },
  ask: { ...field(observedAt), value: 3900.2 }, capturedAt: observedAt,
});
assert.ok(mp0.buildInstitutionalMarketPricingSnapshot(snapshot(AFTER), CUTOFF).reasonCodes
  .includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
assert.ok(!mp0.buildInstitutionalMarketPricingSnapshot(snapshot(AT), CUTOFF).reasonCodes
  .includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
console.log('PASS MP-0 rejects an observation 500 µs after the cutoff');

// --- MP-1.
const candidate = (candidateId, field, value, observedAt, ingestedAt) => ({
  candidateId, field, value, observedAt, ingestedAt, source: 'source-a',
});
const before = candidate('spot-before', 'spot', 3898, '2026-10-01T14:10:00Z', '2026-10-01T14:11:00Z');
let selection = mp1.selectMarketPricingAsOf([before,
  candidate('spot-late', 'spot', 3950, '2026-10-01T14:14:00Z', AFTER)], CUTOFF);
assert.equal(selection.fields.spot.candidateId, 'spot-before', 'ingested 500 µs after the cutoff is not known');
assert.equal(selection.evidence.excludedAfterCutoffCount, 1);
selection = mp1.selectMarketPricingAsOf([before,
  candidate('spot-lookahead', 'spot', 3950, AFTER, '2026-10-01T14:14:00Z')], CUTOFF);
assert.ok(selection.reasonCodes.includes('OBSERVATION_AFTER_INGESTION'));
assert.ok(selection.reasonCodes.includes('LOOKAHEAD_CANDIDATE'));
selection = mp1.selectMarketPricingAsOf([before,
  candidate('spot-at', 'spot', 3950, '2026-10-01T14:14:00Z', AT)], CUTOFF);
assert.equal(selection.fields.spot.candidateId, 'spot-at', 'ingested exactly at the cutoff is known');
console.log('PASS MP-1 excludes ingestion and observation 500 µs after the cutoff');

// --- P-0.
const evidence = (overrides) => ({ ...golden.input.positioningEvidence[0], ...overrides });
for (const late of [{ publishedAt: AT, observedAt: AFTER }, { publishedAt: AFTER, observedAt: AFTER }]) {
  const envelope = p0.buildPositioningEvidenceEnvelope([evidence(late)], CUTOFF);
  assert.ok(envelope.reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'), JSON.stringify(late));
}
// Published after observed by 500 µs breaks the persistence invariant.
assert.ok(p0.buildPositioningEvidenceEnvelope([evidence({ publishedAt: AFTER, observedAt: AT })], '2026-10-02T00:00:00Z')
  .reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));
assert.ok(!p0.buildPositioningEvidenceEnvelope([evidence({ publishedAt: AT, observedAt: AT })], CUTOFF)
  .reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'));
console.log('PASS P-0 rejects evidence published or observed 500 µs after the cutoff');

// --- CHAIN-0 end to end.
const input = structuredClone(golden.input);
Object.assign(input.marketSnapshot, snapshot(AFTER));
input.positioningEvidence = [evidence({ publishedAt: '2026-10-01T14:15:00.0001Z', observedAt: '2026-10-01T14:15:00.0001Z' })];
const outcome = chain.evaluateDecisionChain(input, CUTOFF);
assert.equal(outcome.kind, 'COMPLETED');
assert.equal(outcome.result.integrity, 'CONSISTENT');
const [market, positioning] = outcome.result.trace;
assert.equal(market.state, 'ABSTAIN');
assert.ok(market.reasonCodes.includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
assert.equal(positioning.state, 'ABSTAIN');
assert.ok(positioning.reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'));
// The golden replay is unchanged.
const goldenOutcome = chain.evaluateDecisionChain(golden.input, golden.knowledgeCutoff);
assert.equal(await chain.computeDecisionChainDigest(goldenOutcome.result),
  'sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7');
console.log('PASS CHAIN-0 abstains on sub-millisecond lookahead; golden digest unchanged');
