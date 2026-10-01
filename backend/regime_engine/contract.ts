/** Deterministic Regime R-0 dependency/abstention contract. */

import {
  MARKET_PRICING_ALGORITHM_VERSION,
  MARKET_PRICING_SCHEMA_VERSION,
  type InstitutionalMarketPricingSnapshot,
} from '../market_engine/institutional_snapshot.js';
import {
  POSITIONING_ALGORITHM_VERSION,
  POSITIONING_SCHEMA_VERSION,
  type PositioningEvidenceEnvelope,
} from '../positioning_engine/evidence_contract.js';

export const REGIME_SCHEMA_VERSION = 'xau.regime-assessment.v1' as const;
export const REGIME_ALGORITHM_VERSION = 'regime-dependency-gate-1.0.0' as const;

export type RegimeReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'UPSTREAM_CUTOFF_MISMATCH'
  | 'MARKET_PRICING_VERSION_MISMATCH'
  | 'MARKET_PRICING_ABSTAINED'
  | 'MARKET_PRICING_DEGRADED'
  | 'POSITIONING_VERSION_MISMATCH'
  | 'POSITIONING_EVIDENCE_ABSTAINED'
  | 'POSITIONING_SIGNAL_UNAVAILABLE'
  | 'REGIME_METHODOLOGY_NOT_APPROVED';

export interface RegimeContractInput {
  readonly marketPricing: Pick<InstitutionalMarketPricingSnapshot,
    'schemaVersion' | 'algorithmVersion' | 'state' | 'reasonCodes' | 'knowledgeCutoff'>;
  readonly positioning: Pick<PositioningEvidenceEnvelope,
    'schemaVersion' | 'algorithmVersion' | 'evidenceState' | 'positioningState'
    | 'reasonCodes' | 'knowledgeCutoff'>;
}

export interface RegimeAssessmentEnvelope {
  readonly schemaVersion: typeof REGIME_SCHEMA_VERSION;
  readonly algorithmVersion: typeof REGIME_ALGORITHM_VERSION;
  readonly evidenceState: 'READY' | 'DEGRADED' | 'ABSTAIN';
  readonly regime: 'UNAVAILABLE';
  readonly confidence: null;
  readonly reasonCodes: readonly RegimeReasonCode[];
  readonly knowledgeCutoff: string;
  readonly upstream: {
    readonly marketPricingSchemaVersion: string;
    readonly marketPricingAlgorithmVersion: string;
    readonly positioningSchemaVersion: string;
    readonly positioningAlgorithmVersion: string;
  };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function validTimestamp(value: string): boolean {
  return TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Validates the two upstream institutional envelopes but performs no regime
 * inference. R-0 exists to prevent legacy prose/LLM labels from crossing the
 * V2 evidence boundary before an approved deterministic methodology exists.
 */
export function buildRegimeAssessmentContract(
  input: RegimeContractInput,
  knowledgeCutoff: string,
): RegimeAssessmentEnvelope {
  const reasons = new Set<RegimeReasonCode>();
  if (!validTimestamp(knowledgeCutoff)) reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  if (input.marketPricing.knowledgeCutoff !== knowledgeCutoff
      || input.positioning.knowledgeCutoff !== knowledgeCutoff) {
    reasons.add('UPSTREAM_CUTOFF_MISMATCH');
  }

  if (input.marketPricing.schemaVersion !== MARKET_PRICING_SCHEMA_VERSION
      || input.marketPricing.algorithmVersion !== MARKET_PRICING_ALGORITHM_VERSION) {
    reasons.add('MARKET_PRICING_VERSION_MISMATCH');
  }
  if (input.marketPricing.state === 'ABSTAIN') reasons.add('MARKET_PRICING_ABSTAINED');
  if (input.marketPricing.state === 'DEGRADED') reasons.add('MARKET_PRICING_DEGRADED');

  if (input.positioning.schemaVersion !== POSITIONING_SCHEMA_VERSION
      || input.positioning.algorithmVersion !== POSITIONING_ALGORITHM_VERSION) {
    reasons.add('POSITIONING_VERSION_MISMATCH');
  }
  if (input.positioning.evidenceState === 'ABSTAIN') reasons.add('POSITIONING_EVIDENCE_ABSTAINED');
  if (input.positioning.positioningState === 'UNAVAILABLE') reasons.add('POSITIONING_SIGNAL_UNAVAILABLE');

  reasons.add('REGIME_METHODOLOGY_NOT_APPROVED');

  const blocking = [
    'INVALID_KNOWLEDGE_CUTOFF', 'UPSTREAM_CUTOFF_MISMATCH',
    'MARKET_PRICING_VERSION_MISMATCH', 'MARKET_PRICING_ABSTAINED',
    'POSITIONING_VERSION_MISMATCH', 'POSITIONING_EVIDENCE_ABSTAINED',
  ] satisfies readonly RegimeReasonCode[];
  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'UPSTREAM_CUTOFF_MISMATCH',
    'MARKET_PRICING_VERSION_MISMATCH', 'MARKET_PRICING_ABSTAINED',
    'MARKET_PRICING_DEGRADED', 'POSITIONING_VERSION_MISMATCH',
    'POSITIONING_EVIDENCE_ABSTAINED', 'POSITIONING_SIGNAL_UNAVAILABLE',
    'REGIME_METHODOLOGY_NOT_APPROVED',
  ] satisfies readonly RegimeReasonCode[];

  return {
    schemaVersion: REGIME_SCHEMA_VERSION,
    algorithmVersion: REGIME_ALGORITHM_VERSION,
    evidenceState: blocking.some((reason) => reasons.has(reason))
      ? 'ABSTAIN'
      : reasons.has('MARKET_PRICING_DEGRADED') || reasons.has('POSITIONING_SIGNAL_UNAVAILABLE')
        ? 'DEGRADED'
        : 'READY',
    regime: 'UNAVAILABLE',
    confidence: null,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    upstream: {
      marketPricingSchemaVersion: input.marketPricing.schemaVersion,
      marketPricingAlgorithmVersion: input.marketPricing.algorithmVersion,
      positioningSchemaVersion: input.positioning.schemaVersion,
      positioningAlgorithmVersion: input.positioning.algorithmVersion,
    },
  };
}

