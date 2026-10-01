/**
 * Provider-independent, deterministic Market Pricing V1 audit envelope.
 *
 * This adapter is deliberately not wired to the runtime yet. It makes the
 * current latest-market contract explicit without pretending that the current
 * `v_market_latest` read can reproduce a historical knowledge cutoff.
 */

import type { MarketField, MarketSnapshot } from './types.js';

export const MARKET_PRICING_SCHEMA_VERSION = 'xau.market-pricing-snapshot.v1' as const;
export const MARKET_PRICING_ALGORITHM_VERSION = 'market-pricing-envelope-1.0.0' as const;

export type MarketPricingState = 'AVAILABLE' | 'DEGRADED' | 'ABSTAIN';

export type MarketPricingReasonCode =
  | 'SOURCE_SNAPSHOT_UNAVAILABLE'
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'INVALID_FIELD_CONTRACT'
  | 'OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'
  | 'CAPTURED_AT_MISMATCH'
  | 'SPOT_NOT_LIVE'
  | 'OPTIONAL_FIELD_UNAVAILABLE'
  | 'OPTIONAL_FIELD_STALE'
  | 'BOOK_INVERTED'
  | 'HISTORICAL_REPLAY_UNAVAILABLE';

export interface InstitutionalMarketField extends MarketField {
  readonly role: 'REQUIRED' | 'OPTIONAL';
}

export interface InstitutionalMarketPricingSnapshot {
  readonly schemaVersion: typeof MARKET_PRICING_SCHEMA_VERSION;
  readonly algorithmVersion: typeof MARKET_PRICING_ALGORITHM_VERSION;
  readonly state: MarketPricingState;
  readonly reasonCodes: readonly MarketPricingReasonCode[];
  /** Explicit evaluation boundary supplied by the caller, never a local clock read. */
  readonly knowledgeCutoff: string;
  /** Latest real source timestamp across usable fields. */
  readonly observedThrough: string | null;
  readonly fields: {
    readonly spot: InstitutionalMarketField;
    readonly bid: InstitutionalMarketField;
    readonly ask: InstitutionalMarketField;
    readonly dxy: InstitutionalMarketField;
    readonly us10y: InstitutionalMarketField;
    readonly realYield: InstitutionalMarketField;
    readonly vix: InstitutionalMarketField;
    readonly wti: InstitutionalMarketField;
  };
  readonly sourceReason: string | null;
  readonly replay: {
    readonly mode: 'LATEST_ONLY';
    readonly reproducible: false;
    readonly reason: 'INGESTION_CUTOFF_NOT_AVAILABLE';
  };
}

