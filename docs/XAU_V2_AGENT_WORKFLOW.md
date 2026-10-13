# XAU V2 — Agentic development workflow

Status: `PROPOSAL — NOT ACTIVE`

This document defines how an autonomous coding agent (Claude Code) works on
XAU V2 under architectural supervision and independent CI validation. It
closes the design part of INFRA-AGENT-1. It does not activate any permission,
create any identity, change any GitHub protection, or touch production.

## 1. Roles

| Role | Actor | Owns |
| --- | --- | --- |
| Architect | ChatGPT (human-relayed) | Mission brief, scope, acceptance criteria, design review |
| Implementer | Claude Code | Branch, code, tests, evidence, draft PR, mission report |
| Validator | GitHub Actions `Quality Gate` | Independent re-run of the deterministic and PostgreSQL suites |
| Approver | Human repository owner | Review, approval, merge, every production decision |

The implementer never approves or merges its own work and never acts on
production. Merge authority stays with the human approver.

## 2. Mission lifecycle

1. **Brief.** The architect issues a mission with an ID (for example
   `INFRA-AGENT-1`, `EF-14`), objective, scope, explicit prohibitions, and
   acceptance criteria.
2. **Branch.** The implementer fetches `origin/main`, verifies a clean tree,
   and creates one dedicated branch per mission:
   `<type>/<mission-id-lowercase>-<short-slug>` with `type` in
   `feat|fix|docs|chore|test|refactor`. The branch must not track
   `origin/main` (`git branch --unset-upstream` if the tool set it).
3. **Implement.** Small, reviewable commits using the existing convention
   `type(scope): summary`. No unrelated changes.
4. **Validate locally.** Run the commands in `CLAUDE.md` § Validation. Record
   exact commands and pass counts.
5. **Draft PR.** Push the mission branch only and open a **draft** PR against
   `main` whose body is the completed mission report
   (`.github/pull_request_template.md`).
6. **CI.** Wait for `Quality Gate`. A red check is fixed on the same branch;
   it is never bypassed or re-run blindly.
7. **Review.** The architect reviews the report and diff; the human approver
   decides. The implementer answers review comments with new commits.
8. **Merge.** Human only. Production rollout, if any, is a separate mission
   with its own authorization packet (see the Event Facts and recovery
   packets for the existing pattern).

## 3. Resuming a mission and finding its evidence

All mission state lives in Git and GitHub, never only in a chat transcript:

| Evidence | Location |
| --- | --- |
| Code and tests | Mission branch: `git log --oneline origin/main..<branch>` |
| Mission report | Draft PR body: `gh pr view <branch>` |
| Local test results | "Tests executed" section of the report (commands + pass counts) |
| Independent validation | `gh pr checks <branch>` and the linked Actions run IDs |
| Decisions and open gates | "Decisions requiring human approval" section of the report |

To resume: `git fetch origin`, check out the mission branch, read the PR body,
then `gh pr checks`. Evidence that could contain sensitive values (database
dumps, logs with connection strings) is never committed or pasted into a PR.

## 4. Security boundaries

A prohibition in a prompt or in `CLAUDE.md` is guidance, not a control.
Controls are layered; only the first two are security boundaries.

| Layer | Mechanism | Protects against | Status |
| --- | --- | --- | --- |
| 1. Credential boundary | Dedicated WSL distribution for the agent (§ 5) | Agent reading production or owner credentials | `NOT PROVISIONED` |
| 2. Merge boundary | Minimal GitHub identity + `main` protection (§ 6, § 7) | Unreviewed or red code reaching `main` and GitHub Pages | `NOT APPLIED` |
| 3. OS sandbox | Claude Code sandbox (bubblewrap + socat) | Sandboxed commands reading denied paths or reaching unlisted hosts | `UNAVAILABLE` (socat missing on the owner host) |
| 4. Permission rules | `docs/XAU_V2_AGENT_CLAUDE_SETTINGS_PROPOSAL.json` | Accidental tool calls; prompts on risky actions | `PROPOSAL — NOT ACTIVE` |
| 5. Instructions | `CLAUDE.md` | Drift from conventions and scope | Guidance only |

