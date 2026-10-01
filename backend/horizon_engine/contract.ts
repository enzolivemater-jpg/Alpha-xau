/** H1-H5 S-0 dependency gate. It emits no scenario while evidence is incomplete. */

import { EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION } from '../event_impact/deterministic_processor.js';
import { GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION } from '../gold_transmission/deterministic_processor.js';
import {
  MARKET_PRICING_ALGORITHM_VERSION,
  MARKET_PRICING_SCHEMA_VERSION,
} from '../market_engine/institutional_snapshot.js';
import {
  POSITIONING_ALGORITHM_VERSION,
  POSITIONING_SCHEMA_VERSION,
} from '../positioning_engine/evidence_contract.js';
import { REGIME_ALGORITHM_VERSION, REGIME_SCHEMA_VERSION } from '../regime_engine/contract.js';

export const HORIZON_SCHEMA_VERSION = 'xau.horizon-synthesis.v1' as const;
export const HORIZON_ALGORITHM_VERSION = 'horizon-dependency-gate-1.0.0' as const;
export const HORIZONS = ['H1', 'H2', 'H3', 'H4', 'H5'] as const;
export type Horizon = typeof HORIZONS[number];

export type HorizonReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'UPSTREAM_CUTOFF_MISMATCH'
  | 'EVENT_IMPACT_VERSION_MISMATCH'
  | 'EVENT_IMPACT_INSUFFICIENT'
  | 'GOLD_TRANSMISSION_VERSION_MISMATCH'
  | 'GOLD_TRANSMISSION_INSUFFICIENT'
  | 'MARKET_PRICING_VERSION_MISMATCH'
  | 'MARKET_PRICING_NOT_AVAILABLE'
  | 'POSITIONING_VERSION_MISMATCH'
  | 'POSITIONING_SIGNAL_UNAVAILABLE'
  | 'REGIME_VERSION_MISMATCH'
  | 'REGIME_UNAVAILABLE'
  | 'HORIZON_METHODOLOGY_NOT_APPROVED';

export interface HorizonContractInput {
  readonly eventImpact: {
    readonly algorithmVersion: string;
    readonly status: 'ASSESSED' | 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
    readonly knowledgeCutoff: string;
  };
  readonly goldTransmission: {
    readonly algorithmVersion: string;
    readonly status: 'ASSESSED' | 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
    readonly knowledgeCutoff: string;
  };
  readonly marketPricing: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: 'AVAILABLE' | 'DEGRADED' | 'ABSTAIN';
    readonly knowledgeCutoff: string;
  };
  readonly positioning: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly positioningState: 'UNAVAILABLE';
    readonly knowledgeCutoff: string;
  };
  readonly regime: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly regime: 'UNAVAILABLE';
    readonly knowledgeCutoff: string;
  };
}
export interface HorizonScenarioAbstention {
  readonly horizon: Horizon;
  readonly status: 'ABSTAIN';
  readonly direction: 'UNAVAILABLE';
  readonly probability: null;
  readonly target: null;
  readonly invalidation: null;
  readonly confidence: null;
}

export interface HorizonSynthesisEnvelope {
  readonly schemaVersion: typeof HORIZON_SCHEMA_VERSION;
  readonly algorithmVersion: typeof HORIZON_ALGORITHM_VERSION;
  readonly state: 'ABSTAIN';
  readonly reasonCodes: readonly HorizonReasonCode[];
  readonly knowledgeCutoff: string;
  readonly scenarios: readonly HorizonScenarioAbstention[];
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validates upstream identity/cutoff and returns five explicit abstentions. */
export function buildHorizonSynthesisContract(
  input: HorizonContractInput,
  knowledgeCutoff: string,
): HorizonSynthesisEnvelope {
  const reasons = new Set<HorizonReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  const cutoffs = [
    input.eventImpact.knowledgeCutoff,
    input.goldTransmission.knowledgeCutoff,
    input.marketPricing.knowledgeCutoff,
    input.positioning.knowledgeCutoff,
    input.regime.knowledgeCutoff,
  ];
  if (cutoffs.some((cutoff) => cutoff !== knowledgeCutoff)) reasons.add('UPSTREAM_CUTOFF_MISMATCH');

  if (input.eventImpact.algorithmVersion !== EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION) {
    reasons.add('EVENT_IMPACT_VERSION_MISMATCH');
  }
  if (input.eventImpact.status !== 'ASSESSED') reasons.add('EVENT_IMPACT_INSUFFICIENT');

  if (input.goldTransmission.algorithmVersion !== GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION) {
    reasons.add('GOLD_TRANSMISSION_VERSION_MISMATCH');
  }
  if (input.goldTransmission.status !== 'ASSESSED') reasons.add('GOLD_TRANSMISSION_INSUFFICIENT');

  if (input.marketPricing.schemaVersion !== MARKET_PRICING_SCHEMA_VERSION
      || input.marketPricing.algorithmVersion !== MARKET_PRICING_ALGORITHM_VERSION) {
    reasons.add('MARKET_PRICING_VERSION_MISMATCH');
  }
  if (input.marketPricing.state !== 'AVAILABLE') reasons.add('MARKET_PRICING_NOT_AVAILABLE');

  if (input.positioning.schemaVersion !== POSITIONING_SCHEMA_VERSION
      || input.positioning.algorithmVersion !== POSITIONING_ALGORITHM_VERSION) {
    reasons.add('POSITIONING_VERSION_MISMATCH');
  }
  if (input.positioning.positioningState === 'UNAVAILABLE') reasons.add('POSITIONING_SIGNAL_UNAVAILABLE');

  if (input.regime.schemaVersion !== REGIME_SCHEMA_VERSION
      || input.regime.algorithmVersion !== REGIME_ALGORITHM_VERSION) {
    reasons.add('REGIME_VERSION_MISMATCH');
  }
  if (input.regime.regime === 'UNAVAILABLE') reasons.add('REGIME_UNAVAILABLE');

  reasons.add('HORIZON_METHODOLOGY_NOT_APPROVED');
  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'UPSTREAM_CUTOFF_MISMATCH',
    'EVENT_IMPACT_VERSION_MISMATCH', 'EVENT_IMPACT_INSUFFICIENT',
    'GOLD_TRANSMISSION_VERSION_MISMATCH', 'GOLD_TRANSMISSION_INSUFFICIENT',
    'MARKET_PRICING_VERSION_MISMATCH', 'MARKET_PRICING_NOT_AVAILABLE',
    'POSITIONING_VERSION_MISMATCH', 'POSITIONING_SIGNAL_UNAVAILABLE',
    'REGIME_VERSION_MISMATCH', 'REGIME_UNAVAILABLE',
    'HORIZON_METHODOLOGY_NOT_APPROVED',
  ] satisfies readonly HorizonReasonCode[];

  return {
    schemaVersion: HORIZON_SCHEMA_VERSION,
    algorithmVersion: HORIZON_ALGORITHM_VERSION,
    state: 'ABSTAIN',
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    scenarios: HORIZONS.map((horizon) => ({
      horizon,
      status: 'ABSTAIN',
      direction: 'UNAVAILABLE',
      probability: null,
      target: null,
      invalidation: null,
      confidence: null,
    })),
  };
}
