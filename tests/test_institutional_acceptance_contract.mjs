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
  'command_center/contract.ts', 'alert_engine/contract.ts',
  'acceptance_engine/contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'acceptance-contract-'));
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
  mod = await import(pathToFileURL(path.join(temp, 'acceptance_engine', 'contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T19:30:00.000Z';
const evidence = Object.fromEntries(mod.ACCEPTANCE_EVIDENCE_KEYS.map((key) => [key, false]));
const input = {
  alert: {
    schemaVersion: 'xau.alert-suppression.v1',
    algorithmVersion: 'alert-suppression-gate-1.0.0',
    state: 'SUPPRESSED', delivery: 'FORBIDDEN', knowledgeCutoff: cutoff,
  },
  evidence,
};
const result = mod.buildInstitutionalAcceptanceGate(input, cutoff);
assert.equal(result.acceptanceState, 'NOT_ACCEPTED');
assert.equal(result.productionReadiness, 'HOLD');
assert.equal(result.acceptanceRun, null);
assert.equal(result.report, null);
assert.deepEqual(result.missingEvidence, mod.ACCEPTANCE_EVIDENCE_KEYS);
assert.deepEqual(result.reasonCodes, [
  'ALERT_NOT_DELIVERABLE', 'REQUIRED_EVIDENCE_MISSING',
  'E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED',
]);
assert.deepEqual(result, mod.buildInstitutionalAcceptanceGate(structuredClone(input), cutoff));

const source = readFileSync(path.join(ROOT, 'backend', 'acceptance_engine', 'contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_INSTITUTIONAL_ACCEPTANCE_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.match(source, /acceptanceState: 'NOT_ACCEPTED'/);
assert.match(docs, /NOT ACCEPTED \/ PRODUCTION HOLD/);
assert.match(docs, /authorizes no backup extraction[\s\S]*trade/i);
console.log('PASS E2E-0 records every missing proof without claiming production acceptance');
