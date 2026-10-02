# XAU V2 — Positioning evidence contract (P-0)

Status: `CONTRACT_CI_PROVEN — NO PROVIDER OR METHODOLOGY APPROVED`

## Purpose

P-0 defines the provider-independent evidence boundary that any future gold
positioning source must satisfy. It accepts retained, attributable metrics and
normalizes their order. It does not infer crowding, percentile, bullishness,
bearishness, regime, horizon, recommendation or trade.

Canonical implementation:
`backend/positioning_engine/evidence_contract.ts`.

Frozen versions:

- `xau.positioning-evidence.v1`;
- `positioning-evidence-normalizer-1.0.0`.

## Evidence tuple

Every metric must carry its source authority, dataset, instrument, metric code,
finite value, unit, report period end, publication timestamp, system observation
timestamp, retained artifact identifier and explicit revision identifier/null.
The tuple is rejected if its shape is not exact, its timestamps are ambiguous,
its date is impossible, it is duplicated, or publication/observation occurs
after the supplied knowledge cutoff.

Supported units describe representation only: `CONTRACTS`, `PERCENT`, `RATIO`,
and `INDEX`. They do not confer semantic comparability between datasets.

## Deliberate abstention

With valid evidence, `evidenceState` can be `EVIDENCE_READY`, but P-0 always
returns:

```text
positioningState=UNAVAILABLE
reason=METHODOLOGY_NOT_APPROVED
```

This separation prevents “data exists” from becoming “a positioning signal is
known.” A later methodology decision must define category mappings, revisions,
normalization window, percentile/crowding rules, instrument roll treatment,
missing-report behavior and backtest/validation evidence.

## Human Gate

Before any live collection or semantic activation, the owner must separately
approve the exact source, access path, terms/licensing, cost, retention policy,
release/revision semantics and directional methodology. CFTC, CME/COMEX, LBMA
and WGC remain candidates only; this contract does not assert access, approval,
coverage or suitability for any of them.

P-0 authorizes no provider call, account creation, purchase, secret, database
write, migration, deployment, schedule, broker connection or trading action.

P-1 now defines a separate provider-neutral append-only persistence and
complete-or-error historical read contract. It remains schema/code only until
proved and does not change P-0's deliberate `UNAVAILABLE` positioning state.
