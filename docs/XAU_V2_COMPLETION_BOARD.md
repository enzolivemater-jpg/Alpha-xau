# XAU V2 — institutional completion board

Status: `LIVE BOARD — RECONCILED 2026-10-08T15:08Z`

Main evidence reconciled through PR #92 / `2e89f7c64540de51475a41bb1a2324d2aab6ead3`
Production: `ejvwmjgfvhsslqiydwpz` — `ACTIVE_HEALTHY`, PostgreSQL 17.6  
Live migration tail: `20260923133811 gold_transmission_atomic_rpc`  
Open pull requests: none  
Main Quality Gate: run `37797009275` — `success` (10/10 jobs)
Production Edge Functions: none

Statuses mean only the strongest evidence actually obtained. `COMPLETE` is
reserved for a component that has reached its required production evidence,
not merely for merged code.

| Milestone | Status | Blocking dependency | Human Gate | Evidence | Next action | Estimated remaining engineering effort* |
| --- | --- | --- | --- | --- | --- | --- |
| Event Foundation | COMPLETE | None | No | Production schema/RPC history through 0021; prior live proofs | Regression maintenance only | <0.5 day |
| Official-source provenance | CI_PROVEN | Bounded live official-artifact capture not activated; BLS July AHE release-vintage percentage evidence unresolved | Yes, runtime + NFP source-method decision | CPI path; pure BLS NFP adapter; raw DOL archive PDF + bounded decoder + claims parser/adapter; pure BEA PCE adapter; exact fixture hashes; conservative CPI/NFP/claims/PCE consumers; 75/75 local suites; PR #93 run `37798129022` | Resolve NFP AHE evidence without inference; keep live capture behind runtime/deployment authority | 1–2 days plus source decision |
| Event Facts CES V2 | STAGING_PROVEN | Recovery gate; migrations 0029–0032 | Yes, schema | EF-12 hosted PG17.11 proof; EF-13 packet | Execute REC-1, then separately authorize schema rollout | 1–2 days after gate |
| Event Impact V1 | LIVE_PROVEN | None | No | Prior 45-version/3-assessment proof and exact replay | Preserve while V2 remains gated | <0.5 day |
| Event Impact V2 technical path | CI_PROVEN | CES V2 live facts; consensus policy | Yes, provider/semantic | Versioned deterministic consumer admits exact CPI/NFP/jobless-claims/PCE typed facts but preserves zero-interpretation insufficiency | Keep insufficiency output until consensus and positive methodology are authorized | 1–3 days after inputs |
| Gold Transmission persistence | PROD_SCHEMA_READY | Worker route not deployed | Yes, runtime | GT schema/RPC live; rollback proof; 3 historical assessments | Deploy only bounded manual route after access/authority | 1–2 days after access |
| Gold Transmission V2 semantics | CI_PROVEN | Typed facts and authorized transmission evidence/consensus | Yes, semantic | Versioned CPI/NFP/jobless-claims/PCE validation with deterministic zero-path proof and `CONSENSUS_FACTS_UNAVAILABLE` | Design positive paths only after evidence source and methodology are approved | 3–7 days after decision |
| Consensus policy/provider | NOT_STARTED | Auditable source, licensing, timestamp and revision policy | Yes, provider/cost | Canonical state remains `UNKNOWN`; no provider authorized | Prepare provider comparison; do not integrate or purchase yet | 1–3 days contract + provider work |
| Recovery readiness | CI_PROVEN | Named operator, target choice, encrypted off-site location | Yes, recovery | REC-1 PR #62; PG17 fail-closed manifest proof | Approve and execute isolated restore rehearsal | 1–2 operator hours |
| Security SB-1 | CI_PROVEN | Independent production authorization | Yes, schema | Migration 0033; PostgreSQL 17 proof | Apply/re-audit only after scoped approval | 1–2 operator hours |
| Security SB-2 | CI_PROVEN | Independent production authorization | Yes, schema | Migration 0034; PostgreSQL 17 proof | Apply/re-audit only after scoped approval | 1 operator hour |
| Security SB-3 | CI_PROVEN | Independent production authorization; managed `supabase_admin` default-ACL disposition | Yes, schema | Corrected migration `20261008094133`, hash `ac67440e...`; all future table/sequence privileges revoked; PostgreSQL 17 proof; PR #92 run `37796386665` | Resolve managed-role disposition, then apply/re-audit only after scoped approval | 1–2 operator hours |
| Security SB-4 | CI_PROVEN | None | No | Post-SB-3 migration linter; positive/negative SQL corpus; 73/73 local suites; PR #91 run `37794267054` | Preserve explicit object ACLs and timestamp ordering in every future migration | Maintenance only |
| Security SB-5 | CI_PROVEN | Managed `supabase_admin` ownership/default semantics; production authorization | Yes before any live change | Read-only repeatable-read catalog snapshot; production/staging evidence; fail-closed evaluator; 74/74 local suites; PostgreSQL 17 proof; PR #92 run `37796386665` | Obtain current platform evidence or separately review an exact managed-role payload; keep production on HOLD | External evidence + 1–2 operator hours |
| Cloudflare bounded runtime | CODE_COMPLETE | Dashboard/token access; deployment authority | Yes, runtime | Manual GT/Event Facts paths in source; deployment not proven | Freeze deploy packet and execute when access exists | 0.5–1 day after access |
| Market Pricing institutional contract | STAGING_PROVEN | Production migration and runtime evidence ingestion/read remain absent | Yes for production schema/runtime | MP-0 latest-only; MP-1 no-lookahead selector; MP-2 CI on PG17.6 plus hosted staging PG17.11 transaction/rollback proof with zero data residue | Independently authorize MP-2 production schema, then wire one bounded caller under separate runtime authority | 1–2 days after gates |
| Positioning institutional contract | STAGING_PROVEN | Source/licensing, production schema and directional methodology decisions | Yes, production schema + provider + semantic | P-0 forced `UNAVAILABLE`; P-1 CI on PG17.6 plus hosted staging PG17.11 replay/revision/as-of transaction proof with zero data residue | Independently authorize P-1 production schema; keep collection and methodology off pending separate approvals | 1–3 days plus gates/provider |
| Regime institutional contract | CONTRACT_CI_PROVEN | Approved deterministic regime methodology and complete evidence inputs | Yes, semantic | R-0 exact MP-0/P-0 version+cutoff gate; forced `UNAVAILABLE` with no legacy fallback | Specify and validate R-1 methodology before activation | 2–4 days |
| H1–H5 synthesis | CONTRACT_CI_PROVEN | Positive EI/GT, replayable Market Pricing, approved Positioning/Regime and S-1 methodology | Yes, semantic | S-0 exact upstream version+cutoff gate; five ordered explicit abstentions | Specify horizon durations/calibration/targets only after evidence gates close | 3–6 days |
| AI Committee | CONTRACT_CI_PROVEN | Ready V2 horizons; approved provider/cost/runtime and C-1 method | Yes, provider + cost + runtime | C-0 exact S-0 version/cutoff gate; provider invocation forbidden; legacy output rejected | Freeze C-1 request/response, evidence and budget only after approvals | 2–4 days |
| Pre-PM evidence/risk | CONTRACT_CI_PROVEN | Ready Committee V2 evidence; versioned evidence graph; PMR-1 method | Yes for semantic activation | PMR-0 exact C-0 version/cutoff gate; PM input blocked with null verdict/confidence | Freeze graph/veto/uncertainty method only after V2 evidence exists | 2–4 days |
| Portfolio Manager | CONTRACT_CI_PROVEN | Ready PMR-1; approved portfolio policy and live portfolio state | Yes, portfolio policy | PM-0 exact PMR-0 gate; advisory-only null recommendation/allocation/size | Freeze PM-1 method only after policy approval | 3–6 days |
| Final Action Risk | CONTRACT_CI_PROVEN | Ready PM-1; approved risk policy and broker constraints | Yes, risk policy | FAR-0 exact PM-0 gate; action blocked with null loss/size/stop/verdict | Freeze FAR-1 veto/sizing method only after policy approval | 3–5 days |
| Action / Abstention | CONTRACT_CI_PROVEN | Ready FAR-1; explicit execution authority and broker connection | Yes before any execution | A-0 exact FAR-0 gate; advisory abstention, execution forbidden, order null | Keep A-1 execution boundary unimplemented until separately authorized | 2–4 days |
| Command Center / Scenario Tree | CONTRACT_CI_PROVEN | Reviewed UI mapping, runtime correlation and deployment proof | No for read-only contract; yes for deploy | CC-0 exact A-0 projection, nine-stage lineage, honest HOLD/abstention, no ticket | Design CC-1 UI mapping without implying live data | 4–8 days |
| Alerts | CONTRACT_CI_PROVEN | Ready actionable CC-1; alert/recipient/delivery policy and authority | Yes before any delivery | AL-0 exact CC-0 gate; deterministic dedupe; delivery/escalation forbidden; expiry/ack/recipient/channel null | Freeze AL-1 policy only after explicit approval | 2–4 days |
| Full observability / incident response | CONTRACT_CI_PROVEN | Correlation propagation, deployment IDs and live incident proof | No for contract; yes for deploy | CC-0 deterministic nine-stage version lineage; missing runtime IDs explicit | Define O-1 runtime propagation and incident proof after deploy authority | 3–6 days |
| End-to-end institutional acceptance | CONTRACT_CI_PROVEN | Every live proof and authorization in E2E-0 manifest | Yes, production | E2E-0 stable eleven-item evidence manifest; forced NOT_ACCEPTED/HOLD; no run/report | Execute E2E-1 only after every prerequisite is evidenced and scoped | 2–4 days after all gates |

