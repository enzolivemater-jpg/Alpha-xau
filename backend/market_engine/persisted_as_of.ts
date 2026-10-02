/**
 * MP-2 adapter from the bounded SQL as-of RPC to the pure MP-1 selector.
 *
 * It performs no I/O. A runtime caller may pass rows returned by
 * `fn_market_pricing_candidates_as_of`; wiring such a caller remains gated.
 */

import {
  selectMarketPricingAsOf,
  type MarketPricingAsOfCandidate,
  type MarketPricingAsOfFieldName,
  type MarketPricingAsOfSelection,
} from './as_of_snapshot.js';

export const MARKET_PRICING_PERSISTENCE_SCHEMA_VERSION = 'xau.market-pricing-persistence.v1' as const;
export const MARKET_PRICING_PERSISTENCE_ALGORITHM_VERSION = 'market-pricing-persisted-as-of-adapter-1.0.0' as const;

export interface MarketPricingAsOfRpcRow {
  readonly candidate_id: string;
  readonly field: string;
  readonly value: number | string;
  readonly source: string;
  readonly observed_at: string;
  readonly ingested_at: string;
  readonly evidence_revision: string;
}

export interface PersistedMarketPricingAsOf {
  readonly schemaVersion: typeof MARKET_PRICING_PERSISTENCE_SCHEMA_VERSION;
  readonly algorithmVersion: typeof MARKET_PRICING_PERSISTENCE_ALGORITHM_VERSION;
  readonly knowledgeCutoff: string;
  readonly persistence: {
    readonly relation: 'market_pricing_observations';
    readonly readRpc: 'fn_market_pricing_candidates_as_of';
    readonly historyCompleteness: 'COMPLETE_OR_ERROR';
    readonly runtimeWiring: 'NOT_ACTIVATED';
  };
  readonly selection: MarketPricingAsOfSelection;
}

const FIELD_SET: ReadonlySet<string> = new Set([
  'spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RPC_KEYS = [
  'candidate_id', 'evidence_revision', 'field', 'ingested_at',
  'observed_at', 'source', 'value',
] as const;

function timestamp(value: unknown): { readonly milliseconds: number; readonly canonical: string } | null {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return { milliseconds, canonical: new Date(milliseconds).toISOString() };
}

function exactKeys(row: object): boolean {
  const keys = Object.keys(row).sort();
  return keys.length === RPC_KEYS.length && keys.every((key, index) => key === RPC_KEYS[index]);
}

/** Strictly normalizes PostgREST NUMERIC/timestamp serialization. */
export function normalizeMarketPricingAsOfRows(
  rows: readonly MarketPricingAsOfRpcRow[],
): readonly MarketPricingAsOfCandidate[] {
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || !exactKeys(row)) {
      throw new Error(`MP2_RPC_ROW_${index}_SHAPE_INVALID`);
    }
    if (!UUID.test(row.candidate_id) || !FIELD_SET.has(row.field)
        || typeof row.source !== 'string' || row.source.trim().length === 0
        || typeof row.evidence_revision !== 'string' || row.evidence_revision.trim().length === 0) {
      throw new Error(`MP2_RPC_ROW_${index}_IDENTITY_INVALID`);
    }
    const value = typeof row.value === 'number' ? row.value
      : typeof row.value === 'string' && row.value.trim().length > 0 ? Number(row.value) : Number.NaN;
    const observed = timestamp(row.observed_at);
    const ingested = timestamp(row.ingested_at);
    if (!Number.isFinite(value) || observed === null || ingested === null
        || observed.milliseconds > ingested.milliseconds) {
      throw new Error(`MP2_RPC_ROW_${index}_EVIDENCE_INVALID`);
    }
    return {
      candidateId: row.candidate_id,
      field: row.field as MarketPricingAsOfFieldName,
      value,
      source: row.source,
      observedAt: observed.canonical,
      ingestedAt: ingested.canonical,
      evidenceRevision: row.evidence_revision,
    };
  });
}

export function buildPersistedMarketPricingAsOf(
  rows: readonly MarketPricingAsOfRpcRow[],
  knowledgeCutoff: string,
): PersistedMarketPricingAsOf {
  const candidates = normalizeMarketPricingAsOfRows(rows);
  return {
    schemaVersion: MARKET_PRICING_PERSISTENCE_SCHEMA_VERSION,
    algorithmVersion: MARKET_PRICING_PERSISTENCE_ALGORITHM_VERSION,
    knowledgeCutoff,
    persistence: {
      relation: 'market_pricing_observations',
      readRpc: 'fn_market_pricing_candidates_as_of',
      historyCompleteness: 'COMPLETE_OR_ERROR',
      runtimeWiring: 'NOT_ACTIVATED',
    },
    selection: selectMarketPricingAsOf(candidates, knowledgeCutoff),
  };
}
