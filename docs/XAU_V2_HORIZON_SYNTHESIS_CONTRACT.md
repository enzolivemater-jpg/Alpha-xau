# XAU V2 — H1–H5 synthesis dependency contract (S-0)

Status: `CONTRACT_CI_PROVEN — SCENARIO INFERENCE FORBIDDEN`

S-0 freezes the boundary that must be crossed before XAU V2 may emit horizon
scenarios. It validates the exact Event Impact, Gold Transmission, MP-0, P-0
and R-0 algorithm/schema versions under one shared explicit knowledge cutoff.

Frozen versions:

- `xau.horizon-synthesis.v1`;
- `horizon-dependency-gate-1.0.0`.

## Current output

S-0 emits exactly H1, H2, H3, H4 and H5 in stable order. Every horizon is an
explicit abstention:

```text
status=ABSTAIN
direction=UNAVAILABLE
probability=null
target=null
invalidation=null
confidence=null
```

It never converts a missing upstream assessment into a neutral direction,
zero probability, `range_bound` regime or copied legacy Committee scenario.
Today EI/GT are insufficient, MP-0 is latest-only/degraded, Positioning and
Regime are unavailable, and no H1–H5 methodology is approved; positive
scenario synthesis is therefore forbidden.

## S-1 closure requirements

S-1 must separately define the real-world duration and expiry of each horizon,
required inputs, cutoff/as-of semantics, event-to-horizon mapping, probability
calibration, target/invalidation construction, cross-horizon consistency,
revision behavior, validation corpus, replay rules and explicit abstention.

S-0 authorizes no AI/LLM inference, provider, cost, persistence, migration,
runtime wiring, deployment, schedule, alert, broker connection or trading.
