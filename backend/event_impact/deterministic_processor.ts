/**
 * =============================================================================
 * ALPHA-XAU — deterministic Event Impact domain processor (CES V1/V2 gate).
 *
 * This module is deliberately pure and side-effect free. It consumes one
 * already-persisted Event Version and produces a persistence-ready domain
 * plan. It never reads a database, the application clock, environment
 * variables, market data, legacy article scores, Committee output, or an LLM.
 *
 * V1 is intentionally conservative. The current canonical Event Version
 * state contains factual `event_type`, `subject`, and `detail` only. Those
 * facts do not establish a defensible gold direction, affected horizon,
 * magnitude, confidence, or pricing state without the separate Gold
 * Transmission and Market Pricing stages. A valid schema-v1 Event Version
 * therefore produces INSUFFICIENT_EVIDENCE with zero interpretations.
 *
 * A future positive directional rule requires a separately reviewed processor
 * version. V1 never scans subject/detail for market keywords and never turns
 * an unsupported canonical schema into an invented assessment.
 * =============================================================================
 */

export const EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION =
  'event-impact-deterministic-processor-v2' as const;

export const SUPPORTED_CANONICAL_EVENT_STATE_SCHEMA_VERSION = 2 as const;

export type EventTransition = 'NOVELTY' | 'CONFIRMATION' | 'CORRECTION' | 'REVERSAL';

export type OfficialConfirmationState =
  | 'UNCONFIRMED'
  | 'SECONDARY_CONFIRMED'
  | 'OFFICIALLY_CONFIRMED'
  | 'OFFICIALLY_CORRECTED'
  | 'OFFICIALLY_REVERSED';

export type SourceIndependenceState =
  | 'UNKNOWN'
  | 'SINGLE_EDITORIAL_ORIGIN'
  | 'SYNDICATED_ONLY'
  | 'INDEPENDENTLY_CORROBORATED';

export type CanonicalEventType =
  | 'MONETARY_POLICY_COMMUNICATION'
  | 'OFFICIAL_SPEECH'
  | 'CENTRAL_BANK_COMMUNICATION'
  | 'STATISTICAL_RELEASE'
  | 'OFFICIAL_PRESS_RELEASE'
  | 'SANCTIONS_ACTION';

export interface CanonicalEventStateV1 {
  readonly event_type: CanonicalEventType;
  readonly subject: string;
  readonly detail: string | null;
}

/**
 * Explicit adapter boundary. A later orchestration PR must map the selected
 * database row into this shape rather than pass a broad, drifting row object.
 */
export interface PersistedEventVersionForImpact {
  readonly id: string;
  readonly clusterId: string;
  readonly versionNumber: number;
  readonly transitionType: EventTransition;
  readonly knowledgeCutoff: string;
  readonly effectiveTime: string | null;
  readonly effectiveTimePrecision: string | null;
  readonly canonicalEventStateSchemaVersion: number;
  readonly canonicalEventState: unknown;
  readonly officialConfirmationState: OfficialConfirmationState;
  readonly sourceIndependenceState: SourceIndependenceState;
  readonly supersedesVersionId: string | null;
  readonly stateFingerprint: string;
}

export interface EventImpactProcessorInput {
  readonly eventVersion: PersistedEventVersionForImpact;
}

// Full downstream interpretation vocabulary is declared here so the domain
// boundary matches the already-live schema. V1 deliberately emits none.
export type EventImpactHorizon = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'structural_tail';
export type EventImpactDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';
export type EventImpactMagnitudeState = 'UNASSESSED' | 'UNKNOWN' | 'ESTIMATED';
export type EventImpactConfidenceState = 'UNASSESSED' | 'UNKNOWN' | 'ESTIMATED';
export type EventImpactPricingState =
  | 'UNASSESSED'
  | 'UNPRICED'
  | 'PARTIALLY_PRICED'
  | 'LARGELY_PRICED'
  | 'UNCERTAIN';
export type EventImpactInterpretationRole = 'PRIMARY' | 'ALTERNATIVE';

