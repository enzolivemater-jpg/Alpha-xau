# XAU V2 — Combined offline integration rehearsal (CHAIN/OBS/UI)

**NOT a merge candidate. DO NOT DEPLOY. Main and REC-1 remain frozen.**

This branch combines files proposed in draft PR #115, UI-0 files from PR #116, and the strictly isolated OBS-0 calendar-validation patch from PR #118, plus a cross-contract integration test. It does not overwrite any source PR. The only intentionally reconciled shared file is the deterministic test runner, registering both UI-0 tests without dropping any existing contract guard.

## Integration path tested

- A **fixed synthetic** fixture feeds the actual ten-stage CHAIN-0 offline implementation.
- OBS-0 generates a deterministic `VALID_HOLD` checksum; it is not a signature, approval, source attestation or production result.
- The actual CC-0, AL-0 and E2E-0 envelopes feed UI-0, which emits only an unverified, read-only `HOLD / ABSTAIN / FORBIDDEN` projection.
- Tampered trade tickets, fabricated deployments, alert recipients/delivery and fake acceptance proofs are rejected by both OBS-0 and UI-0.
- A tampered upstream horizon remains unverified by UI-0 and is rejected by OBS-0; UI-0 cannot validate its earlier stages in isolation.

## Exclusions

No new network code, HTTP route, cron hook, UI binding, storage read/write, backup restore, migration, secret access, provider action, broker adapter or execution authority. The historical terminal is untouched. A green CI workflow verifies only repository code and ephemeral test infrastructure.

Review independent PRs in dependency order before considering any integration. No automatic merge, even if Quality Gate is green.

The calendar inconsistency between OBS-0 `Date.parse` normalization and strict UI-0 validation is exercised explicitly: February 30 produces `OBS: REJECTED/fingerprint=null` and `UI: INVALID_CLAIMED_CUTOFF`. OBS-0 strict validation is proposed independently in PR #118 and must be reviewed before integration.

## Compatibility correction discovered by composite CI

A naive whole-file copy of the earlier OBS-0 calendar patch removed later OBS-0 spoof defenses. The combined CI correctly rejected this regression. The final experiment therefore uses the fully hardened OBS-0 implementation from PR #115 and applies **only** the strict calendar predicate from PR #118, preserving the full prior adversarial receipt corpus. Any final integration must follow this same forward-port/rebase sequence rather than replacing the newer observability module with an old branch snapshot.