Per the official Claude Code documentation, Bash permission rules are not a
security boundary around a program, `Read` deny rules do not stop a script that
opens files itself, and `sandbox.credentials` entries are ignored in project
settings. Layers 3–5 therefore never compensate for a missing layer 1 or 2.

## 5. Target isolation — dedicated WSL distribution

The agent runs in its own WSL distribution with its own Linux user, its own
clone of the repository, and its own Claude Code login. Required properties,
each verified by inspection before activation:

- **No production credentials:** no Supabase CLI token, no Wrangler/Cloudflare
  login, no production `.env`, no `SUPABASE_SERVICE_ROLE_KEY` or other runtime
  secret, no owner SSH keys. Check existence only, never print values.
- **No access to the owner's distribution or Windows files:** in
  `/etc/wsl.conf`, disable automount of Windows drives (`[automount]
  enabled=false`) and Windows interop (`[interop] enabled=false`,
  `appendWindowsPath=false`); verify with `mount` that no `/mnt/<drive>` or
  owner home is mounted. Interop must be off because a WSL Unix socket can
  launch Windows binaries outside the sandbox.
- **Sockets:** no Docker Desktop socket shared from the owner context. If
  PostgreSQL tests need a server, install PostgreSQL 17 inside the agent
  distribution or a Docker engine local to it; verify `ls -l /var/run/*.sock`.
- **Network:** outbound access limited in practice to GitHub and the npm
  registry; the sandbox `network.allowedDomains` enforces this for sandboxed
  commands. Production hosts (`*.supabase.co`, `api.supabase.com`,
  `api.cloudflare.com`) must not be required by any mission.
- **Sandbox dependencies:** `bubblewrap` and `socat` installed; the proposal
  sets `sandbox.failIfUnavailable=true` so Claude Code refuses to start
  unsandboxed.
- **Claude Code settings:** after approval, copy the proposal file to the
  agent clone's `.claude/settings.local.json` (personal scope, never
  committed, so it cannot change the owner's sessions). In the agent user's
  `~/.claude/settings.json`, add `sandbox.credentials.envVars` deny entries
  (they are honored only from user or managed scope) and keep Auto mode and
  `bypassPermissions` disabled.
- **`acceptEdits` scope:** the proposal's `defaultMode: acceptEdits` is
  intended only for this isolated distribution. It must never be applied to
  the owner's environment, where production credentials are readable.

## 6. Minimal GitHub identity

A technical identity distinct from the human approver, so that the existing
"1 approving review" rule is meaningful and the agent cannot approve itself.

- Preferred: a machine user added as collaborator with the **Write** role, or
  a GitHub App installed only on `enzolivemater-jpg/Alpha-xau`.
- Token permissions: `Contents: read/write`, `Pull requests: read/write`,
  `Metadata: read`. No `Administration`, `Secrets`, `Variables`,
  `Environments`, or `Workflows` permission; finite expiry.
- Consequence of no `Workflows` permission: a mission that changes
  `.github/workflows/**` cannot be pushed by the agent; the approver pushes
  those changes. This is intended.
- To verify before creation: whether a fine-grained token of a collaborator
  account can target this personally owned repository; if not, use the GitHub
  App option.

## 7. Proposed `main` protection (not applied)

Current state (read-only inventory, 2026-10-13): pull request with one
approving review required; `enforce_admins=false`; no required status checks;
force-push and deletion blocked; the owner token is repository admin. A push
to `main` touching `frontend/**` deploys GitHub Pages.

Proposal:

1. Require these status checks, which are the job names reported by every
   `Quality Gate` run on `main` (verified on run `38304245245`):
   `quality`, `security-baseline-postgres`, `recovery-rehearsal-postgres`,
   `public-schema-privilege-postgres`, `event-impact-postgres`,
   `event-facts-postgres`, `market-driver-postgres`,
   `market-partition-rls-postgres`, `gold-transmission-postgres`,
   `gold-transmission-rpc-postgres`.
2. Enable `enforce_admins` so the admin token cannot bypass review or checks.
3. Dismiss stale approvals when new commits are pushed, and require approval
   of the most recent push (`require_last_push_approval`), so a Write
   identity cannot add commits after the human approval and then merge.
