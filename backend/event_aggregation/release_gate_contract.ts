/**
 * EIA-0 v2 (B3): the EIA-0 aggregation with the official publication instant
 * of every event version required as explicit caller evidence. A plan whose
 * cutoff precedes its event's release is excluded; an admitted plan without
 * evidence, or an invalid evidence set, makes the summary UNAVAILABLE. The
 * summary keeps the S-0 shape. v1 (`contract.ts`) is unchanged.
 *
 * Offline qualification only: not wired into any runtime or into CHAIN-0.
 */

import type { EventAggregationEnvelope, EventAggregationReasonCode, EventAggregationSummary } from './contract.js';
import { aggregateCore, compareCodeUnits, releaseInstants, statusOf, type EventAggregationKind } from './core.js';

export const EVENT_AGGREGATION_V2_SCHEMA_VERSION = 'xau.event-plan-aggregation.v2' as const;
export const EVENT_AGGREGATION_V2_ALGORITHM_VERSION = 'event-plan-aggregation-release-gate-2.0.0' as const;

export type EventAggregationV2ReasonCode =
  | EventAggregationReasonCode
  | 'INVALID_RELEASE_SET'
  | 'RELEASE_INSTANT_MISSING'
  | 'EVENT_PLAN_BEFORE_OFFICIAL_RELEASE';

/** Official publication instant of one event version, supplied by the caller (v2). */
export interface EventOfficialRelease {
  readonly eventVersionId: string;
  readonly publishedAt: string;
}

export interface EventAggregationV2Envelope {
  readonly schemaVersion: typeof EVENT_AGGREGATION_V2_SCHEMA_VERSION;
  readonly algorithmVersion: typeof EVENT_AGGREGATION_V2_ALGORITHM_VERSION;
  readonly kind: EventAggregationKind;
  readonly knowledgeCutoff: string;
  readonly releaseEvidence: 'REQUIRED';
  /** Exactly the S-0 input shape for this kind, as in v1. */
  readonly summary: EventAggregationSummary;
  readonly reasonCodes: readonly EventAggregationV2ReasonCode[];
  readonly eventVersionIds: readonly string[];
  readonly counts: EventAggregationEnvelope['counts'] & {
    readonly excludedBeforeOfficialRelease: number;
    readonly missingReleaseInstant: number;
    readonly releasesUnused: number;
  };
}

const V2_REASON_ORDER: readonly EventAggregationV2ReasonCode[] = [
  'INVALID_KNOWLEDGE_CUTOFF', 'INVALID_PLAN_SET', 'INVALID_RELEASE_SET', 'NO_EVENT_PLANS', 'INVALID_EVENT_PLAN',
  'EVENT_PLAN_ABSTAINED', 'EVENT_PLAN_VERSION_MISMATCH', 'DUPLICATE_EVENT_VERSION',
  'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'EVENT_PLAN_BEFORE_OFFICIAL_RELEASE', 'RELEASE_INSTANT_MISSING',
  'EVENT_PLAN_UNAVAILABLE', 'ALL_EVENTS_INSUFFICIENT', 'AGGREGATION_RULE_NOT_APPROVED',
];

/**
 * v2 (B3). As v1, with the official publication instant of every event
 * version required: a plan whose cutoff precedes it is excluded (exact to the
 * nanosecond); an admitted plan without one, or an invalid evidence set, makes
 * the summary UNAVAILABLE. Never throws.
 */
export function aggregateEventPlansWithOfficialRelease(
  kind: EventAggregationKind,
  plans: unknown,
  releases: unknown,
  knowledgeCutoff: unknown,
): EventAggregationV2Envelope {
  const instants = releaseInstants(releases);
  const core = aggregateCore(kind, plans, knowledgeCutoff, instants);
  return {
    schemaVersion: EVENT_AGGREGATION_V2_SCHEMA_VERSION,
    algorithmVersion: EVENT_AGGREGATION_V2_ALGORITHM_VERSION,
    kind,
    knowledgeCutoff: core.cutoff,
    releaseEvidence: 'REQUIRED',
    summary: { algorithmVersion: core.expectedVersion, status: statusOf(core), knowledgeCutoff: core.cutoff },
    reasonCodes: V2_REASON_ORDER.filter((reason) => core.reasons.has(reason)),
    eventVersionIds: [...core.admitted].sort(compareCodeUnits),
    counts: {
      received: core.counts.received,
      admitted: core.counts.admitted,
      excludedAfterCutoff: core.counts.excludedAfterCutoff,
      excludedBeforeOfficialRelease: core.release.excludedBeforeOfficialRelease,
      missingReleaseInstant: core.release.missingReleaseInstant,
      releasesUnused: instants === null ? 0 : instants.size - core.release.used.size,
      insufficient: core.counts.insufficient,
      unavailable: core.counts.unavailable,
      assessed: core.counts.assessed,
      rejected: core.counts.rejected,
    },
  };
}
