# XAU V2 — Positioning persistence and as-of evidence (P-1)

Status: `STAGING_PROVEN — NO PROVIDER OR METHODOLOGY APPROVED`

## Scope

P-1 adds the provider-neutral persistence/read boundary required by P-0:

- append-only evidence with database-owned first-observation time;
- exact source, dataset, instrument, metric, period, artifact and revision;
- idempotent replay with divergent identity reuse rejected;
- complete-or-error historical reads at an explicit knowledge cutoff;
- strict application normalization into the P-0 evidence envelope.

Canonical implementation:

- `database/migrations/20261002092118_positioning_evidence_history_as_of.sql`;
- `backend/positioning_engine/persisted_evidence.ts`.

## Frozen versions

- persistence schema: `xau.positioning-persistence.v1`;
- adapter algorithm: `positioning-persisted-evidence-adapter-1.0.0`;
- downstream evidence envelope: `xau.positioning-evidence.v1` /
  `positioning-evidence-normalizer-1.0.0` (P-0).

## Evidence identity and revision semantics

One identity is `(source_authority, dataset_code, instrument_code, metric_code,
period_end, revision)`. Null is an explicit initial revision. Exact replay
returns the original row and database-owned observation timestamp. A changed
value, unit, publication time or artifact under the same identity fails closed.
A genuine correction must carry a distinct explicit revision.

`published_at` records source publication. `observed_at` is set by the database
when that exact evidence first becomes known. Publication after observation is
rejected. Both timestamps must be at or before a historical knowledge cutoff.

## Complete-or-error read

`fn_positioning_evidence_as_of` counts eligible rows before returning them. If
the caller's explicit bound is too small, the RPC raises an error; it never
silently truncates history. Ordering matches the P-0 evidence identity and is
independent of insertion order. The adapter exposes this as
`historyCompleteness=COMPLETE_OR_ERROR`.

Adapter and P-0 input hardening (RC-0 remediation, `tests/test_market_data_ingest_mutation.mjs`):
a non-array RPC result raises `P1_RPC_RESULT_INVALID`; identity fields are checked with
`typeof` before the regular expression (an `undefined` source authority used to pass
as the text "undefined" and reach the evidence set); a NUMERIC given as text must be a
plain decimal (`"0x10"` is refused, not read as 16); a non-string cutoff is an invalid
(empty) cutoff and non-array evidence is malformed evidence.

## Deliberate semantic boundary

P-1 persists attributable evidence only. Its adapter always delegates to P-0,
which preserves:

```text
positioningState=UNAVAILABLE
reason=METHODOLOGY_NOT_APPROVED
```

The schema contains no crowding, percentile, bullish/bearish, horizon,
recommendation, allocation, risk or trade field. No provider candidate becomes
approved merely because this interface exists.

## Acceptance evidence

CI proves on PostgreSQL 17.6 and in deterministic application tests:

- exact idempotent replay and divergent-payload rejection;
- revision retention without overwrite;
- late-observed evidence excluded at an earlier cutoff and included later;
- complete-or-error bounds and deterministic ordering;
- RLS, service-role-only access, invoker functions and empty search paths;
- append-only enforcement and chronology/value constraints;
- strict RPC normalization into P-0 with methodology still unavailable.

The isolated staging project `viskjhkkcnzqxkuvibdx` on PostgreSQL 17.11 has
the P-1 schema applied. A transaction-rollback proof established exact replay,
divergent-payload rejection, retained revisions, early/late cutoff behavior,
complete-or-error bounds, RLS and exact grants, empty-search-path invoker RPCs,
and append-only enforcement. The table contains zero rows after rollback.

Post-apply security and performance advisors introduced no P-1 ERROR/WARN or
unindexed-foreign-key finding. `rls_enabled_no_policy` is the expected INFO for
this intentionally policy-free, service-role-only table.

## Human Gates

P-1 authorizes no provider selection, provider call, account, licensing term,
purchase, secret, production migration, backfill, runtime wiring, deployment,
schedule, directional methodology, alert delivery, broker connection, order or
trade. Those remain separate owner decisions.
