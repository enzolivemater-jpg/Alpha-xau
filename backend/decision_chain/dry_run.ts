/**
 * CHAIN-0: offline-only composition of EXISTING institutional abstention gates.
 * No provider, clock, database, persistence, HTTP, broker or production path.
 *
 * The supplied inputs are claims for deterministic contract validation,
 * not live evidence. Absence of approvals is fixed in this harness; an
 * untrusted caller cannot set authorization to true via an input flag.
 */
import {
  buildRegimeAssessmentContract,
  type RegimeContractInput,
} from '../regime_engine/contract.js';
import {
  buildHorizonSynthesisContract,
  type HorizonContractInput,
} from '../horizon_engine/contract.js';
import { buildCommitteeV2Gate } from '../ai_engine/v2_committee_contract.js';
import { buildPrePmEvidenceRiskGate } from '../risk_engine/pre_pm_contract.js';
import { buildPortfolioManagerGate } from '../portfolio_engine/contract.js';
import { buildFinalActionRiskGate } from '../risk_engine/final_action_contract.js';
import { buildActionAbstentionGate } from '../action_engine/contract.js';
import { buildCommandCenterProjection } from '../command_center/contract.js';
import { buildAlertSuppressionGate } from '../alert_engine/contract.js';
import {
  buildInstitutionalAcceptanceGate,
  ACCEPTANCE_EVIDENCE_KEYS,
  type AcceptanceEvidenceKey,
} from '../acceptance_engine/contract.js';

export const CHAIN_0_SCHEMA_VERSION = 'xau.decision-chain-dry-run.v1' as const;

export interface ChainDryRunInput {
  readonly knowledgeCutoff: string;
  readonly eventImpact: HorizonContractInput['eventImpact'];
  readonly goldTransmission: HorizonContractInput['goldTransmission'];
  readonly marketPricing: RegimeContractInput['marketPricing'] & HorizonContractInput['marketPricing'];
  readonly positioning: RegimeContractInput['positioning'] & HorizonContractInput['positioning'];
}

export interface ChainDryRunResult {
  readonly schemaVersion: typeof CHAIN_0_SCHEMA_VERSION;
  readonly mode: 'OFFLINE_ONLY';
  readonly knowledgeCutoff: string;
  readonly systemState: 'HOLD';
  readonly execution: 'FORBIDDEN';
  readonly stages: Readonly<{
    regime: ReturnType<typeof buildRegimeAssessmentContract>;
    horizons: ReturnType<typeof buildHorizonSynthesisContract>;
    committee: ReturnType<typeof buildCommitteeV2Gate>;
    prePm: ReturnType<typeof buildPrePmEvidenceRiskGate>;
    portfolioManager: ReturnType<typeof buildPortfolioManagerGate>;
    finalActionRisk: ReturnType<typeof buildFinalActionRiskGate>;
    action: ReturnType<typeof buildActionAbstentionGate>;
    commandCenter: ReturnType<typeof buildCommandCenterProjection>;
    alerts: ReturnType<typeof buildAlertSuppressionGate>;
    acceptance: ReturnType<typeof buildInstitutionalAcceptanceGate>;
  }>;
}

/** No branch to a positive decision exists. All stages receive their actual
 * preceding envelope, rather than a separately handwritten mock of that stage.
 */
export function runDecisionChainDryRun(input: ChainDryRunInput): ChainDryRunResult {
  const cutoff = input.knowledgeCutoff;
  const regime = buildRegimeAssessmentContract({
    marketPricing: input.marketPricing,
    positioning: input.positioning,
  }, cutoff);
  const horizons = buildHorizonSynthesisContract({
    eventImpact: input.eventImpact,
    goldTransmission: input.goldTransmission,
    marketPricing: input.marketPricing,
    positioning: input.positioning,
    regime,
  }, cutoff);
  const committee = buildCommitteeV2Gate({
    horizonSynthesis: horizons,
    providerAuthorization: 'UNAUTHORIZED',
    costAuthorization: 'UNAUTHORIZED',
  }, cutoff);
  const prePm = buildPrePmEvidenceRiskGate({
    committee,
    evidenceGraph: { schemaVersion: null, complete: false, nodeCount: 0 },
  }, cutoff);
  const portfolioManager = buildPortfolioManagerGate({
    prePm,
    portfolioPolicyAuthorization: 'UNAUTHORIZED',
    portfolioState: 'UNAVAILABLE',
  }, cutoff);
  const finalActionRisk = buildFinalActionRiskGate({
    portfolioManager,
    riskPolicyAuthorization: 'UNAUTHORIZED',
    brokerConstraintsVersion: null,
  }, cutoff);
  const action = buildActionAbstentionGate({
    finalRisk: finalActionRisk,
    executionAuthorization: 'UNAUTHORIZED',
    brokerConnection: 'ABSENT',
  }, cutoff);
  const commandCenter = buildCommandCenterProjection({
    action,
    runtimeEvidence: { correlationId: null, deploymentId: null },
  }, cutoff);
  const alerts = buildAlertSuppressionGate({
    commandCenter,
    alertPolicyAuthorization: 'UNAUTHORIZED',
    deliveryAuthorization: 'UNAUTHORIZED',
    recipientPolicyVersion: null,
  }, cutoff);
  // False means 'proof not supplied to this offline run', NOT evidence
  // that a live environment lacks it. A separate E2E-1 approval is needed.
  const evidence = Object.fromEntries(
    ACCEPTANCE_EVIDENCE_KEYS.map((key) => [key, false]),
  ) as Record<AcceptanceEvidenceKey, boolean>;
  const acceptance = buildInstitutionalAcceptanceGate({
    alert: alerts,
    evidence,
  }, cutoff);
  return {
    schemaVersion: CHAIN_0_SCHEMA_VERSION,
    mode: 'OFFLINE_ONLY',
    knowledgeCutoff: cutoff,
    systemState: 'HOLD',
    execution: 'FORBIDDEN',
    stages: {
      regime, horizons, committee, prePm, portfolioManager, finalActionRisk,
      action, commandCenter, alerts, acceptance,
    },
  };
}
