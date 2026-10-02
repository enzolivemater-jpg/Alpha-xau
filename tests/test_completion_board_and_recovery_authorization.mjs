import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const board = read('docs/XAU_V2_COMPLETION_BOARD.md');
const packet = read('docs/XAU_V2_RECOVERY_EXECUTION_AUTHORIZATION_PACKET.md');
const script = read('scripts/recovery_manifest.mjs');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');

for (const value of [
  '10b926d08f92bcf42e974e92e5e102ab60362cfb',
  '20260923133811 gold_transmission_atomic_rpc',
  'Recovery readiness', 'STAGING_PROVEN', 'LIVE_PROVEN', 'CI_PROVEN',
  'Estimated remaining engineering effort', 'Consensus',
  'No trading or broker execution authority',
]) assert.ok(board.includes(value), `completion board missing ${value}`);

assert.match(board, /Effort ranges are engineering estimates, not completion facts/);
assert.doesNotMatch(board, /\b\d{1,3}% complete\b/i);
console.log('PASS completion board uses evidence levels, gates, blockers, actions, and explicit effort estimates');

const scriptHash = createHash('sha256').update(script).digest('hex');
const runbookHash = createHash('sha256').update(runbook).digest('hex');
assert.equal(scriptHash, '526c41fbb38138c5e238eb416a913b7ff53e2e3e2dde31afee11c9158b22458a');
assert.equal(runbookHash, 'b30e65c549227afc4a1fdd30402255c31a76d4d40be70cfb732f9387d7d87b17');
for (const value of [
  scriptHash, runbookHash, 'READY FOR ONE-RESPONSE HUMAN DECISION — NOT AUTHORIZED',
  'TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING',
  'TARGET_RESET_AUTHORIZED=YES|NO',
  'PRODUCTION_READ_ONLY_CAPTURE_AND_DUMP_AUTHORIZED=YES',
  'PRODUCTION_RESTORE_AUTHORIZED=NO',
  'MIGRATIONS_0029_0034_AUTHORIZED=NO', 'RUNTIME_AUTHORIZED=NO',
  'FINAL_MAIN_SHA=<current 40-hex main SHA verified immediately before execution>',
]) assert.ok(packet.includes(value), `authorization packet missing ${value}`);

assert.match(packet, /production ref can never be a target/i);
assert.match(packet, /Generic language such as “continue”/);
assert.match(packet, /hard-coding it in this document would make the packet invalidate itself/i);
assert.match(packet, /verify that `FINAL_MAIN_SHA` equals\s+the remote `main` head/i);
assert.doesNotMatch(packet, /FINAL_MAIN_SHA=[0-9a-f]{40}/);
assert.doesNotMatch(packet, /REC1_EXECUTION_AUTHORIZED=YES[\s\S]*RECOVERY_OPERATOR=(?!<)/);
console.log('PASS REC-1 packet freezes implementation while binding approval to the execution-time main head');