\* Effort ranges are engineering estimates, not completion facts. They exclude
waiting for Human Gates, provider procurement, access recovery, and observation
windows for scheduled economic releases.

## Critical path now

1. Authorize and execute REC-1 with a named operator and isolated target.
2. Separately authorize Event Facts schema migrations 0029–0032 while runtime
   remains off.
3. Optionally authorize SB-1/SB-2/SB-3 as three independent payloads; SB-3
   additionally requires a resolved `supabase_admin` default-ACL disposition.
4. Separately authorize MP-2 production schema; keep provider ingestion and
   runtime reads off until their own decisions are approved.
5. Obtain Cloudflare deployment access and authorize one bounded manual caller.
6. Prove one live official bundle, atomic persistence, exact replay, downstream
   insufficiency, readback, logs, and containment.
7. Freeze the next provider-independent contracts while consensus stays
   `UNKNOWN`.

## Current hard stops

- No current restorable backup or successful isolated restore rehearsal.
- No named recovery operator or approved encrypted off-site location.
- No authorization to apply migrations 0029–0034 or timestamped SB-3 migration
  `20261008094133`.
- No Cloudflare deployment proof or runtime authority.
- No authorized consensus provider; positive EI/GT semantic inference remains
  forbidden.
- The BLS July 2026 archive supplies release-vintage AHE levels but no explicit
  month-over-month percentage supporting the current `0.0` fixture; a parser
  must not infer or revise that fact without an approved source rule.
- No trading or broker execution authority.

## Reconciliation rule

Before every external mutation, repeat GitHub main/PR/CI, Supabase project and
migration history, target objects, runtime inventory, and the relevant
authorization record. Real state supersedes this board.
