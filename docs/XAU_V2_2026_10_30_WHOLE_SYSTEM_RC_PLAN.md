# XAU V2 — 14-day whole-system delivery plan (16–30 October 2026)

**Scope:** integrated, testable **offline release candidate**, not an institutional live-trading launch. **Owner of final authorizations: human operator.** This plan cannot override REC-1, a migration freeze, market-data licences, broker restrictions or production review.

## Explicit delivery verdicts

- **RC-OFFLINE candidate by 30 Oct:** contingent on actual green CI at the exact release commit, cross-system replay, local terminal security, published handoff and residual risk register. This is an engineering delivery target, not a promise of institutional live readiness.
- **INSTITUTIONAL LIVE:** **NOT AUTHORIZED / NOT PROVEN** until independent approvals of recovery REC-1, supplier rights, complete market-history provenance, methods/calibration, production configuration and broker/risk controls.
- Do not call `ATTEMPTS_RECORDED`, `SIMULATED`, `READY_FOR_HUMAN_REVIEW` or 11/11 CI `LIVE_READY`; do not fabricate bid/ask/DXY, provider quotas, business methods or trade recommendations.

## Critical-path workstreams (one owner of truth per area)

| Workstream | Current artifact to reuse | Remaining provable criterion | Default verdict |
|---|---|---|---|
| Integration and release | CHAIN-0, ARCH-CLOSE, OBS-0, RC-0 | One stacked candidate, full CI and no branch regression | OFFLINE_ONLY |
| Market data and capture | DATA-1/2/3/4A–4G, real local archives | Source identity and durable completeness, revised history, DXY/bid/ask verified | HISTORICAL_UNVERIFIED |
| Macro and price interpretation | Event Impact, Gold Transmission, MP-0 | Synchronized as-of cutoff; official event artifacts; empirical validation | NOT_APPROVED |
| Decision and risk | R-0, H1–H5, committee, PMR-0, PM-0, FAR-0, action | Methodology review, outside-sample tests, risk policy, broker constraints | HOLD/FORBIDDEN |
| Terminal | TV-0/1/2, TV-3 OBS audit receipt, local server | Complete local replay, visible simulation/origin/freshness, no positive claims | READ_ONLY |
| Database and operations | DATA-4B SQL *proposal*, ephemeral PostgreSQL CI | Reviewed schema/security/storage cost + explicit migration authorization | NOT_MIGRATED |
| Recovery/security | REC-1 v3 frozen, CI gates, raw evidence private | Isolated restore evidence, secrets review, dedicated human gate | FROZEN |

## Milestones and quality gates

| Window | Deliverable | Objective proof |
|---|---|---|
| 16–18 Oct | RC-0 integrate DATA-4G + TV-3 **without** merging main; cross-system test | Exact SHA, complete deterministic and ephemeral PG CI |
| 19–21 Oct | Whole-terminal/offline regression across fixture, archive, 12-stage CHAIN, OBS, UI | Same accepted receipt fingerprint; HOLD on every scenario |
| 22–24 Oct | Data, source provenance and as-of gap audit; recovery/gov evidence review | Missing series and human approvals recorded as blockers, no data invented |
| 25–27 Oct | Defect remediation + deterministic replay, negative/mutation tests | CI green on exact frozen RC commit, explicit regression inventory |
| 28–30 Oct | Release candidate documentation and operator walkthrough | Reproducible local start, read-only terminal, architecture trace, signed-off residual blockers |

Each interval is a **target**; only proof establishes completion. Do not advance a workstream by relabeling its status. Complete remaining work based on critical path, not number of PRs.

## Definition of done for OFFLINE release candidate

1. Integration branch includes the approved source contracts from both DATA-4G and TV-3, delta reviewed against DATA-4F.
2. `npm run typecheck`, reviewed deterministic test inventory, and ephemeral PG CI green **on the same HEAD**.
3. RC-0 cross-system smoke proves DATA-4E → DATA-4F → DATA-4G and independently CHAIN-0 → OBS-0 → terminal / transport agree on no live authority.
4. Local terminal renders provenance, simulated/observed distinction, cutoff and all 12 stages; invalid evidence and altered receipts do not produce an actionable signal.
5. Every absent piece of actual evidence remains PENDING / UNVERIFIED; no real supplier request, DB schema migration, broker access or live order implied.
6. Frozen `main` unchanged, no PR merged, no production deploy. Integration / Human Gates remain separate.

## Human dependency register (not software TODOs)

- **REC-1 clearance:** blocked until operator confirms recovery complete; cannot be inferred from a CI backup rehearsal.
- **Provider/legal authorization:** FRED/Twelve Data quota, licence and retention/replay rights require an approved supplier record.
- **Market completeness:** DXY, bid and ask, official release times, continuously retained complete historical captures, real revisions; supplier/source choice required.
- **Model methodology:** non-synthetic out-of-sample tests and independent approval of regime/horizons/committee/PM/risk, position sizing and alerts.
- **Infrastructure:** production secrets, database migrations, network, release monitoring and rollback need separate explicit approvals.
- **Trading:** broker connectivity and BUY/SELL remain forbidden independently of engineering RC.

## Work policy and focus

- **Keep** the existing branches #123–126, #135–147, #148 open/draft; do not redevelop them.
- Implement isolated, reversible fixes on RC, with targeted tests and minimal diffs; treat GitHub's PR-to-main diff as accumulated history, not the incremental delta.
- One canonical decision chain, one canonical as-of audit, one OBS-0 fingerprint gate, and human-only production authority.
- Report only: exact commit, CI state, objective outcome, unresolved critical blockers, next highest-impact action. No speculative completion percentages.

**Acceptance:** On 30 Oct, the system may be called **OFFLINE RELEASE CANDIDATE** only if all six engineering items above are evidenced; it may **not** be called institutional live/complete unless the independent human and market-validity gates have truly closed.
