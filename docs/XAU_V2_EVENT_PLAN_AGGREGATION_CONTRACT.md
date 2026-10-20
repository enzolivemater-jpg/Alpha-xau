# XAU V2 — conservative event plan aggregation (EIA-0)

Status: `CONTRACT_CI_PROVEN — NOT WIRED`

The Event Impact and Gold Transmission processors emit one plan per event
version. S-0 and CHAIN-0 consume a single chain-level summary
(`algorithmVersion`, `status`, `knowledgeCutoff`). EIA-0 decides only the case
that needs no business rule.

Frozen versions:

- `xau.event-plan-aggregation.v1`;
- `event-plan-aggregation-gate-1.0.0`.

## Rule

`aggregateEventPlans(kind, plans, knowledgeCutoff)` never throws. Its summary
is exactly the S-0 input shape for `kind`:
- `algorithmVersion` is the current processor version;
- `knowledgeCutoff` is the chain cutoff.

| Plan set | Summary | Reason |
| --- | --- | --- |
| Every admitted plan is `INSUFFICIENT_EVIDENCE` | `INSUFFICIENT_EVIDENCE` | `ALL_EVENTS_INSUFFICIENT` |
| Invalid chain cutoff | `UNAVAILABLE` | `INVALID_KNOWLEDGE_CUTOFF` |
| Not an array | `UNAVAILABLE` | `INVALID_PLAN_SET` |
| No admitted plan | `UNAVAILABLE` | `NO_EVENT_PLANS` |
| Malformed plan, or a status the processor cannot emit | `UNAVAILABLE` | `INVALID_EVENT_PLAN` |
| Plan whose processor abstained | `UNAVAILABLE` | `EVENT_PLAN_ABSTAINED` |
| Processor or algorithm version is not the current one | `UNAVAILABLE` | `EVENT_PLAN_VERSION_MISMATCH` |
| Same event version twice | `UNAVAILABLE` | `DUPLICATE_EVENT_VERSION` |
| A plan reports `UNAVAILABLE` | `UNAVAILABLE` | `EVENT_PLAN_UNAVAILABLE` |
| Any `ASSESSED` plan | `UNAVAILABLE` | `AGGREGATION_RULE_NOT_APPROVED` |

A plan whose own cutoff is after the chain cutoff was not knowable at that
cutoff. It is excluded (`EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF`), and the
comparison is exact to the nanosecond.

The summary is never `ASSESSED`. The envelope also lists the admitted event
version IDs, sorted by code unit, and the counts.

## Open decisions

1. **Positive combination.** How assessed events combine (weighting,
   conflict, decay) is not approved.
2. **Event set.** Which events belong to the set at a cutoff is not defined:
   the window, the relevance rule and the choice of the latest version within
   a cluster. Today the set is the caller's choice.

## v2 — official release evidence (B3, offline qualification)

Status: `CONTRACT_CI_PROVEN — NOT WIRED`. Additive: v1 above is unchanged
(same function, versions, reasons and envelope; a 20,000-case differential
check against the previous implementation gave identical envelopes).

Frozen versions:

- `xau.event-plan-aggregation.v2`;
- `event-plan-aggregation-release-gate-2.0.0`.

`aggregateEventPlansWithOfficialRelease(kind, plans, releases, knowledgeCutoff)`
(`backend/event_aggregation/release_gate_contract.ts`; both versions share the
aggregation in `core.ts`) never throws. `releases` is the explicit evidence boundary: an array of exactly
`{ eventVersionId, publishedAt }`, one per event version, where `publishedAt` is
the official publication instant (the four Event Facts adapters expose it as
`publishedAt`, parsed from the release text in US Eastern time). The summary
keeps the S-0 shape, so a valid evidence set yields the v1 summary and the
golden CHAIN-0 digest.

After the v1 checks, for each plan still admissible:

| Case | Effect | Reason |
| --- | --- | --- |
| Plan cutoff before the release instant (exact to the nanosecond) | Excluded | `EVENT_PLAN_BEFORE_OFFICIAL_RELEASE` |
| No evidence for the event version | `UNAVAILABLE` | `RELEASE_INSTANT_MISSING` |
| Evidence set not an array, a record with other keys, an empty ID, a non-strict instant, a duplicate ID, a hostile accessor | `UNAVAILABLE`, no plan admitted | `INVALID_RELEASE_SET` |

A plan known after the chain cutoff is excluded as in v1 and needs no
evidence. Evidence for event versions without a plan is ignored and counted
(`releasesUnused`). The envelope adds `releaseEvidence: 'REQUIRED'` and the
counts `excludedBeforeOfficialRelease`, `missingReleaseInstant`,
`releasesUnused`.

Limits: the evidence is supplied by the caller; v2 checks its shape and
time, not its authenticity. Event Impact / Gold Transmission v5 and the CPI
producer planner do not carry the instant, and v1 still admits a back-dated
plan. The protection holds only where an aggregation uses v2.

## Scope

EIA-0 (v1 and v2) is a pure function and is not wired into any runtime or
into CHAIN-0's input contract: CHAIN-0 receives whatever summary its caller
passes, so it is protected only when that caller aggregates with v2.

Tests: `tests/test_event_plan_aggregation.mjs` (v1 and v2). On real processor
plans, the aggregated summaries reproduce the golden CHAIN-0 digest.
`tests/test_rc0_cross_system_contract.mjs` runs v2 on the four official
fixtures with the adapters' instants.
