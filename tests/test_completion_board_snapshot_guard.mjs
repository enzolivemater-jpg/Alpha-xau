import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (filename) => readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
const board = read('docs/XAU_V2_COMPLETION_BOARD.md');
const runbook = read('docs/XAU_V2_RECOVERY_REHEARSAL_RUNBOOK.md');
const packet = read('docs/XAU_V2_RECOVERY_EXECUTION_AUTHORIZATION_PACKET.md');

// A repository-committed completion snapshot cannot claim to be
// authoritative live state, regardless of whether new PRs exist.
assert.match(board, /^Status: `HISTORICAL SNAPSHOT — RECONCILED /m);
assert.match(board, /CURRENT STATE NOT VERIFIED/);
assert.match(board, /do not use this snapshot for live operations or authorizations/i);
assert.match(board, /No Supabase production state, deployed runtime or migration tail was\s+re-queried/i);
assert.match(board, /check GitHub directly/i);
assert.doesNotMatch(board, /^Open pull requests: none\s*$/m);
assert.doesNotMatch(board, /^Status: `LIVE BOARD/m);

// A checked/encrypted backup and a successful isolated restore are
// different states, and the board must not conflate them.
assert.match(runbook, /encrypted off-site copy/i);
assert.match(runbook, /V3 resume may reuse the already verified encrypted backup/i);
assert.match(board, /No \*\*successful isolated restore rehearsal\*\*/);
assert.match(board, /successful decryption\/hash verification/i);
assert.match(board, /Backup\s+existence\/integrity is not the same as verified restorability/i);
assert.doesNotMatch(board, /No current restorable backup or successful isolated restore rehearsal/);

// Frozen hashes and scoped authority remain in the separately governed
// packet; a documentation snapshot cannot change its requirements.
assert.match(packet, /Every earlier REC-1 execution approval is stale and void/i);
assert.match(board, /Prior approvals are not reusable/i);
assert.match(board, /REC-1 V3 resume authorization/i);
assert.match(board, /before any resume/i);
assert.match(board, /No trading or broker execution authority/);
console.log('PASS GOV-1 historical board, REC-1 evidence distinction and freeze warning');
