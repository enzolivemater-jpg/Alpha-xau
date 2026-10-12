import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const board = read('docs/XAU_V2_COMPLETION_BOARD.md');
const packet = read('docs/XAU_V2_RECOVERY_EXECUTION_AUTHORIZATION_PACKET.md');
const script = read('scripts/recovery_manifest.mjs');
const rolesNormalizer = read('scripts/prepare_recovery_roles.mjs');
const plaintextVerifier = read('scripts/verify_recovery_plaintext.mjs');
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
const rolesNormalizerHash = createHash('sha256').update(rolesNormalizer).digest('hex');
const plaintextVerifierHash = createHash('sha256').update(plaintextVerifier).digest('hex');
const runbookHash = createHash('sha256').update(runbook).digest('hex');
assert.equal(scriptHash, 'fd95a49fbd7eca3938d4044e47d16b6fab7f86317362e173d8482096b06bac31');
assert.equal(rolesNormalizerHash, '623f1640422028719556da71c97c8e11391a273de7358d327431559573df91dd');
assert.equal(plaintextVerifierHash, 'c0624627a8c877f1f8e541f0891045b3b8348f450d524c3cf1294e35f5cd5e7f');
assert.equal(runbookHash, '05007a87f0a4164c22f49a659ae6493a8c81ba8b76d53a40f4bdce2e35e99880');
for (const value of [
  scriptHash, rolesNormalizerHash, plaintextVerifierHash, runbookHash, 'REC-1 V3 READY FOR FRESH HUMAN DECISION — NOT AUTHORIZED',
  'REC1_EXECUTION_MODE=FULL|RESUME_VERIFIED_BACKUP',
  'CHANGE_REFERENCE=<ticket/change id>',
  'TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING',
  'TARGET_RESET_AUTHORIZED=YES|NO',
  'REC1_PLAINTEXT_VERIFIER_SHA256=c0624627a8c877f1f8e541f0891045b3b8348f450d524c3cf1294e35f5cd5e7f',
  'RESUME_SOURCE_ARTIFACT_SHA256=<64 hex or N/A for FULL>',
  'PRODUCTION_READ_ONLY_CAPTURE_AND_DUMP_AUTHORIZED=YES|NO',
  'SOURCE_RECAPTURE_AUTHORIZED=YES|NO',
  'PRODUCTION_RESTORE_AUTHORIZED=NO',
  'MIGRATIONS_0029_0034_AUTHORIZED=NO', 'RUNTIME_AUTHORIZED=NO',
  'FINAL_MAIN_SHA=<current 40-hex main SHA verified immediately before execution>',
]) assert.ok(packet.includes(value), `authorization packet missing ${value}`);

assert.match(packet, /production ref can never be a target/i);
assert.match(packet, /Every earlier REC-1 execution approval is stale and void/i);
assert.match(packet, /Generic language such as “continue”/);
assert.match(packet, /hard-coding it in this document would make the packet invalidate itself/i);
assert.match(packet, /verify that `FINAL_MAIN_SHA` equals\s+the remote `main` head/i);
assert.doesNotMatch(packet, /FINAL_MAIN_SHA=[0-9a-f]{40}/);
assert.doesNotMatch(packet, /REC1_EXECUTION_AUTHORIZED=YES[\s\S]*RECOVERY_OPERATOR=(?!<)/);
assert.match(packet, /RESUME_VERIFIED_BACKUP.*production\/source-recapture fields to be `NO`/is);
console.log('PASS REC-1 V3 packet freezes implementation and bounds verified-backup resume');

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
