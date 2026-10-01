# XAU V2 — downstream decision-chain contracts (D-0)

Status: `CONTRACT_CI_PROVEN — ADVISORY ABSTENTION ONLY`

D-0 freezes three provider-independent fail-closed boundaries downstream of
PMR-0. None of them supplies a trading policy or execution capability.

| Gate | Frozen versions | Current result |
| --- | --- | --- |
| Portfolio Manager PM-0 | `xau.portfolio-manager-gate.v1` / `portfolio-manager-dependency-gate-1.0.0` | advisory-only abstention; recommendation, allocation, size and confidence are null |
| Final Action Risk FAR-0 | `xau.final-action-risk-gate.v1` / `final-action-risk-dependency-gate-1.0.0` | action blocked; loss, size, stop and verdict are null |
| Action/Abstention A-0 | `xau.action-abstention.v1` / `action-abstention-gate-1.0.0` | `decision=ABSTAIN`, `execution=FORBIDDEN`, order null |

Every boundary checks the exact upstream schema/algorithm identity and one
shared explicit knowledge cutoff. Missing readiness, portfolio policy, live
portfolio state, risk policy, broker constraints, execution authorization and
broker connection remain distinct reason codes.

No default percentage, allocation, position size, stop loss, neutral trade or
legacy Committee result is substituted for an absent approved policy. A
generic request to continue is not execution authorization.

Positive PM-1, FAR-1 and A-1 contracts require separately approved portfolio
and risk policies, deterministic validation corpora, broker constraints and
explicit execution authority. D-0 authorizes no LLM call, provider cost,
persistence, migration, deployment, alert delivery, broker connection, order
construction or trading.
