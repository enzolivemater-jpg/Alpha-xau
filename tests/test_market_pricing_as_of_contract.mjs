import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(ROOT, 'backend', 'market_engine', 'as_of_snapshot.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_MARKET_PRICING_AS_OF_CONTRACT.md'), 'utf8');
const board = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_COMPLETION_BOARD.md'), 'utf8');

const mod = await loadBackendModule('market_engine/as_of_snapshot.ts');

const candidate = (candidateId, field, value, observedAt, ingestedAt, sourceName = 'source-a') => ({
  candidateId, field, value, observedAt, ingestedAt, source: sourceName,
});

const cutoff = '2026-10-01T10:00:00.000Z';
const complete = [
  candidate('spot-old', 'spot', 3890, '2026-10-01T09:00:00Z', '2026-10-01T09:00:05Z'),
  candidate('spot-current', 'spot', 3898, '2026-10-01T09:55:00Z', '2026-10-01T09:56:00Z'),
  candidate('spot-late-correction', 'spot', 3900, '2026-10-01T09:59:00Z', '2026-10-01T10:05:00Z'),
  candidate('bid', 'bid', 3897.8, '2026-10-01T09:55:00Z', '2026-10-01T09:56:00Z'),
  candidate('ask', 'ask', 3898.2, '2026-10-01T09:55:00Z', '2026-10-01T09:56:00Z'),
  candidate('dxy', 'dxy', 97.4, '2026-10-01T08:00:00Z', '2026-10-01T08:01:00Z'),
  candidate('us10y', 'us10y', 4.1, '2026-10-01T00:00:00Z', '2026-10-01T00:03:00Z'),
  candidate('real-yield', 'realYield', 1.7, '2026-10-01T00:00:00Z', '2026-10-01T00:03:00Z'),
  candidate('vix', 'vix', 17.2, '2026-10-01T00:00:00Z', '2026-10-01T00:03:00Z'),
  candidate('wti', 'wti', 66.4, '2026-10-01T00:00:00Z', '2026-10-01T00:03:00Z'),
];

const first = mod.selectMarketPricingAsOf(complete, cutoff);
const reordered = mod.selectMarketPricingAsOf([...complete].reverse(), cutoff);
assert.deepEqual(first, reordered);
assert.equal(first.schemaVersion, 'xau.market-pricing-as-of.v1');
assert.equal(first.algorithmVersion, 'market-pricing-as-of-selector-1.0.0');
assert.equal(first.state, 'AS_OF_AVAILABLE');
assert.deepEqual(first.reasonCodes, []);
assert.equal(first.fields.spot.candidateId, 'spot-current');
assert.equal(first.fields.spot.ageSeconds, 300);
assert.equal(first.fields.spot.observedAt, '2026-10-01T09:55:00.000Z');
assert.equal(first.fields.spot.ingestedAt, '2026-10-01T09:56:00.000Z');
assert.equal(first.evidence.candidateCount, 10);
assert.equal(first.evidence.uniqueCandidateCount, 10);
assert.equal(first.evidence.eligibleCandidateCount, 9);
assert.equal(first.evidence.excludedAfterCutoffCount, 1);
assert.deepEqual(first.evidence.selectedCandidateIds, [
  'spot-current', 'bid', 'ask', 'dxy', 'us10y', 'real-yield', 'vix', 'wti',
]);
assert.deepEqual(first.replay, {
  mode: 'EXPLICIT_HISTORY_AS_OF', reproducible: true, persistenceProven: false,
});

const afterCorrection = mod.selectMarketPricingAsOf(complete, '2026-10-01T10:06:00Z');
assert.equal(afterCorrection.fields.spot.candidateId, 'spot-late-correction');
assert.equal(afterCorrection.fields.spot.ageSeconds, 420);

