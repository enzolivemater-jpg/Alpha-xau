/** PM-0: recommendation-only Portfolio Manager dependency gate. */

import {
  PRE_PM_ALGORITHM_VERSION,
  PRE_PM_SCHEMA_VERSION,
} from '../risk_engine/pre_pm_contract.js';

export const PORTFOLIO_MANAGER_SCHEMA_VERSION = 'xau.portfolio-manager-gate.v1' as const;
export const PORTFOLIO_MANAGER_ALGORITHM_VERSION = 'portfolio-manager-dependency-gate-1.0.0' as const;

export type PortfolioManagerReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'PRE_PM_VERSION_MISMATCH'
  | 'PRE_PM_CUTOFF_MISMATCH'
  | 'PRE_PM_NOT_READY'
  | 'PORTFOLIO_POLICY_NOT_APPROVED'
  | 'PORTFOLIO_STATE_UNAVAILABLE'
  | 'PORTFOLIO_METHOD_NOT_APPROVED';

export interface PortfolioManagerGateInput {
  readonly prePm: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: string;
    readonly portfolioManagerEligibility: string;
    readonly knowledgeCutoff: string;
  };
  readonly portfolioPolicyAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
  readonly portfolioState: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface PortfolioManagerGateEnvelope {
  readonly schemaVersion: typeof PORTFOLIO_MANAGER_SCHEMA_VERSION;
  readonly algorithmVersion: typeof PORTFOLIO_MANAGER_ALGORITHM_VERSION;
  readonly state: 'ABSTAIN';
  readonly advisoryOnly: true;
  readonly recommendation: null;
  readonly targetAllocation: null;
  readonly sizing: null;
  readonly confidence: null;
  readonly reasonCodes: readonly PortfolioManagerReasonCode[];
  readonly knowledgeCutoff: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** PM-0 never invents a portfolio policy, recommendation, allocation or size. */
export function buildPortfolioManagerGate(
  input: PortfolioManagerGateInput,
  knowledgeCutoff: string,
): PortfolioManagerGateEnvelope {
  const reasons = new Set<PortfolioManagerReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.prePm.schemaVersion !== PRE_PM_SCHEMA_VERSION
      || input.prePm.algorithmVersion !== PRE_PM_ALGORITHM_VERSION) {
    reasons.add('PRE_PM_VERSION_MISMATCH');
  }
  if (input.prePm.knowledgeCutoff !== knowledgeCutoff) reasons.add('PRE_PM_CUTOFF_MISMATCH');
  if (input.prePm.state !== 'READY' || input.prePm.portfolioManagerEligibility !== 'ELIGIBLE') {
    reasons.add('PRE_PM_NOT_READY');
  }
  if (input.portfolioPolicyAuthorization !== 'AUTHORIZED') {
    reasons.add('PORTFOLIO_POLICY_NOT_APPROVED');
  }
  if (input.portfolioState !== 'AVAILABLE') reasons.add('PORTFOLIO_STATE_UNAVAILABLE');
  reasons.add('PORTFOLIO_METHOD_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'PRE_PM_VERSION_MISMATCH', 'PRE_PM_CUTOFF_MISMATCH',
    'PRE_PM_NOT_READY', 'PORTFOLIO_POLICY_NOT_APPROVED', 'PORTFOLIO_STATE_UNAVAILABLE',
    'PORTFOLIO_METHOD_NOT_APPROVED',
  ] satisfies readonly PortfolioManagerReasonCode[];

  return {
    schemaVersion: PORTFOLIO_MANAGER_SCHEMA_VERSION,
    algorithmVersion: PORTFOLIO_MANAGER_ALGORITHM_VERSION,
    state: 'ABSTAIN',
    advisoryOnly: true,
    recommendation: null,
    targetAllocation: null,
    sizing: null,
    confidence: null,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
  };
}