export interface EventImpactInterpretationDraft {
  readonly horizon: EventImpactHorizon;
  readonly interpretation_key: string;
  readonly interpretation_role: EventImpactInterpretationRole;
  readonly direction: EventImpactDirection;
  readonly magnitude_state: EventImpactMagnitudeState;
  readonly magnitude_value: number | null;
  readonly magnitude_unit: string | null;
  readonly magnitude_basis: string | null;
  readonly confidence_state: EventImpactConfidenceState;
  readonly confidence_value: number | null;
  readonly pricing_state: EventImpactPricingState;
  readonly rationale: string | null;
}

export type EventImpactAssessmentStatus =
  | 'ASSESSED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNAVAILABLE';

export type EventImpactAssessmentReason =
  | 'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE'
  | 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA';

export interface EventImpactProcessPlan {
  readonly kind: 'PROCESS';
  readonly processorVersion: typeof EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION;
  readonly eventVersionId: string;
  readonly canonicalEventStateSchemaVersion: number;
  readonly producerType: 'DETERMINISTIC';
  readonly algorithmVersion: typeof EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION;
  readonly knowledgeCutoff: string;
  readonly assessmentStatus: EventImpactAssessmentStatus;
  readonly assessmentReason: EventImpactAssessmentReason;
  readonly interpretations: readonly EventImpactInterpretationDraft[];
}

export type EventImpactAbstention = 'INVALID_INPUT';

export interface EventImpactAbstainPlan {
  readonly kind: 'ABSTAIN';
  readonly processorVersion: typeof EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION;
  readonly eventVersionId: string | null;
  readonly abstention: EventImpactAbstention;
  readonly reason: string;
}

export type EventImpactProcessingPlan = EventImpactProcessPlan | EventImpactAbstainPlan;

const EVENT_VERSION_KEYS = [
  'id',
  'clusterId',
  'versionNumber',
  'transitionType',
  'knowledgeCutoff',
  'effectiveTime',
  'effectiveTimePrecision',
  'canonicalEventStateSchemaVersion',
  'canonicalEventState',
  'officialConfirmationState',
  'sourceIndependenceState',
  'supersedesVersionId',
  'stateFingerprint',
] as const;

const CANONICAL_EVENT_STATE_V1_KEYS = ['detail', 'event_type', 'subject'] as const;
const CPI_CODES = new Set(['CPI_CORE_MOM', 'CPI_CORE_YOY', 'CPI_HEADLINE_MOM', 'CPI_HEADLINE_YOY']);
const CPI_MOM_CODES = new Set(['CPI_CORE_MOM', 'CPI_HEADLINE_MOM']);

const EVENT_TRANSITIONS: ReadonlySet<string> = new Set([
  'NOVELTY', 'CONFIRMATION', 'CORRECTION', 'REVERSAL',
]);

const OFFICIAL_CONFIRMATION_STATES: ReadonlySet<string> = new Set([
  'UNCONFIRMED',
  'SECONDARY_CONFIRMED',
  'OFFICIALLY_CONFIRMED',
  'OFFICIALLY_CORRECTED',
  'OFFICIALLY_REVERSED',
]);

const SOURCE_INDEPENDENCE_STATES: ReadonlySet<string> = new Set([
  'UNKNOWN',
  'SINGLE_EDITORIAL_ORIGIN',
  'SYNDICATED_ONLY',
  'INDEPENDENTLY_CORROBORATED',
]);

const CANONICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'MONETARY_POLICY_COMMUNICATION',
  'OFFICIAL_SPEECH',
  'CENTRAL_BANK_COMMUNICATION',
  'STATISTICAL_RELEASE',
  'OFFICIAL_PRESS_RELEASE',
  'SANCTIONS_ACTION',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const EMPTY_INTERPRETATIONS: readonly EventImpactInterpretationDraft[] = Object.freeze([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isCanonicalNonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && normalizeWhitespace(value) === value;
}

function validateCanonicalEventStateV2(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['detail', 'event_type', 'facts', 'subject'])
      || value.event_type !== 'STATISTICAL_RELEASE' || !isCanonicalNonBlankText(value.subject)
      || value.detail !== null || !isRecord(value.facts)
      || !hasExactKeys(value.facts, ['metrics', 'release_family'])
      || value.facts.release_family !== 'US_CPI' || !Array.isArray(value.facts.metrics)
      || value.facts.metrics.length !== 4) return false;
  const seen = new Set<string>();
  let period = '';
  for (const item of value.facts.metrics) {
    if (!isRecord(item) || !hasExactKeys(item, ['actual', 'consensus', 'metric_code', 'prior_periods', 'reference_period', 'unit'])
        || typeof item.metric_code !== 'string' || !CPI_CODES.has(item.metric_code)
        || seen.has(item.metric_code) || !isRecord(item.reference_period)
        || !hasExactKeys(item.reference_period, ['kind', 'month', 'year'])
        || item.reference_period.kind !== 'MONTH' || !Number.isInteger(item.reference_period.year)
        || (item.reference_period.year as number) < 1900 || (item.reference_period.year as number) > 9999
        || !Number.isInteger(item.reference_period.month) || (item.reference_period.month as number) < 1
        || (item.reference_period.month as number) > 12) return false;
    const expectedUnit = CPI_MOM_CODES.has(item.metric_code) ? 'PERCENT_CHANGE_MOM' : 'PERCENT_CHANGE_YOY';
    const nextPeriod = `${item.reference_period.year}-${item.reference_period.month}`;
    if (item.unit !== expectedUnit || (period !== '' && period !== nextPeriod)) return false;
    period = nextPeriod;
    if (!isRecord(item.actual) || !hasExactKeys(item.actual, ['state', 'value'])
        || item.actual.state !== 'KNOWN' || typeof item.actual.value !== 'string'
        || !/^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(item.actual.value)
        || item.actual.value === '-0' || !isRecord(item.consensus)
        || !hasExactKeys(item.consensus, ['state', 'value'])
        || item.consensus.state !== 'UNKNOWN' || item.consensus.value !== null
        || !Array.isArray(item.prior_periods) || item.prior_periods.length !== 0) return false;
    seen.add(item.metric_code);
  }
  return seen.size === 4;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

/** Validate a supplied timestamp without converting it or losing microseconds. */
function isStrictTimestampWithTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  const timezone = match[7];
  if (timezone !== 'Z') {
    const offset = /^[+-](\d{2}):?(\d{2})$/.exec(timezone);
    if (offset === null || Number(offset[1]) > 23 || Number(offset[2]) > 59) return false;
  }
  return true;
}

function candidateEventVersionId(input: unknown): string | null {
  if (!isRecord(input) || !isRecord(input.eventVersion)) return null;
  return isUuid(input.eventVersion.id) ? input.eventVersion.id : null;
}

function abstain(input: unknown, reason: string): EventImpactAbstainPlan {
  return {
    kind: 'ABSTAIN',
    processorVersion: EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
    eventVersionId: candidateEventVersionId(input),
    abstention: 'INVALID_INPUT',
    reason,
  };
}

