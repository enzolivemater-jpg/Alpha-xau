/** CC-0: read-only Command Center and lineage projection. */

import { ACTION_ALGORITHM_VERSION, ACTION_SCHEMA_VERSION } from '../action_engine/contract.js';
import { COMMITTEE_V2_ALGORITHM_VERSION, COMMITTEE_V2_SCHEMA_VERSION } from '../ai_engine/v2_committee_contract.js';
import { HORIZON_ALGORITHM_VERSION, HORIZON_SCHEMA_VERSION } from '../horizon_engine/contract.js';
import { MARKET_PRICING_ALGORITHM_VERSION, MARKET_PRICING_SCHEMA_VERSION } from '../market_engine/institutional_snapshot.js';
import { PORTFOLIO_MANAGER_ALGORITHM_VERSION, PORTFOLIO_MANAGER_SCHEMA_VERSION } from '../portfolio_engine/contract.js';
import { POSITIONING_ALGORITHM_VERSION, POSITIONING_SCHEMA_VERSION } from '../positioning_engine/evidence_contract.js';
import { REGIME_ALGORITHM_VERSION, REGIME_SCHEMA_VERSION } from '../regime_engine/contract.js';
import { FINAL_ACTION_RISK_ALGORITHM_VERSION, FINAL_ACTION_RISK_SCHEMA_VERSION } from '../risk_engine/final_action_contract.js';
import { PRE_PM_ALGORITHM_VERSION, PRE_PM_SCHEMA_VERSION } from '../risk_engine/pre_pm_contract.js';

export const COMMAND_CENTER_SCHEMA_VERSION = 'xau.command-center-projection.v1' as const;
export const COMMAND_CENTER_ALGORITHM_VERSION = 'command-center-read-only-projection-1.0.0' as const;

export const COMMAND_CENTER_LINEAGE = [
  { stage: 'MARKET_PRICING', schemaVersion: MARKET_PRICING_SCHEMA_VERSION, algorithmVersion: MARKET_PRICING_ALGORITHM_VERSION },
  { stage: 'POSITIONING', schemaVersion: POSITIONING_SCHEMA_VERSION, algorithmVersion: POSITIONING_ALGORITHM_VERSION },
  { stage: 'REGIME', schemaVersion: REGIME_SCHEMA_VERSION, algorithmVersion: REGIME_ALGORITHM_VERSION },
  { stage: 'HORIZON_SYNTHESIS', schemaVersion: HORIZON_SCHEMA_VERSION, algorithmVersion: HORIZON_ALGORITHM_VERSION },
  { stage: 'AI_COMMITTEE', schemaVersion: COMMITTEE_V2_SCHEMA_VERSION, algorithmVersion: COMMITTEE_V2_ALGORITHM_VERSION },
  { stage: 'PRE_PM', schemaVersion: PRE_PM_SCHEMA_VERSION, algorithmVersion: PRE_PM_ALGORITHM_VERSION },
  { stage: 'PORTFOLIO_MANAGER', schemaVersion: PORTFOLIO_MANAGER_SCHEMA_VERSION, algorithmVersion: PORTFOLIO_MANAGER_ALGORITHM_VERSION },
  { stage: 'FINAL_ACTION_RISK', schemaVersion: FINAL_ACTION_RISK_SCHEMA_VERSION, algorithmVersion: FINAL_ACTION_RISK_ALGORITHM_VERSION },
  { stage: 'ACTION', schemaVersion: ACTION_SCHEMA_VERSION, algorithmVersion: ACTION_ALGORITHM_VERSION },
] as const;

export type CommandCenterReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'ACTION_VERSION_MISMATCH'
  | 'ACTION_CUTOFF_MISMATCH'
  | 'ACTION_NOT_ABSTAINING'
  | 'RUNTIME_CORRELATION_UNAVAILABLE'
  | 'DEPLOYMENT_NOT_PROVEN'
  | 'COMMAND_CENTER_RUNTIME_NOT_APPROVED';

export interface CommandCenterInput {
  readonly action: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly decision: string;
    readonly execution: string;
    readonly reasonCodes: readonly string[];
    readonly knowledgeCutoff: string;
  };
  readonly runtimeEvidence: {
    readonly correlationId: string | null;
    readonly deploymentId: string | null;
  };
}

export interface CommandCenterProjection {
  readonly schemaVersion: typeof COMMAND_CENTER_SCHEMA_VERSION;
  readonly algorithmVersion: typeof COMMAND_CENTER_ALGORITHM_VERSION;
  readonly mode: 'READ_ONLY';
  readonly systemState: 'HOLD';
  readonly banner: 'EVIDENCE_INCOMPLETE';
  readonly decision: 'ABSTAIN';
  readonly execution: 'FORBIDDEN';
  readonly scenarioTreeStatus: 'UNAVAILABLE';
  readonly tradeTicket: null;
  readonly actionReasonCodes: readonly string[];
  readonly reasonCodes: readonly CommandCenterReasonCode[];
  readonly knowledgeCutoff: string;
  readonly lineage: typeof COMMAND_CENTER_LINEAGE;
  readonly observability: {
    readonly state: 'CONTRACT_ONLY';
    readonly correlationId: string | null;
    readonly deploymentId: string | null;
  };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** CC-0 projects only the safe HOLD state and never constructs a trade ticket. */
export function buildCommandCenterProjection(
  input: CommandCenterInput,
  knowledgeCutoff: string,
): CommandCenterProjection {
  const reasons = new Set<CommandCenterReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.action.schemaVersion !== ACTION_SCHEMA_VERSION
      || input.action.algorithmVersion !== ACTION_ALGORITHM_VERSION) {
    reasons.add('ACTION_VERSION_MISMATCH');
  }
  if (input.action.knowledgeCutoff !== knowledgeCutoff) reasons.add('ACTION_CUTOFF_MISMATCH');
  if (input.action.decision !== 'ABSTAIN' || input.action.execution !== 'FORBIDDEN') {
    reasons.add('ACTION_NOT_ABSTAINING');
  }
  if (input.runtimeEvidence.correlationId === null) reasons.add('RUNTIME_CORRELATION_UNAVAILABLE');
  if (input.runtimeEvidence.deploymentId === null) reasons.add('DEPLOYMENT_NOT_PROVEN');
  reasons.add('COMMAND_CENTER_RUNTIME_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'ACTION_VERSION_MISMATCH', 'ACTION_CUTOFF_MISMATCH',
    'ACTION_NOT_ABSTAINING', 'RUNTIME_CORRELATION_UNAVAILABLE', 'DEPLOYMENT_NOT_PROVEN',
    'COMMAND_CENTER_RUNTIME_NOT_APPROVED',
  ] satisfies readonly CommandCenterReasonCode[];

  return {
    schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
    algorithmVersion: COMMAND_CENTER_ALGORITHM_VERSION,
    mode: 'READ_ONLY', systemState: 'HOLD', banner: 'EVIDENCE_INCOMPLETE',
    decision: 'ABSTAIN', execution: 'FORBIDDEN', scenarioTreeStatus: 'UNAVAILABLE',
    tradeTicket: null,
    actionReasonCodes: [...input.action.reasonCodes],
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    lineage: COMMAND_CENTER_LINEAGE,
    observability: {
      state: 'CONTRACT_ONLY',
      correlationId: input.runtimeEvidence.correlationId,
      deploymentId: input.runtimeEvidence.deploymentId,
    },
  };
}
