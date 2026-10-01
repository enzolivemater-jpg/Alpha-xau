# XAU V2 — institutional completion board

Status: `LIVE BOARD — RECONCILED 2026-10-01T07:46Z`

Main SHA: `a4be93e89374a3809527dce7dd6b3160fabbd325`  
Production: `ejvwmjgfvhsslqiydwpz` — `ACTIVE_HEALTHY`, PostgreSQL 17.6  
Live migration tail: `20260923133811 gold_transmission_atomic_rpc`  
Open pull requests: none  
Production Edge Functions: none

Statuses mean only the strongest evidence actually obtained. `COMPLETE` is
reserved for a component that has reached its required production evidence,
not merely for merged code.

| Milestone | Status | Blocking dependency | Human Gate | Evidence | Next action | Estimated remaining engineering effort* |
| --- | --- | --- | --- | --- | --- | --- |
| Event Foundation | COMPLETE | None | No | Production schema/RPC history through 0021; prior live proofs | Regression maintenance only | <0.5 day |
| Official-source provenance | CI_PROVEN | Bounded live BLS fetch/capture not activated | Yes, runtime | EF-2/EF-5A/EF-5B contracts and fixtures | One-item live capture after schema/runtime gates | 1–2 days |
| Event Facts CES V2 | STAGING_PROVEN | Recovery gate; migrations 0029–0032 | Yes, schema | EF-12 hosted PG17.11 proof; EF-13 packet | Execute REC-1, then separately authorize schema rollout | 1–2 days after gate |
| Event Impact V1 | LIVE_PROVEN | None | No | Prior 45-version/3-assessment proof and exact replay | Preserve while V2 remains gated | <0.5 day |
| Event Impact V2 technical path | CI_PROVEN | CES V2 live facts; consensus policy | Yes, provider/semantic | EF-4 deterministic consumer proof | Keep insufficiency output until consensus is authorized | 1–3 days after inputs |
| Gold Transmission persistence | PROD_SCHEMA_READY | Worker route not deployed | Yes, runtime | GT schema/RPC live; rollback proof; 3 historical assessments | Deploy only bounded manual route after access/authority | 1–2 days after access |
| Gold Transmission V2 semantics | CI_PROVEN | Typed facts and authorized transmission evidence/consensus | Yes, semantic | EF-4/GT deterministic zero-path proof | Design positive paths only after evidence source is approved | 3–7 days after decision |
| Consensus policy/provider | NOT_STARTED | Auditable source, licensing, timestamp and revision policy | Yes, provider/cost | Canonical state remains `UNKNOWN`; no provider authorized | Prepare provider comparison; do not integrate or purchase yet | 1–3 days contract + provider work |
| Recovery readiness | CI_PROVEN | Named operator, target choice, encrypted off-site location | Yes, recovery | REC-1 PR #62; PG17 fail-closed manifest proof | Approve and execute isolated restore rehearsal | 1–2 operator hours |
| Security SB-1 | CI_PROVEN | Independent production authorization | Yes, schema | Migration 0033; PostgreSQL 17 proof | Apply/re-audit only after scoped approval | 1–2 operator hours |
| Security SB-2 | CI_PROVEN | Independent production authorization | Yes, schema | Migration 0034; PostgreSQL 17 proof | Apply/re-audit only after scoped approval | 1 operator hour |
| Cloudflare bounded runtime | CODE_COMPLETE | Dashboard/token access; deployment authority | Yes, runtime | Manual GT/Event Facts paths in source; deployment not proven | Freeze deploy packet and execute when access exists | 0.5–1 day after access |
| Market Pricing institutional contract | NOT_STARTED | Current market-engine reconciliation | No for audit | Legacy/native market-driver code exists; no V2 acceptance packet | Audit contract, freshness, provenance, replay, failure modes | 2–4 days |
| Positioning institutional contract | NOT_STARTED | Source/provider decision | Possibly provider | No accepted V2 evidence | Freeze provider-independent contract first | 2–4 days plus provider |
| Regime institutional contract | NOT_STARTED | Market Pricing/Positioning contracts | No for contract | Legacy AI fields are not V2 acceptance evidence | Freeze deterministic inputs/abstention contract | 2–4 days |
| H1–H5 synthesis | NOT_STARTED | Event Facts/EI/GT/Market/Regime | Yes for semantic activation | Legacy horizon schema only | Freeze versioned input/output and cutoff semantics | 3–6 days |
| AI Committee | CODE_COMPLETE | V2 horizon inputs; live provider access | Yes, cost/runtime | Existing committee contracts/tests; not V2 end-to-end | Reconcile and version V2 committee envelope | 2–4 days |
| Pre-PM evidence/risk | NOT_STARTED | Committee and deterministic evidence graph | No for contract | None accepted | Define evidence, uncertainty, freshness and abstention contract | 2–4 days |
| Portfolio Manager | NOT_STARTED | Pre-PM contract; portfolio/risk policy | Yes, frozen risk policy | None accepted | Freeze recommendation-only PM contract | 3–6 days |
| Final Action Risk | NOT_STARTED | PM plus broker/risk constraints | Yes, risk policy | Existing SL/risk rules are not encoded acceptance proof | Encode hard vetoes and bounded sizing contract | 3–5 days |
| Action / Abstention | NOT_STARTED | Final Action Risk | Yes before any execution | No broker execution authorized | Build advisory-only result first; execution remains forbidden | 2–4 days |
| Command Center / Scenario Tree | NOT_STARTED | Stable upstream envelopes | No for read-only UI | Existing terminal is not V2 acceptance evidence | Build after contracts stabilize | 4–8 days |
| Alerts | NOT_STARTED | Action/abstention and notification policy | Yes before automated delivery | Legacy alerts schema only | Define dedupe, horizon, escalation and acknowledgement | 2–4 days |
| Full observability / incident response | CODE_COMPLETE | Live runtime identifiers and deploy access | No for repo work | Operation ledgers/run locks exist in several stages | Unify correlation/version/runbook contract | 3–6 days |
| End-to-end institutional acceptance | NOT_STARTED | Every upstream milestone | Yes, production | No end-to-end live proof | Execute bounded golden path, replay, failure and recovery proof | 2–4 days after all gates |

\* Effort ranges are engineering estimates, not completion facts. They exclude
waiting for Human Gates, provider procurement, access recovery, and observation
windows for scheduled economic releases.

## Critical path now

1. Authorize and execute REC-1 with a named operator and isolated target.
2. Separately authorize Event Facts schema migrations 0029–0032 while runtime
   remains off.
3. Optionally authorize SB-1/SB-2 (0033/0034) as independent payloads.
4. Obtain Cloudflare deployment access and authorize one bounded manual caller.
5. Prove one live official bundle, atomic persistence, exact replay, downstream
   insufficiency, readback, logs, and containment.
6. Freeze the next provider-independent contracts while consensus stays
   `UNKNOWN`.

## Current hard stops

- No current restorable backup or successful isolated restore rehearsal.
- No named recovery operator or approved encrypted off-site location.
- No authorization to apply migrations 0029–0034.
- No Cloudflare deployment proof or runtime authority.
- No authorized consensus provider; positive EI/GT semantic inference remains
  forbidden.
- No trading or broker execution authority.

## Reconciliation rule

Before every external mutation, repeat GitHub main/PR/CI, Supabase project and
migration history, target objects, runtime inventory, and the relevant
authorization record. Real state supersedes this board.