function validateCommonEventVersion(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, EVENT_VERSION_KEYS)) return 'INVALID_EVENT_VERSION_SHAPE';
  if (!isUuid(value.id)) return 'INVALID_EVENT_VERSION_ID';
  if (!isUuid(value.clusterId)) return 'INVALID_CLUSTER_ID';
  if (!Number.isInteger(value.versionNumber) || (value.versionNumber as number) <= 0) {
    return 'INVALID_VERSION_NUMBER';
  }
  if (typeof value.transitionType !== 'string' || !EVENT_TRANSITIONS.has(value.transitionType)) {
    return 'INVALID_TRANSITION_TYPE';
  }
  if (!isStrictTimestampWithTimezone(value.knowledgeCutoff)) return 'INVALID_KNOWLEDGE_CUTOFF';
  if (value.effectiveTime !== null && !isStrictTimestampWithTimezone(value.effectiveTime)) {
    return 'INVALID_EFFECTIVE_TIME';
  }
  if (value.effectiveTime === null) {
    if (value.effectiveTimePrecision !== null) return 'INVALID_EFFECTIVE_TIME_PRECISION';
  } else if (!isCanonicalNonBlankText(value.effectiveTimePrecision)) {
    return 'INVALID_EFFECTIVE_TIME_PRECISION';
  }
  if (!Number.isInteger(value.canonicalEventStateSchemaVersion)
      || (value.canonicalEventStateSchemaVersion as number) <= 0) {
    return 'INVALID_CANONICAL_EVENT_STATE_SCHEMA_VERSION';
  }
  if (typeof value.officialConfirmationState !== 'string'
      || !OFFICIAL_CONFIRMATION_STATES.has(value.officialConfirmationState)) {
    return 'INVALID_OFFICIAL_CONFIRMATION_STATE';
  }
  if (typeof value.sourceIndependenceState !== 'string'
      || !SOURCE_INDEPENDENCE_STATES.has(value.sourceIndependenceState)) {
    return 'INVALID_SOURCE_INDEPENDENCE_STATE';
  }
  if (value.supersedesVersionId !== null && !isUuid(value.supersedesVersionId)) {
    return 'INVALID_SUPERSEDES_VERSION_ID';
  }
  if (typeof value.stateFingerprint !== 'string'
      || !SHA256_HEX_PATTERN.test(value.stateFingerprint)) {
    return 'INVALID_STATE_FINGERPRINT';
  }
  return null;
}

function validateCanonicalEventStateV1(value: unknown): value is CanonicalEventStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, CANONICAL_EVENT_STATE_V1_KEYS)) return false;
  if (typeof value.event_type !== 'string' || !CANONICAL_EVENT_TYPES.has(value.event_type)) return false;
  if (!isCanonicalNonBlankText(value.subject)) return false;
  if (value.detail !== null && !isCanonicalNonBlankText(value.detail)) return false;
  return true;
}

function processPlan(
  eventVersion: Record<string, unknown>,
  assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE',
  assessmentReason: EventImpactAssessmentReason,
): EventImpactProcessPlan {
  return {
    kind: 'PROCESS',
    processorVersion: EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
    eventVersionId: eventVersion.id as string,
    canonicalEventStateSchemaVersion: eventVersion.canonicalEventStateSchemaVersion as number,
    producerType: 'DETERMINISTIC',
    algorithmVersion: EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
    knowledgeCutoff: eventVersion.knowledgeCutoff as string,
    assessmentStatus,
    assessmentReason,
    interpretations: EMPTY_INTERPRETATIONS,
  };
}

/**
 * Produce a deterministic Event Impact plan from exactly one Event Version.
 * Malformed input abstains. A well-formed but future canonical schema produces
 * UNAVAILABLE so the inability can later be persisted explicitly rather than
 * silently skipped. Current schema v1 produces INSUFFICIENT_EVIDENCE because
 * no defensible impact interpretation exists before Gold Transmission.
 */
export function planDeterministicEventImpact(input: unknown): EventImpactProcessingPlan {
  if (!isRecord(input) || !hasExactKeys(input, ['eventVersion']) || !isRecord(input.eventVersion)) {
    return abstain(input, 'INVALID_INPUT_SHAPE');
  }

  const eventVersion = input.eventVersion;
  const commonError = validateCommonEventVersion(eventVersion);
  if (commonError !== null) return abstain(input, commonError);

  if ((eventVersion.canonicalEventStateSchemaVersion as number)
      > SUPPORTED_CANONICAL_EVENT_STATE_SCHEMA_VERSION) {
    return processPlan(
      eventVersion,
      'UNAVAILABLE',
      'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA',
    );
  }

  if (eventVersion.canonicalEventStateSchemaVersion === 1
      && !validateCanonicalEventStateV1(eventVersion.canonicalEventState)) {
    return abstain(input, 'INVALID_CANONICAL_EVENT_STATE_V1');
  }
  if (eventVersion.canonicalEventStateSchemaVersion === 2
      && !validateCanonicalEventStateV2(eventVersion.canonicalEventState)) {
    return abstain(input, 'INVALID_CANONICAL_EVENT_STATE_V2');
  }

  return processPlan(
    eventVersion,
    'INSUFFICIENT_EVIDENCE',
    'GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE',
  );
}
