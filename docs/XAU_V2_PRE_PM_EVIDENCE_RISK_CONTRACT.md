# XAU V2 — pre-PM evidence/risk contract (PMR-0)

Status: `CONTRACT_CI_PROVEN — PORTFOLIO MANAGER BLOCKED`

PMR-0 freezes the provider-independent boundary between AI Committee V2 and
the Portfolio Manager. It validates the exact C-0 identity and shared cutoff,
then requires a completed Committee invocation and a non-empty, complete,
versioned evidence graph before a future gate may become eligible.

Frozen versions:

- `xau.pre-pm-evidence-risk.v1`;
- `pre-pm-dependency-gate-1.0.0`.

## Current output

PMR-0 always emits `state=ABSTAIN`,
`portfolioManagerEligibility=BLOCKED`, `riskVerdict=null`, `confidence=null`
and `portfolioManagerInput=null`. Committee readiness, invocation completion,
evidence availability and methodology approval remain distinct blockers.

The existing legacy Risk Committee prompt/output is not an evidence graph and
is not accepted as PMR-0 proof. Missing evidence never becomes a neutral risk
verdict, low confidence or an implicit permission to continue.

## PMR-1 closure requirements

PMR-1 must freeze the evidence-graph schema, node and edge provenance,
freshness, contradiction and missingness semantics, deterministic vetoes,
uncertainty aggregation, validation corpus, replay behavior and exact output
accepted by the Portfolio Manager. Positive eligibility requires explicit
approval of that method after ready Committee V2 evidence exists.

PMR-0 authorizes no LLM call, provider cost, Portfolio Manager proposal,
persistence, migration, deployment, alert, broker connection or trading.