4. Keep force-push and deletion blocked.
5. Optional: a `CODEOWNERS` entry for `.github/`, `scripts/`, `tests/` and
   `database/` with code-owner review required, so changes to the code that
   CI itself runs always get an explicit owner review.

Adding a CI job later requires updating this list in the same PR.

## 8. Activation sequence

Each step needs explicit human approval; none is authorized by this document.

1. Provision and verify the agent WSL distribution (§ 5).
2. Create the minimal GitHub identity (§ 6).
3. Apply the `main` protection (§ 7).
4. Copy the settings proposal into the agent clone's
   `.claude/settings.local.json` and verify it with `/permissions` and
   `/sandbox` (no Dependencies tab; strict sandbox mode shown).
5. Run one low-risk pilot mission end to end and review its report.

Auto mode and `bypassPermissions` stay disabled throughout.

## 9. Push and draft-PR autonomy — restrictions and independent controls

In the isolated distribution the proposal pre-approves exactly two outward
actions: `git push origin <type>/<branch>` for the six branch prefixes, and
`gh pr create --draft …`. Everything else that leaves the machine prompts or
is denied.

These rules are pattern matches on command text. They reduce accidental
actions; they are **not** a security guarantee. Known limits: a refspec
spelling not anticipated by the deny list, flag combinations such as a later
`--draft=false`, or a script that calls `git` internally are not reliably
caught. Each outward action therefore has an independent control that holds
even if a pattern is bypassed:

| Action | Pattern restriction (convenience) | Independent control (enforced) |
| --- | --- | --- |
| Push | Only `origin feat|fix|docs|chore|test|refactor/*`; deny `main`, `refs/*`, `gh-pages`, force, delete, mirror, all, tags | `main` protection with `enforce_admins` (§ 7) rejects direct pushes; the token has no `Workflows` permission, so `.github/workflows/**` cannot be pushed; Pages deploys only from `main` (environment branch policy) |
| Draft PR | Only `gh pr create --draft`; deny `gh pr ready`, `merge`, `review`, `close` | Required human approval of the latest push, 10 required checks; the agent identity cannot approve its own PR |
| Merge | Denied | Same branch protection; human approver only |
| Production | Supabase/Wrangler/deploy denied; credential paths denied | No production credential exists in the agent distribution (§ 5) |
| Migrations | `Edit(/database/migrations/**)` denied | Human review; migration hashes recorded in authorization packets |

Residual risk accepted by design: a Write identity can merge a PR once a
human has approved its latest push and every required check is green. The
merge then contains only what the human approved.

## 10. GitHub Actions exposure to agent branches and PRs

Read-only inventory (2026-10-13):

- `Quality Gate` runs on `pull_request` to `main` and on push to `main`; a
  push to an agent branch alone triggers nothing. Its jobs use
  `permissions: contents: read` and no secrets.
- No workflow uses `pull_request_target`, `workflow_run`, or `secrets.*`.
  Repository default `GITHUB_TOKEN` permission is `read`, and Actions cannot
  approve pull requests.
- `pages.yml` runs only on push to `main` or manual dispatch; the
  `github-pages` environment accepts deployments from `main` only. It reads
  two public repository variables.
- Actions allow-list is `all` and SHA pinning is not required; workflows pin
  official `actions/*` by major tag.

Risks and mitigations:

1. **CI executes agent-controlled code.** A PR's tests and
   `scripts/run_ci_tests.mjs` come from the agent branch, so a green check
   cannot prove that tests were not weakened. Mitigation: human review of
   any diff under `tests/`, `scripts/` or `.github/`; the optional
   `CODEOWNERS` rule in § 7; the proposal makes edits to
   `scripts/run_ci_tests.mjs` and `.github/**` prompt.
2. **No secret exposure through PR CI.** Jobs receive no secrets and a
   read-only token; keep it that way. Any future workflow that needs a
   secret must not run on `pull_request` from agent branches.
3. **Workflow injection.** The agent token lacks `Workflows` permission, so
   it cannot add or modify workflows; such changes are pushed by the human.
4. **Supply chain.** Recommended (human decision): restrict allowed actions
   to GitHub-owned actions and pin them by commit SHA.
5. **Resource use.** Each agent push to an open PR re-runs ten jobs; keep
   PRs in draft and push in batches.
