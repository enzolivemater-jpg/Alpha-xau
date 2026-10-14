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

## Scope

EIA-0 is a pure function and is not wired into any runtime or into CHAIN-0's
input contract.

Test: `tests/test_event_plan_aggregation.mjs`. On real processor plans, the
aggregated summaries reproduce the golden CHAIN-0 digest.
