import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/run_chain_0_offline.mjs');
const invoke = () => execFileSync(process.execPath, [script], {
  cwd: root, encoding: 'utf8', timeout: 30000,
});
const first = invoke();
const second = invoke();
assert.equal(first, second, 'No unobserved time, ID or randomness in output');
const json = JSON.parse(first);
assert.equal(json.evidenceType, 'SYNTHETIC_CONTRACT_ONLY');
assert.equal(json.mode, 'OFFLINE_ONLY');
assert.equal(json.state, 'HOLD');
assert.equal(json.decision, 'ABSTAIN');
assert.equal(json.execution, 'FORBIDDEN');
assert.equal(json.alertDelivery, 'FORBIDDEN');
assert.equal(json.acceptance, 'NOT_ACCEPTED');
assert.equal(json.receiptVerification, 'VALID_HOLD');
assert.match(json.checksumSha256, /^[0-9a-f]{64}$/);
assert.equal(json.stages.length, 10);
assert.deepEqual(json.stages.map((x) => x.stage), [
  'REGIME', 'HORIZONS', 'COMMITTEE', 'PRE_PM', 'PORTFOLIO_MANAGER',
  'FINAL_ACTION_RISK', 'ACTION', 'COMMAND_CENTER', 'ALERTS', 'ACCEPTANCE',
]);
const illicit = spawnSync(process.execPath, [script, '--production'], {
  cwd: root, encoding: 'utf8', timeout: 30000,
});
assert.equal(illicit.status, 2);
assert.equal(illicit.stdout, '');
assert.match(illicit.stderr, /accepts no arguments/i);
console.log('PASS CHAIN-0 CLI: deterministic fixture, no live input, HOLD');
