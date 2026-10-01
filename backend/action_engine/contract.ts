/** A-0: terminal action/abstention gate. */

import {
  FINAL_ACTION_RISK_ALGORITHM_VERSION,
  FINAL_ACTION_RISK_SCHEMA_VERSION,
} from '../risk_engine/final_action_contract.js';

export const ACTION_SCHEMA_VERSION = 'xau.action-abstention.v1' as const;
export const ACTION_ALGORITHM_VERSION = 'action-abstention-gate-1.0.0' as const;

export type ActionReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'FINAL_RISK_VERSION_MISMATCH'
  | 'FINAL_RISK_CUTOFF_MISMATCH'
  | 'FINAL_RISK_NOT_READY'
  | 'EXECUTION_NOT_AUTHORIZED'
  | 'BROKER_NOT_CONNECTED'
  | 'ACTION_METHOD_NOT_APPROVED';

export interface ActionGateInput {
  readonly finalRisk: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: string;
    readonly actionEligibility: string;
    readonly knowledgeCutoff: string;
  };
  readonly executionAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
  readonly brokerConnection: 'CONNECTED' | 'ABSENT';
}

export interface ActionAbstentionEnvelope {
  readonly schemaVersion: typeof ACTION_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ACTION_ALGORITHM_VERSION;
  readonly decision: 'ABSTAIN';
  readonly execution: 'FORBIDDEN';
  readonly advisoryOnly: true;
  readonly recommendation: null;
  readonly order: null;
  readonly reasonCodes: readonly ActionReasonCode[];
  readonly knowledgeCutoff: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A-0 is terminal and can only abstain; it contains no broker adapter. */
export function buildActionAbstentionGate(
  input: ActionGateInput,
  knowledgeCutoff: string,
): ActionAbstentionEnvelope {
  const reasons = new Set<ActionReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.finalRisk.schemaVersion !== FINAL_ACTION_RISK_SCHEMA_VERSION
      || input.finalRisk.algorithmVersion !== FINAL_ACTION_RISK_ALGORITHM_VERSION) {
    reasons.add('FINAL_RISK_VERSION_MISMATCH');
  }
  if (input.finalRisk.knowledgeCutoff !== knowledgeCutoff) {
    reasons.add('FINAL_RISK_CUTOFF_MISMATCH');
  }
  if (input.finalRisk.state !== 'READY' || input.finalRisk.actionEligibility !== 'ELIGIBLE') {
    reasons.add('FINAL_RISK_NOT_READY');
  }
  if (input.executionAuthorization !== 'AUTHORIZED') reasons.add('EXECUTION_NOT_AUTHORIZED');
  if (input.brokerConnection !== 'CONNECTED') reasons.add('BROKER_NOT_CONNECTED');
  reasons.add('ACTION_METHOD_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'FINAL_RISK_VERSION_MISMATCH',
    'FINAL_RISK_CUTOFF_MISMATCH', 'FINAL_RISK_NOT_READY', 'EXECUTION_NOT_AUTHORIZED',
    'BROKER_NOT_CONNECTED', 'ACTION_METHOD_NOT_APPROVED',
  ] satisfies readonly ActionReasonCode[];

  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    algorithmVersion: ACTION_ALGORITHM_VERSION,
    decision: 'ABSTAIN',
    execution: 'FORBIDDEN',
    advisoryOnly: true,
    recommendation: null,
    order: null,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
  };
}
