# XAU V2 — Market Pricing institutional contract (MP-0)

Status: `CONTRACT_CI_PROVEN — NOT RUNTIME-ACTIVATED`

## Scope

MP-0 freezes a provider-independent audit envelope around the existing market
snapshot. It does not add a provider, purchase data, alter a schedule, write a
database row, deploy a Worker, or activate a downstream decision.

Canonical implementation:
`backend/market_engine/institutional_snapshot.ts`.

## Frozen versions

- schema: `xau.market-pricing-snapshot.v1`;
- algorithm: `market-pricing-envelope-1.0.0`.

Every field carries value, freshness state, real source timestamp, age and
source together. Spot is required. Bid, ask, DXY, US10Y, real yield, VIX and WTI
are optional but their absence or staleness is explicit. Missing data is never
zero-filled, proxied, or silently inherited from the XAU compatibility stamps.

## Deterministic states

| State | Meaning |
| --- | --- |
| `AVAILABLE` | Required spot and all invariants are valid, with no degradation reason. |
| `DEGRADED` | Spot remains usable, but it is stale, an optional field is stale/absent, or historical replay is not yet supported. |
| `ABSTAIN` | Required data is absent or the cutoff, field, capture, future-observation, or book invariant fails. |

Reason codes are emitted in a fixed order. The builder reads no clock,
environment, database, network, provider or random source. `knowledgeCutoff`
is mandatory caller input and every source observation must be at or before it.

## Replay boundary

The current `v_market_latest` path is a latest-state read. It does not expose a
historical ingestion cutoff and therefore cannot prove what the system knew at
an arbitrary past instant. MP-0 reports this honestly as:

```text
mode=LATEST_ONLY
reproducible=false
reason=INGESTION_CUTOFF_NOT_AVAILABLE
```

Accordingly, MP-0 is contract/CI evidence, not end-to-end institutional replay
evidence. MP-1 now defines a separate explicit-history as-of selector carrying
both source observation time and system knowledge/ingestion time. MP-0 remains
latest-only until a separately gated persisted history and runtime read path
exist; MP-1 does not silently upgrade this adapter's replay claim.

## Acceptance evidence

The deterministic test must prove:

- stable schema/algorithm versions and output for identical input;
- explicit required/optional field roles and provenance preservation;
- stale/absent optional data degrades without fabrication;
- absent spot, malformed field contracts, future observations, captured-at
  drift and inverted books abstain;
- historical replay is never claimed by the latest-only adapter;
- no runtime wiring, provider call, secret, database mutation or deployment.

## Activation boundary

Runtime wiring is a separate Human Gate because it can alter downstream
committee behavior and provider cost. This document authorizes no runtime,
provider, schema, migration, deployment, schedule, broker or trading action.
