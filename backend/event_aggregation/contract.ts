/**
 * EIA-0: conservative aggregation of per-event Event Impact or Gold
 * Transmission plans into the chain-level summary S-0 consumes
 * (`algorithmVersion`, `status`, `knowledgeCutoff`).
 *
 * Only the case that needs no business rule is decided: when every admitted
 * plan reports INSUFFICIENT_EVIDENCE, so does the summary. Everything else is
 * UNAVAILABLE with a reason: no plan, an invalid or abstaining plan, a
 * version drift, a duplicate event version, an unavailable plan, and any
 * ASSESSED plan, because how assessed events combine is not approved. The
 * summary is therefore never ASSESSED.
 *
 * Which events belong to the set (window, relevance, supersession) is the
 * caller's choice and is not defined here. A plan whose own cutoff is after
 * the chain cutoff was not knowable at that cutoff and is excluded.
 *
 * v2 (B3) is a separate, additive contract in release_gate_contract.ts; both
 * share the aggregation in core.ts. This v1 contract is unchanged.
 */

import { aggregateCore, compareCodeUnits, statusOf, type EventAggregationKind } from './core.js';

export const EVENT_AGGREGATION_SCHEMA_VERSION = 'xau.event-plan-aggregation.v1' as const;
export const EVENT_AGGREGATION_ALGORITHM_VERSION = 'event-plan-aggregation-gate-1.0.0' as const;

export type { EventAggregationKind };

export type EventAggregationReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'INVALID_PLAN_SET'
  | 'NO_EVENT_PLANS'
  | 'INVALID_EVENT_PLAN'
  | 'EVENT_PLAN_ABSTAINED'
  | 'EVENT_PLAN_VERSION_MISMATCH'
  | 'DUPLICATE_EVENT_VERSION'
  | 'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF'
  | 'EVENT_PLAN_UNAVAILABLE'
  | 'ALL_EVENTS_INSUFFICIENT'
  | 'AGGREGATION_RULE_NOT_APPROVED';

export interface EventAggregationSummary {
  readonly algorithmVersion: string;
  readonly status: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
  readonly knowledgeCutoff: string;
}

export interface EventAggregationEnvelope {
  readonly schemaVersion: typeof EVENT_AGGREGATION_SCHEMA_VERSION;
  readonly algorithmVersion: typeof EVENT_AGGREGATION_ALGORITHM_VERSION;
  readonly kind: EventAggregationKind;
  readonly knowledgeCutoff: string;
  /** Exactly the S-0 input shape for this kind. */
  readonly summary: EventAggregationSummary;
  readonly reasonCodes: readonly EventAggregationReasonCode[];
  /** Admitted event versions, sorted by code unit. */
  readonly eventVersionIds: readonly string[];
  readonly counts: {
    readonly received: number;
    readonly admitted: number;
    readonly excludedAfterCutoff: number;
    readonly insufficient: number;
    readonly unavailable: number;
    readonly assessed: number;
    readonly rejected: number;
  };
}

const REASON_ORDER: readonly EventAggregationReasonCode[] = [
  'INVALID_KNOWLEDGE_CUTOFF', 'INVALID_PLAN_SET', 'NO_EVENT_PLANS', 'INVALID_EVENT_PLAN',
  'EVENT_PLAN_ABSTAINED', 'EVENT_PLAN_VERSION_MISMATCH', 'DUPLICATE_EVENT_VERSION',
  'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'EVENT_PLAN_UNAVAILABLE', 'ALL_EVENTS_INSUFFICIENT',
  'AGGREGATION_RULE_NOT_APPROVED',
];

/** v1. Never throws; malformed input yields an UNAVAILABLE summary. */
export function aggregateEventPlans(
  kind: EventAggregationKind,
  plans: unknown,
  knowledgeCutoff: unknown,
): EventAggregationEnvelope {
  const core = aggregateCore(kind, plans, knowledgeCutoff, undefined);
  return {
    schemaVersion: EVENT_AGGREGATION_SCHEMA_VERSION,
    algorithmVersion: EVENT_AGGREGATION_ALGORITHM_VERSION,
    kind,
    knowledgeCutoff: core.cutoff,
    summary: { algorithmVersion: core.expectedVersion, status: statusOf(core), knowledgeCutoff: core.cutoff },
    reasonCodes: REASON_ORDER.filter((reason) => core.reasons.has(reason)),
    eventVersionIds: [...core.admitted].sort(compareCodeUnits),
    counts: core.counts,
  };
}
