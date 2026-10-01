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
];
const temp = mkdtempSync(path.join(tmpdir(), 'alert-contract-'));
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
  mod = await import(pathToFileURL(path.join(temp, 'alert_engine', 'contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-01T14:30:00.000Z';
const input = {
  commandCenter: {
    schemaVersion: 'xau.command-center-projection.v1',
    algorithmVersion: 'command-center-read-only-projection-1.0.0',
    systemState: 'HOLD', decision: 'ABSTAIN', execution: 'FORBIDDEN',
    reasonCodes: ['DEPLOYMENT_NOT_PROVEN', 'RUNTIME_CORRELATION_UNAVAILABLE'],
    knowledgeCutoff: cutoff,
  },
  alertPolicyAuthorization: 'UNAUTHORIZED',
  deliveryAuthorization: 'UNAUTHORIZED',
  recipientPolicyVersion: null,
};
const result = mod.buildAlertSuppressionGate(input, cutoff);
assert.equal(result.state, 'SUPPRESSED');
assert.equal(result.delivery, 'FORBIDDEN');
assert.equal(result.expiresAt, null);
assert.equal(result.acknowledgementState, 'UNAVAILABLE');
assert.equal(result.escalation, 'FORBIDDEN');
assert.equal(result.recipient, null);
assert.equal(result.channel, null);
assert.equal(result.payload, null);
assert.deepEqual(result.reasonCodes, [
  'COMMAND_CENTER_NOT_ACTIONABLE', 'ALERT_POLICY_NOT_APPROVED',
  'DELIVERY_NOT_AUTHORIZED', 'RECIPIENT_POLICY_UNAVAILABLE',
  'ALERT_HORIZON_NOT_APPROVED', 'ALERT_METHOD_NOT_APPROVED',
]);
assert.deepEqual(result, mod.buildAlertSuppressionGate(structuredClone(input), cutoff));
const reordered = structuredClone(input);
reordered.commandCenter.reasonCodes.reverse();
assert.equal(mod.buildAlertSuppressionGate(reordered, cutoff).dedupeKey, result.dedupeKey);

const source = readFileSync(path.join(ROOT, 'backend', 'alert_engine', 'contract.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_ALERT_CONTRACT.md'), 'utf8');
assert.doesNotMatch(source, /fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env|Math\.random\(/);
assert.match(source, /delivery: 'FORBIDDEN'/);
assert.match(docs, /DELIVERY FORBIDDEN/);
assert.match(docs, /authorizes no secret use[\s\S]*trading/i);
console.log('PASS AL-0 deduplicates deterministically while forbidding every delivery path');
