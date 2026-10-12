import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const board = read('docs/XAU_V2_COMPLETION_BOARD.md');
const packet = read('docs/XAU_V2_RECOVERY_EXECUTION_AUTHORIZATION_PACKET.md');
const v3 = read('docs/XAU_V2_RECOVERY_V3_AMENDMENT.md');
const script = read('scripts/recovery_manifest.mjs');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');

for (const value of [
  'ff2e34ea30c37cf17f382d3839ec57b98590ed2a',
  '37907851018', '37794267054', '37796386665', '37798129022', '37907477341',
  '37909217202',
  '20260923133811 gold_transmission_atomic_rpc',
  'Recovery readiness', 'STAGING_PROVEN', 'LIVE_PROVEN', 'CI_PROVEN',
  'Security SB-3', '20261008094133', 'Security SB-4', 'Security SB-5',
  'Estimated remaining engineering effort', 'Consensus',
  'raw BLS July/August archive HTML + authenticated bounded parser + NFP adapter',
  'raw DOL archive PDF + bounded decoder + claims parser/adapter', 'CPI/NFP/jobless-claims',
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
assert.equal(scriptHash, 'fd95a49fbd7eca3938d4044e47d16b6fab7f86317362e173d8482096b06bac31');
assert.equal(runbookHash, '3e72e17ac4230affcde2de1ed61eb00f83546f4e24f5ce7bda2c648c906cb121');
for (const value of [
  scriptHash, 'READY FOR ONE-RESPONSE HUMAN DECISION — NOT AUTHORIZED',
  'CHANGE_REFERENCE=<ticket/change id>',
  'TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING',
  'TARGET_RESET_AUTHORIZED=YES|NO',
  'PRODUCTION_READ_ONLY_CAPTURE_AND_DUMP_AUTHORIZED=YES',
  'PRODUCTION_RESTORE_AUTHORIZED=NO',
  'MIGRATIONS_0029_0034_AUTHORIZED=NO', 'RUNTIME_AUTHORIZED=NO',
  'FINAL_MAIN_SHA=<current 40-hex main SHA verified immediately before execution>',
]) assert.ok(packet.includes(value), `authorization packet missing ${value}`);

for (const value of [
  scriptHash, runbookHash, 'READY FOR FRESH HUMAN DECISION — NOT AUTHORIZED',
  'roles-restore.sql', 'perform no new production capture/dump',
]) assert.ok(v3.includes(value), `V3 amendment missing ${value}`);

assert.match(packet, /production ref can never be a target/i);
assert.match(packet, /Every previous REC-1 execution approval is\s+stale and void/);
assert.match(packet, /Generic language such as “continue”/);
assert.match(packet, /hard-coding it in this document would make the packet invalidate itself/i);
assert.match(packet, /verify that `FINAL_MAIN_SHA` equals\s+the remote `main` head/i);
assert.doesNotMatch(packet, /FINAL_MAIN_SHA=[0-9a-f]{40}/);
assert.doesNotMatch(packet, /REC1_EXECUTION_AUTHORIZED=YES[\s\S]*RECOVERY_OPERATOR=(?!<)/);
console.log('PASS REC-1 packet freezes implementation while binding approval to the execution-time main head');

for (const value of [
  'RECOVERY_REVIEW_MODE=INDEPENDENT_REVIEWER|SOLO_OPERATOR_EXCEPTION',
  'SOLO_OPERATOR_EXCEPTION=YES|NO',
  'SOLO_OPERATOR_JUSTIFICATION=<non-secret rationale',
  'AUTOMATED_SECONDARY_AUDIT_REQUIRED=YES',
]) assert.ok(packet.includes(value), `authorization packet missing ${value}`);
assert.match(packet, /`RECOVERY_REVIEW_MODE=INDEPENDENT_REVIEWER` is the default/);
assert.match(packet, /Segregation of duties is \*\*reduced\*\*/);
assert.match(packet, /never represented as\s+a human reviewer/);
assert.match(packet, /exception applies only to REC-1\. It grants no migration,\s+deployment, runtime/);
assert.match(packet, /Every previous REC-1 execution approval is stale\s+and void\*\*, including any approval that quoted runbook hash `9bbfbfd6…ceee`/);
assert.doesNotMatch(packet, /different person if available/);
assert.doesNotMatch(packet, /SOLO_OPERATOR_EXCEPTION=YES\n/);
for (const value of [
  'RECOVERY_REVIEW_MODE=INDEPENDENT_REVIEWER|SOLO_OPERATOR_EXCEPTION',
  'SEGREGATION_OF_DUTIES=FULL|REDUCED', 'DECRYPTION_VERIFIED=YES',
  'AUTOMATED_SECONDARY_AUDIT=<tool',
]) assert.ok(runbook.includes(value), `runbook missing ${value}`);
assert.match(runbook, /it is never represented\s+as a human reviewer or as reviewer sign-off/);
console.log('PASS REC-1 keeps independent review as default and bounds the solo-operator exception');
