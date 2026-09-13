# XAU V2 — Resource & Capability Registry

**Status:** DRAFT v3 — canonical clean rebuild after independent review

**Scope:** governance/documentation only

**Public-repo rule:** no personal email, no account ID, no OAuth/session
detail, no production endpoint URL, no secret value. Allowed: repository
public name, Task IDs, commit SHAs, secret *variable names* (e.g.
`ANTHROPIC_API_KEY`).

This file exists so architecture decisions never depend on conversational
memory. It is a stable capability/governance record, not an incident
diary — historical proof is cited by Task ID (e.g. OPS-020), not
reproduced as timestamps, log excerpts, version IDs, or command output.

---

## How to read this registry

Every resource is classified on independent dimensions. This is the
**only** classification model used in this file — no other values, and
no dimension is conflated with another.

**Evidence State** — what is factually known:
`PROJECT_IN_USE` · `CONNECTED_VERIFIED` · `AVAILABLE_TO_CONNECT` ·
`USER_REPORTED` · `TO_VERIFY`

**Architecture Disposition** — what the project has decided to do with it:
`CORE` · `APPROVED` · `CANDIDATE` · `DEFERRED` · `REJECTED_DUPLICATIVE` ·
`REJECTED_UNSUITABLE` · `TO_DECIDE`

**Criticality** — impact if unavailable:
`CRITICAL` · `HIGH` · `MEDIUM` · `LOW` · `NONE`

**Data Authority** — only for resources that provide or could provide data:
`PRIMARY_OFFICIAL` · `PRIMARY_MARKET` · `SECONDARY_VALIDATION` ·
`RESEARCH` · `INTERNAL_SYSTEM_TRUTH` · `NOT_APPLICABLE` · `TO_VERIFY`

**Rules:**
- `USER_REPORTED` and `TO_VERIFY` are never silently upgraded. Only
  independently reproducible evidence (a repo file, a config comment, a
  directly-obtained API response) justifies a change, cited in
  **Evidence reference**.
- Nothing here invents subscription tier, API entitlement, quota,
  commercial rights, redistribution rights, pricing, credentials, or
  account status. Unknown → `TO_VERIFY`.
- Every resource has exactly one canonical block, using exactly these
  seventeen fields, in this order, and no others: Category, Evidence
  State, Architecture Disposition, Criticality, Data Authority, Current
  role, Approved use, Prohibited/discouraged use, Capability/data
  provided, Access/authentication model, Cost/quota status,
  Licensing/data-rights status, Failure/dependency risk,
  Fallback/alternative, Evidence reference, Owner, Next action.

---

## XAU V2 Governance Model (C2+/C3)

This registry documents resources; it does not replace or weaken the
project's governance model. Stated once, here only:

1. **Enzo = final human authority.** No AI approves, merges, deploys, or
   overrides on its own authority.
2. **ChatGPT / GPT-Codex** = architect + independent reviewer.
3. **Claude Code** = implementation writer.
4. **Gemini** = external researcher / challenger / P0-C3 auditor, when
   useful.
5. **GitHub Actions** = the intended deterministic automated control
   layer (not yet a quality gate — see § Verified Technical Gaps).
6. **Exactly one active writer at a time** for a governed implementation
   task.
7. **Critical handovers reference Task ID + SHA.**
8. **Material GPT/Gemini disagreement ⇒ `NEEDS_DECISION`**, escalated to
   Enzo.
9. **No AI may approve production by itself.**
10. **No AI may activate live execution by itself.**
11. **No AI may modify risk limits by itself.**
12. **P0/P1/C3-classified work requires stronger independent review**
    than routine work.

---

## A. GOVERNANCE / ARCHITECTURE

### ChatGPT (GPT-5.6 Sol)
- Category: A
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH
- Data Authority: NOT_APPLICABLE
- Current role: architecture / orchestration / independent review
- Approved use: architecture decisions, cross-checking implementation plans, independent review
- Prohibited/discouraged use: must not be sole designer, sole implementer, and sole verifier of one critical change (governance model, item 12)
- Capability/data provided: TO_VERIFY (model/version, tool access not tracked by this registry)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable (not a data provider)
- Failure/dependency risk: none to the deployed system — does not execute inside it
- Fallback/alternative: Gemini as independent challenger when appropriate
- Evidence reference: role assignment is a governance decision, not an infrastructure fact
- Owner: Enzo
- Next action: none

### Claude Code
- Category: A/B
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH during active implementation sessions; NONE at rest
- Data Authority: NOT_APPLICABLE
- Current role: implementation writer — has authored, tested, and deployed the code in this repository across the OPS-009 through OPS-023 task series
- Approved use: implementation, testing, controlled deploys/DB reads under explicit instruction
- Prohibited/discouraged use: must not be sole designer+implementer+verifier of a critical change (governance model, item 12); must not merge/deploy/mutate production without explicit instruction
- Capability/data provided: repository read/write, shell, deploy tooling access within an explicit task
- Access/authentication model: session-scoped tool access (git, deploy CLI, code-hosting CLI); not persisted between sessions
- Cost/quota status: TO_VERIFY (plan/billing not visible to this registry)
- Licensing/data-rights status: not applicable
- Failure/dependency risk: a faulty implementation reaches production if not independently reviewed — mitigated by the governance model's separation of roles
- Fallback/alternative: none within this project (single implementation writer by design)
- Evidence reference: this repository's own commit history (OPS task series)
- Owner: Enzo
- Next action: none

