import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  'market_engine/types.ts': 'market_engine/types.mjs',
  'market_engine/institutional_snapshot.ts': 'market_engine/institutional_snapshot.mjs',
  'positioning_engine/evidence_contract.ts': 'positioning_engine/evidence_contract.mjs',
  'regime_engine/contract.ts': 'regime_engine/contract.mjs',
};
const temp = mkdtempSync(path.join(tmpdir(), 'regime-contract-'));
let mod;
try {
  for (const [sourcePath, outputPath] of Object.entries(files)) {
    const input = readFileSync(path.join(ROOT, 'backend', sourcePath), 'utf8');
    const output = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])\.\.\/([a-z_]+)\/([a-z_]+)\.js\1/g, '$1../$2/$3.mjs$1')
      .replaceAll(/(['"])\.\/([a-z_]+)\.js\1/g, '$1./$2.mjs$1');
    const destination = path.join(temp, outputPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output, 'utf8');
  }
  mod = await import(pathToFileURL(path.join(temp, 'regime_engine', 'contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

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

const regimeSource = readFileSync(path.join(ROOT, 'backend', 'regime_engine', 'contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_REGIME_CONTRACT.md'), 'utf8');
assert.doesNotMatch(regimeSource, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.doesNotMatch(regimeSource, /regime:\s*'(?:range_bound|risk_on|risk_off|reflation|stagflation)'/);
assert.match(docs, /REGIME INFERENCE FORBIDDEN/);
assert.match(docs, /authorizes no semantic activation[\s\S]*trading action/i);
console.log('PASS Regime R-0 enforces exact upstream versions/cutoff and forbids fallback inference');

