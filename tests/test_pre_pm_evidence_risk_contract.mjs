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
  'risk_engine/pre_pm_contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'pre-pm-contract-'));
let mod;
try {
  for (const sourcePath of sourceFiles) {
    const input = readFileSync(path.join(ROOT, 'backend', sourcePath), 'utf8');
    const output = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const destination = path.join(temp, sourcePath.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, output, 'utf8');
  }
  mod = await import(pathToFileURL(path.join(temp, 'risk_engine', 'pre_pm_contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T13:45:00.000Z';
const input = {
  committee: {
    schemaVersion: 'xau.ai-committee-gate.v1',
    algorithmVersion: 'ai-committee-dependency-gate-1.0.0',
    state: 'ABSTAIN',
    providerInvocation: 'FORBIDDEN',
    knowledgeCutoff: cutoff,
  },
  evidenceGraph: { schemaVersion: null, complete: false, nodeCount: 0 },
};

const result = mod.buildPrePmEvidenceRiskGate(input, cutoff);
assert.equal(result.schemaVersion, 'xau.pre-pm-evidence-risk.v1');
assert.equal(result.algorithmVersion, 'pre-pm-dependency-gate-1.0.0');
assert.equal(result.state, 'ABSTAIN');
assert.equal(result.portfolioManagerEligibility, 'BLOCKED');
assert.equal(result.evidenceAcceptance, 'UNAVAILABLE');
assert.equal(result.riskVerdict, null);
assert.equal(result.confidence, null);
assert.equal(result.portfolioManagerInput, null);
assert.deepEqual(result.reasonCodes, [
  'COMMITTEE_NOT_READY', 'COMMITTEE_PROVIDER_NOT_COMPLETED',
  'EVIDENCE_GRAPH_UNAVAILABLE', 'PRE_PM_METHOD_NOT_APPROVED',
]);
assert.deepEqual(result, mod.buildPrePmEvidenceRiskGate(structuredClone(input), cutoff));

const drift = structuredClone(input);
drift.committee.algorithmVersion = 'legacy';
assert.ok(mod.buildPrePmEvidenceRiskGate(drift, cutoff).reasonCodes.includes('COMMITTEE_VERSION_MISMATCH'));
const cutoffDrift = structuredClone(input);
cutoffDrift.committee.knowledgeCutoff = '2026-10-01T13:44:59.000Z';
assert.ok(mod.buildPrePmEvidenceRiskGate(cutoffDrift, cutoff).reasonCodes.includes('COMMITTEE_CUTOFF_MISMATCH'));

const source = readFileSync(path.join(ROOT, 'backend', 'risk_engine', 'pre_pm_contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_PRE_PM_EVIDENCE_RISK_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.match(source, /portfolioManagerEligibility: 'BLOCKED'/);
assert.match(docs, /PORTFOLIO MANAGER BLOCKED/);
assert.match(docs, /authorizes no LLM call[\s\S]*trading/i);
console.log('PASS pre-PM PMR-0 blocks Portfolio Manager without V2 evidence and method approval');
