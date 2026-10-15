import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await loadBackendModule('regime_engine/contract.ts');

const cutoff = '2026-10-01T12:00:00.000Z';
const input = {
  marketPricing: {
    schemaVersion: 'xau.market-pricing-snapshot.v1',
    algorithmVersion: 'market-pricing-envelope-1.0.0',
    state: 'DEGRADED',
    reasonCodes: ['HISTORICAL_REPLAY_UNAVAILABLE'],
    knowledgeCutoff: cutoff,
  },
  positioning: {
    schemaVersion: 'xau.positioning-evidence.v1',
    algorithmVersion: 'positioning-evidence-normalizer-1.0.0',
    evidenceState: 'EVIDENCE_READY',
    positioningState: 'UNAVAILABLE',
    reasonCodes: ['METHODOLOGY_NOT_APPROVED'],
    knowledgeCutoff: cutoff,
  },
};

const result = mod.buildRegimeAssessmentContract(input, cutoff);
assert.equal(result.schemaVersion, 'xau.regime-assessment.v1');
assert.equal(result.algorithmVersion, 'regime-dependency-gate-1.0.0');
assert.equal(result.evidenceState, 'DEGRADED');
assert.equal(result.regime, 'UNAVAILABLE');
assert.equal(result.confidence, null);
assert.deepEqual(result.reasonCodes, [
  'MARKET_PRICING_DEGRADED',
  'POSITIONING_SIGNAL_UNAVAILABLE',
  'REGIME_METHODOLOGY_NOT_APPROVED',
]);
assert.deepEqual(result, mod.buildRegimeAssessmentContract(structuredClone(input), cutoff));

const mismatch = structuredClone(input);
mismatch.positioning.knowledgeCutoff = '2026-10-01T11:00:00.000Z';
assert.equal(mod.buildRegimeAssessmentContract(mismatch, cutoff).evidenceState, 'ABSTAIN');
assert.ok(mod.buildRegimeAssessmentContract(mismatch, cutoff).reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));

const wrongVersion = structuredClone(input);
wrongVersion.marketPricing.algorithmVersion = 'legacy';
assert.ok(mod.buildRegimeAssessmentContract(wrongVersion, cutoff).reasonCodes.includes('MARKET_PRICING_VERSION_MISMATCH'));

const upstreamAbstain = structuredClone(input);
upstreamAbstain.positioning.evidenceState = 'ABSTAIN';
assert.equal(mod.buildRegimeAssessmentContract(upstreamAbstain, cutoff).evidenceState, 'ABSTAIN');
assert.ok(mod.buildRegimeAssessmentContract(input, '2026-10-01').reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));

// Upstream states outside MP-0/P-0 v1 fail closed instead of reading as READY.
for (const [label, mutate, reason] of [
  ['unknown market state', (value) => { value.marketPricing.state = 'BOGUS'; }, 'MARKET_PRICING_ABSTAINED'],
  ['missing market state', (value) => { delete value.marketPricing.state; }, 'MARKET_PRICING_ABSTAINED'],
  ['unknown evidence state', (value) => { value.positioning.evidenceState = 'BOGUS'; }, 'POSITIONING_EVIDENCE_ABSTAINED'],
  ['forged positioning signal', (value) => { value.positioning.positioningState = 'LONG'; }, 'POSITIONING_EVIDENCE_ABSTAINED'],
]) {
  const forged = structuredClone(input);
  forged.marketPricing.state = 'AVAILABLE';
  mutate(forged);
  const assessed = mod.buildRegimeAssessmentContract(forged, cutoff);
  assert.equal(assessed.evidenceState, 'ABSTAIN', label);
  assert.ok(assessed.reasonCodes.includes(reason), label);
  assert.equal(assessed.regime, 'UNAVAILABLE', label);
}

const regimeSource = readFileSync(path.join(ROOT, 'backend', 'regime_engine', 'contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_REGIME_CONTRACT.md'), 'utf8');
assert.doesNotMatch(regimeSource, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.doesNotMatch(regimeSource, /regime:\s*'(?:range_bound|risk_on|risk_off|reflation|stagflation)'/);
assert.match(docs, /REGIME INFERENCE FORBIDDEN/);
assert.match(docs, /authorizes no semantic activation[\s\S]*trading action/i);
console.log('PASS Regime R-0 enforces exact upstream versions/cutoff and forbids fallback inference');

