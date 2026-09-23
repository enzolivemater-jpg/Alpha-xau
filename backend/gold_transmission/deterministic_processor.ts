/**
 * Gold Transmission deterministic processor V1.
 *
 * Pure and side-effect free: no database, clock, environment, market fetch,
 * legacy score, Committee output, or LLM. Canonical Event State V1 contains
 * descriptive text but no typed actual/forecast/previous/unit facts, so V1
 * fails closed with an explicit zero-path assessment. It never mines prose
 * for market keywords and never fabricates a transmission chain.
 */

export const GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION =
  'gold-transmission-deterministic-processor-v1' as const;

export const GOLD_TRANSMISSION_SUPPORTED_EVENT_SCHEMA_VERSION = 1 as const;

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

export interface PersistedEventVersionForGoldTransmission {
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

export interface GoldTransmissionProcessorInput {
  readonly eventVersion: PersistedEventVersionForGoldTransmission;
}

export type GoldTransmissionChannel =
  | 'NOMINAL_YIELDS'
  | 'REAL_YIELDS'
  | 'USD'
  | 'MONETARY_POLICY_EXPECTATIONS'
  | 'INFLATION_EXPECTATIONS'
  | 'RISK_OFF_SAFE_HAVEN'
  | 'LIQUIDITY'
  | 'GEOPOLITICAL_RISK'
  | 'POSITIONING_CROWDING'
  | 'PHYSICAL_ETF_STRUCTURAL_DEMAND'
  | 'VOLATILITY';
export type GoldTransmissionMarketVariable =
  | 'NOMINAL_YIELD'
  | 'REAL_YIELD'
  | 'USD'
  | 'POLICY_RATE_EXPECTATIONS'
  | 'INFLATION_EXPECTATIONS'
  | 'SAFE_HAVEN_DEMAND'
  | 'LIQUIDITY'
  | 'GEOPOLITICAL_RISK'
  | 'POSITIONING'
  | 'PHYSICAL_DEMAND'
  | 'ETF_DEMAND'
  | 'VOLATILITY';
export type GoldTransmissionVariableEffect = 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
export type GoldTransmissionGoldEffect = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';
export type GoldTransmissionConfidenceState = 'UNASSESSED' | 'UNKNOWN' | 'ESTIMATED';

export interface GoldTransmissionPathDraft {
  readonly path_key: string;
  readonly transmission_channel: GoldTransmissionChannel;
  readonly market_variable: GoldTransmissionMarketVariable;
  readonly variable_effect: GoldTransmissionVariableEffect;
  readonly gold_effect: GoldTransmissionGoldEffect;
  readonly confidence_state: GoldTransmissionConfidenceState;
  readonly confidence_value: number | null;
  readonly rationale: string | null;
  readonly driver_evidence: readonly never[];
}

export type GoldTransmissionAssessmentReason =
  | 'TYPED_EVENT_FACTS_UNAVAILABLE'
  | 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA';

export interface GoldTransmissionProcessPlan {
  readonly kind: 'PROCESS';
  readonly processorVersion: typeof GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION;
  readonly eventVersionId: string;
  readonly canonicalEventStateSchemaVersion: number;
  readonly producerType: 'DETERMINISTIC';
  readonly algorithmVersion: typeof GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION;
  readonly knowledgeCutoff: string;
  readonly assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
  readonly assessmentReason: GoldTransmissionAssessmentReason;
  readonly paths: readonly GoldTransmissionPathDraft[];
}

export interface GoldTransmissionAbstainPlan {
  readonly kind: 'ABSTAIN';
  readonly processorVersion: typeof GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION;
  readonly eventVersionId: string | null;
  readonly abstention: 'INVALID_INPUT';
  readonly reason: string;
}

export type GoldTransmissionProcessingPlan =
  | GoldTransmissionProcessPlan
  | GoldTransmissionAbstainPlan;

const EVENT_VERSION_KEYS = [
  'id', 'clusterId', 'versionNumber', 'transitionType', 'knowledgeCutoff',
  'effectiveTime', 'effectiveTimePrecision', 'canonicalEventStateSchemaVersion',
  'canonicalEventState', 'officialConfirmationState', 'sourceIndependenceState',
  'supersedesVersionId', 'stateFingerprint',
] as const;
const CANONICAL_STATE_KEYS = ['detail', 'event_type', 'subject'] as const;
const EVENT_TRANSITIONS = new Set<string>(['NOVELTY', 'CONFIRMATION', 'CORRECTION', 'REVERSAL']);
const CONFIRMATION_STATES = new Set<string>([
  'UNCONFIRMED', 'SECONDARY_CONFIRMED', 'OFFICIALLY_CONFIRMED',
  'OFFICIALLY_CORRECTED', 'OFFICIALLY_REVERSED',
]);
const INDEPENDENCE_STATES = new Set<string>([
  'UNKNOWN', 'SINGLE_EDITORIAL_ORIGIN', 'SYNDICATED_ONLY', 'INDEPENDENTLY_CORROBORATED',
]);
const EVENT_TYPES = new Set<string>([
  'MONETARY_POLICY_COMMUNICATION', 'OFFICIAL_SPEECH', 'CENTRAL_BANK_COMMUNICATION',
  'STATISTICAL_RELEASE', 'OFFICIAL_PRESS_RELEASE', 'SANCTIONS_ACTION',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EMPTY_PATHS: readonly GoldTransmissionPathDraft[] = Object.freeze([]);

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

function isCanonicalText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim().replace(/\s+/g, ' ') === value;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isTimestampWithTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
      || hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== 'Z') {
    const offset = /^[+-](\d{2}):?(\d{2})$/.exec(match[7]);
    if (offset === null || Number(offset[1]) > 23 || Number(offset[2]) > 59) return false;
  }
  return true;
}

function candidateEventVersionId(input: unknown): string | null {
  if (!isRecord(input) || !isRecord(input.eventVersion)) return null;
  return isUuid(input.eventVersion.id) ? input.eventVersion.id : null;
}

function abstain(input: unknown, reason: string): GoldTransmissionAbstainPlan {
  return {
    kind: 'ABSTAIN',
    processorVersion: GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION,
    eventVersionId: candidateEventVersionId(input),
    abstention: 'INVALID_INPUT',
    reason,
  };
}

function validateEventVersion(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, EVENT_VERSION_KEYS)) return 'INVALID_EVENT_VERSION_SHAPE';
  if (!isUuid(value.id)) return 'INVALID_EVENT_VERSION_ID';
  if (!isUuid(value.clusterId)) return 'INVALID_CLUSTER_ID';
  if (!Number.isInteger(value.versionNumber) || (value.versionNumber as number) <= 0) return 'INVALID_VERSION_NUMBER';
  if (typeof value.transitionType !== 'string' || !EVENT_TRANSITIONS.has(value.transitionType)) return 'INVALID_TRANSITION_TYPE';
  if (!isTimestampWithTimezone(value.knowledgeCutoff)) return 'INVALID_KNOWLEDGE_CUTOFF';
  if (value.effectiveTime === null) {
    if (value.effectiveTimePrecision !== null) return 'INVALID_EFFECTIVE_TIME_PRECISION';
  } else if (!isTimestampWithTimezone(value.effectiveTime) || !isCanonicalText(value.effectiveTimePrecision)) {
    return 'INVALID_EFFECTIVE_TIME';
  }
  if (!Number.isInteger(value.canonicalEventStateSchemaVersion)
      || (value.canonicalEventStateSchemaVersion as number) <= 0) return 'INVALID_CANONICAL_EVENT_STATE_SCHEMA_VERSION';
  if (typeof value.officialConfirmationState !== 'string'
      || !CONFIRMATION_STATES.has(value.officialConfirmationState)) return 'INVALID_OFFICIAL_CONFIRMATION_STATE';
  if (typeof value.sourceIndependenceState !== 'string'
      || !INDEPENDENCE_STATES.has(value.sourceIndependenceState)) return 'INVALID_SOURCE_INDEPENDENCE_STATE';
  if (value.supersedesVersionId !== null && !isUuid(value.supersedesVersionId)) return 'INVALID_SUPERSEDES_VERSION_ID';
  if (typeof value.stateFingerprint !== 'string' || !SHA256_PATTERN.test(value.stateFingerprint)) return 'INVALID_STATE_FINGERPRINT';
  return null;
}

