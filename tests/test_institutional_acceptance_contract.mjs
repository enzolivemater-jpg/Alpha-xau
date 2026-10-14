import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await loadBackendModule('acceptance_engine/contract.ts');

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
