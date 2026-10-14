# XAU V2 — METH-0 Institutional methodology research and Human Gates

**Status: RESEARCH / NOT APPROVED / NO EXECUTION.**

This document and its machine-checked companion
\`docs/XAU_V2_METH_0_REVIEW_MATRIX.json\` are **not a positive trading policy**.
No regime classification, horizon probability, AI Committee vote,
portfolio allocation, stop-loss, lot size, trade signal or alert authority
is activated here. The existing institutional code continues to block all
positive outputs; the matrix is **documentation only**, not a runtime
authorization source.

## Purpose

Turn the missing positive methodology decisions into independently reviewable,
testable questions without silently making business or financial decisions.
The review stages mirror the currently implemented reason codes, not new
ad hoc scoring paths.

| Stage | Human decision required before *any* positive policy |
| --- | --- |
| Regime R-0 | Market-regime taxonomy, range/trend identification, contradictory indicators, abstention and calibrated confidence |
| Horizons H1–H5 S-0 | Exact horizon definitions, horizon-specific scenarios/probabilities, out-of-sample calibration, invalidation logic and cross-horizon conflicts |
| Committee C-0 | Provider eligibility, independent model roles, deterministic prompt/model versions, dissent resolution, injection defenses, cost and evidence budget |
| Pre-PM PMR-0 | Evidence graph, completeness threshold, release-vintage validity, confidence limitations, explicit veto conditions |
| Portfolio PM-0 | Approved portfolio snapshots, concentration, diversification, correlated risk, existing exposure and capital allocation constraints |
| Final Risk FAR-0 | Stop-loss methodology, rounding, max loss, instrument volatility/liquidity constraints, broker minimums and rejection if execution cannot fit limits |
| Action A-0 | Separation of advice, manual authorization, broker privileges, idempotent execution and emergency stop |
| Alerts AL-0 | Recipients, delivery channels, deduplication/expiry, suppression, acknowledgement and zero coupling to order execution |

## Cross-cutting validation requirements

All stages need provenance of official artifacts and precise as-of release /
ingestion timing; source or market snapshots alone do not establish trust.
Replay data must enforce strict no-lookahead release vintages and a frozen
algorithm version. Training, validation and testing intervals must be separated
temporally. Horizon probabilities and model confidence need independent,
documented calibration with uncertainty estimates; backtest results must
report sensitivity to regime, publication delays, missing data, execution
costs and adverse tail scenarios. Passing on one curated fixture cannot replace
out-of-sample evidence.

An independent human reviewer must approve the *specific* versioned
methodology, its assumptions, interpretation, failure cases, trading
authority boundaries, permitted providers, costs, capital constraints and
explicit risk budget. A signed or versioned proposal alone is not an approval.
No approval can be inferred from an input flag, an AI vote, a SHA-256 checksum,
a successful PR build or a restored database backup.

## Methodology selection decisions still open

**No numeric thresholds, model weights, API provider preference, regime
taxonomy or maximum account loss rate is selected in this METH-0 plan.**
Do not convert historical exploratory parameters into production defaults.
Before writing positive rules, define and approve:

1. The research objective and allowed instruments (including how XAGUSD
   informs XAUUSD, if at all), data availability and latency envelopes;
2. Gold/silver regime labels and transitions, trend/range criteria and the
   conditions under which every stage must abstain;
3. H1–H5 time window semantics, scenario calibration, targets, invalidation,
   confidence, disagreement and horizon weighting (or no weighting);
4. Whether any AI provider may be invoked, committee vote semantics,
   cost envelope, prompt injection boundaries and audit logging;
5. Formal risk policy per account/instrument, position sizing, compulsory
   stop-loss, slippage/gap exposure, portfolio concentration and human veto;
6. Realistic backtesting/replay acceptance standards and independent
   benchmark metrics, **chosen before** inspecting final holdout performance;
7. Recovery/staging, approved evidence providers, transport trust boundaries,
   security, rollback, incident handling and eventual Human Gate sign-off.

## Production / Human Gate constraints

Even a future positive strategy research result would not change the existing
REC-1 recovery freeze, migration/deployment embargo, execution authorization
or unknown broker constraints. These are separate **HUMAN GATE** approvals.
No PR merge or deployment is requested by this document.

The valid state of XAU V2's current decision chain remains
\`HOLD / ABSTAIN / FORBIDDEN\`. No input, caller assertion, test fixture,
CI status or review-matrix field may change that. This document makes the
remaining decisions explicit, not automatic.
