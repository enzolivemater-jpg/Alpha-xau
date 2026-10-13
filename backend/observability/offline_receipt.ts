/**
 * OBS-0: portable, deterministic *offline* receipt for CHAIN-0 output.
 * SHA-256 is a content checksum, not a signature, authenticity proof,
 * authorization, operator identity or production evidence.
 */
import {
  CHAIN_0_SCHEMA_VERSION, type ChainDryRunResult,
} from '../decision_chain/dry_run.js';
import { REGIME_SCHEMA_VERSION, REGIME_ALGORITHM_VERSION } from '../regime_engine/contract.js';
import { HORIZON_SCHEMA_VERSION, HORIZON_ALGORITHM_VERSION } from '../horizon_engine/contract.js';
import { COMMITTEE_V2_SCHEMA_VERSION, COMMITTEE_V2_ALGORITHM_VERSION } from '../ai_engine/v2_committee_contract.js';
import { PRE_PM_SCHEMA_VERSION, PRE_PM_ALGORITHM_VERSION } from '../risk_engine/pre_pm_contract.js';
import { PORTFOLIO_MANAGER_SCHEMA_VERSION, PORTFOLIO_MANAGER_ALGORITHM_VERSION } from '../portfolio_engine/contract.js';
import { FINAL_ACTION_RISK_SCHEMA_VERSION, FINAL_ACTION_RISK_ALGORITHM_VERSION } from '../risk_engine/final_action_contract.js';
import { ACTION_SCHEMA_VERSION, ACTION_ALGORITHM_VERSION } from '../action_engine/contract.js';
import { COMMAND_CENTER_SCHEMA_VERSION, COMMAND_CENTER_ALGORITHM_VERSION } from '../command_center/contract.js';
import { ALERT_SCHEMA_VERSION, ALERT_ALGORITHM_VERSION } from '../alert_engine/contract.js';
import { ACCEPTANCE_SCHEMA_VERSION, ACCEPTANCE_ALGORITHM_VERSION } from '../acceptance_engine/contract.js';

export const OFFLINE_RECEIPT_SCHEMA_VERSION = 'xau.offline-audit-receipt.v1' as const;
type ReceiptProblem =
  | 'CHAIN_IDENTITY_INVALID'
  | 'CHAIN_MODE_INVALID'
  | 'CHAIN_STATE_INVALID'
  | 'CUTOFF_INVALID'
  | 'STAGE_IDENTITY_INVALID'
  | 'STAGE_CUTOFF_MISMATCH'
  | 'STAGE_STATE_INVALID'
  | 'REASON_CODES_INVALID'
  | 'UNSAFE_OUTPUT_PRESENT';

export interface AuditLineageEntry {
  readonly stage: string;
  readonly schemaVersion: string;
  readonly algorithmVersion: string;
  readonly state: string;
  readonly reasonCodes: readonly string[];
}

