# XAU V2 — TIME-0 integration proof (offline synthetic rehearsal)

**THIS IS NOT A MERGE CANDIDATE. NO PRODUCTION OPERATIONS.**

## Purpose

Verify that a single deterministic temporal utility can replace three independent timestamp implementations without dropping hardening from PR #110 or making an unverified evidence claim actionable.

## Sources assembled

Base: previously CI-validated draft composite PR #117. Shared TIME-0 utility/tests/docs: independent draft PR #120. Changed in this experimental branch: imports and timestamp validation of OBS-0, EVIDENCE-0 and UI-0; updated fixture-based tests, offline CLI transpilation, AST purity guard and transitive import allowlist. No existing live Worker/ingestion, database schema, frontend runtime or broker code altered.

TIME-0 is the single comparison implementation, with a strict Gregorian date check before deterministic UTC conversion:

- OBS-0 uses the standard <=9 fractional digits for receipt cutoff validity and retains *all* later anti-forgery checks.
- UI-0 uses the same <=9 digits when reporting only claimed cutoff, never live proof.
- EVIDENCE-0 uses <=3 digits to preserve its proposed legacy millisecond contract, then compares instants using bigint nanoseconds so timezone offsets cannot induce false ordering.

All evidence remains UNVERIFIED with authorization NONE; the chain remains HOLD / ABSTAIN / FORBIDDEN; TR-0 remains NOT_CONNECTED and structurally valid only. An externally supplied future or fake release cannot become a trusted source by satisfying TIME-0.

## Migration hazards identified

Each existing offline contract test compiles TypeScript into a temporary directory. Imports of the new utility must therefore include its source file and rewrite its .js import path to .mjs. The offline CLI needs the same explicit source list. EVIDENCE-0's direct transpilation test must create observability/ and shared/ output directories rather than importing an absent relative path.

ARCH-2 static purity and ARCH-3 transitive closure require an explicit allowlist entry for backend/shared/temporal_contract.ts. These changes are staged **only on this integration branch**, not silently applied to the source PRs.

## No-go

This composite branch is an integration rehearsal and must never be merged as source code. Review standalone PR #120 separately, then forward-port the shared contract into independently approved upstream source branches. Do not replace hardened OBS-0 with #118's old branch snapshot. No production permissions, restore, migration, deploy, provider, network, alert delivery, or trading.