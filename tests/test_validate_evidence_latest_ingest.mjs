import assert from 'node:assert/strict';

import { latestIngestedAt, verifiedClaimProblems } from '../scripts/validate_evidence_captures.mjs';

const rec = (ingestedAt) => ({ ingestedAt });

// '.' sorts before 'Z', so a lexical sort picks the earlier instant.
assert.equal(latestIngestedAt([rec('2026-01-01T10:00:00.500Z'), rec('2026-01-01T10:00:00Z')]), '2026-01-01T10:00:00.500Z');
assert.equal(latestIngestedAt([rec('2026-01-01T10:00:00Z'), rec('2026-01-01T10:00:00.500Z')]), '2026-01-01T10:00:00.500Z');
// Offsets are compared as instants.
assert.equal(latestIngestedAt([rec('2026-01-01T10:00:00Z'), rec('2026-01-01T10:30:00+01:00')]), '2026-01-01T10:00:00Z');
// A value that does not parse never wins over one that does.
assert.equal(latestIngestedAt([rec('zzz'), rec('2026-01-01T10:00:00Z')]), '2026-01-01T10:00:00Z');
// Nothing parses: deterministic fallback, no throw.
assert.equal(latestIngestedAt([rec('b'), rec('a')]), 'b');
assert.equal(latestIngestedAt([]), undefined);

console.log('PASS validate_evidence_captures: latest reception time compared as instants, not as text');

// verifiedClaimProblems: the source check can fail (its former form, `status !== 'VERIFIED' || reproducible`, never could).
const FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];
const replayOf = (status, held, extra = {}) => ({ status, reproducible: status === 'VERIFIED', nature: 'SIMULATION',
  observations: Object.fromEntries(FIELDS.map((f) => [f, held.includes(f) ? { field: f } : null])), ...extra });
assert.deepEqual(verifiedClaimProblems(replayOf('VERIFIED', FIELDS)), []);
assert.deepEqual(verifiedClaimProblems(replayOf('INCOMPLETE', ['spot'])), [], 'an INCOMPLETE replay may lack fields');
assert.deepEqual(verifiedClaimProblems(replayOf('VERIFIED', FIELDS.filter((f) => f !== 'dxy'))), ['VERIFIED_WITH_FIELD_NOT_HELD']);
assert.deepEqual(verifiedClaimProblems(replayOf('INCOMPLETE', FIELDS, { reproducible: true })), ['REPRODUCIBLE_STATUS_MISMATCH']);
assert.deepEqual(verifiedClaimProblems(replayOf('VERIFIED', FIELDS, { reproducible: false })), ['REPRODUCIBLE_STATUS_MISMATCH']);
assert.deepEqual(verifiedClaimProblems(replayOf('INCOMPLETE', FIELDS, { nature: 'HISTORICAL_VERIFIED' })), ['HISTORICAL_VERIFIED_WITHOUT_VERIFIED']);
// The former expression accepted the first defect: it is the one that matters for DATA-3 L1.
const former = (r) => r.status !== 'VERIFIED' || r.reproducible;
assert.equal(former(replayOf('VERIFIED', FIELDS.filter((f) => f !== 'dxy'))), true, 'the former check passed a VERIFIED replay without DXY');

console.log('PASS validate_evidence_captures: a VERIFIED, reproducible or HISTORICAL_VERIFIED label is checked against the data held');
