# XAU V2 — RECON-AUTO-1: reconciliation of cloud and local branches

Status: `LOCAL TOOL — DRY_RUN BY DEFAULT — NOT SCHEDULED`

`scripts/recon_auto.mjs` integrates explicitly declared branches (Claude Cloud
PRs, local WSL branches) onto an explicitly declared canonical candidate in a
throwaway worktree, and reports PASS, CONFLICT or BLOCKED with the evidence.
It reuses the repository's own checks (`tests/test_ci_inventory.mjs`, `tsc
--noEmit`, `scripts/run_ci_tests.mjs`) and the O_EXCL lock convention of
`scripts/market_evidence_capture.mjs`. It is not a merge bot.

Versions: plan `xau.recon-auto-plan.v1`, report `xau.recon-auto-report.v1`,
algorithm `recon-auto-1.1.0`. Test: `tests/test_recon_auto.mjs`.

## Plan (explicit input, validated before any git command)

```json
{
  "schemaVersion": "xau.recon-auto-plan.v1",
  "canonical": { "name": "pr-153", "ref": "refs/remotes/origin/ci/quality-gate-terminal-offline",
                 "sha": "44b08b933052cfd89c4370569835c3853f12b608" },
  "candidates": [
    { "name": "b1", "ref": "refs/heads/feat/b1-rc0-e2e-offline", "sha": "c6bb706e…", "base": "44b08b93…", "origin": "LOCAL" },
    { "name": "pr-154", "ref": "refs/remotes/origin/claude/bold-keller-ejr6qi", "sha": "709227415e…", "base": "44b08b93…", "origin": "CLOUD" }
  ],
  "integrationBranch": "refs/heads/recon/rc-b5-plus-154"
}
```

Exact keys only. Names `^[a-z0-9][a-z0-9._-]{0,63}$`; refs only
`refs/heads/*` or `refs/remotes/origin/*`, never `main`/`master`, no `..`,
`//`, `@{`, leading-dot or `.lock` component; SHAs and bases are full
lowercase 40-hex; origin `CLOUD` or `LOCAL` (a declaration, recorded as
`DECLARED_UNVERIFIED`, never trusted more); 1 to 20 candidates, unique names
and refs; the integration branch is `refs/heads/recon/<name>`. Anything else,
including a getter that throws, is `INVALID_PLAN` and no git command runs.
Nothing is discovered: an unknown branch is never selected.

### Proposing a plan (`--init-plan`, 1.1.0)

```sh
node scripts/recon_auto.mjs --init-plan --canonical rc=refs/heads/recon/terminal-offline-final \
  --candidate auto=refs/heads/feat/auto-session-1@LOCAL \
  --integration-branch refs/heads/recon/auto-session-1 --out-plan plan.json
```

Only the refs named on the command line are used (nothing is discovered).
Each resolves to its current commit; a candidate's base is the previous
candidate when that one is its ancestor (a stack), else its merge-base with
the canonical commit. The result must pass the plan validation above; it is
written create-only (an existing file is never replaced, exit 2) and never
run by itself. Exit 0 written, 2 no plan (unknown or invalid ref, no
merge-base, invalid result), 64 usage. A human reviews the file, then runs it
with `--plan`.

## Algorithm

1. Lock `<git-common-dir>/recon-auto.lock` (O_EXCL). A live owner:
   `LOCK_HELD`. A dead owner (interrupted run): `STALE_LOCK`, unless
   `--recover-stale-lock`, which removes only `recon-auto-wt-*` worktrees under
   the work root, prunes, deletes the stale lock and continues.
2. Every ref must resolve to its declared SHA (`UNKNOWN_REF`,
   `REF_SHA_MISMATCH`); each base must exist (`UNKNOWN_BASE`) and be an
   ancestor of its candidate (`BASE_NOT_ANCESTOR`); a range holding a merge
   commit is `MERGE_COMMIT_UNSUPPORTED`. All candidates are checked before any
   simulation.
3. In plan order, on top of the canonical commit or the previous result: the
   base must be in the current head (`BASE_NOT_IN_CANONICAL`); a contained
   candidate is `ALREADY_INTEGRATED` (`ANCESTOR`, or every commit
   `PATCH_EQUIVALENT` per `git cherry`); one containing the head is a
   `FAST_FORWARD`; otherwise:
   - files changed on both sides since the base are compared. A shared
     contract file (`backend/**.ts`, `database/`, `tests/fixtures/`,
     `docs/XAU_V2_*.md`, `.github/workflows/`) stops with `CONFLICT`
     (`CONTRACT_OVERLAP`) even when git could merge it. A shared manifest
     (`scripts/run_ci_tests.mjs`) is listed in `manifestOverlap` and left to
     the textual merge plus the CI inventory check;
   - pending commits are cherry-picked with `-x` in a detached worktree
     `recon-auto-wt-*`, committer `RECON-AUTO-1` and the source commit's
     committer date: the same inputs give the same commits. A conflict is
     aborted and reported with its files (`TEXT_CONFLICT`), never resolved.
4. `--verify inventory,typecheck,full` runs those fixed commands (no command
   comes from the plan) in the worktree; a failure is `BLOCKED`
   (`VERIFY_FAILED_*`). 1.1.0: each step's whole output is kept as
   `verify-<step>.log` next to the report, and `failedTests` lists the test
   files the runner reported as `FAILED: <file> (exit N)` (also in
   `report.md`), so a failure is read without re-running it.
5. The worktree is removed in every case, the canonical ref is re-read
   (`canonical.unchanged`), the lock is released, and `report.json` and
   `report.md` are written atomically. `resultDigest` covers everything but
   paths and timings, so a rerun with the same inputs gives the same digest.
6. `--apply`, on PASS only, creates `integrationBranch` with
   `git update-ref <ref> <sha> 0000…` (create-only). Same SHA: `UNCHANGED`;
   another SHA: `BLOCKED` (`INTEGRATION_BRANCH_EXISTS`), never overwritten.

Allowed git subcommands: `rev-parse cat-file merge-base rev-list cherry diff
diff-tree log show worktree(add|remove|prune|list) cherry-pick checkout
update-ref(refs/heads/recon/* only)`. No push, fetch, pull, clone, remote,
merge, rebase or reset; no shell; hooks disabled; `GIT_TERMINAL_PROMPT=0`.
Fetching is not this tool's job: the refs it reads must already exist.

Exit: 0 PASS, 1 CONFLICT, 2 BLOCKED, 64 usage.

## Plan drift

When a declared ref no longer points at its declared SHA, nothing is
simulated: the report is `BLOCKED` (`REF_SHA_MISMATCH`) and lists the moved
refs in `drift` (declared and current SHA) and under "Plan drift — review
required" in `report.md`. The tool never updates the plan: a human reviews the
new commits and commits the new SHAs.

1.1.0 prepares that review (read-only git only). Each drift entry has a
`kind`:

| Kind | Meaning | Listed |
| --- | --- | --- |
| `ADVANCED` | the declared commit is an ancestor of the current one: new commits on top | new commits (SHA, subject; at most 50, `commitsTruncated`), changed files (at most 200, `filesTruncated`), contract files among them, merge commits |
| `REWRITTEN` | the declared commit exists but left the history (rebase or force-push) | nothing: a decision is needed |
| `DECLARED_UNKNOWN` | the declared commit is not in this repository | nothing |

When every drift is `ADVANCED`, `proposedPlan` (also written as
`proposed-plan.json` next to the report) is the plan with those refs moved to
their current SHA, bases unchanged. It is a proposal: the tool never writes
the plan file, never runs it by itself, and gives no proposal when any drift
is `REWRITTEN` or unknown. The human step becomes: read the listed commits,
then commit `proposed-plan.json` in place of the plan.

## Recurring read-only operation

Plan: `docs/recon/plan-rc-offline.json` (canonical PR #153 head, candidate
`recon/rc-b5-plus-154` = PR #155), remote-tracking refs only, so the same plan
runs in WSL and in GitHub Actions. One run, by hand or from cron (not
installed):

```sh
git fetch --no-tags origin \
  +refs/heads/ci/quality-gate-terminal-offline:refs/remotes/origin/ci/quality-gate-terminal-offline \
  +refs/heads/recon/rc-b5-plus-154:refs/remotes/origin/recon/rc-b5-plus-154
node scripts/recon_auto.mjs --plan docs/recon/plan-rc-offline.json \
  --out "$HOME/xau-recon/$(date -u +%Y-%m-%d)" --verify inventory,typecheck,full
# example crontab line (UTC 05:17 daily), only after review:
# 17 5 * * * cd /home/xauagent/projects/Alpha-xau && <the two commands above> >/dev/null 2>&1
```

The fetch is the caller's job; the tool stays offline. Outcomes: PASS — nothing
to do; BLOCKED with `drift` — review the new commits listed in the report and,
when all are `ADVANCED`, commit `proposed-plan.json` as the plan; CONFLICT — an integration decision; any other BLOCKED reason
— read the report. No run ever writes a ref (no `--apply` in recurring use).

## Trust boundary

A PASS means the declared commits apply and the repository's own checks pass
on the simulated tree, locally. It is not CI evidence (`trust.ci =
NOT_VERIFIED`), not a review, not provenance, and grants no merge, deploy,
migration or trading authority. HOLD / FORBIDDEN and REC-1 are unaffected.

## Proposed GitHub Actions workflow (NOT committed under .github, NOT active)

```yaml
name: RECON-AUTO-1 (proposal)
on:
  workflow_dispatch:
    inputs:
      plan: { description: 'reviewed plan file in the repository', required: true }
  # schedule: [{ cron: '17 5 * * *' }]   # only after the activation steps below
permissions:
  contents: read
concurrency: { group: recon-auto, cancel-in-progress: false }
jobs:
  recon:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@<pinned-sha>
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version: 22 }
      - run: npm ci
      - run: sudo apt-get update -qq && sudo apt-get install -y poppler-utils
      # Read-only fetch by the workflow, never by the tool; PR heads become refs/remotes/origin/pr/<n>.
      - run: git fetch --no-tags origin '+refs/heads/*:refs/remotes/origin/*' '+refs/pull/*/head:refs/remotes/origin/pr/*'
      - run: node scripts/recon_auto.mjs --plan "${{ inputs.plan }}" --out recon-report --verify inventory,typecheck,full
      - uses: actions/upload-artifact@<pinned-sha>
        if: always()
        with: { name: recon-report, path: recon-report/ }
```

No `--apply`, no write token, no secret: the job only produces a report.

### What runs where

| Operation | GitHub Actions | Local WSL only |
| --- | --- | --- |
| Pushed branches and PR heads as candidates | yes | yes |
| Local, unpushed branches (B1–B5 today) | **no**: they do not exist on GitHub | yes |
| Canonical candidate | if pushed (e.g. PR #153 head) | any local ref |
| Ephemeral PostgreSQL suites | possible (existing CI services), not wired to this job | via the local PG17 sandbox |
| `--apply` (create `recon/*` branch) | not proposed | yes, local ref only |
| Real DATA-3 capture validation | no (captures are not in the repository) | yes |

## Activation steps (each a human decision)

1. Review and merge path for the tool itself (it lives on a local branch).
2. Decide the canonical candidate and keep it in a reviewed plan file; decide
   who updates the SHAs (they change with every push) — the plan never
   resolves a branch name to "latest" by itself.
3. Push the local branches that must be reconciled in CI, or keep local runs.
4. Pin the action SHAs, commit the workflow under `.github/workflows/`, run it
   by `workflow_dispatch` and compare its report with a local run.
5. Only then consider `schedule`, still without `--apply` or write permission.
