# XAU V2 — CI-GOV-1 deterministic test-inventory contract

**Status:** draft architectural QA protection only; no production, REC-1, deployment, trading, or migrations.

## Problem and decision

The deterministic runner uses a manually reviewed `TEST_FILES` list. A newly
created `tests/test_*.mjs` file can otherwise be omitted from both the
runner and the GitHub Quality Gate without detection. **CI-GOV-1 makes missing
registration a test failure**; it never dynamically executes unexpected tests.

`tests/test_ci_inventory.mjs` is a pure, local test that parses the
`TEST_FILES` literal via TypeScript AST, checks path existence and
uniqueness, and accounts for every `tests/test_*.mjs` file in exactly one
reviewed execution policy:

1. Deterministic/no-external runner `scripts/run_ci_tests.mjs`.
2. PostgreSQL integration tests invoked by literal `run: node` commands in
   `.github/workflows/quality-gate.yml` using **ephemeral CI PostgreSQL**
   services. The inventory guard does not start or connect to a database.
3. Eight explicitly named legacy/environment-dependent exemptions with
   recorded reasons: Anthropic external failure path; assembly HTTP;
   committee locking; frontend contract; legacy nontradable; live market
   cycle; news score parity; removed Stooq provider expectations.

The guard fails on newly added untracked tests, missing entries, duplicates,
nonliteral runner paths, stale exemptions and PostgreSQL tests not wired to
the ephemeral workflow. This is **inventory completeness**, not a statement
that any exempt test passed, that every test is sufficiently thorough, or
that production behavior is validated.

## Change control

Adding a deterministic test requires registering its literal path.
Adding a PostgreSQL integration test requires an isolated CI service job,
or placement into an existing compatible ephemeral database job.
Updating an exception requires a separate explanation and code review,
not a silent skip. No new job, database service, secret, API call or
production endpoint is introduced by this PR.

**DO NOT MERGE until independent human review of the #127 integration stack,
ARCH-4 and CI-GOV-1. `main` remains frozen.**
