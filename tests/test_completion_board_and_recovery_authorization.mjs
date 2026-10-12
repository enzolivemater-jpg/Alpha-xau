import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const board = read('docs/XAU_V2_COMPLETION_BOARD.md');
const packet = read('docs/XAU_V2_RECOVERY_EXECUTION_AUTHORIZATION_PACKET.md');
const script = read('scripts/recovery_manifest.mjs');
const rolesNormalizer = read('scripts/prepare_recovery_roles.mjs');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');

for (const value of [
  'a4bdd6d43d048f98dc7e506537a82d4f7488d119',
  '37909587607', '37794267054', '37796386665', '37798129022', '37907477341',
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
const runbookHash = createHash('sha256').update(runbook).digest('hex');
assert.equal(scriptHash, '9d0d3ea003a0ad87885e4e3297570e10dc804f301df1b650e20d2834da71ec70');
assert.equal(rolesNormalizerHash, '623f1640422028719556da71c97c8e11391a273de7358d327431559573df91dd');
assert.equal(runbookHash, 'f94774fec208b38c440aacce61f4994aa2dabc0cfdc32125e1c40d652b72c052');
for (const value of [
  scriptHash, rolesNormalizerHash, runbookHash, 'REC-1 V3 FROZEN — RESUME NOT AUTHORIZED',
  'TARGET_MODE=NEW_DEDICATED_PROJECT|RESET_EF12_STAGING',
  'TARGET_RESET_AUTHORIZED=YES|NO',
  'USE_EXISTING_VERIFIED_BACKUP_ONLY=YES', 'PRODUCTION_ACCESS_AUTHORIZED=NO',
  'PRODUCTION_RESTORE_AUTHORIZED=NO',
  'MIGRATIONS_0029_0034_AUTHORIZED=NO', 'RUNTIME_AUTHORIZED=NO',
  'FROZEN_MAIN_SHA=a4bdd6d43d048f98dc7e506537a82d4f7488d119',
  'REC1_V3_COMMIT_SHA=<reviewed 40-hex V3 branch commit>',
]) assert.ok(packet.includes(value), `authorization packet missing ${value}`);

assert.match(packet, /production ref can never be a target/i);
assert.match(packet, /All earlier REC-1 payload approvals and hashes are stale/);
assert.match(packet, /Generic language such as “continue”/);
assert.match(packet, /Production\s+freeze keeps `main` at `a4bdd6d/i);
assert.match(packet, /verify that remote `main` still equals\s+`FROZEN_MAIN_SHA`/i);
assert.doesNotMatch(packet, /REC1_V3_COMMIT_SHA=[0-9a-f]{40}/);
assert.doesNotMatch(packet, /REC1_V3_RESUME_AUTHORIZED=YES[\s\S]*RECOVERY_OPERATOR=(?!<)/);
console.log('PASS REC-1 packet freezes implementation while binding approval to the execution-time main head');