### Remote Desktop Commander
- Category: A/B
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — identified connector, not connected
- Approved use: TO_VERIFY
- Prohibited/discouraged use: must not be connected to any production-adjacent machine without an explicit decision, given its blast radius
- Capability/data provided: TO_VERIFY (presumed remote desktop/file control; identity is known, capability detail is not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: high blast radius if connected carelessly — no decision made
- Fallback/alternative: n/a
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: decide whether to connect (Action Queue)

---

## B. IMPLEMENTATION / DEVELOPMENT

### TypeScript
- Category: B
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH
- Data Authority: NOT_APPLICABLE
- Current role: primary implementation language for the entire backend
- Approved use: all backend implementation
- Prohibited/discouraged use: n/a
- Capability/data provided: static typing, compiled/bundled at deploy time
- Access/authentication model: n/a
- Cost/quota status: free, open source
- Licensing/data-rights status: Apache-2.0; not applicable to redistribution concerns
- Failure/dependency risk: low — mature toolchain
- Fallback/alternative: none needed
- Evidence reference: `package.json` devDependency; strict typecheck passes (see § Verified Technical Gaps for the one known caveat)
- Owner: project
- Next action: none

### Node.js
- Category: B
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: NONE to production (test/dev only — production runtime is Cloudflare Workers)
- Data Authority: NOT_APPLICABLE
- Current role: local test/dev runtime; tests run via Node's native TypeScript type-stripping
- Approved use: local testing, tooling scripts
- Prohibited/discouraged use: must not be assumed to be the production runtime
- Capability/data provided: n/a
- Access/authentication model: n/a
- Cost/quota status: free, open source
- Licensing/data-rights status: not applicable
- Failure/dependency risk: a modern Node version is required for the test suite's type-stripping approach
- Fallback/alternative: none needed for its current role
- Evidence reference: repo test suite runs under it
- Owner: project
- Next action: none

### Python
- Category: B/L
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: NONE (not part of the deployed runtime)
- Data Authority: NOT_APPLICABLE
- Current role: one repo script (contract-vs-schema validation)
- Approved use: validation/contract scripts
- Prohibited/discouraged use: must not be introduced into the Worker runtime path
- Capability/data provided: n/a
- Access/authentication model: n/a
- Cost/quota status: free, open source
- Licensing/data-rights status: not applicable
- Failure/dependency risk: this script depends on a local database-role prerequisite that is absent in some sandboxes, reported as NOT_RUN_ENVIRONMENT there — pre-existing, environment-specific
- Fallback/alternative: none needed
- Evidence reference: repo file listing; repeated NOT_RUN_ENVIRONMENT observation across the OPS task series
- Owner: project
- Next action: TO_VERIFY whether the missing environment prerequisite also affects CI

### AJV
- Category: B/L
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: LOW
- Data Authority: NOT_APPLICABLE
- Current role: JSON-schema validation devDependency
- Approved use: schema/contract validation
- Prohibited/discouraged use: n/a
- Capability/data provided: n/a
- Access/authentication model: n/a
- Cost/quota status: free, open source
- Licensing/data-rights status: not applicable
- Failure/dependency risk: low
- Fallback/alternative: none needed
- Evidence reference: `package.json` devDependencies
- Owner: project
- Next action: none

### jsdom
- Category: B
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: NONE (test tooling only)
- Data Authority: NOT_APPLICABLE
- Current role: DOM simulation for frontend contract tests
- Approved use: frontend test tooling
- Prohibited/discouraged use: n/a
- Capability/data provided: n/a
- Access/authentication model: n/a
- Cost/quota status: free, open source
- Licensing/data-rights status: not applicable
- Failure/dependency risk: has repeatedly failed in some sandboxes on a module-resolution path mismatch — pre-existing environment issue, not a jsdom defect
- Fallback/alternative: none needed once the install path is reconciled
- Evidence reference: repeated identical failure signature across the OPS task series; `package.json` devDependency
- Owner: project
- Next action: reconcile the resolved install path with the actual project root in the affected environment

### Qodo
- Category: B
- Evidence State: USER_REPORTED
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — no repo evidence of use
- Approved use: TO_VERIFY (plausibly AI code review)
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not integrated
- Fallback/alternative: existing code-review skill and manual review
- Evidence reference: none
- Owner: Enzo
- Next action: clarify intended use before any integration

---

## C. CODE / VERSION CONTROL / CI

### GitHub
- Category: C
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: CRITICAL
- Data Authority: INTERNAL_SYSTEM_TRUTH
- Current role: code and provenance source of truth for XAU V2
- Approved use: all source control, PR review, merge history
- Prohibited/discouraged use: must not be bypassed as the record of what shipped
- Capability/data provided: hosting, pull-request workflow, issue tracking (unused so far)
- Access/authentication model: CLI/OAuth-based authenticated access during agent sessions
- Cost/quota status: TO_VERIFY (plan tier not visible to this registry)
- Licensing/data-rights status: not applicable (own code)
- Failure/dependency risk: low — external dependency for merges, an accepted risk
- Fallback/alternative: none adopted
- Evidence reference: this repository's own commit/PR history (OPS task series)
- Owner: Enzo
- Next action: design a mandatory CI quality gate (§ Verified Technical Gaps; Action Queue)

### GitHub Actions
- Category: C
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: MEDIUM today (one deployment workflow live); intended to become HIGH once a quality gate exists
- Data Authority: NOT_APPLICABLE
- Current role: runs the GitHub Pages deployment workflow (frontend publish, path-scoped, with a pre-publish secret-leak guard step). **`QUALITY_CI_GATE = ABSENT`** — no typecheck/test/lint workflow exists.
- Approved use: current frontend deployment; intended future home for a mandatory quality gate
- Prohibited/discouraged use: must not be assumed to already enforce test/typecheck quality — it does not
- Capability/data provided: CI/CD execution on repository events
- Access/authentication model: repository-scoped, triggered by push/workflow_dispatch
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: the absence of a quality gate means merges rely entirely on manual/agent-run validation today
- Fallback/alternative: manual validation sequence (focused tests, strict typecheck, dry-run deploy) performed per task
- Evidence reference: repository workflow file (Pages deployment)
- Owner: project
- Next action: design a mandatory CI quality gate (Action Queue)

### GitHub Pages
- Category: C
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH
- Data Authority: NOT_APPLICABLE
- Current role: current frontend hosting for XAU V2, deployed via the GitHub Actions workflow above
- Approved use: frontend hosting
- Prohibited/discouraged use: must not be silently replaced by another runtime (e.g. Vercel) without an explicit decision
- Capability/data provided: static hosting
- Access/authentication model: n/a (public static site)
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: TO_VERIFY
- Fallback/alternative: none adopted
- Evidence reference: repository workflow file (Pages deployment)
- Owner: project
- Next action: none

### GitHub (ChatGPT integration)
- Category: C
- Evidence State: CONNECTED_VERIFIED
- Architecture Disposition: APPROVED
- Criticality: NONE directly to the deployed system
- Data Authority: NOT_APPLICABLE
- Current role: connected integration used for architecture/review workflows conducted via ChatGPT
- Approved use: architecture/review workflows
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: TO_VERIFY
- Fallback/alternative: n/a
- Evidence reference: recorded per governance instruction
- Owner: Enzo
- Next action: none

---

## D. DATABASE / STORAGE

### Supabase / PostgreSQL
- Category: D
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: CRITICAL
- Data Authority: INTERNAL_SYSTEM_TRUTH
- Current role: database source of truth for XAU V2 — all persistent state (news, RAW observations, AI analyses, run/lock journal, source registry, market data)
- Approved use: all persistent state
- Prohibited/discouraged use: must not be duplicated by another database (e.g. CockroachDB) without a future explicit architecture decision
- Capability/data provided: managed Postgres with a REST data API and row-level security
- Access/authentication model: service-role credential (backend-only); anon/authenticated roles for any client access
- Cost/quota status: TO_VERIFY (plan tier not visible to this registry)
- Licensing/data-rights status: not applicable (own data)
- Failure/dependency risk: hard dependency for every engine; a per-engine locking mechanism defends against concurrent-run corruption
- Fallback/alternative: none adopted
- Evidence reference: repository migration files; repeatedly proven live via production log observation across the OPS task series
- Owner: Enzo
- Next action: this agent has no direct SQL access in its working environment — only what the deployed system's own code paths expose via logs (a standing operational limitation, not a database issue)

### CockroachDB
- Category: D
- Evidence State: USER_REPORTED
- Architecture Disposition: REJECTED_DUPLICATIVE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — not integrated
- Approved use: none currently
- Prohibited/discouraged use: standing decision — must not be introduced alongside Supabase absent a future explicit decision
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: none unless explicitly revisited

### Prisma
- Category: D
- Evidence State: USER_REPORTED
- Architecture Disposition: REJECTED_UNSUITABLE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — XAU V2 uses raw SQL migrations directly
- Approved use: none currently
- Prohibited/discouraged use: standing decision — must not replace the SQL schema/migrations as source of truth
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: existing SQL migrations + data-API client code
- Evidence reference: none
- Owner: Enzo
- Next action: none unless explicitly revisited

### Supabase ChatGPT integration
- Category: D
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: TO_DECIDE
- Criticality: NONE currently
- Data Authority: NOT_APPLICABLE
- Current role: none — identified connector, not connected
- Approved use: TO_VERIFY
- Prohibited/discouraged use: any future write path must respect the same append-only/idempotency guarantees the backend already enforces — must not become a second, less-guarded write path into production tables
- Capability/data provided: TO_VERIFY (identity known, capability detail not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: unassessed — no decision made
- Fallback/alternative: existing data-API backend code
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: decide whether to connect (Action Queue)

---

## E. RUNTIME / EDGE / DEPLOYMENT

### Cloudflare Workers
- Category: E
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: CRITICAL
- Data Authority: NOT_APPLICABLE
- Current role: selected production backend runtime for XAU V2 — hosts the market, news, and AI-committee engines on scheduled triggers plus a small authenticated HTTP surface
- Approved use: all production backend execution
- Prohibited/discouraged use: must not gain a parallel active runtime (Vercel, Fastly) without an explicit decision; the codebase retains a Vercel-compatible export purely for portability, explicitly documented as never deployed
- Capability/data provided: scheduled execution, HTTP routing, secret storage
- Access/authentication model: account-scoped deploy credential (not detailed here)
- Cost/quota status: **Current account plan: TO_VERIFY.** Repository config evidence: a subrequest-limit setting was configured on the assumption of a paid plan tier at that time — a historical configuration decision, not independent proof of the current billing plan.
- Licensing/data-rights status: not applicable (compute platform)
- Failure/dependency risk: hard production dependency; per-engine locking defends against overlapping runs
- Fallback/alternative: none adopted
- Evidence reference: repository deploy configuration; deployment history and passive health checks across the OPS task series (OPS-017, OPS-021, OPS-022)
- Owner: Enzo
- Next action: independently verify current billing plan if it becomes decision-relevant

### Wrangler
- Category: E
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH operationally (the only deploy mechanism in use)
- Data Authority: NOT_APPLICABLE
- Current role: CLI used for deploys, secret management, deployment history, and log tailing
- Approved use: deploy, dry-run validation, log tailing
- Prohibited/discouraged use: n/a
- Capability/data provided: n/a
- Access/authentication model: account-scoped OAuth credential
- Cost/quota status: free tool (Cloudflare account cost applies, not the tool)
- Licensing/data-rights status: not applicable
- Failure/dependency risk: low
- Fallback/alternative: Cloudflare dashboard (not currently used)
- Evidence reference: `package.json` devDependency; used successfully across the OPS task series
- Owner: project
- Next action: none

### Vercel
- Category: E
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: REJECTED_DUPLICATIVE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none active — the backend retains a Vercel-compatible HTTP export for portability only, explicitly documented as never deployed
- Approved use: none currently
- Prohibited/discouraged use: standing decision — must not become a second active runtime by default
- Capability/data provided: TO_VERIFY (identity known; not evaluated)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not active
- Fallback/alternative: Cloudflare Workers (current runtime)
- Evidence reference: repository deploy configuration comment; dormant export in backend source
- Owner: Enzo
- Next action: none unless explicitly revisited

### Fastly
- Category: E
- Evidence State: USER_REPORTED
- Architecture Disposition: REJECTED_DUPLICATIVE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — not integrated
- Approved use: none currently
- Prohibited/discouraged use: standing decision — must not duplicate Cloudflare by default
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: Cloudflare Workers (current runtime)
- Evidence reference: none
- Owner: Enzo
- Next action: none unless explicitly revisited

---

## F. OBSERVABILITY / SECURITY

### Cloudflare Workers Observability (native)
- Category: F
- Evidence State: CONNECTED_VERIFIED
- Architecture Disposition: CORE
- Criticality: HIGH for operational visibility; not required for the Worker to function
- Data Authority: NOT_APPLICABLE
- Current role: log/trace collection for the deployed Worker, used for read-only production observation
- Approved use: production log observation, debugging, natural-runtime proof capture
- Prohibited/discouraged use: must remain read-only observation; never used to manufacture/trigger events
- Capability/data provided: structured logs and invocation metadata
- Access/authentication model: same account-scoped credential as Cloudflare Workers
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: low
- Fallback/alternative: Cloudflare API polling of deployment/settings/schedule state
- Evidence reference: repository observability configuration; used successfully across the OPS task series
- Owner: Enzo
- Next action: none

### Codex Security
- Category: F
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: NOT_APPLICABLE
- Current role: none — identified connector, not connected
- Approved use: intended future security role per governance model — not yet operational
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY (identity known, capability detail not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: existing security-review skill and manual review
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

### Datadog
- Category: F
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: CANDIDATE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — Cloudflare's native observability is what is actually in use
- Approved use: none currently
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY (identity known, capability detail not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: Cloudflare Workers Observability (current, connected)
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

---

## G. AI / MODEL PROVIDERS

### Anthropic API
- Category: G
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE (for the Committee function specifically)
- Criticality: HIGH for the Committee analysis function; not system-wide CRITICAL — the rest of the system (RAW ingestion, scoring, notification queueing) is explicitly designed to continue without it
- Data Authority: NOT_APPLICABLE
- Current role: powers the AI committee engine (macro/geopolitical/technical analysts, risk committee, portfolio manager)
- Approved use: Committee LLM analysis
- Prohibited/discouraged use: must never be a required dependency for raw ingestion (true by design); **credits must not be restored merely because infrastructure works** — a deliberate, standing decision
- Capability/data provided: LLM inference for the Committee's analysis stages
- Access/authentication model: backend-only API credential
- Cost/quota status: **currently intentionally unavailable for useful Committee inference — the account is in an insufficient-credit / blocked state.** This is a known, observed condition, not a healthy-availability claim. A durable provider circuit-breaker detects this condition and defers further attempts rather than retrying uselessly.
- Licensing/data-rights status: not applicable (API service, not a data-redistribution concern)
- Failure/dependency risk: currently failing on every Committee attempt due to account state; the circuit-breaker design prevents this from cascading into other engines
- Fallback/alternative: none — Committee has no secondary LLM provider; the system correctly degrades (no Committee analysis) rather than failing unsafely
- Evidence reference: OPS-015 (provider circuit design + tests), OPS-018 and OPS-022 (live production observation of the blocked state)
- Owner: Enzo
- Next action: do not restore credits as part of any infrastructure task unless Enzo explicitly requests it as its own decision

### Google AI Pro / Gemini
- Category: G
- Evidence State: USER_REPORTED
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: NOT_APPLICABLE
- Current role: reported as available; not connected to XAU V2's backend
- Approved use: intended future independent architectural challenge / P0-C3 audit role
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none independently obtained — remains USER_REPORTED until exact account capabilities are independently verified
- Owner: Enzo
- Next action: verify exact capabilities available (Action Queue)

### NotebookLM / Gemini Notebook
- Category: G/M
- Evidence State: USER_REPORTED
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none connected to XAU V2
- Approved use: TO_VERIFY (plausibly documentation/knowledge synthesis)
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: none queued this task

---

## H. MARKET DATA

### Twelve Data
- Category: H
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH
- Data Authority: PRIMARY_MARKET
- Current role: market data provider for the market-data engine (XAUUSD)
- Approved use: live market price ingestion
- Prohibited/discouraged use: TO_VERIFY beyond current ingestion use
- Capability/data provided: XAUUSD quote data
- Access/authentication model: backend-only API credential
- Cost/quota status: TO_VERIFY (a prior free-tier quota is referenced in repo config comments as historical context for the ingestion cadence chosen; current plan tier is not independently confirmed)
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: TO_VERIFY (retry/fallback behavior not independently re-verified)
- Fallback/alternative: TO_VERIFY
- Evidence reference: backend-only API credential present in the deployed runtime's configuration; cadence-justification comments in repository deploy configuration
- Owner: Enzo
- Next action: none

### Massive
- Category: H
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: none — identified connector, not connected
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY (identity known as a connector-directory entry, exact market-data product scope not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

---

## I. MACRO / OFFICIAL DATA

### FRED (Federal Reserve Economic Data)
- Category: I
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: MEDIUM
- Data Authority: PRIMARY_OFFICIAL
- Current role: macro data source (real yields, rates) for market context
- Approved use: macro data ingestion
- Prohibited/discouraged use: must not be treated as a single blanket public-domain grant — see rights note below
- Capability/data provided: FRED series data, delivered via the Federal Reserve Bank of St. Louis's API/service
- Access/authentication model: backend-only API credential
- Cost/quota status: free API access to the FRED service itself; TO_VERIFY whether any per-series or aggregate quota applies to current usage
- Licensing/data-rights status: **institutional distinction, not a single blanket right.** The FRED API/service is operated by the Federal Reserve Bank of St. Louis, but individual FRED series are sourced from many original providers, some of which retain third-party ownership/copyright over that series' data even when redistributed through FRED. Storage, derived use, redistribution, commercial use, and attribution must be verified **per series/provider** where relevant, per the FRED API Terms of Use. This registry does not assert a favorable licensing conclusion for any series currently ingested by XAU V2 — current XAU V2 series rights = TO_VERIFY unless independently proven. See § Data Rights and Licensing.
- Failure/dependency risk: TO_VERIFY
- Fallback/alternative: TO_VERIFY
- Evidence reference: backend-only API credential present in the deployed runtime's configuration; official FRED API Terms of Use (not independently re-read this review — cited as the authority to check, not as a confirmed-favorable source)
- Owner: Enzo
- Next action: verify per-series data rights for whichever FRED series XAU V2 actually ingests

### BLS — Bureau of Labor Statistics (candidate)
- Category: I
- Evidence State: TO_VERIFY
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: PRIMARY_OFFICIAL
- Current role: not integrated
- Approved use: none currently — candidate role is official labor/inflation releases relevant to CPI, employment/NFP, and other US macro-event truth
- Prohibited/discouraged use: n/a — nothing connected to restrict; no API entitlement, quota, or licensing claim is made unless verified
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none — candidate only, not evaluated
- Owner: Enzo
- Next action: evaluate as a future official macro-event source; not implemented by this task

### BEA — Bureau of Economic Analysis (candidate)
- Category: I
- Evidence State: TO_VERIFY
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: PRIMARY_OFFICIAL
- Current role: not integrated
- Approved use: none currently — candidate role is official US economic releases relevant to PCE, GDP, and related macro-event truth
- Prohibited/discouraged use: n/a — nothing connected to restrict; no API entitlement, quota, or licensing claim is made unless verified
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none — candidate only, not evaluated
- Owner: Enzo
- Next action: evaluate as a future official macro-event source; not implemented by this task

### Federal Reserve (official RAW source)
- Category: I
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: MEDIUM today (archival only, not yet decision-critical)
- Data Authority: PRIMARY_OFFICIAL
- Current role: official RAW news collector — press-release and speech feeds, single attempt, no retry, by deliberate design
- Approved use: RAW archival ingestion
- Prohibited/discouraged use: must not bypass the append-only RAW storage layer
- Capability/data provided: press releases, speech transcripts
- Access/authentication model: none required (public feeds)
- Cost/quota status: free, public
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: low — isolated failure domain, no retry amplification, non-blocking of the rest of the ingestion cycle
- Fallback/alternative: n/a (primary source for its own authority)
- Evidence reference: repository source files; live behavior confirmed across OPS-018 and OPS-022
- Owner: Enzo (data is public; the integration is project-owned)
- Next action: candidate first source for a future event-clustering pipeline (OPS-023); RAW → cluster/version pipeline not yet implemented

### ECB (official RAW source)
- Category: I
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: MEDIUM today
- Data Authority: PRIMARY_OFFICIAL
- Current role: official RAW news collector — press and statistical press feeds, single attempt, no retry
- Approved use: RAW archival ingestion
- Prohibited/discouraged use: must not bypass the append-only RAW storage layer
- Capability/data provided: ECB press releases, statistical press releases
- Access/authentication model: none required (public feeds)
- Cost/quota status: free, public
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: low, same isolation pattern as Federal Reserve above
- Fallback/alternative: n/a
- Evidence reference: repository source files; live behavior confirmed across OPS-018 and OPS-022
- Owner: Enzo
- Next action: RAW → cluster/version pipeline not yet implemented

### US Treasury (official RAW source)
- Category: I
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: MEDIUM today
- Data Authority: PRIMARY_OFFICIAL
- Current role: official RAW news collector — press-releases page, single attempt, no retry
- Approved use: RAW archival ingestion
- Prohibited/discouraged use: must not bypass the append-only RAW storage layer
- Capability/data provided: Treasury press releases
- Access/authentication model: none required (public page)
- Cost/quota status: free, public
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: low, same isolation pattern
- Fallback/alternative: n/a
- Evidence reference: repository source files; live behavior confirmed across OPS-018 and OPS-022
- Owner: Enzo
- Next action: RAW → cluster/version pipeline not yet implemented

### OFAC (official RAW source)
- Category: I
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED
- Criticality: MEDIUM today
- Data Authority: PRIMARY_OFFICIAL
- Current role: official RAW news collector — sanctions-actions page, single attempt, no retry
- Approved use: RAW archival ingestion
- Prohibited/discouraged use: must not bypass the append-only RAW storage layer
- Capability/data provided: OFAC sanctions actions
- Access/authentication model: none required (public page)
- Cost/quota status: free, public
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: low, same isolation pattern
- Fallback/alternative: n/a
- Evidence reference: repository source files; own source-registry entry; live behavior confirmed across OPS-018 and OPS-022
- Owner: Enzo
- Next action: identified (OPS-023) as the recommended first slice for a future event-clustering pipeline (smallest volume, cleanest canonical matching); RAW → cluster/version pipeline not yet implemented

---

## J. NEWS / RESEARCH

### GDELT
- Category: J
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED — explicitly **best-effort**, not a guaranteed dependency
- Criticality: MEDIUM
- Data Authority: SECONDARY_VALIDATION
- Current role: legacy scored-pipeline news collector; feeds the notification pipeline directly, alongside NewsAPI
- Approved use: broad keyword gold/macro/geopolitical news sweep
- Prohibited/discouraged use: must not be treated as guaranteed-available; must not be retried aggressively against its per-IP rate limit
- Capability/data provided: article discovery (title/URL/domain/timestamp; no article body)
- Access/authentication model: none required (no API key)
- Cost/quota status: free, but subject to an undocumented-exact per-IP rate limit, observed live more than once
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: by design never blocks the rest of the ingestion cycle; an in-cycle retry-storm against the rate limit was specifically hardened away (OPS-020)
- Fallback/alternative: NewsAPI (partial — narrower query); the official RAW sources do not feed the same pipeline, so are not a functional substitute (OPS-019)
- Evidence reference: OPS-019 (coverage audit), OPS-020 (hardening + tests), OPS-018/OPS-022 (live confirmation)
- Owner: project (public API, no account)
- Next action: none pending — the OPS-019 gap was addressed by OPS-020

### NewsAPI
- Category: J
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: APPROVED, with a known licensing caveat that must not be hidden
- Criticality: HIGH (currently the more reliably-succeeding of the two legacy sources)
- Data Authority: SECONDARY_VALIDATION
- Current role: legacy scored-pipeline news collector, narrower query than GDELT (requires an explicit gold/bullion/XAUUSD term)
- Approved use: gold/macro news search
- Prohibited/discouraged use: **plan/data-rights status is TO_VERIFY** — this repository's own code contains a comment describing free-plan content-truncation behavior, evidence that free-plan behavior was specifically coded for, but this registry does not confirm the exact current account plan/tier either way. No production-scale or commercial claim should be made about this data path until verified.
- Capability/data provided: article title, description, truncated body, source, URL, publish time
- Access/authentication model: backend-only API credential; collector degrades cleanly if absent
- Cost/quota status: TO_VERIFY — see Prohibited/discouraged use above
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing (flagged risk: NewsAPI's publicly documented free "Developer" plan restricts production/commercial use)
- Failure/dependency risk: its query is structurally narrower than GDELT's (OPS-019 finding), so it cannot fully substitute for GDELT during an outage
- Fallback/alternative: GDELT (broader net); no other legacy-pipeline source exists
- Evidence reference: repository source code comment (free-plan content truncation); OPS-019 audit; live confirmation OPS-018/OPS-022
- Owner: Enzo
- Next action: verify actual NewsAPI account plan/tier before any production-scale or commercial claim is made about this data path

### Bigdata.com
- Category: J
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: CANDIDATE
- Criticality: NONE
- Data Authority: RESEARCH
- Current role: none — identified connector, not connected
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY (identity known, capability detail not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

### LSEG (London Stock Exchange Group / Refinitiv)
- Category: J
- Evidence State: USER_REPORTED
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: RESEARCH
- Current role: none — not integrated
- Approved use: none currently — potential future professional research source, only if entitlement is verified
- Prohibited/discouraged use: must not be used commercially/redistributed without confirmed entitlement
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY — no subscription tier or entitlement is asserted or assumed
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: official primary sources (Fed/ECB/Treasury/OFAC), already integrated
- Evidence reference: none
- Owner: Enzo
- Next action: verify entitlement/API/data rights (Action Queue)

### S&P Global
- Category: J
- Evidence State: USER_REPORTED
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: RESEARCH
- Current role: none — not integrated
- Approved use: none currently — same potential future role as LSEG
- Prohibited/discouraged use: must not be used commercially/redistributed without confirmed entitlement
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: official primary sources, already integrated
- Evidence reference: none
- Owner: Enzo
- Next action: verify entitlement/API/data rights (Action Queue)

### Public Equity Investing
- Category: J
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: none — identified connector, not connected
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY (identity known as a connector-directory entry, exact financial-research product scope not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

---

## K. GOLD-SPECIFIC / POSITIONING

No resource in this category is currently connected — an open gap
requiring evaluation, not a decision already made.

### CME / COMEX (future gold-positioning source)
- Category: K
- Evidence State: TO_VERIFY
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: TO_VERIFY (would plausibly be PRIMARY_MARKET for GC/MGC futures/options market structure, not asserted as fact)
- Current role: none — not integrated, not yet designed
- Approved use: none currently
- Prohibited/discouraged use: n/a — nothing connected to restrict
- Capability/data provided: TO_VERIFY — candidate role is GC/MGC gold futures/options market structure, volume, open interest, and settlements/derivatives-market information where licensed. **CME is not the primary authority for Commitments of Traders (COT) positioning data** — CFTC is (see its own entry below); CME may expose tools built from CFTC COT data, but is not the original authority for that dataset.
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none — named because a future gold-positioning capability is anticipated, not because any access exists
- Owner: Enzo
- Next action: evaluate future value/licensing separately, when gold-positioning analysis becomes a stated goal

### CFTC — Commitments of Traders (future gold-positioning source)
- Category: K
- Evidence State: TO_VERIFY
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: PRIMARY_OFFICIAL
- Current role: none — not integrated
- Approved use: none currently — potential future approved use is official Gold/COMEX positioning, including trader-category positioning and open-interest context, sourced from the Commitments of Traders (COT) report
- Prohibited/discouraged use: n/a — nothing connected to restrict
- Capability/data provided: TO_VERIFY. **The CFTC is the source authority for Commitments of Traders data** — this is distinct from CME/COMEX above, which is a market-structure/futures venue and not the original authority for COT positioning even where it exposes tools built on CFTC COT data.
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing; all rights TO_VERIFY until official terms are evaluated
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none — named because a future gold-positioning capability is anticipated, not because any access exists
- Owner: Enzo
- Next action: evaluate future value/licensing separately, when gold-positioning analysis becomes a stated goal

### LBMA (future gold-positioning source)
- Category: K
- Evidence State: TO_VERIFY
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: TO_VERIFY (would plausibly be PRIMARY_MARKET for the gold price benchmark, not asserted as fact)
- Current role: none — not integrated, not yet designed
- Approved use: none currently
- Prohibited/discouraged use: n/a
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: evaluate future value/licensing separately

### WGC (future gold-positioning source)
- Category: K
- Evidence State: TO_VERIFY
- Architecture Disposition: CANDIDATE
- Criticality: NONE currently
- Data Authority: TO_VERIFY (would plausibly be RESEARCH for flows/holdings data, not asserted as fact)
- Current role: none — not integrated, not yet designed
- Approved use: none currently
- Prohibited/discouraged use: n/a
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY — see § Data Rights and Licensing
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: evaluate future value/licensing separately

**Silver's Edge remains `DEFERRED`** (Architecture Disposition) — see
§ Standing Architectural Decisions. This is the only Architecture
Disposition = DEFERRED resource in this registry; CME/LBMA/WGC above are
`CANDIDATE`, not `DEFERRED`, because no decision has actually deferred
them.

---

## L. QUANT / VALIDATION / BACKTEST

Python and AJV (Category B) are the only established resources currently
serving a validation role. No dedicated backtest engine or
reproducible-dataset pipeline exists yet — an open gap, not a queued
action this task.

### Data
- Category: L
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: none — identified connector, not connected
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY (identity known as a connector-directory entry, exact quant/analytics product scope not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

---

## M. DOCUMENTATION / KNOWLEDGE

### Context7
- Category: M
- Evidence State: AVAILABLE_TO_CONNECT
- Architecture Disposition: CANDIDATE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — identified connector, not connected
- Approved use: potential future library/API documentation lookup
- Prohibited/discouraged use: must not replace official vendor documentation as the primary source
- Capability/data provided: TO_VERIFY (identity known, capability detail not verified)
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable (documentation retrieval tool)
- Failure/dependency risk: none — not connected
- Fallback/alternative: official vendor documentation directly
- Evidence reference: connector directory listing (identity confirmed)
- Owner: Enzo
- Next action: none queued this task

### DEPLOYMENT_RUNBOOK.md (internal)
- Category: M
- Evidence State: PROJECT_IN_USE
- Architecture Disposition: CORE
- Criticality: HIGH operationally
- Data Authority: INTERNAL_SYSTEM_TRUTH
- Current role: this repo's own operational runbook — migration procedure, post-migration control queries, deployment notes
- Approved use: source of truth for manual operational procedures not yet automated
- Prohibited/discouraged use: must be kept current as procedures change
- Capability/data provided: n/a
- Access/authentication model: n/a (repo file)
- Cost/quota status: n/a
- Licensing/data-rights status: not applicable (internal document)
- Failure/dependency risk: goes stale if not updated alongside process changes
- Fallback/alternative: n/a
- Evidence reference: repo file; confirmed the production-migration procedure is manual — directly informed a BLOCKED task determination in the OPS task series when no automated path existed
- Owner: Enzo
- Next action: none this task

---

## N. AVAILABLE BUT NOT RECOMMENDED

Cross-referenced for visibility; full canonical entries live under their
primary category above — this section is a summary index only, not a
second set of fields.

| Resource | Evidence State | Architecture Disposition | Why |
|---|---|---|---|
| Vercel | AVAILABLE_TO_CONNECT | REJECTED_DUPLICATIVE | second active runtime |
| Fastly | USER_REPORTED | REJECTED_DUPLICATIVE | Cloudflare duplicate |
| CockroachDB | USER_REPORTED | REJECTED_DUPLICATIVE | Supabase duplicate, absent future decision |
| Prisma | USER_REPORTED | REJECTED_UNSUITABLE | schema-source-of-truth replacement |

---

## O. UNKNOWN / NEEDS VERIFICATION

Product identity is **genuinely unconfirmed** for the following — this
registry does not guess. Each remains `USER_REPORTED` with
`IDENTITY_TO_VERIFY`.

### Dalo
- Category: O
- Evidence State: USER_REPORTED, IDENTITY_TO_VERIFY
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: unknown
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: identify precisely (Action Queue)

### Engineering
- Category: O
- Evidence State: USER_REPORTED, IDENTITY_TO_VERIFY
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: unknown — could denote a connector, a workspace label, or something else
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: identify precisely (Action Queue)

### Finance
- Category: O
- Evidence State: USER_REPORTED, IDENTITY_TO_VERIFY
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: unknown
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: identify precisely (Action Queue)

### Testing
- Category: O
- Evidence State: USER_REPORTED, IDENTITY_TO_VERIFY
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: TO_VERIFY
- Current role: unknown
- Approved use: TO_VERIFY
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: TO_VERIFY
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: identify precisely (Action Queue)

Product identity is **not in question** for the following — they remain
`USER_REPORTED` without an identity flag; what is unverified is any
XAU V2 role or connection, not what the product is.

### Unity
- Category: O
- Evidence State: USER_REPORTED
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — no established role in XAU V2
- Approved use: none currently
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: clarify purpose before any evaluation

### Zoom
- Category: O
- Evidence State: USER_REPORTED
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — no established role in XAU V2
- Approved use: none currently
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: clarify purpose before any evaluation

### Sanity
- Category: O
- Evidence State: USER_REPORTED
- Architecture Disposition: TO_DECIDE
- Criticality: NONE
- Data Authority: NOT_APPLICABLE
- Current role: none — no established role in XAU V2
- Approved use: none currently
- Prohibited/discouraged use: TO_VERIFY
- Capability/data provided: TO_VERIFY
- Access/authentication model: TO_VERIFY
- Cost/quota status: TO_VERIFY
- Licensing/data-rights status: not applicable
- Failure/dependency risk: none — not connected
- Fallback/alternative: n/a
- Evidence reference: none
- Owner: Enzo
- Next action: clarify purpose before any evaluation

---

## Data Rights and Licensing

For any market/news/research source that may be stored, redistributed,
shown in the frontend, used commercially, or persisted historically, this
registry tracks the following rights explicitly. `TO_VERIFY` is used
wherever a right is unknown — none is invented or assumed favorable. No
commercial-use or redistribution conclusion is drawn without official
evidence; no plan tier or quota is assumed unless verified.

| Source | Ingestion right | Storage right | Derived-data right | Redistribution/display right | Commercial-use right | Attribution requirement | Retention restriction | Evidence source | Evidence date |
|---|---|---|---|---|---|---|---|---|---|
| LSEG | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none checked | — |
| S&P Global | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none checked | — |
| Bigdata.com | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none checked | — |
| Twelve Data | TO_VERIFY | currently stored (market-data table) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | repo schema (storage fact only) | this review |
| NewsAPI | TO_VERIFY | currently stored (legacy news table) | TO_VERIFY | TO_VERIFY — flagged risk: NewsAPI's public Developer-plan terms restrict production/commercial redistribution; not resolved here | TO_VERIFY | TO_VERIFY | TO_VERIFY | repo code comment (free-plan behavior); NewsAPI's own public plan terms not independently re-read this review | this review |
| GDELT | TO_VERIFY (public API, no key) | currently stored (legacy news table) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | repo schema (storage fact only) | this review |
| FRED | TO_VERIFY — per-series, not a blanket right (FRED aggregates many original providers; some series retain third-party ownership/copyright even when served through FRED) | currently stored (macro data, not persisted verbatim historically at this time) | TO_VERIFY per series | TO_VERIFY per series | TO_VERIFY per series | TO_VERIFY per series | TO_VERIFY | official FRED API Terms of Use (not independently re-read this review — cited as the authority to check) | this review |
| Federal Reserve | TO_VERIFY | currently stored (RAW table, append-only) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | append-only, never deleted/updated by design — effectively indefinite absent a future policy | repo schema (storage fact only) | this review |
| ECB | TO_VERIFY | currently stored (RAW table) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | same as above | repo schema | this review |
| US Treasury | TO_VERIFY | currently stored (RAW table) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | same as above | repo schema | this review |
| OFAC | TO_VERIFY | currently stored (RAW table) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | same as above | repo schema | this review |
| BLS (candidate) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none — not yet evaluated | — |
| BEA (candidate) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none — not yet evaluated | — |
| Future CME/COMEX | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none — not yet evaluated | — |
| Future CFTC (Commitments of Traders) | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none — not yet evaluated; CFTC is the source authority for COT data, distinct from CME/COMEX | — |
| Future LBMA | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none — not yet evaluated | — |
| Future WGC | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | TO_VERIFY | none — not yet evaluated | — |

"Currently stored" reflects only the observable fact that this repo's own
schema persists that provider's output in a named table — it is not a
licensing conclusion. Every other cell is a genuine unknown.

---

## Target Orchestration Model

| Function | Assigned to |
|---|---|
| Architecture / arbitration | ChatGPT |
| Implementation | Claude Code |
| Independent architectural challenge | Gemini, when appropriate |
| Code truth | GitHub |
| Database truth | Supabase / PostgreSQL |
| Runtime truth | Cloudflare |
| Technical documentation truth | official vendor documentation / Context7 where useful |
| Security | Codex Security + deterministic checks |
| Quantitative validation | Python + reproducible datasets |
| Financial research | official primary sources first, then licensed/professional research sources only if entitlement is verified |

**Standing rule:** no single LLM may be both sole designer, sole
implementer, and sole verifier of a critical production change (§ XAU V2
Governance Model, item 12).

---

## Standing Architectural Decisions

1. ChatGPT = architecture / orchestration / independent review
2. Claude Code = implementation writer
3. GitHub = code/provenance source of truth
4. Supabase/PostgreSQL = database source of truth
5. Cloudflare Workers = production backend runtime
6. GitHub Pages = current frontend hosting
7. No direct LLM → broker execution
8. Deterministic fallback required around AI (proven: the Anthropic provider circuit, the GDELT retry hardening)
9. AI must not be required for raw ingestion (proven: RAW/legacy collectors are all non-blocking on Anthropic/GDELT failure)
10. Silver's Edge deferred until Gold is stable
11. Prisma must not replace the SQL schema as source of truth
12. CockroachDB must not be introduced alongside Supabase without a future explicit architecture decision
13. Fastly must not duplicate Cloudflare by default
14. Vercel must not become a second active runtime by default
15. Anthropic credits must not be restored merely because infrastructure works

These are standing decisions, not defaults to be silently revisited.

---

## Verified Technical Gaps

- No root `tsconfig.json` exists in this repository.
- `package.json`'s `typecheck` script is exactly `tsc --noEmit`.
- Because no `tsconfig.json` configures `tsc`, the current `npm run
  typecheck` script is not a reliable mandatory CI gate until this
  configuration is fixed.
- A GitHub Actions deployment workflow exists (frontend → GitHub Pages).
- A mandatory quality CI gate is absent — no typecheck/test/lint workflow
  exists.
- A staging architecture/environment is not yet established.
- The official RAW → event-cluster/event-version pipeline is not yet
  implemented (RAW ingestion for Fed/ECB/Treasury/OFAC stops at storage
  today; OPS-023 is the architecture audit for the next stage, not an
  implementation).

---

## Priority / Criticality Summary

Criticality and Architecture Disposition are tracked per-resource above;
this section is a cross-reference, not an additional independent scale.

**CRITICAL:** GitHub, Supabase/PostgreSQL, Cloudflare Workers

**HIGH:** Wrangler, GitHub Pages, ChatGPT, Claude Code (during active
sessions), Twelve Data, Cloudflare Workers Observability, Anthropic API
(for the Committee function specifically, not system-wide), NewsAPI

**MEDIUM:** GitHub Actions (current deploy role; intended to rise once a
quality gate exists), FRED, GDELT, Federal Reserve / ECB / US Treasury /
OFAC (archival today)

**DEFERRED (Architecture Disposition):** Silver's Edge

**REJECTED_DUPLICATIVE / REJECTED_UNSUITABLE:** Vercel, Fastly,
CockroachDB, Prisma

**CANDIDATE (not yet decided):** Gemini/Google AI Pro, Context7, Codex
Security, Datadog, Bigdata.com, LSEG, S&P Global, CME/COMEX, CFTC, LBMA,
WGC, BLS, BEA

Everything else in this registry remains `TO_DECIDE` or `TO_VERIFY` on
one or more axes — assigning a firmer classification to an unverified or
unidentified resource would itself be an invented judgment, which this
registry does not do.

---

## Near-Term Action Queue

Ordered; none of these actions is performed by this task. Reflects the
latest validated project decision on sequencing: Resource Registry →
Daily Operating Model → OPS-023 implementation planning.

1. Verify exact Google AI Pro / Gemini capabilities available to Enzo
2. Verify LSEG entitlement / API / data rights
3. Verify S&P Global entitlement / API / data rights
4. Identify Dalo precisely
5. Identify Engineering / Finance / Testing resources precisely
6. Decide whether to connect Remote Desktop Commander
7. Decide whether to connect the Supabase ChatGPT integration
8. Design a mandatory GitHub Actions CI quality gate (fixing the missing
   `tsconfig.json` is a prerequisite)
9. Design a staging architecture
10. **Create `docs/XAU_V2_DAILY_OPERATING_MODEL.md`** — defines how the
    production terminal operates every day, end to end: data sources →
    quality/freshness → RAW observation → event cluster → event version
    → novelty/confirmation/correction/reversal → event impact → gold
    transmission → market pricing/positioning/regime → H1-H5 → AI
    committee → portfolio manager → risk committee → abstention/action
    → command center → alerts/audit trail. Documentation/architecture
    only — **not created by this task.**
11. Resume the RAW event-clustering architecture work (OPS-023
    implementation planning) only after the Daily Operating Model above
    exists — not before it
