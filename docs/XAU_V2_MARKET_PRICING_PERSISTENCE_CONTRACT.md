# XAU V2 — Market Pricing persistence and as-of read (MP-2)

Status: `STAGING_PROVEN — NOT PRODUCTION-APPLIED / NOT RUNTIME-ACTIVATED`

## Scope

MP-2 supplies the persistence/read boundary missing after MP-0 and MP-1:

- append-only `market_pricing_observations` evidence;
- source observation time and database-owned ingestion time;
- explicit provider revision identifier or retained-evidence digest;
- idempotent record RPC with divergent identity reuse rejected;
- bounded as-of RPC that returns the complete eligible history or errors;
- strict TypeScript normalization into the pure MP-1 selector.

Canonical implementation:

- `database/migrations/20261002085845_market_pricing_history_as_of.sql`;
- `database/migrations/20261002091342_market_pricing_source_fk_index.sql`;
- `backend/market_engine/persisted_as_of.ts`.

## Frozen versions

- persistence schema: `xau.market-pricing-persistence.v1`;
- adapter algorithm: `market-pricing-persisted-as-of-adapter-1.0.0`;
- downstream selector: `xau.market-pricing-as-of.v1` /
  `market-pricing-as-of-selector-1.0.0`.

## Evidence identity and correction semantics

One identity is `(field, source, source_observed_at, evidence_revision)`.
Exact replay returns the original row and ingestion timestamp. Reusing that
identity with a different value fails; it never overwrites history. A genuine
correction must carry a new evidence revision and becomes a new row with a new
database-owned ingestion timestamp.

The source revision may be a provider revision identifier or an exact retained
evidence digest. Choosing how a runtime provider derives it remains part of the
provider/runtime review; MP-2 never invents one.

## As-of and boundedness

`fn_market_pricing_candidates_as_of` returns only rows satisfying both:

```text
source_observed_at <= knowledge_cutoff
ingested_at        <= knowledge_cutoff
```

The RPC counts eligible rows first. If the caller's explicit bound would be
exceeded, it raises an error instead of returning a silently truncated history.
Rows are emitted in fixed field/source-time/ingestion/source/id order, then the
MP-1 selector applies its no-lookahead, ambiguity, book and availability rules.
The adapter records this invariant as `historyCompleteness=COMPLETE_OR_ERROR`.

## Access and mutation boundary

The table has RLS enabled with no client policy. `anon` and `authenticated`
receive neither table privileges nor RPC execution. `service_role` receives
only `SELECT`/`INSERT` and the two business RPCs. Update and delete are denied
by both privileges and the append-only trigger.

The migration does not alter `market_ticks`, MP-0, the current ingestion loop,
the current Committee path or any deployed route. It adds no provider, secret,
schedule, background discovery or paid dependency.

## Evidence level

CI proves on PostgreSQL 17.6:

- schema checks, RLS and exact grants;
- idempotent persistence and divergent replay rejection;
- correction retention without overwriting prior evidence;
- historical cutoff exclusion followed by later inclusion;
- complete-or-error bounds, fixed ordering and invalid-input rejection;
- append-only enforcement and invoker/empty-search-path functions;
- strict application normalization and deterministic MP-1 composition.

The isolated staging project `viskjhkkcnzqxkuvibdx` on PostgreSQL 17.11 also
has the MP-2 schema applied. A transaction-rollback proof established writer
persist/replay behavior, divergent replay rejection, late-correction cutoff,
complete-or-error bounds, RLS and exact grants, empty-search-path invoker RPCs,
and append-only enforcement. The transaction left zero observation rows.

The staging performance advisor then exposed the uncovered `source` foreign
key. The additive follow-up index closes that finding and is exercised by the
same disposable PostgreSQL CI proof. Staging reports the index valid and ready,
the advisor no longer reports that foreign key, and the table still contains
zero rows. No provider data was ingested.

Production persistence remains unproven until
the exact migration is separately authorized, applied, reconciled and exercised
through an authorized runtime caller.

## Human Gates

MP-2 authorizes no production migration, backfill, runtime wiring, provider
selection, purchase, deployment, schedule, alert delivery, broker connection,
order or trade. Those actions remain separately gated.
