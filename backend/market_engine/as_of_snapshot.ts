/**
 * Deterministic Market Pricing MP-1 historical as-of selector.
 *
 * This module is storage- and provider-independent. The caller must supply an
 * explicit observation history carrying both source and ingestion timestamps.
 * It never reads a clock, database, network, environment variable or provider.
 */

export const MARKET_PRICING_AS_OF_SCHEMA_VERSION = 'xau.market-pricing-as-of.v1' as const;
export const MARKET_PRICING_AS_OF_ALGORITHM_VERSION = 'market-pricing-as-of-selector-1.0.0' as const;

export const MARKET_PRICING_AS_OF_FIELDS = [
  'spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti',
] as const;

export type MarketPricingAsOfFieldName = typeof MARKET_PRICING_AS_OF_FIELDS[number];
export type MarketPricingAsOfState = 'AS_OF_AVAILABLE' | 'DEGRADED' | 'ABSTAIN';

export type MarketPricingAsOfReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'INVALID_CANDIDATE_HISTORY'
  | 'AMBIGUOUS_CANDIDATE_IDENTITY'
  | 'OBSERVATION_AFTER_INGESTION'
  | 'LOOKAHEAD_CANDIDATE'
  | 'AMBIGUOUS_TOP_OBSERVATION'
  | 'SPOT_UNAVAILABLE_AS_OF'
  | 'OPTIONAL_FIELD_UNAVAILABLE_AS_OF'
  | 'BOOK_INVERTED';

export interface MarketPricingAsOfCandidate {
  /** Stable evidence identifier supplied by the history owner. */
  readonly candidateId: string;
  readonly field: MarketPricingAsOfFieldName;
  readonly value: number;
  readonly source: string;
  /** Timestamp published by the source. */
  readonly observedAt: string;
  /** First timestamp at which this exact evidence became known to the system. */
  readonly ingestedAt: string;
  /** Optional provider revision identifier or retained-evidence digest. */
  readonly evidenceRevision?: string;
}

export interface SelectedMarketPricingObservation extends MarketPricingAsOfCandidate {
  /** Deterministic age at the requested cutoff, not at wall-clock time. */
  readonly ageSeconds: number;
}

export type MarketPricingAsOfFields = Readonly<
  Record<MarketPricingAsOfFieldName, SelectedMarketPricingObservation | null>
>;

export interface MarketPricingAsOfSelection {
  readonly schemaVersion: typeof MARKET_PRICING_AS_OF_SCHEMA_VERSION;
  readonly algorithmVersion: typeof MARKET_PRICING_AS_OF_ALGORITHM_VERSION;
  readonly state: MarketPricingAsOfState;
  readonly reasonCodes: readonly MarketPricingAsOfReasonCode[];
  readonly knowledgeCutoff: string;
  readonly observedThrough: string | null;
  readonly knownThrough: string | null;
  readonly fields: MarketPricingAsOfFields;
  readonly evidence: {
    readonly candidateCount: number;
    readonly uniqueCandidateCount: number;
    readonly eligibleCandidateCount: number;
    readonly excludedAfterCutoffCount: number;
    readonly selectedCandidateIds: readonly string[];
  };
  readonly replay: {
    readonly mode: 'EXPLICIT_HISTORY_AS_OF';
    readonly reproducible: boolean;
    readonly persistenceProven: false;
  };
}

const FIELD_SET: ReadonlySet<string> = new Set(MARKET_PRICING_AS_OF_FIELDS);
const OPTIONAL_FIELDS = MARKET_PRICING_AS_OF_FIELDS.filter((field) => field !== 'spot');
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

interface ParsedCandidate extends MarketPricingAsOfCandidate {
  readonly observedMs: number;
  readonly ingestedMs: number;
}

function parseExplicitTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyFields(): Record<MarketPricingAsOfFieldName, SelectedMarketPricingObservation | null> {
  return {
    spot: null,
    bid: null,
    ask: null,
    dxy: null,
    us10y: null,
    realYield: null,
    vix: null,
    wti: null,
  };
}