function isCanonicalStateV1(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, CANONICAL_STATE_KEYS)
    && typeof value.event_type === 'string'
    && EVENT_TYPES.has(value.event_type)
    && isCanonicalText(value.subject)
    && (value.detail === null || isCanonicalText(value.detail));
}

function processPlan(
  eventVersion: Record<string, unknown>,
  assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE',
  assessmentReason: GoldTransmissionAssessmentReason,
): GoldTransmissionProcessPlan {
  return {
    kind: 'PROCESS',
    processorVersion: GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION,
    eventVersionId: eventVersion.id as string,
    canonicalEventStateSchemaVersion: eventVersion.canonicalEventStateSchemaVersion as number,
    producerType: 'DETERMINISTIC',
    algorithmVersion: GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION,
    knowledgeCutoff: eventVersion.knowledgeCutoff as string,
    assessmentStatus,
    assessmentReason,
    paths: EMPTY_PATHS,
  };
}

export function planDeterministicGoldTransmission(input: unknown): GoldTransmissionProcessingPlan {
  if (!isRecord(input) || !hasExactKeys(input, ['eventVersion']) || !isRecord(input.eventVersion)) {
    return abstain(input, 'INVALID_INPUT_SHAPE');
  }
  const eventVersion = input.eventVersion;
  const error = validateEventVersion(eventVersion);
  if (error !== null) return abstain(input, error);
  if (eventVersion.canonicalEventStateSchemaVersion
      !== GOLD_TRANSMISSION_SUPPORTED_EVENT_SCHEMA_VERSION) {
    return processPlan(eventVersion, 'UNAVAILABLE', 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA');
  }
  if (!isCanonicalStateV1(eventVersion.canonicalEventState)) {
    return abstain(input, 'INVALID_CANONICAL_EVENT_STATE_V1');
  }
  return processPlan(eventVersion, 'INSUFFICIENT_EVIDENCE', 'TYPED_EVENT_FACTS_UNAVAILABLE');
}
