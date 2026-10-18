/**
 * EIA-0 shared aggregation, used by the v1 contract (`contract.ts`) and the
 * v2 release-gate contract (`release_gate_contract.ts`). Not a contract
 * itself: it exports no version and is not meant to be called directly.
 */

import { EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION } from '../event_impact/deterministic_processor.js';
import { GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION } from '../gold_transmission/deterministic_processor.js';
import { isStrictTimestamp, isStrictlyAfter } from '../shared/strict_timestamp.js';

export type EventAggregationKind = 'EVENT_IMPACT' | 'GOLD_TRANSMISSION';

/** Every reason either contract can report; v1 reports only its own subset. */
export type AggregationReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'INVALID_PLAN_SET'
  | 'INVALID_RELEASE_SET'
  | 'NO_EVENT_PLANS'
  | 'INVALID_EVENT_PLAN'
  | 'EVENT_PLAN_ABSTAINED'
  | 'EVENT_PLAN_VERSION_MISMATCH'
  | 'DUPLICATE_EVENT_VERSION'
  | 'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF'
  | 'EVENT_PLAN_BEFORE_OFFICIAL_RELEASE'
  | 'RELEASE_INSTANT_MISSING'
  | 'EVENT_PLAN_UNAVAILABLE'
  | 'ALL_EVENTS_INSUFFICIENT'
  | 'AGGREGATION_RULE_NOT_APPROVED';

export const PROCESSOR_VERSION: Readonly<Record<EventAggregationKind, string>> = {
  EVENT_IMPACT: EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
  GOLD_TRANSMISSION: GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION,
};

/** Statuses each processor can emit for a processed event. */
const PLAN_STATUSES: Readonly<Record<EventAggregationKind, readonly string[]>> = {
  EVENT_IMPACT: ['ASSESSED', 'INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'],
  GOLD_TRANSMISSION: ['INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'],
};

/** Reasons that do not make the summary UNAVAILABLE on their own. */
const INFORMATIONAL: ReadonlySet<AggregationReasonCode> = new Set([
  'EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF', 'EVENT_PLAN_BEFORE_OFFICIAL_RELEASE', 'ALL_EVENTS_INSUFFICIENT',
]);

const RELEASE_KEYS = ['eventVersionId', 'publishedAt'] as const;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Release evidence (v2): a map from event version ID to publication instant,
 * or null when the set is not an array of exactly `{ eventVersionId, publishedAt }`
 * records with a non-empty ID, a strict instant and no duplicate ID.
 */
export function releaseInstants(releases: unknown): Map<string, string> | null {
  try {
    if (!Array.isArray(releases)) return null;
    const instants = new Map<string, string>();
    for (const entry of releases) {
      if (!isRecord(entry) || Object.keys(entry).length !== RELEASE_KEYS.length
          || !RELEASE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(entry, key))) {
        return null;
      }
      const { eventVersionId, publishedAt } = entry;
      if (typeof eventVersionId !== 'string' || eventVersionId.length === 0
          || !isStrictTimestamp(publishedAt) || instants.has(eventVersionId)) {
        return null;
      }
      instants.set(eventVersionId, publishedAt);
    }
    return instants;
  } catch {
    return null; // hostile accessors are an invalid evidence set, never a throw
  }
}

export interface AggregationCore {
  readonly reasons: Set<AggregationReasonCode>;
  readonly cutoff: string;
  readonly expectedVersion: string;
  readonly admitted: Set<string>;
  readonly counts: { received: number; admitted: number; excludedAfterCutoff: number; insufficient: number;
    unavailable: number; assessed: number; rejected: number };
  readonly release: { excludedBeforeOfficialRelease: number; missingReleaseInstant: number; used: Set<string> };
}

/**
 * The aggregation shared by v1 and v2. With `instants` undefined (v1) no
 * release check runs. With a map (v2) each plan still admissible after the v1
 * checks must have an instant, and is excluded if its cutoff precedes it.
 * With null (v2, invalid evidence set) no plan is admitted.
 */
export function aggregateCore(
  kind: EventAggregationKind,
  plans: unknown,
  knowledgeCutoff: unknown,
  instants: Map<string, string> | null | undefined,
): AggregationCore {
  const reasons = new Set<AggregationReasonCode>();
  const cutoffValid = isStrictTimestamp(knowledgeCutoff);
  if (!cutoffValid) reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  const cutoff = typeof knowledgeCutoff === 'string' ? knowledgeCutoff : '';
  const expectedVersion = PROCESSOR_VERSION[kind];
  if (instants === null) reasons.add('INVALID_RELEASE_SET');

  const counts = { received: 0, admitted: 0, excludedAfterCutoff: 0, insufficient: 0, unavailable: 0, assessed: 0, rejected: 0 };
  const release = { excludedBeforeOfficialRelease: 0, missingReleaseInstant: 0, used: new Set<string>() };
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
      if (instants === null) {
        counts.rejected += 1;
        continue;
      }
      if (instants !== undefined) {
        const publishedAt = instants.get(id);
        if (publishedAt === undefined) {
          reasons.add('RELEASE_INSTANT_MISSING');
          release.missingReleaseInstant += 1;
          counts.rejected += 1;
          continue;
        }
        release.used.add(id);
        if (isStrictlyAfter(publishedAt, plan.knowledgeCutoff)) {
          reasons.add('EVENT_PLAN_BEFORE_OFFICIAL_RELEASE');
          release.excludedBeforeOfficialRelease += 1;
          continue;
        }
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
  return { reasons, cutoff, expectedVersion, admitted, counts, release };
}

export const statusOf = (core: AggregationCore): 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE' =>
  core.reasons.has('ALL_EVENTS_INSUFFICIENT') ? 'INSUFFICIENT_EVIDENCE' : 'UNAVAILABLE';
