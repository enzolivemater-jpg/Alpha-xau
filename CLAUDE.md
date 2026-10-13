# XAU V2 — instructions for Claude Code

Read `docs/XAU_V2_AGENT_WORKFLOW.md` for the mission lifecycle, security
layers, and how to resume a mission. This file is guidance, not a security
control.

## Responsibilities

You implement one mission per branch: code, tests, evidence, and a draft PR
whose body is the mission report (`.github/pull_request_template.md`). You
never approve, merge, deploy, migrate, or act on production. Stop and ask when
a step needs a credential, a production target, or an action outside the
mission scope.

## Architecture and sources of truth

- `ARCHITECTURE.md` — repository layout (Worker backend, static frontend on
  GitHub Pages, PostgreSQL/Supabase).
- `docs/XAU_V2_*.md` — contracts, runbooks, and authorization packets.
  `docs/XAU_V2_COMPLETION_BOARD.md` is the status board; confirm production
  state with the human approver before relying on it.
- `database/migrations/` — ordered, transactional SQL. A migration whose
  hash is recorded in an authorization packet is immutable; changes go in a
  new forward-fix migration.
- `backend/` — TypeScript run with `node --experimental-strip-types`; no
  build step. `frontend/` — plain HTML/CSS/JS, no bundler.

## Conventions

- Branch: `<type>/<mission-id>-<slug>` from `origin/main`, never tracking
  `origin/main`. Never commit on `main`.
- Commits: `type(scope): summary` (for example `feat(event-facts): …`,
  `fix(recovery): …`, `docs(ops): …`).
- Match surrounding code style and comment density; no unrelated edits.
- A new deterministic test is added to `TEST_FILES` in
  `scripts/run_ci_tests.mjs`. A PostgreSQL test asserts a disposable
  database name and a local `PGHOST`, and gets a step in
  `.github/workflows/quality-gate.yml`.
- Never write secrets, tokens, connection strings, or production identifiers
  beyond those already public in the repository. `.env.example` lists
  variable names only.

## Validation

```sh
npm ci
npm run typecheck
npm test                                   # deterministic suite, no DB, no network
bash tests/test_pages_secret_guard.sh      # when frontend/ or pages.yml changes
```

PostgreSQL contract tests (`tests/*_postgres.mjs`) need a disposable local
PostgreSQL 17 with the database name each test asserts, and `PGHOST` set to
`127.0.0.1`. They drop and recreate schemas: never point them at a shared or
remote server. CI runs them in the `*-postgres` jobs.

## Hard constraints

- No production connection, migration, deploy, cron, route, or runtime
  activation; no `supabase`, `wrangler`, or deploy commands.
- No merge, no push to `main`, no force-push, no change to GitHub settings,
  secrets, variables, or branch protection.
- Auto mode and `bypassPermissions` are not used.
- Do not read credential files or `.env` files; report credential exposure
  by category only.

## Definition of DONE

1. Mission scope delivered on its own branch; nothing outside scope changed.
2. `npm run typecheck` and `npm test` pass locally; relevant PostgreSQL
   tests pass on a disposable local server, or the gap is stated.
3. Draft PR open against `main` with the completed mission report.
4. `Quality Gate` green on the PR head commit.
5. Risks, limits, and decisions requiring human approval are listed
   explicitly; nothing is reported as done that was not verified.