const FIELD_ORDER = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'] as const;

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseExplicitTimestamp(value: string | null): number | null {
  if (value === null || !ISO_WITH_ZONE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldIsCoherent(field: MarketField): boolean {
  if (field.status === 'UNAVAILABLE') return field.value === null;
  return field.value !== null
    && Number.isFinite(field.value)
    && field.observedAt !== null
    && parseExplicitTimestamp(field.observedAt) !== null
    && field.ageSeconds !== null
    && Number.isFinite(field.ageSeconds)
    && field.ageSeconds >= 0
    && field.source !== null
    && field.source.trim().length > 0;
}

function withRole(field: MarketField, role: 'REQUIRED' | 'OPTIONAL'): InstitutionalMarketField {
  return { ...field, role };
}

/**
 * Wraps the existing snapshot in an auditable envelope.
 *
 * The function is pure: the cutoff is mandatory input, reason ordering is
 * fixed, and no clock, network, database, provider, or random source is read.
 */
export function buildInstitutionalMarketPricingSnapshot(
  snapshot: MarketSnapshot,
  knowledgeCutoff: string,
): InstitutionalMarketPricingSnapshot {
  const reasons = new Set<MarketPricingReasonCode>();
  const cutoffMs = parseExplicitTimestamp(knowledgeCutoff);
  if (cutoffMs === null) reasons.add('INVALID_KNOWLEDGE_CUTOFF');

  const fieldEntries = FIELD_ORDER.map((name) => [name, snapshot[name]] as const);
  const observed: number[] = [];
  for (const [, field] of fieldEntries) {
    if (!fieldIsCoherent(field)) reasons.add('INVALID_FIELD_CONTRACT');
    const observedMs = parseExplicitTimestamp(field.observedAt);
    if (observedMs !== null) {
      observed.push(observedMs);
      if (cutoffMs !== null && observedMs > cutoffMs) {
        reasons.add('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF');
      }
    }
  }

  if (!snapshot.available || snapshot.spot.value === null || snapshot.spot.status === 'UNAVAILABLE') {
    reasons.add('SOURCE_SNAPSHOT_UNAVAILABLE');
  }
  if (snapshot.spot.status === 'STALE') reasons.add('SPOT_NOT_LIVE');
  if (snapshot.capturedAt !== snapshot.spot.observedAt) reasons.add('CAPTURED_AT_MISMATCH');

  for (const name of FIELD_ORDER.slice(1)) {
    const field = snapshot[name];
    if (field.status === 'UNAVAILABLE') reasons.add('OPTIONAL_FIELD_UNAVAILABLE');
    else if (field.status === 'STALE') reasons.add('OPTIONAL_FIELD_STALE');
  }

  if (snapshot.bid.value !== null && snapshot.ask.value !== null
      && snapshot.ask.value < snapshot.bid.value) {
    reasons.add('BOOK_INVERTED');
  }

  // The present read path exposes only the latest row and no ingestion-time
  // cutoff. Latest-state use is explicit; historical as-of replay is not
  // claimed until a separate persisted snapshot/as-of contract exists.
  reasons.add('HISTORICAL_REPLAY_UNAVAILABLE');

  const blocking = [
    'SOURCE_SNAPSHOT_UNAVAILABLE',
    'INVALID_KNOWLEDGE_CUTOFF',
    'INVALID_FIELD_CONTRACT',
    'OBSERVATION_AFTER_KNOWLEDGE_CUTOFF',
    'CAPTURED_AT_MISMATCH',
    'BOOK_INVERTED',
  ] satisfies readonly MarketPricingReasonCode[];

  const state: MarketPricingState = blocking.some((code) => reasons.has(code))
    ? 'ABSTAIN'
    : reasons.has('SPOT_NOT_LIVE') || reasons.has('OPTIONAL_FIELD_UNAVAILABLE')
      || reasons.has('OPTIONAL_FIELD_STALE') || reasons.has('HISTORICAL_REPLAY_UNAVAILABLE')
      ? 'DEGRADED'
      : 'AVAILABLE';

  const orderedReasons = [
    'SOURCE_SNAPSHOT_UNAVAILABLE',
    'INVALID_KNOWLEDGE_CUTOFF',
    'INVALID_FIELD_CONTRACT',
    'OBSERVATION_AFTER_KNOWLEDGE_CUTOFF',
    'CAPTURED_AT_MISMATCH',
    'BOOK_INVERTED',
    'SPOT_NOT_LIVE',
    'OPTIONAL_FIELD_UNAVAILABLE',
    'OPTIONAL_FIELD_STALE',
    'HISTORICAL_REPLAY_UNAVAILABLE',
  ] satisfies readonly MarketPricingReasonCode[];

  return {
    schemaVersion: MARKET_PRICING_SCHEMA_VERSION,
    algorithmVersion: MARKET_PRICING_ALGORITHM_VERSION,
    state,
    reasonCodes: orderedReasons.filter((code) => reasons.has(code)),
    knowledgeCutoff,
    observedThrough: observed.length > 0 ? new Date(Math.max(...observed)).toISOString() : null,
    fields: {
      spot: withRole(snapshot.spot, 'REQUIRED'),
      bid: withRole(snapshot.bid, 'OPTIONAL'),
      ask: withRole(snapshot.ask, 'OPTIONAL'),
      dxy: withRole(snapshot.dxy, 'OPTIONAL'),
      us10y: withRole(snapshot.us10y, 'OPTIONAL'),
      realYield: withRole(snapshot.realYield, 'OPTIONAL'),
      vix: withRole(snapshot.vix, 'OPTIONAL'),
      wti: withRole(snapshot.wti, 'OPTIONAL'),
    },
    sourceReason: snapshot.reason,
    replay: {
      mode: 'LATEST_ONLY',
      reproducible: false,
      reason: 'INGESTION_CUTOFF_NOT_AVAILABLE',
    },
  };
}