const exactDuplicate = mod.selectMarketPricingAsOf([...complete, structuredClone(complete[1])], cutoff);
assert.equal(exactDuplicate.state, 'AS_OF_AVAILABLE');
assert.equal(exactDuplicate.evidence.candidateCount, 11);
assert.equal(exactDuplicate.evidence.uniqueCandidateCount, 10);

const missingOptional = mod.selectMarketPricingAsOf([complete[1]], cutoff);
assert.equal(missingOptional.state, 'DEGRADED');
assert.deepEqual(missingOptional.reasonCodes, ['OPTIONAL_FIELD_UNAVAILABLE_AS_OF']);
assert.equal(missingOptional.fields.bid, null);

const noSpot = mod.selectMarketPricingAsOf(complete.filter((item) => item.field !== 'spot'), cutoff);
assert.equal(noSpot.state, 'ABSTAIN');
assert.deepEqual(noSpot.reasonCodes, ['SPOT_UNAVAILABLE_AS_OF']);
assert.equal(noSpot.replay.reproducible, true);

const malformed = structuredClone(complete);
malformed[0].observedAt = '2026-10-01';
assert.deepEqual(mod.selectMarketPricingAsOf(malformed, cutoff).reasonCodes.slice(0, 1), ['INVALID_CANDIDATE_HISTORY']);
assert.equal(mod.selectMarketPricingAsOf(complete, '2026-10-01').state, 'ABSTAIN');

const identityConflict = [...complete, { ...complete[1], value: 9999 }];
assert.ok(mod.selectMarketPricingAsOf(identityConflict, cutoff).reasonCodes.includes('AMBIGUOUS_CANDIDATE_IDENTITY'));

const causalInversion = [...complete, candidate(
  'causal-inversion', 'spot', 3901, '2026-10-01T09:59:00Z', '2026-10-01T09:58:00Z',
)];
assert.ok(mod.selectMarketPricingAsOf(causalInversion, cutoff).reasonCodes.includes('OBSERVATION_AFTER_INGESTION'));

const lookahead = [...complete, candidate(
  'lookahead', 'spot', 3901, '2026-10-01T10:01:00Z', '2026-10-01T09:59:00Z',
)];
assert.ok(mod.selectMarketPricingAsOf(lookahead, cutoff).reasonCodes.includes('LOOKAHEAD_CANDIDATE'));

const ambiguous = [...complete, candidate(
  'spot-source-b', 'spot', 3899, '2026-10-01T09:55:00Z', '2026-10-01T09:57:00Z', 'source-b',
)];
const ambiguousResult = mod.selectMarketPricingAsOf(ambiguous, cutoff);
assert.equal(ambiguousResult.state, 'ABSTAIN');
assert.ok(ambiguousResult.reasonCodes.includes('AMBIGUOUS_TOP_OBSERVATION'));
assert.equal(ambiguousResult.fields.spot, null);

const inverted = complete.map((item) => item.candidateId === 'bid' ? { ...item, value: 3899 } : item);
assert.ok(mod.selectMarketPricingAsOf(inverted, cutoff).reasonCodes.includes('BOOK_INVERTED'));

assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env/);
assert.match(docs, /EXPLICIT HISTORY ONLY \/ NOT RUNTIME-ACTIVATED/);
assert.match(docs, /persistenceProven=false/);
assert.match(docs, /authorizes no provider selection, purchase, schema, migration, production/i);
assert.match(board, /MP-1 no-lookahead selector/);
assert.match(board, /production migration and runtime evidence ingestion\/read remain absent/i);
console.log('PASS Market Pricing MP-1 selects deterministic as-of evidence without lookahead or runtime claims');