function candidateIsStructurallyValid(candidate: MarketPricingAsOfCandidate): boolean {
  return typeof candidate === 'object'
    && candidate !== null
    && typeof candidate.candidateId === 'string'
    && candidate.candidateId.trim().length > 0
    && FIELD_SET.has(candidate.field)
    && typeof candidate.value === 'number'
    && Number.isFinite(candidate.value)
    && typeof candidate.source === 'string'
    && candidate.source.trim().length > 0
    && (candidate.evidenceRevision === undefined
      || (typeof candidate.evidenceRevision === 'string'
        && candidate.evidenceRevision.trim().length > 0));
}

function sameEvidence(left: ParsedCandidate, right: ParsedCandidate): boolean {
  return left.candidateId === right.candidateId
    && left.field === right.field
    && Object.is(left.value, right.value)
    && left.source === right.source
    && left.observedMs === right.observedMs
    && left.ingestedMs === right.ingestedMs
    && left.evidenceRevision === right.evidenceRevision;
}

function compareCandidate(left: ParsedCandidate, right: ParsedCandidate): number {
  return right.observedMs - left.observedMs
    || right.ingestedMs - left.ingestedMs
    || (left.source < right.source ? -1 : left.source > right.source ? 1 : 0)
    || (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
}

function canonicalTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/**
 * Reconstructs only evidence that was observable by `knowledgeCutoff`.
 *
 * A candidate is eligible iff both its source observation and its ingestion
 * timestamp are at or before the cutoff. Future history is ignored. A record
 * claiming to have been ingested before it was observed, or a source value
 * from after the cutoff already known by the cutoff, fails closed.
 */
export function selectMarketPricingAsOf(
  candidates: readonly MarketPricingAsOfCandidate[],
  knowledgeCutoff: string,
): MarketPricingAsOfSelection {
  const reasons = new Set<MarketPricingAsOfReasonCode>();
  const cutoffMs = parseExplicitTimestamp(knowledgeCutoff);
  if (cutoffMs === null) reasons.add('INVALID_KNOWLEDGE_CUTOFF');

  const parsed: ParsedCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidateIsStructurallyValid(candidate)) {
      reasons.add('INVALID_CANDIDATE_HISTORY');
      continue;
    }
    const observedMs = parseExplicitTimestamp(candidate.observedAt);
    const ingestedMs = parseExplicitTimestamp(candidate.ingestedAt);
    if (observedMs === null || ingestedMs === null) {
      reasons.add('INVALID_CANDIDATE_HISTORY');
      continue;
    }
    if (observedMs > ingestedMs) reasons.add('OBSERVATION_AFTER_INGESTION');
    parsed.push({ ...candidate, observedMs, ingestedMs });
  }

  const byId = new Map<string, ParsedCandidate>();
  const unique: ParsedCandidate[] = [];
  for (const candidate of parsed) {
    const prior = byId.get(candidate.candidateId);
    if (!prior) {
      byId.set(candidate.candidateId, candidate);
      unique.push(candidate);
    } else if (!sameEvidence(prior, candidate)) {
      reasons.add('AMBIGUOUS_CANDIDATE_IDENTITY');
    }
  }

  const eligible: ParsedCandidate[] = [];
  let excludedAfterCutoffCount = 0;
  if (cutoffMs !== null) {
    for (const candidate of unique) {
      if (candidate.ingestedMs > cutoffMs) {
        excludedAfterCutoffCount += 1;
        continue;
      }
      if (candidate.observedMs > cutoffMs) {
        reasons.add('LOOKAHEAD_CANDIDATE');
        continue;
      }
      eligible.push(candidate);
    }
  }

  const fields = emptyFields();
  for (const field of MARKET_PRICING_AS_OF_FIELDS) {
    const fieldCandidates = eligible.filter((candidate) => candidate.field === field).sort(compareCandidate);
    const newest = fieldCandidates[0];
    if (!newest || cutoffMs === null) continue;

    const topObservedMs = newest.observedMs;
    const latestBySource = new Map<string, ParsedCandidate>();
    for (const candidate of fieldCandidates) {
      if (candidate.observedMs !== topObservedMs) break;
      const prior = latestBySource.get(candidate.source);
      if (!prior || compareCandidate(candidate, prior) < 0) latestBySource.set(candidate.source, candidate);
    }
    const sourceLeaders = [...latestBySource.values()].sort(compareCandidate);
    if (sourceLeaders.some((candidate) => !Object.is(candidate.value, sourceLeaders[0].value))) {
      reasons.add('AMBIGUOUS_TOP_OBSERVATION');
      continue;
    }

    const selected = sourceLeaders[0];
    fields[field] = {
      candidateId: selected.candidateId,
      field: selected.field,
      value: selected.value,
      source: selected.source,
      observedAt: canonicalTimestamp(selected.observedMs),
      ingestedAt: canonicalTimestamp(selected.ingestedMs),
      ...(selected.evidenceRevision === undefined
        ? {}
        : { evidenceRevision: selected.evidenceRevision }),
      ageSeconds: Math.floor((cutoffMs - selected.observedMs) / 1000),
    };
  }

  if (fields.spot === null) reasons.add('SPOT_UNAVAILABLE_AS_OF');
  if (OPTIONAL_FIELDS.some((field) => fields[field] === null)) {
    reasons.add('OPTIONAL_FIELD_UNAVAILABLE_AS_OF');
  }
  if (fields.bid !== null && fields.ask !== null && fields.ask.value < fields.bid.value) {
    reasons.add('BOOK_INVERTED');
  }

  const blocking = [
    'INVALID_KNOWLEDGE_CUTOFF',
    'INVALID_CANDIDATE_HISTORY',
    'AMBIGUOUS_CANDIDATE_IDENTITY',
    'OBSERVATION_AFTER_INGESTION',
    'LOOKAHEAD_CANDIDATE',
    'AMBIGUOUS_TOP_OBSERVATION',
    'SPOT_UNAVAILABLE_AS_OF',
    'BOOK_INVERTED',
  ] satisfies readonly MarketPricingAsOfReasonCode[];

  const state: MarketPricingAsOfState = blocking.some((code) => reasons.has(code))
    ? 'ABSTAIN'
    : reasons.has('OPTIONAL_FIELD_UNAVAILABLE_AS_OF') ? 'DEGRADED' : 'AS_OF_AVAILABLE';

  const orderedReasons = [
    'INVALID_KNOWLEDGE_CUTOFF',
    'INVALID_CANDIDATE_HISTORY',
    'AMBIGUOUS_CANDIDATE_IDENTITY',
    'OBSERVATION_AFTER_INGESTION',
    'LOOKAHEAD_CANDIDATE',
    'AMBIGUOUS_TOP_OBSERVATION',
    'SPOT_UNAVAILABLE_AS_OF',
    'OPTIONAL_FIELD_UNAVAILABLE_AS_OF',
    'BOOK_INVERTED',
  ] satisfies readonly MarketPricingAsOfReasonCode[];

  const selected = MARKET_PRICING_AS_OF_FIELDS
    .map((field) => fields[field])
    .filter((candidate): candidate is SelectedMarketPricingObservation => candidate !== null);
  const contractInvalid = reasons.has('INVALID_KNOWLEDGE_CUTOFF')
    || reasons.has('INVALID_CANDIDATE_HISTORY')
    || reasons.has('AMBIGUOUS_CANDIDATE_IDENTITY')
    || reasons.has('OBSERVATION_AFTER_INGESTION')
    || reasons.has('LOOKAHEAD_CANDIDATE')
    || reasons.has('AMBIGUOUS_TOP_OBSERVATION');

  return {
    schemaVersion: MARKET_PRICING_AS_OF_SCHEMA_VERSION,
    algorithmVersion: MARKET_PRICING_AS_OF_ALGORITHM_VERSION,
    state,
    reasonCodes: orderedReasons.filter((code) => reasons.has(code)),
    knowledgeCutoff,
    observedThrough: selected.length > 0
      ? canonicalTimestamp(Math.max(...selected.map((candidate) => Date.parse(candidate.observedAt))))
      : null,
    knownThrough: selected.length > 0
      ? canonicalTimestamp(Math.max(...selected.map((candidate) => Date.parse(candidate.ingestedAt))))
      : null,
    fields,
    evidence: {
      candidateCount: candidates.length,
      uniqueCandidateCount: unique.length,
      eligibleCandidateCount: eligible.length,
      excludedAfterCutoffCount,
      selectedCandidateIds: selected.map((candidate) => candidate.candidateId),
    },
    replay: {
      mode: 'EXPLICIT_HISTORY_AS_OF',
      reproducible: !contractInvalid,
      persistenceProven: false,
    },
  };
}
