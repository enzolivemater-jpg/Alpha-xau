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
 */

import { EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION } from '../event_impact/deterministic_processor.js';
import { GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION } from '../gold_transmission/deterministic_processor.js';
import { isStrictTimestamp, isStrictlyAfter } from '../shared/strict_timestamp.js';

export const EVENT_AGGREGATION_SCHEMA_VERSION = 'xau.event-plan-aggregation.v1' as const;
export const EVENT_AGGREGATION_ALGORITHM_VERSION = 'event-plan-aggregation-gate-1.0.0' as const;

export type EventAggregationKind = 'EVENT_IMPACT' | 'GOLD_TRANSMISSION';

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

const PROCESSOR_VERSION: Readonly<Record<EventAggregationKind, string>> = {
  EVENT_IMPACT: EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
  GOLD_TRANSMISSION: GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION,
};

/** Statuses each processor can emit for a processed event. */
const PLAN_STATUSES: Readonly<Record<EventAggregationKind, readonly string[]>> = {
  EVENT_IMPACT: ['ASSESSED', 'INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'],
  GOLD_TRANSMISSION: ['INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'],
};

const REASON_ORDER: readonly EventAggregationReasonCode[] = [
  'INVALID_KNOWLEDGE_CUTOFF', 'INVALID_PLAN_SET', 'NO_EVENT_PLANS', 'INVALID_EVENT_PLAN',
  'EVENT_PLAN_ABSTAINED', 'EVENT_PLAN_VERSION_MISMATCH', 'DUPLICATE_EVENT_VERSION',
  'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'EVENT_PLAN_UNAVAILABLE', 'ALL_EVENTS_INSUFFICIENT',
  'AGGREGATION_RULE_NOT_APPROVED',
];

/** Reasons that do not make the summary UNAVAILABLE on their own. */
const INFORMATIONAL: ReadonlySet<EventAggregationReasonCode> = new Set([
  'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'ALL_EVENTS_INSUFFICIENT',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Never throws; malformed input yields an UNAVAILABLE summary. */
export function aggregateEventPlans(
  kind: EventAggregationKind,
  plans: unknown,
  knowledgeCutoff: unknown,
): EventAggregationEnvelope {
  const reasons = new Set<EventAggregationReasonCode>();
  const cutoffValid = isStrictTimestamp(knowledgeCutoff);
  if (!cutoffValid) reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  const cutoff = typeof knowledgeCutoff === 'string' ? knowledgeCutoff : '';
  const expectedVersion = PROCESSOR_VERSION[kind];

  const counts = { received: 0, admitted: 0, excludedAfterCutoff: 0, insufficient: 0, unavailable: 0, assessed: 0, rejected: 0 };
  const admitted = new Set<string>();
  if (!Array.isArray(plans)) {
    reasons.add('INVALID_PLAN_SET');
  } else {
    counts.received = plans.length;
    for (const plan of plans) {
      if (!isRecord(plan) || (plan.kind !== 'PROCESS' && plan.kind !== 'ABSTAIN')) {
        reasons.add('INVALID_EVENT_PLAN');
        counts.rejected += 1;
        continue;
      }
      if (plan.processorVersion !== expectedVersion
          || (plan.kind === 'PROCESS' && plan.algorithmVersion !== expectedVersion)) {
        reasons.add('EVENT_PLAN_VERSION_MISMATCH');
        counts.rejected += 1;
        continue;
      }
      if (plan.kind === 'ABSTAIN') {
        reasons.add('EVENT_PLAN_ABSTAINED');
        counts.rejected += 1;
        continue;
      }
      const id = plan.eventVersionId;
      const status = plan.assessmentStatus;
      if (typeof id !== 'string' || id.length === 0 || !isStrictTimestamp(plan.knowledgeCutoff)
          || typeof status !== 'string' || !PLAN_STATUSES[kind].includes(status)) {
        reasons.add('INVALID_EVENT_PLAN');
        counts.rejected += 1;
        continue;
      }
      if (cutoffValid && isStrictlyAfter(plan.knowledgeCutoff, cutoff)) {
        reasons.add('EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF');
        counts.excludedAfterCutoff += 1;
        continue;
      }
      if (admitted.has(id)) {
        reasons.add('DUPLICATE_EVENT_VERSION');
        counts.rejected += 1;
        continue;
      }
      admitted.add(id);
      counts.admitted += 1;
      if (status === 'INSUFFICIENT_EVIDENCE') counts.insufficient += 1;
      else if (status === 'UNAVAILABLE') counts.unavailable += 1;
      else counts.assessed += 1;
    }
  }

  if (Array.isArray(plans) && counts.admitted === 0) reasons.add('NO_EVENT_PLANS');
  if (counts.unavailable > 0) reasons.add('EVENT_PLAN_UNAVAILABLE');
  if (counts.assessed > 0) reasons.add('AGGREGATION_RULE_NOT_APPROVED');
  const blocked = [...reasons].some((reason) => !INFORMATIONAL.has(reason));
  if (!blocked && counts.admitted > 0 && counts.insufficient === counts.admitted) {
    reasons.add('ALL_EVENTS_INSUFFICIENT');
  }
  const status = reasons.has('ALL_EVENTS_INSUFFICIENT') ? 'INSUFFICIENT_EVIDENCE' : 'UNAVAILABLE';

  return {
    schemaVersion: EVENT_AGGREGATION_SCHEMA_VERSION,
    algorithmVersion: EVENT_AGGREGATION_ALGORITHM_VERSION,
    kind,
    knowledgeCutoff: cutoff,
    summary: { algorithmVersion: expectedVersion, status, knowledgeCutoff: cutoff },
    reasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)),
    eventVersionIds: [...admitted].sort(compareCodeUnits),
    counts,
  };
}