// --- Engine qualification (Agent C): revisions, late data, ambiguity and fail-closed history, at exact edges.
{
  const sel = (cands, at) => mod.selectMarketPricingAsOf(cands, at);
  const withRev = (id, value, ingestedAt, rev) => ({ ...candidate(id, 'vix', value, '2026-10-01T00:00:00Z', ingestedAt), evidenceRevision: rev });
  const base = complete.filter((c) => c.field !== 'vix');
  const v1 = withRev('vix-v1', 17.2, '2026-10-01T00:03:00Z', 'r1');
  const v2 = withRev('vix-v2', 17.9, '2026-10-01T09:30:00Z', 'r2');
  // A correction is used from its ingestion instant, never one millisecond before.
  assert.equal(sel([...base, v1, v2], '2026-10-01T09:29:59.999Z').fields.vix.candidateId, 'vix-v1');
  assert.equal(sel([...base, v1, v2], '2026-10-01T09:30:00.000Z').fields.vix.candidateId, 'vix-v2');
  assert.equal(sel([...base, v2, v1], '2026-10-01T09:30:00.000Z').fields.vix.candidateId, 'vix-v2', 'history order does not matter');
  // Late data: a newer observation received after the cutoff is excluded and counted; one received in time wins.
  const late = candidate('spot-newer-late', 'spot', 3911, '2026-10-01T09:58:00Z', '2026-10-01T10:00:00.001Z');
  const lateSel = sel([...complete, late], cutoff);
  assert.equal(lateSel.fields.spot.candidateId, 'spot-current');
  assert.equal(lateSel.evidence.excludedAfterCutoffCount, 2, 'the late correction and the late observation');
  // An older observation arriving after a newer one never displaces it.
  const backfill = candidate('spot-backfill', 'spot', 3801, '2026-10-01T09:50:00Z', '2026-10-01T09:59:00Z');
  assert.equal(sel([...complete, backfill], cutoff).fields.spot.candidateId, 'spot-current');
  // Two sources, same observation time, different values: ambiguity abstains the whole selection, even on an optional field.
  const disagree = candidate('vix-other', 'vix', 18.4, '2026-10-01T00:00:00Z', '2026-10-01T00:04:00Z', 'source-b');
  const amb = sel([...complete, disagree], cutoff);
  assert.equal(amb.state, 'ABSTAIN');
  assert.deepEqual([amb.fields.vix, amb.replay.reproducible], [null, false]);
  assert.ok(amb.reasonCodes.includes('AMBIGUOUS_TOP_OBSERVATION'));
  // Same value from two sources: not ambiguous, and the pick does not depend on history order.
  const agree = candidate('vix-other', 'vix', 17.2, '2026-10-01T00:00:00Z', '2026-10-01T00:04:00Z', 'source-b');
  assert.deepEqual(sel([...complete, agree], cutoff).fields.vix, sel([agree, ...complete], cutoff).fields.vix);
  assert.equal(sel([...complete, agree], cutoff).state, 'AS_OF_AVAILABLE');
  // A defective record known only later makes earlier cutoffs abstain (whole-history integrity): fail closed, never more data.
  const defective = candidate('bad-chronology', 'wti', 66.1, '2026-10-02T00:00:00Z', '2026-10-01T23:00:00Z');
  for (const at of ['2026-10-01T10:00:00.000Z', '2026-10-01T22:59:59.999Z']) {
    const clean = sel(complete, at);
    const poisoned = sel([...complete, defective], at);
    assert.equal(poisoned.state, 'ABSTAIN', at);
    assert.equal(poisoned.replay.reproducible, false, at);
    for (const f of mod.MARKET_PRICING_AS_OF_FIELDS) {
      assert.ok(poisoned.fields[f] === null || poisoned.fields[f].candidateId === clean.fields[f]?.candidateId, `${f} at ${at}: never a different value`);
    }
  }
  // Ages are whole seconds, floored (current contract): 999 ms after a second boundary is still the earlier second.
  const s = sel(complete, '2026-10-01T10:00:00.999Z');
  assert.equal(s.fields.spot.ageSeconds, 300);
  assert.equal(sel(complete, '2026-10-01T10:00:01.000Z').fields.spot.ageSeconds, 301);
}
console.log('PASS MP-1 qualification: revisions at their ingestion edge, late data excluded, ambiguity abstains, defective history fails closed');
