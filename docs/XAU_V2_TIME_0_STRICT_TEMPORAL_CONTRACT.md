# XAU V2 — TIME-0 strict temporal contract

**Draft, offline only; NO production, no merge authorization, no trading.**

## Architectural problem

Existing gates use different calendar validators: some use Date.parse (which may normalize nonexistent days); EVIDENCE-0 has a strict millisecond-precision contract; OBS-0 and UI-0 allow at most nine fractional digits. Timestamp strings with differing RFC3339 offsets must be compared by instant rather than lexically. Repeated independent validators create regression risk during PR forward-porting.

## Proposed single-purpose capability

`backend/shared/temporal_contract.ts` exports:

- `parseStrictInstant(value, maximumFractionDigits=9)` returns a validated explicit Gregorian/offset-aware instant with exact nanosecond precision represented by bigint or null.
- `isStrictTimestamp` checks the same predicate without I/O.
- `compareStrictInstants(a,b, maximumFractionDigits=9)` returns -1, 0, 1, or null when either claim is invalid.

Year 0000, nonexistent days, leap seconds, 24:00, missing timezones, invalid offsets and RFC3339 -00:00 (unknown offset) are rejected. Accepted offsets retain precise UTC instant comparisons crossing dates. EVIDENCE-0 retains its previously proposed maximum **three fractional digits** by explicitly passing 3; OBS-0 and UI-0 retain maximum nine digits. Date.parse is used only to convert an already validated explicit millisecond UTC-offset timestamp; sub-millisecond nanoseconds are preserved separately, not silently rounded.

## Trust and limitations

TIME-0 validates syntax, civil calendar and relative instant ordering only. An apparently valid future-dated, stale, fabricated or unofficial event is **still an untrusted claim**. The module never reads wall-clock time, source material, provider data, PostgreSQL, APIs, secrets or a broker. No live data, publication attestation, approval or trading decision is implied. The bigint field is internal; do not JSON-serialize it as an operational envelope.

## Integration plan (no integration executed on main)

Run `node --experimental-strip-types tests/test_temporal_contract.mjs`, `npm run typecheck` and `npm test`. The new test is included in the deterministic CI runner.

Only after source review, forward-port uses of TIME-0 to EVIDENCE-0, hardened OBS-0 and UI-0 in an **isolated composite rehearsal**, updating the existing tests/transpilation sources and ARCH-2/ARCH-3 allowlist together. Never replace hardened OBS-0 with a less protected old snapshot (the PR #117 regression). Recheck invalid dates, nano ordering, offset equality and all HOLD / ABSTAIN / FORBIDDEN invariants.

Future broad use by already-merged regime, pricing, positioning or acceptance gates requires separate reviewed localized PRs. A TIME-0 helper does not itself approve any upstream data, methodology, runtime, migration or action.

**Human gates remain closed.**

## ARCH-TIME-1 — cross-parser conformance at the offline boundary

This is an **additive CI proof obligation**, not a runtime migration.
The original `backend/shared/strict_timestamp.ts` is still used by
the existing decision chain, while `backend/shared/temporal_contract.ts`
is the TIME-0 validator at the unified rehearsal trust boundary.

The deterministic regression in
`tests/test_cross_temporal_boundary.mjs` verifies:

- On 324 supported RFC3339 vectors (valid dates, times, nanosecond
  fractions and accepted UTC offsets), both implementations resolve the
  exact same epoch nanosecond count.
- Equivalent offsets yield the same instant. Millisecond rounding can
  never hide an observation strictly after its knowledge cutoff.
- The unified boundary **rejects** unsupported offsets (including
  `-00:00`), year zero, and impossible civil dates, withholding the
  decision receipt and digest rather than accepting a legacy parser's
  broader syntax.
- All rejected inputs remain `HOLD / FORBIDDEN / UNVERIFIED`.

This does **not** claim that two parsers are now interchangeable.
The legacy parser deliberately accepts a broader syntax; replacing it
inside other engines could change their public input contracts and needs
a separate approval, version bump, replay corpus and regression review.
Do not disable this guard to hide disagreements.

No live runtime, source attestation, database migration, deployment,
broker capability or REC-1 operation is included.

### Fixed integration issue surfaced by the cross-parser test

The first CI run exposed a defect in the *integration adapter*, not a
false assumption about TIME-0: invalid offsets could be normalized to
`''` and passed to the canonical chain, yielding `COMPLETED` and a
fallback digest. The adapter now short-circuits invalid cutoffs to a
`REJECTED` local result **before** the chain runs. An invalid OBS
receipt must likewise suppress completion and the checksum.
This preserves a single canonical evaluator on valid inputs.
