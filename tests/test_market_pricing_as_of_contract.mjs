import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(ROOT, 'backend', 'market_engine', 'as_of_snapshot.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_MARKET_PRICING_AS_OF_CONTRACT.md'), 'utf8');
const board = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_COMPLETION_BOARD.md'), 'utf8');

const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = mkdtempSync(path.join(tmpdir(), 'market-pricing-as-of-'));
let mod;
try {
  const modulePath = path.join(temp, 'as_of_snapshot.mjs');
  writeFileSync(modulePath, output, 'utf8');
  mod = await import(pathToFileURL(modulePath).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

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
assert.match(board, /MP-1 explicit-history as-of selector/);
assert.match(board, /production persistence\/runtime replay remain absent/i);
console.log('PASS Market Pricing MP-1 selects deterministic as-of evidence without lookahead or runtime claims');
