import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'event_impact/deterministic_processor.ts',
  'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts',
  'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts',
  'regime_engine/contract.ts',
  'horizon_engine/contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'horizon-contract-'));
let mod;
try {
  for (const sourcePath of sourceFiles) {
    const input = readFileSync(path.join(ROOT, 'backend', sourcePath), 'utf8');
    const output = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z_]+\/[a-z_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z_]+)\.js\1/g, '$1$2.mjs$1');
    const destination = path.join(temp, sourcePath.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output, 'utf8');
  }
  mod = await import(pathToFileURL(path.join(temp, 'horizon_engine', 'contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T12:00:00.000Z';
const input = {
  eventImpact: { algorithmVersion: 'event-impact-deterministic-processor-v5', status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff },
  goldTransmission: { algorithmVersion: 'gold-transmission-deterministic-processor-v5', status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff },
  marketPricing: { schemaVersion: 'xau.market-pricing-snapshot.v1', algorithmVersion: 'market-pricing-envelope-1.0.0', state: 'DEGRADED', knowledgeCutoff: cutoff },
  positioning: { schemaVersion: 'xau.positioning-evidence.v1', algorithmVersion: 'positioning-evidence-normalizer-1.0.0', positioningState: 'UNAVAILABLE', knowledgeCutoff: cutoff },
  regime: { schemaVersion: 'xau.regime-assessment.v1', algorithmVersion: 'regime-dependency-gate-1.0.0', regime: 'UNAVAILABLE', knowledgeCutoff: cutoff },
};

const result = mod.buildHorizonSynthesisContract(input, cutoff);
assert.equal(result.schemaVersion, 'xau.horizon-synthesis.v1');
assert.equal(result.algorithmVersion, 'horizon-dependency-gate-1.0.0');
assert.equal(result.state, 'ABSTAIN');
assert.deepEqual(result.scenarios.map((item) => item.horizon), ['H1', 'H2', 'H3', 'H4', 'H5']);
for (const scenario of result.scenarios) {
  assert.deepEqual(scenario, {
    horizon: scenario.horizon, status: 'ABSTAIN', direction: 'UNAVAILABLE',
    probability: null, target: null, invalidation: null, confidence: null,
  });
}
assert.deepEqual(result.reasonCodes, [
  'EVENT_IMPACT_INSUFFICIENT', 'GOLD_TRANSMISSION_INSUFFICIENT',
  'MARKET_PRICING_NOT_AVAILABLE', 'POSITIONING_SIGNAL_UNAVAILABLE',
  'REGIME_UNAVAILABLE', 'HORIZON_METHODOLOGY_NOT_APPROVED',
]);
assert.deepEqual(result, mod.buildHorizonSynthesisContract(structuredClone(input), cutoff));

const drift = structuredClone(input);
drift.regime.knowledgeCutoff = '2026-10-01T11:59:00.000Z';
assert.ok(mod.buildHorizonSynthesisContract(drift, cutoff).reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));
const legacy = structuredClone(input);
legacy.eventImpact.algorithmVersion = 'legacy';
assert.ok(mod.buildHorizonSynthesisContract(legacy, cutoff).reasonCodes.includes('EVENT_IMPACT_VERSION_MISMATCH'));
assert.ok(mod.buildHorizonSynthesisContract(input, '2026-10-01').reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));

const source = readFileSync(path.join(ROOT, 'backend', 'horizon_engine', 'contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_HORIZON_SYNTHESIS_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.doesNotMatch(source, /direction:\s*'(?:bullish|bearish|neutral)'/);
assert.match(docs, /SCENARIO INFERENCE FORBIDDEN/);
assert.match(docs, /authorizes no AI\/LLM inference[\s\S]*trading/i);
console.log('PASS H1-H5 S-0 freezes versions/cutoff and emits five explicit abstentions');
