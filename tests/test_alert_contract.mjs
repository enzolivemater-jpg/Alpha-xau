import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await loadBackendModule('alert_engine/contract.ts');

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
