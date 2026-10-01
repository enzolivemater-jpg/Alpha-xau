import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'event_impact/deterministic_processor.ts', 'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts', 'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
  'horizon_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
  'risk_engine/pre_pm_contract.ts', 'portfolio_engine/contract.ts',
  'risk_engine/final_action_contract.ts', 'action_engine/contract.ts',
  'command_center/contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'command-center-contract-'));
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
  mod = await import(pathToFileURL(path.join(temp, 'command_center', 'contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T14:15:00.000Z';
const input = {
  action: {
    schemaVersion: 'xau.action-abstention.v1', algorithmVersion: 'action-abstention-gate-1.0.0',
    decision: 'ABSTAIN', execution: 'FORBIDDEN',
    reasonCodes: ['FINAL_RISK_NOT_READY', 'EXECUTION_NOT_AUTHORIZED'], knowledgeCutoff: cutoff,
  },
  runtimeEvidence: { correlationId: null, deploymentId: null },
};
const result = mod.buildCommandCenterProjection(input, cutoff);
assert.equal(result.mode, 'READ_ONLY');
assert.equal(result.systemState, 'HOLD');
assert.equal(result.banner, 'EVIDENCE_INCOMPLETE');
assert.equal(result.decision, 'ABSTAIN');
assert.equal(result.execution, 'FORBIDDEN');
assert.equal(result.scenarioTreeStatus, 'UNAVAILABLE');
assert.equal(result.tradeTicket, null);
assert.equal(result.lineage.length, 9);
assert.deepEqual(result.actionReasonCodes, input.action.reasonCodes);
assert.deepEqual(result.reasonCodes, [
  'RUNTIME_CORRELATION_UNAVAILABLE', 'DEPLOYMENT_NOT_PROVEN',
  'COMMAND_CENTER_RUNTIME_NOT_APPROVED',
]);
assert.deepEqual(result, mod.buildCommandCenterProjection(structuredClone(input), cutoff));

const source = readFileSync(path.join(ROOT, 'backend', 'command_center', 'contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_COMMAND_CENTER_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.match(source, /tradeTicket: null/);
assert.match(docs, /RUNTIME NOT DEPLOYED/);
assert.match(docs, /authorizes no persistence[\s\S]*trading/i);
console.log('PASS CC-0 projects exact lineage and honest read-only HOLD state');
