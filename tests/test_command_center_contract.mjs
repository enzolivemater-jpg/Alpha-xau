import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await loadBackendModule('command_center/contract.ts');

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
