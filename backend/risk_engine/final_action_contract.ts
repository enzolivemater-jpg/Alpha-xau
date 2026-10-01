/** FAR-0: final-action risk dependency gate. */

import {
  PORTFOLIO_MANAGER_ALGORITHM_VERSION,
  PORTFOLIO_MANAGER_SCHEMA_VERSION,
} from '../portfolio_engine/contract.js';

export const FINAL_ACTION_RISK_SCHEMA_VERSION = 'xau.final-action-risk-gate.v1' as const;
export const FINAL_ACTION_RISK_ALGORITHM_VERSION = 'final-action-risk-dependency-gate-1.0.0' as const;

export type FinalActionRiskReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'PORTFOLIO_VERSION_MISMATCH'
  | 'PORTFOLIO_CUTOFF_MISMATCH'
  | 'PORTFOLIO_NOT_READY'
  | 'RISK_POLICY_NOT_APPROVED'
  | 'BROKER_CONSTRAINTS_UNAVAILABLE'
  | 'FINAL_RISK_METHOD_NOT_APPROVED';

export interface FinalActionRiskGateInput {
  readonly portfolioManager: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: string;
    readonly knowledgeCutoff: string;
  };
  readonly riskPolicyAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
  readonly brokerConstraintsVersion: string | null;
}

export interface FinalActionRiskEnvelope {
  readonly schemaVersion: typeof FINAL_ACTION_RISK_SCHEMA_VERSION;
  readonly algorithmVersion: typeof FINAL_ACTION_RISK_ALGORITHM_VERSION;
  readonly state: 'ABSTAIN';
  readonly actionEligibility: 'BLOCKED';
  readonly maximumLoss: null;
  readonly positionSize: null;
  readonly stopLoss: null;
  readonly riskVerdict: null;
  readonly reasonCodes: readonly FinalActionRiskReasonCode[];
  readonly knowledgeCutoff: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** FAR-0 never fabricates a loss limit, size, stop or risk verdict. */
export function buildFinalActionRiskGate(
  input: FinalActionRiskGateInput,
  knowledgeCutoff: string,
): FinalActionRiskEnvelope {
  const reasons = new Set<FinalActionRiskReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.portfolioManager.schemaVersion !== PORTFOLIO_MANAGER_SCHEMA_VERSION
      || input.portfolioManager.algorithmVersion !== PORTFOLIO_MANAGER_ALGORITHM_VERSION) {
    reasons.add('PORTFOLIO_VERSION_MISMATCH');
  }
  if (input.portfolioManager.knowledgeCutoff !== knowledgeCutoff) {
    reasons.add('PORTFOLIO_CUTOFF_MISMATCH');
  }
  if (input.portfolioManager.state !== 'READY') reasons.add('PORTFOLIO_NOT_READY');
  if (input.riskPolicyAuthorization !== 'AUTHORIZED') reasons.add('RISK_POLICY_NOT_APPROVED');
  if (input.brokerConstraintsVersion === null) reasons.add('BROKER_CONSTRAINTS_UNAVAILABLE');
  reasons.add('FINAL_RISK_METHOD_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'PORTFOLIO_VERSION_MISMATCH',
    'PORTFOLIO_CUTOFF_MISMATCH', 'PORTFOLIO_NOT_READY', 'RISK_POLICY_NOT_APPROVED',
    'BROKER_CONSTRAINTS_UNAVAILABLE', 'FINAL_RISK_METHOD_NOT_APPROVED',
  ] satisfies readonly FinalActionRiskReasonCode[];

  return {
    schemaVersion: FINAL_ACTION_RISK_SCHEMA_VERSION,
    algorithmVersion: FINAL_ACTION_RISK_ALGORITHM_VERSION,
    state: 'ABSTAIN',
    actionEligibility: 'BLOCKED',
    maximumLoss: null,
    positionSize: null,
    stopLoss: null,
    riskVerdict: null,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
  };
}
