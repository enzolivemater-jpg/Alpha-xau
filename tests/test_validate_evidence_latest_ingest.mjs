import assert from 'node:assert/strict';

import { latestIngestedAt } from '../scripts/validate_evidence_captures.mjs';

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