export interface OfflineAuditReceipt {
  readonly schemaVersion: typeof OFFLINE_RECEIPT_SCHEMA_VERSION;
  readonly mode: 'OFFLINE_ONLY';
  readonly verification: 'VALID_HOLD' | 'REJECTED';
  readonly execution: 'FORBIDDEN';
  readonly knowledgeCutoff: string;
  readonly hashAlgorithm: 'SHA-256';
  readonly fingerprint: string | null;
  readonly problems: readonly ReceiptProblem[];
  readonly lineage: readonly AuditLineageEntry[];
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EXPECTED = [
  ['REGIME', REGIME_SCHEMA_VERSION, REGIME_ALGORITHM_VERSION, 'UNAVAILABLE'],
  ['HORIZONS', HORIZON_SCHEMA_VERSION, HORIZON_ALGORITHM_VERSION, 'ABSTAIN'],
  ['COMMITTEE', COMMITTEE_V2_SCHEMA_VERSION, COMMITTEE_V2_ALGORITHM_VERSION, 'ABSTAIN'],
  ['PRE_PM', PRE_PM_SCHEMA_VERSION, PRE_PM_ALGORITHM_VERSION, 'ABSTAIN'],
  ['PORTFOLIO_MANAGER', PORTFOLIO_MANAGER_SCHEMA_VERSION, PORTFOLIO_MANAGER_ALGORITHM_VERSION, 'ABSTAIN'],
  ['FINAL_ACTION_RISK', FINAL_ACTION_RISK_SCHEMA_VERSION, FINAL_ACTION_RISK_ALGORITHM_VERSION, 'ABSTAIN'],
  ['ACTION', ACTION_SCHEMA_VERSION, ACTION_ALGORITHM_VERSION, 'ABSTAIN'],
  ['COMMAND_CENTER', COMMAND_CENTER_SCHEMA_VERSION, COMMAND_CENTER_ALGORITHM_VERSION, 'HOLD'],
  ['ALERTS', ALERT_SCHEMA_VERSION, ALERT_ALGORITHM_VERSION, 'SUPPRESSED'],
  ['ACCEPTANCE', ACCEPTANCE_SCHEMA_VERSION, ACCEPTANCE_ALGORITHM_VERSION, 'NOT_ACCEPTED'],
] as const;

function safeReasonCodes(value: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every((code) => typeof code === 'string' && /^[A-Z][A-Z_0-9]*$/.test(code))
    && new Set(value).size === value.length;
}

/** Produces no receipt fingerprint for a suspicious or inconsistent chain.
 * Uses only explicit caller-provided data; no generated timestamps or IDs.
 */
export async function buildOfflineAuditReceipt(run: ChainDryRunResult): Promise<OfflineAuditReceipt> {
  const problems = new Set<ReceiptProblem>();
  if (run.schemaVersion !== CHAIN_0_SCHEMA_VERSION) problems.add('CHAIN_IDENTITY_INVALID');
  if (run.mode !== 'OFFLINE_ONLY') problems.add('CHAIN_MODE_INVALID');
  if (run.systemState !== 'HOLD' || run.execution !== 'FORBIDDEN') {
    problems.add('CHAIN_STATE_INVALID');
  }
  const cutoff = run.knowledgeCutoff;
  if (!timestampPattern.test(cutoff) || !Number.isFinite(Date.parse(cutoff))) {
    problems.add('CUTOFF_INVALID');
  }

  const s = run.stages;
  const envelopes = [
    [s.regime, s.regime.regime],
    [s.horizons, s.horizons.state],
    [s.committee, s.committee.state],
    [s.prePm, s.prePm.state],
    [s.portfolioManager, s.portfolioManager.state],
    [s.finalActionRisk, s.finalActionRisk.state],
    [s.action, s.action.decision],
    [s.commandCenter, s.commandCenter.systemState],
    [s.alerts, s.alerts.state],
    [s.acceptance, s.acceptance.acceptanceState],
  ] as const;
  const lineage: AuditLineageEntry[] = [];
  for (let i = 0; i < EXPECTED.length; i++) {
    const [stage, schema, algorithm, expectedState] = EXPECTED[i];
    const [envelope, state] = envelopes[i];
    if (envelope.schemaVersion !== schema || envelope.algorithmVersion !== algorithm) {
      problems.add('STAGE_IDENTITY_INVALID');
    }
    if (envelope.knowledgeCutoff !== cutoff) problems.add('STAGE_CUTOFF_MISMATCH');
    if (state !== expectedState) problems.add('STAGE_STATE_INVALID');
    if (!safeReasonCodes(envelope.reasonCodes)) problems.add('REASON_CODES_INVALID');
    lineage.push({
      stage,
      schemaVersion: envelope.schemaVersion,
      algorithmVersion: envelope.algorithmVersion,
      state,
      reasonCodes: [...envelope.reasonCodes],
    });
  }

  const safeHorizonSet = Array.isArray(s.horizons.scenarios)
    && s.horizons.scenarios.length === 5
    && ['H1', 'H2', 'H3', 'H4', 'H5'].every((horizon, index) => {
      const item = s.horizons.scenarios[index];
      return item.horizon === horizon
        && item.status === 'ABSTAIN'
        && item.direction === 'UNAVAILABLE'
        && item.probability === null
        && item.target === null
        && item.invalidation === null
        && item.confidence === null;
    });
  const safeAcceptance = s.acceptance.acceptanceRun === null
    && s.acceptance.report === null
    && s.acceptance.productionReadiness === 'HOLD'
    && s.acceptance.missingEvidence.length === 11
    && Object.keys(s.acceptance.evidence).length === 11
    && Object.values(s.acceptance.evidence).every((value) => value === false);
  if (
    !safeHorizonSet
    || s.regime.regime !== 'UNAVAILABLE'
    || s.regime.confidence !== null
    || s.committee.providerInvocation !== 'FORBIDDEN'
    || s.committee.legacyCommitteeOutputAccepted !== false
    || s.committee.request !== null
    || s.committee.response !== null
    || s.prePm.portfolioManagerEligibility !== 'BLOCKED'
    || s.prePm.evidenceAcceptance !== 'UNAVAILABLE'
    || s.prePm.riskVerdict !== null
    || s.prePm.confidence !== null
    || s.prePm.portfolioManagerInput !== null
    || s.portfolioManager.advisoryOnly !== true
    || s.portfolioManager.recommendation !== null
    || s.portfolioManager.targetAllocation !== null
    || s.portfolioManager.sizing !== null
    || s.portfolioManager.confidence !== null
    || s.finalActionRisk.actionEligibility !== 'BLOCKED'
    || s.finalActionRisk.maximumLoss !== null
    || s.finalActionRisk.positionSize !== null
    || s.finalActionRisk.stopLoss !== null
    || s.finalActionRisk.riskVerdict !== null
    || s.action.decision !== 'ABSTAIN'
    || s.action.execution !== 'FORBIDDEN'
    || s.action.advisoryOnly !== true
    || s.action.recommendation !== null
    || s.action.order !== null
    || s.commandCenter.mode !== 'READ_ONLY'
    || s.commandCenter.systemState !== 'HOLD'
    || s.commandCenter.banner !== 'EVIDENCE_INCOMPLETE'
    || s.commandCenter.execution !== 'FORBIDDEN'
    || s.commandCenter.scenarioTreeStatus !== 'UNAVAILABLE'
    || s.commandCenter.tradeTicket !== null
    || s.commandCenter.observability.state !== 'CONTRACT_ONLY'
    || s.commandCenter.observability.correlationId !== null
    || s.commandCenter.observability.deploymentId !== null
    || s.alerts.state !== 'SUPPRESSED'
    || s.alerts.delivery !== 'FORBIDDEN'
    || s.alerts.expiresAt !== null
    || s.alerts.acknowledgementState !== 'UNAVAILABLE'
    || s.alerts.escalation !== 'FORBIDDEN'
    || s.alerts.recipient !== null
    || s.alerts.channel !== null
    || s.alerts.payload !== null
    || !safeAcceptance
  ) problems.add('UNSAFE_OUTPUT_PRESENT');

  // Stable insertion order + contract-defined lineage order make the checksum
  // reproducible across machines. It authenticates *nothing* on its own.
  const orderedProblems: ReceiptProblem[] = [
    'CHAIN_IDENTITY_INVALID', 'CHAIN_MODE_INVALID', 'CHAIN_STATE_INVALID',
    'CUTOFF_INVALID', 'STAGE_IDENTITY_INVALID', 'STAGE_CUTOFF_MISMATCH',
    'STAGE_STATE_INVALID', 'REASON_CODES_INVALID', 'UNSAFE_OUTPUT_PRESENT',
  ];
  const ordered = orderedProblems.filter((code) => problems.has(code));
  let fingerprint: string | null = null;
  if (ordered.length === 0) {
    const canonical = JSON.stringify({
      schemaVersion: OFFLINE_RECEIPT_SCHEMA_VERSION,
      knowledgeCutoff: cutoff,
      mode: 'OFFLINE_ONLY',
      execution: 'FORBIDDEN',
      lineage,
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    fingerprint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    schemaVersion: OFFLINE_RECEIPT_SCHEMA_VERSION,
    mode: 'OFFLINE_ONLY',
    verification: ordered.length === 0 ? 'VALID_HOLD' : 'REJECTED',
    execution: 'FORBIDDEN',
    knowledgeCutoff: cutoff,
    hashAlgorithm: 'SHA-256',
    fingerprint,
    problems: ordered,
    lineage,
  };
}
