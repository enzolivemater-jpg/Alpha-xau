# XAU V2 — Market Pricing historical as-of contract (MP-1)

Status: `CONTRACT_CI_PROVEN — EXPLICIT HISTORY ONLY / NOT RUNTIME-ACTIVATED`

## Scope

MP-1 freezes a deterministic, provider-independent selector for reconstructing
the Market Pricing evidence that was knowable at an explicit historical cutoff.
It accepts candidate history from its caller and performs no database, network,
provider, clock, environment, secret or random read.

Canonical implementation: `backend/market_engine/as_of_snapshot.ts`.

## Frozen versions

- schema: `xau.market-pricing-as-of.v1`;
- algorithm: `market-pricing-as-of-selector-1.0.0`.

Each candidate binds a stable evidence identifier, field, value, source, source
observation timestamp and system ingestion timestamp. The two timestamps are
not interchangeable: source time says when the market fact applied; ingestion
time says when the system could first know it.

## As-of rule

A candidate can be selected only when both `observedAt <= knowledgeCutoff` and
`ingestedAt <= knowledgeCutoff`. A legitimate later-ingested correction is
excluded from earlier replay and becomes eligible only at a later cutoff.
Future history therefore cannot leak backward.

For each field, the selector chooses the newest eligible source observation,
then the newest ingestion of that observation. Remaining exact ties use source
and candidate identifier solely as stable ordering keys. Distinct top values
from different sources are not reconciled by an invented source preference:
they emit `AMBIGUOUS_TOP_OBSERVATION` and fail closed.

Duplicate stable identifiers with different payloads, malformed history,
observation-after-ingestion chronology, cutoff lookahead and inverted books
also fail closed. Exact duplicate evidence is idempotently collapsed.

## States

| State | Meaning |
| --- | --- |
| `AS_OF_AVAILABLE` | Spot and every optional field have an unambiguous eligible observation. |
| `DEGRADED` | Spot is selected, but one or more optional fields are absent at the cutoff. |
| `ABSTAIN` | Spot is absent or an input, chronology, lookahead, ambiguity, or book invariant fails. |

Reason ordering and selected-field ordering are fixed. `ageSeconds` is derived
from the caller-supplied cutoff, never from wall-clock time.

## Evidence boundary

`replay.mode=EXPLICIT_HISTORY_AS_OF` means deterministic replay is available
when the caller provides valid explicit history. `persistenceProven=false`
states the remaining boundary: MP-1 does not prove that production stores the
required ingestion timestamp, exposes a historical query, or retains complete
history. It does not change MP-0's honest `LATEST_ONLY` runtime envelope.

Closing the persistence/runtime gap requires a separately reviewed storage and
read-path design, migration proof, production authorization and activation
evidence. This contract alone is not a production replay proof.

## Acceptance evidence

The deterministic test must prove:

- stable output under input reordering and exact duplicate evidence;
- exclusion of corrections ingested after the cutoff and inclusion later;
- canonical timestamps, deterministic ages and fixed evidence ordering;
- explicit degraded and unavailable states without zero-fill or proxy values;
- abstention on malformed history, ambiguous identity/value, causal inversion,
  lookahead and inverted books;
- absence of clock, database, network, provider, secret or runtime access.

## Activation boundary

MP-1 authorizes no provider selection, purchase, schema, migration, production
read/write, deployment, schedule, alert delivery, broker connection, order or
trade. Runtime wiring and persistence remain separate Human Gates.
