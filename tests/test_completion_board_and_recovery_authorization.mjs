import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const board = read('docs/XAU_V2_COMPLETION_BOARD.md');
const packet = read('docs/XAU_V2_RECOVERY_EXECUTION_AUTHORIZATION_PACKET.md');
const script = read('scripts/recovery_manifest.mjs');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');

for (const value of [
  '61d6429d9004e31931eb10634bf573d1ed8aadac',
  '37794682669', '37794267054', '37796386665',
  '20260923133811 gold_transmission_atomic_rpc',
  'Recovery readiness', 'STAGING_PROVEN', 'LIVE_PROVEN', 'CI_PROVEN',
  'Security SB-3', '20261008094133', 'Security SB-4', 'Security SB-5',
  'Estimated remaining engineering effort', 'Consensus',
  'pure DOL claims text parser + adapter', 'CPI/NFP/jobless-claims',
  'pure BEA PCE adapter',
  'BLS July 2026 archive',
  'No trading or broker execution authority',
]) assert.ok(board.includes(value), `completion board missing ${value}`);

assert.match(board, /Effort ranges are engineering estimates, not completion facts/);
assert.doesNotMatch(board, /no run associated/i);
assert.doesNotMatch(board, /\b\d{1,3}% complete\b/i);
console.log('PASS completion board uses evidence levels, gates, blockers, actions, and explicit effort estimates');

const scriptHash = createHash('sha256').update(script).digest('hex');
const runbookHash = createHash('sha256').update(runbook).digest('hex');
assert.equal(scriptHash, '9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70');
assert.equal(runbookHash, '9bbfbfd683833c1c189fa8155297884a88336c41f3f5961643ff1b312d21ceee');
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
assert.match(packet, /Every previous REC-1 execution approval is\s+stale and void/);
assert.match(packet, /Generic language such as “continue”/);
assert.match(packet, /hard-coding it in this document would make the packet invalidate itself/i);
assert.match(packet, /verify that `FINAL_MAIN_SHA` equals\s+the remote `main` head/i);
assert.doesNotMatch(packet, /FINAL_MAIN_SHA=[0-9a-f]{40}/);
assert.doesNotMatch(packet, /REC1_EXECUTION_AUTHORIZED=YES[\s\S]*RECOVERY_OPERATOR=(?!<)/);
console.log('PASS REC-1 packet freezes implementation while binding approval to the execution-time main head');
