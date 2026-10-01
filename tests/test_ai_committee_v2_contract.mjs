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
  'ai_engine/v2_committee_contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'committee-v2-contract-'));
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
  mod = await import(pathToFileURL(path.join(temp, 'ai_engine', 'v2_committee_contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T13:30:00.000Z';
const input = {
  horizonSynthesis: {
    schemaVersion: 'xau.horizon-synthesis.v1',
    algorithmVersion: 'horizon-dependency-gate-1.0.0',
    state: 'ABSTAIN',
    knowledgeCutoff: cutoff,
    scenarios: ['H1', 'H2', 'H3', 'H4', 'H5'].map((horizon) => ({ horizon, status: 'ABSTAIN' })),
  },
  providerAuthorization: 'UNAUTHORIZED',
  costAuthorization: 'UNAUTHORIZED',
};

const result = mod.buildCommitteeV2Gate(input, cutoff);
assert.equal(result.schemaVersion, 'xau.ai-committee-gate.v1');
assert.equal(result.algorithmVersion, 'ai-committee-dependency-gate-1.0.0');
assert.equal(result.state, 'ABSTAIN');
assert.equal(result.providerInvocation, 'FORBIDDEN');
assert.equal(result.legacyCommitteeOutputAccepted, false);
assert.equal(result.request, null);
assert.equal(result.response, null);
assert.deepEqual(result.reasonCodes, [
  'HORIZON_NOT_READY', 'PROVIDER_NOT_AUTHORIZED', 'COST_NOT_AUTHORIZED',
  'COMMITTEE_V2_METHOD_NOT_APPROVED',
]);
assert.deepEqual(result, mod.buildCommitteeV2Gate(structuredClone(input), cutoff));

const drift = structuredClone(input);
drift.horizonSynthesis.algorithmVersion = 'legacy';
assert.ok(mod.buildCommitteeV2Gate(drift, cutoff).reasonCodes.includes('HORIZON_VERSION_MISMATCH'));
const missing = structuredClone(input);
missing.horizonSynthesis.scenarios.pop();
assert.ok(mod.buildCommitteeV2Gate(missing, cutoff).reasonCodes.includes('HORIZON_SET_MISMATCH'));
const cutoffDrift = structuredClone(input);
cutoffDrift.horizonSynthesis.knowledgeCutoff = '2026-10-01T13:29:59.000Z';
assert.ok(mod.buildCommitteeV2Gate(cutoffDrift, cutoff).reasonCodes.includes('HORIZON_CUTOFF_MISMATCH'));

const source = readFileSync(path.join(ROOT, 'backend', 'ai_engine', 'v2_committee_contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_AI_COMMITTEE_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.match(source, /providerInvocation: 'FORBIDDEN'/);
assert.match(docs, /PROVIDER INVOCATION FORBIDDEN/);
assert.match(docs, /authorizes no LLM call[\s\S]*trading/i);
console.log('PASS AI Committee C-0 forbids provider invocation and legacy V2 promotion');
