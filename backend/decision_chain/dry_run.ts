/**
 * CHAIN-0: deterministic dry run of the complete V2 decision chain.
 *
 * Every stage receives the exact envelope produced by the previous stage at
 * one shared knowledge cutoff. The function is pure: no clock, network,
 * database, provider, broker or random source is read, and nothing is
 * persisted. The terminal state is always HOLD with execution forbidden.
 */

import {
  ACCEPTANCE_ALGORITHM_VERSION,
  ACCEPTANCE_SCHEMA_VERSION,
  buildInstitutionalAcceptanceGate,
  type AcceptanceEvidenceKey,
  type InstitutionalAcceptanceEnvelope,
} from '../acceptance_engine/contract.js';
import {
  ACTION_ALGORITHM_VERSION,
  ACTION_SCHEMA_VERSION,
  buildActionAbstentionGate,
  type ActionAbstentionEnvelope,
} from '../action_engine/contract.js';
import {
  COMMITTEE_V2_ALGORITHM_VERSION,
  COMMITTEE_V2_SCHEMA_VERSION,
  buildCommitteeV2Gate,
  type CommitteeV2GateEnvelope,
} from '../ai_engine/v2_committee_contract.js';
import {
  ALERT_ALGORITHM_VERSION,
  ALERT_SCHEMA_VERSION,
  buildAlertSuppressionGate,
  type AlertSuppressionEnvelope,
} from '../alert_engine/contract.js';
import {
  COMMAND_CENTER_ALGORITHM_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
  buildCommandCenterProjection,
  type CommandCenterProjection,
} from '../command_center/contract.js';
import {
  HORIZON_ALGORITHM_VERSION,
  HORIZON_SCHEMA_VERSION,
  HORIZONS,
  buildHorizonSynthesisContract,
  type HorizonContractInput,
  type HorizonSynthesisEnvelope,
} from '../horizon_engine/contract.js';
import {
  MARKET_PRICING_ALGORITHM_VERSION,
  MARKET_PRICING_SCHEMA_VERSION,
  buildInstitutionalMarketPricingSnapshot,
  type InstitutionalMarketPricingSnapshot,
} from '../market_engine/institutional_snapshot.js';
import type { Freshness, MarketField, MarketSnapshot, MarketSymbol } from '../market_engine/types.js';
import { SYMBOL_RULES, classifyFreshness } from '../market_engine/validate.js';
import {
  PORTFOLIO_MANAGER_ALGORITHM_VERSION,
  PORTFOLIO_MANAGER_SCHEMA_VERSION,
  buildPortfolioManagerGate,
  type PortfolioManagerGateEnvelope,
} from '../portfolio_engine/contract.js';
import {
  POSITIONING_ALGORITHM_VERSION,
  POSITIONING_SCHEMA_VERSION,
  buildPositioningEvidenceEnvelope,
  type PositioningEvidenceEnvelope,
  type PositioningEvidenceInput,
} from '../positioning_engine/evidence_contract.js';
import {
  REGIME_ALGORITHM_VERSION,
  REGIME_SCHEMA_VERSION,
  buildRegimeAssessmentContract,
  type RegimeAssessmentEnvelope,
} from '../regime_engine/contract.js';
import {
  FINAL_ACTION_RISK_ALGORITHM_VERSION,
  FINAL_ACTION_RISK_SCHEMA_VERSION,
  buildFinalActionRiskGate,
  type FinalActionRiskEnvelope,
} from '../risk_engine/final_action_contract.js';
import {
  PRE_PM_ALGORITHM_VERSION,
  PRE_PM_SCHEMA_VERSION,
  buildPrePmEvidenceRiskGate,
  type PrePmContractInput,
  type PrePmEnvelope,
} from '../risk_engine/pre_pm_contract.js';
import { parseStrictTimestamp } from '../shared/strict_timestamp.js';

export const DECISION_CHAIN_SCHEMA_VERSION = 'xau.decision-chain-dry-run.v1' as const;
export const DECISION_CHAIN_ALGORITHM_VERSION = 'decision-chain-dry-run-1.0.0' as const;

export const DECISION_CHAIN_STAGES = [
  { stage: 'MARKET_PRICING', schemaVersion: MARKET_PRICING_SCHEMA_VERSION, algorithmVersion: MARKET_PRICING_ALGORITHM_VERSION },
  { stage: 'POSITIONING', schemaVersion: POSITIONING_SCHEMA_VERSION, algorithmVersion: POSITIONING_ALGORITHM_VERSION },
  { stage: 'REGIME', schemaVersion: REGIME_SCHEMA_VERSION, algorithmVersion: REGIME_ALGORITHM_VERSION },
  { stage: 'HORIZON_SYNTHESIS', schemaVersion: HORIZON_SCHEMA_VERSION, algorithmVersion: HORIZON_ALGORITHM_VERSION },
  { stage: 'AI_COMMITTEE', schemaVersion: COMMITTEE_V2_SCHEMA_VERSION, algorithmVersion: COMMITTEE_V2_ALGORITHM_VERSION },
  { stage: 'PRE_PM', schemaVersion: PRE_PM_SCHEMA_VERSION, algorithmVersion: PRE_PM_ALGORITHM_VERSION },
  { stage: 'PORTFOLIO_MANAGER', schemaVersion: PORTFOLIO_MANAGER_SCHEMA_VERSION, algorithmVersion: PORTFOLIO_MANAGER_ALGORITHM_VERSION },
  { stage: 'FINAL_ACTION_RISK', schemaVersion: FINAL_ACTION_RISK_SCHEMA_VERSION, algorithmVersion: FINAL_ACTION_RISK_ALGORITHM_VERSION },
  { stage: 'ACTION', schemaVersion: ACTION_SCHEMA_VERSION, algorithmVersion: ACTION_ALGORITHM_VERSION },
  { stage: 'COMMAND_CENTER', schemaVersion: COMMAND_CENTER_SCHEMA_VERSION, algorithmVersion: COMMAND_CENTER_ALGORITHM_VERSION },
  { stage: 'ALERT', schemaVersion: ALERT_SCHEMA_VERSION, algorithmVersion: ALERT_ALGORITHM_VERSION },
  { stage: 'ACCEPTANCE', schemaVersion: ACCEPTANCE_SCHEMA_VERSION, algorithmVersion: ACCEPTANCE_ALGORITHM_VERSION },
] as const;

export type DecisionChainStage = typeof DECISION_CHAIN_STAGES[number]['stage'];
export type Authorization = 'AUTHORIZED' | 'UNAUTHORIZED';

/**
 * Every external decision is explicit input. CHAIN-0 never defaults an
 * authorization, a policy version or a runtime identifier.
 */
export interface DecisionChainDryRunInput {
  readonly marketSnapshot: MarketSnapshot;
  readonly positioningEvidence: readonly PositioningEvidenceInput[];
  /**
   * Chain-level Event Impact and Gold Transmission summaries. Aggregating
   * per-event processor plans into one summary at the chain cutoff is not
   * defined by CHAIN-0; the horizon gate rejects any version or cutoff drift.
   */
  readonly eventImpact: HorizonContractInput['eventImpact'];
  readonly goldTransmission: HorizonContractInput['goldTransmission'];
  readonly evidenceGraph: PrePmContractInput['evidenceGraph'];
  readonly authorizations: {
    readonly provider: Authorization;
    readonly cost: Authorization;
    readonly portfolioPolicy: Authorization;
    readonly riskPolicy: Authorization;
    readonly execution: Authorization;
    readonly alertPolicy: Authorization;
    readonly delivery: Authorization;
  };
  readonly portfolioState: 'AVAILABLE' | 'UNAVAILABLE';
  readonly brokerConstraintsVersion: string | null;
  readonly brokerConnection: 'CONNECTED' | 'ABSENT';
  readonly recipientPolicyVersion: string | null;
  readonly runtimeEvidence: {
    readonly correlationId: string | null;
    readonly deploymentId: string | null;
  };
  readonly acceptanceEvidence: Readonly<Record<AcceptanceEvidenceKey, boolean>>;
}

/** Optional identifiers a gate would otherwise treat as present when blank. */
export const DECISION_CHAIN_IDENTIFIER_FIELDS = [
  'evidenceGraph.schemaVersion',
  'brokerConstraintsVersion',
  'recipientPolicyVersion',
  'runtimeEvidence.correlationId',
  'runtimeEvidence.deploymentId',
] as const;

export type DecisionChainIdentifierField = typeof DECISION_CHAIN_IDENTIFIER_FIELDS[number];

export const DECISION_CHAIN_MARKET_FIELDS = [
  'spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti',
] as const;
export type DecisionChainMarketField = typeof DECISION_CHAIN_MARKET_FIELDS[number];

/** Approved freshness rule per snapshot field; DXY has none. */
const MARKET_FIELD_SYMBOL: Readonly<Record<DecisionChainMarketField, MarketSymbol | null>> = {
  spot: 'XAUUSD', bid: 'XAUUSD', ask: 'XAUUSD', dxy: null,
  us10y: 'US10Y', realYield: 'US10YR', vix: 'VIX', wti: 'WTI',
};

export type DecisionChainInputFindingCode =
  | 'INVALID_IDENTIFIER_NULLIFIED'
  | 'MARKET_FIELD_STALE_AT_CUTOFF'
  | 'MARKET_FIELD_EXPIRED_AT_CUTOFF'
  | 'MARKET_FIELD_FRESHNESS_RULE_UNAVAILABLE';

/**
 * Input that the frozen gates would accept too optimistically is made more
 * restrictive before it reaches them, and every such change is recorded:
 * - an identifier failing the shape check is replaced by null;
 * - a market field whose declared freshness is better than its age at the
 *   knowledge cutoff allows (under the existing `SYMBOL_RULES`) is downgraded
 *   to STALE, or to UNAVAILABLE with its value removed;
 * - a market value with no approved freshness rule is made UNAVAILABLE.
 * A finding can only make the chain more restrictive.
 */
export interface DecisionChainInputFinding {
  readonly field: DecisionChainIdentifierField | `marketSnapshot.${DecisionChainMarketField}`;
  readonly code: DecisionChainInputFindingCode;
}

export interface DecisionChainStageTrace {
  readonly stage: DecisionChainStage;
  readonly schemaVersion: string;
  readonly algorithmVersion: string;
  readonly state: string;
  readonly reasonCodes: readonly string[];
  readonly knowledgeCutoff: string;
}

export type DecisionChainViolationCode =
  | 'MALFORMED_RESULT'
  | 'CHAIN_ENVELOPE_MISMATCH'
  | 'STAGE_SET_MISMATCH'
  | 'STAGE_VERSION_MISMATCH'
  | 'STAGE_CUTOFF_MISMATCH'
  | 'STAGE_STATE_FORBIDDEN'
  | 'POSITIVE_OUTPUT_FORBIDDEN'
  | 'TRACE_STAGE_MISMATCH'
  | 'LINEAGE_MISMATCH'
  | 'ACTION_REASONS_NOT_PROPAGATED'
  | 'ALERT_DEDUPE_KEY_MISMATCH';

export interface DecisionChainViolation {
  readonly stage: DecisionChainStage | 'CHAIN';
  readonly code: DecisionChainViolationCode;
}

export interface DecisionChainStages {
  readonly marketPricing: InstitutionalMarketPricingSnapshot;
  readonly positioning: PositioningEvidenceEnvelope;
  readonly regime: RegimeAssessmentEnvelope;
  readonly horizonSynthesis: HorizonSynthesisEnvelope;
  readonly committee: CommitteeV2GateEnvelope;
  readonly prePm: PrePmEnvelope;
  readonly portfolioManager: PortfolioManagerGateEnvelope;
  readonly finalActionRisk: FinalActionRiskEnvelope;
  readonly action: ActionAbstentionEnvelope;
  readonly commandCenter: CommandCenterProjection;
  readonly alert: AlertSuppressionEnvelope;
  readonly acceptance: InstitutionalAcceptanceEnvelope;
}

export interface DecisionChainDryRunResult {
  readonly schemaVersion: typeof DECISION_CHAIN_SCHEMA_VERSION;
  readonly algorithmVersion: typeof DECISION_CHAIN_ALGORITHM_VERSION;
  readonly mode: 'DRY_RUN';
  readonly chainState: 'HOLD';
  readonly execution: 'FORBIDDEN';
  readonly integrity: 'CONSISTENT' | 'VIOLATED';
  readonly violations: readonly DecisionChainViolation[];
  readonly knowledgeCutoff: string;
  readonly inputFindings: readonly DecisionChainInputFinding[];
  readonly trace: readonly DecisionChainStageTrace[];
  readonly stages: DecisionChainStages;
}

const STAGE_KEYS = [
  'marketPricing', 'positioning', 'regime', 'horizonSynthesis', 'committee', 'prePm',
  'portfolioManager', 'finalActionRisk', 'action', 'commandCenter', 'alert', 'acceptance',
] as const satisfies readonly (keyof DecisionChainStages)[];

/** States a stage may report while every downstream method remains unapproved. */
const ALLOWED_STATES: Readonly<Record<DecisionChainStage, readonly string[]>> = {
  MARKET_PRICING: ['AVAILABLE', 'DEGRADED', 'ABSTAIN'],
  POSITIONING: ['EVIDENCE_READY', 'ABSTAIN'],
  REGIME: ['READY', 'DEGRADED', 'ABSTAIN'],
  HORIZON_SYNTHESIS: ['ABSTAIN'],
  AI_COMMITTEE: ['ABSTAIN'],
  PRE_PM: ['ABSTAIN'],
  PORTFOLIO_MANAGER: ['ABSTAIN'],
  FINAL_ACTION_RISK: ['ABSTAIN'],
  ACTION: ['ABSTAIN'],
  COMMAND_CENTER: ['HOLD'],
  ALERT: ['SUPPRESSED'],
  ACCEPTANCE: ['NOT_ACCEPTED'],
};

function stageState(stages: DecisionChainStages, key: typeof STAGE_KEYS[number]): string {
  switch (key) {
    case 'marketPricing': return stages.marketPricing.state;
    case 'positioning': return stages.positioning.evidenceState;
    case 'regime': return stages.regime.evidenceState;
    case 'horizonSynthesis': return stages.horizonSynthesis.state;
    case 'committee': return stages.committee.state;
    case 'prePm': return stages.prePm.state;
    case 'portfolioManager': return stages.portfolioManager.state;
    case 'finalActionRisk': return stages.finalActionRisk.state;
    case 'action': return stages.action.decision;
    case 'commandCenter': return stages.commandCenter.systemState;
    case 'alert': return stages.alert.state;
    case 'acceptance': return stages.acceptance.acceptanceState;
  }
}

function buildTrace(stages: DecisionChainStages): DecisionChainStageTrace[] {
  return STAGE_KEYS.map((key, index) => {
    const envelope = stages[key];
    return {
      stage: DECISION_CHAIN_STAGES[index].stage,
      schemaVersion: envelope.schemaVersion,
      algorithmVersion: envelope.algorithmVersion,
      state: stageState(stages, key),
      reasonCodes: [...envelope.reasonCodes],
      knowledgeCutoff: envelope.knowledgeCutoff,
    };
  });
}

/** Fields that only an approved positive method could populate. */
function positiveOutputs(stages: DecisionChainStages): ReadonlyArray<readonly [DecisionChainStage, boolean]> {
  const s = stages;
  const scenarios = s.horizonSynthesis.scenarios;
  return [
    ['POSITIONING', s.positioning.positioningState !== 'UNAVAILABLE'],
    ['REGIME', s.regime.regime !== 'UNAVAILABLE' || s.regime.confidence !== null],
    ['HORIZON_SYNTHESIS', scenarios.length !== HORIZONS.length
      || scenarios.some((scenario, index) => scenario.horizon !== HORIZONS[index])
      || scenarios.some((scenario) => scenario.status !== 'ABSTAIN'
      || scenario.direction !== 'UNAVAILABLE' || scenario.probability !== null
      || scenario.target !== null || scenario.invalidation !== null || scenario.confidence !== null)],
    ['AI_COMMITTEE', s.committee.providerInvocation !== 'FORBIDDEN' || s.committee.request !== null
      || s.committee.response !== null || s.committee.legacyCommitteeOutputAccepted !== false],
    ['PRE_PM', s.prePm.portfolioManagerEligibility !== 'BLOCKED' || s.prePm.evidenceAcceptance !== 'UNAVAILABLE'
      || s.prePm.riskVerdict !== null
      || s.prePm.confidence !== null || s.prePm.portfolioManagerInput !== null],
    ['PORTFOLIO_MANAGER', s.portfolioManager.advisoryOnly !== true || s.portfolioManager.recommendation !== null || s.portfolioManager.targetAllocation !== null
      || s.portfolioManager.sizing !== null || s.portfolioManager.confidence !== null],
    ['FINAL_ACTION_RISK', s.finalActionRisk.actionEligibility !== 'BLOCKED' || s.finalActionRisk.maximumLoss !== null
      || s.finalActionRisk.positionSize !== null || s.finalActionRisk.stopLoss !== null
      || s.finalActionRisk.riskVerdict !== null],
    ['ACTION', s.action.execution !== 'FORBIDDEN' || s.action.advisoryOnly !== true
      || s.action.recommendation !== null || s.action.order !== null],
    ['COMMAND_CENTER', s.commandCenter.execution !== 'FORBIDDEN' || s.commandCenter.decision !== 'ABSTAIN'
      || s.commandCenter.tradeTicket !== null || s.commandCenter.scenarioTreeStatus !== 'UNAVAILABLE'
      || s.commandCenter.mode !== 'READ_ONLY' || s.commandCenter.observability.state !== 'CONTRACT_ONLY'],
    ['ALERT', s.alert.delivery !== 'FORBIDDEN' || s.alert.escalation !== 'FORBIDDEN' || s.alert.recipient !== null
      || s.alert.channel !== null || s.alert.payload !== null || s.alert.expiresAt !== null],
    ['ACCEPTANCE', s.acceptance.productionReadiness !== 'HOLD' || s.acceptance.acceptanceRun !== null
      || s.acceptance.report !== null],
  ];
}

type VerifiableDecisionChain = Omit<DecisionChainDryRunResult, 'integrity' | 'violations' | 'inputFindings'>;

/**
 * Re-checks a chain result, including one reloaded from storage or a log.
 * Violations are reported in stage order; a single result never hides one.
 * A structurally malformed result is reported, never thrown.
 */
export function verifyDecisionChainIntegrity(result: VerifiableDecisionChain): DecisionChainViolation[] {
  if (result === null || typeof result !== 'object' || result.stages === null
      || typeof result.stages !== 'object' || !Array.isArray(result.trace)) {
    return [{ stage: 'CHAIN', code: 'MALFORMED_RESULT' }];
  }
  if (STAGE_KEYS.some((key) => result.stages[key] === null || typeof result.stages[key] !== 'object')) {
    return [{ stage: 'CHAIN', code: 'STAGE_SET_MISMATCH' }];
  }
  if (STAGE_KEYS.some((key) => !Array.isArray(result.stages[key].reasonCodes))
      || !Array.isArray(result.stages.horizonSynthesis.scenarios)
      || !Array.isArray(result.stages.commandCenter.actionReasonCodes)) {
    return [{ stage: 'CHAIN', code: 'MALFORMED_RESULT' }];
  }
  try {
    return collectViolations(result);
  } catch {
    return [{ stage: 'CHAIN', code: 'MALFORMED_RESULT' }];
  }
}

function collectViolations(result: VerifiableDecisionChain): DecisionChainViolation[] {
  const violations: DecisionChainViolation[] = [];
  const add = (stage: DecisionChainViolation['stage'], code: DecisionChainViolationCode): void => {
    if (!violations.some((v) => v.stage === stage && v.code === code)) violations.push({ stage, code });
  };
  const { stages } = result;
  if (result.schemaVersion !== DECISION_CHAIN_SCHEMA_VERSION
      || result.algorithmVersion !== DECISION_CHAIN_ALGORITHM_VERSION
      || result.mode !== 'DRY_RUN' || result.chainState !== 'HOLD' || result.execution !== 'FORBIDDEN') {
    add('CHAIN', 'CHAIN_ENVELOPE_MISMATCH');
  }

  STAGE_KEYS.forEach((key, index) => {
    const expected = DECISION_CHAIN_STAGES[index];
    const envelope = stages[key];
    if (envelope.schemaVersion !== expected.schemaVersion
        || envelope.algorithmVersion !== expected.algorithmVersion) {
      add(expected.stage, 'STAGE_VERSION_MISMATCH');
    }
    if (envelope.knowledgeCutoff !== result.knowledgeCutoff) add(expected.stage, 'STAGE_CUTOFF_MISMATCH');
    if (!ALLOWED_STATES[expected.stage].includes(stageState(stages, key))) {
      add(expected.stage, 'STAGE_STATE_FORBIDDEN');
    }
  });

  for (const [stage, positive] of positiveOutputs(stages)) {
    if (positive) add(stage, 'POSITIVE_OUTPUT_FORBIDDEN');
  }

  const recomputed = buildTrace(stages);
  if (canonicalJson(result.trace) !== canonicalJson(recomputed)) add('CHAIN', 'TRACE_STAGE_MISMATCH');

  const lineage = stages.commandCenter.lineage;
  const expectedLineage = DECISION_CHAIN_STAGES.slice(0, 9);
  if (!Array.isArray(lineage) || lineage.length !== expectedLineage.length
      || expectedLineage.some((item, index) => lineage[index]?.stage !== item.stage
        || lineage[index]?.schemaVersion !== item.schemaVersion
        || lineage[index]?.algorithmVersion !== item.algorithmVersion)) {
    add('COMMAND_CENTER', 'LINEAGE_MISMATCH');
  }
  if (canonicalJson(stages.commandCenter.actionReasonCodes) !== canonicalJson(stages.action.reasonCodes)) {
    add('COMMAND_CENTER', 'ACTION_REASONS_NOT_PROPAGATED');
  }

  const cc = stages.commandCenter;
  const expectedDedupe = [
    ALERT_SCHEMA_VERSION, cc.schemaVersion, cc.algorithmVersion, result.knowledgeCutoff,
    cc.systemState, cc.decision, cc.execution, [...new Set(cc.reasonCodes)].sort().join(','),
  ].join('|');
  if (stages.alert.dedupeKey !== expectedDedupe) add('ALERT', 'ALERT_DEDUPE_KEY_MISMATCH');

  return violations;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function identifierOrNull(
  field: DecisionChainIdentifierField,
  value: string | null,
  findings: DecisionChainInputFinding[],
): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && IDENTIFIER.test(value)) return value;
  findings.push({ field, code: 'INVALID_IDENTIFIER_NULLIFIED' });
  return null;
}

const FRESHNESS_RANK: Readonly<Record<Freshness, number>> = { LIVE: 0, STALE: 1, UNAVAILABLE: 2 };

function fieldAtCutoff(
  name: DecisionChainMarketField,
  field: MarketField,
  cutoffMs: number | null,
  findings: DecisionChainInputFinding[],
): MarketField {
  if (field.value === null) return field;
  const symbol = MARKET_FIELD_SYMBOL[name];
  if (symbol === null) {
    findings.push({ field: `marketSnapshot.${name}`, code: 'MARKET_FIELD_FRESHNESS_RULE_UNAVAILABLE' });
    return { ...field, value: null, status: 'UNAVAILABLE' };
  }
  const observedMs = parseStrictTimestamp(field.observedAt);
  // Invalid or look-ahead timestamps are rejected by MP-0 itself.
  if (cutoffMs === null || observedMs === null || observedMs > cutoffMs) return field;
  const ageSeconds = Math.floor((cutoffMs - observedMs) / 1000);
  const freshness = classifyFreshness(ageSeconds, SYMBOL_RULES[symbol]);
  if (FRESHNESS_RANK[freshness] <= FRESHNESS_RANK[field.status]) return field;
  if (freshness === 'UNAVAILABLE') {
    findings.push({ field: `marketSnapshot.${name}`, code: 'MARKET_FIELD_EXPIRED_AT_CUTOFF' });
    return { ...field, value: null, status: 'UNAVAILABLE', ageSeconds };
  }
  findings.push({ field: `marketSnapshot.${name}`, code: 'MARKET_FIELD_STALE_AT_CUTOFF' });
  return { ...field, status: 'STALE', ageSeconds };
}

function snapshotAtCutoff(
  snapshot: MarketSnapshot,
  knowledgeCutoff: string,
  findings: DecisionChainInputFinding[],
): MarketSnapshot {
  const cutoffMs = parseStrictTimestamp(knowledgeCutoff);
  const fields = Object.fromEntries(DECISION_CHAIN_MARKET_FIELDS.map((name) => [
    name, fieldAtCutoff(name, snapshot[name], cutoffMs, findings),
  ])) as Record<DecisionChainMarketField, MarketField>;
  return { ...snapshot, ...fields };
}

/** Runs MP-0 through E2E-0 at one explicit cutoff and verifies the result. */
export function runDecisionChainDryRun(
  rawInput: DecisionChainDryRunInput,
  knowledgeCutoff: string,
): DecisionChainDryRunResult {
  const inputFindings: DecisionChainInputFinding[] = [];
  const input: DecisionChainDryRunInput = {
    ...rawInput,
    marketSnapshot: snapshotAtCutoff(rawInput.marketSnapshot, knowledgeCutoff, inputFindings),
    evidenceGraph: {
      ...rawInput.evidenceGraph,
      schemaVersion: identifierOrNull('evidenceGraph.schemaVersion',
        rawInput.evidenceGraph.schemaVersion, inputFindings),
    },
    brokerConstraintsVersion: identifierOrNull('brokerConstraintsVersion',
      rawInput.brokerConstraintsVersion, inputFindings),
    recipientPolicyVersion: identifierOrNull('recipientPolicyVersion',
      rawInput.recipientPolicyVersion, inputFindings),
    runtimeEvidence: {
      correlationId: identifierOrNull('runtimeEvidence.correlationId',
        rawInput.runtimeEvidence.correlationId, inputFindings),
      deploymentId: identifierOrNull('runtimeEvidence.deploymentId',
        rawInput.runtimeEvidence.deploymentId, inputFindings),
    },
  };
  const marketPricing = buildInstitutionalMarketPricingSnapshot(input.marketSnapshot, knowledgeCutoff);
  const positioning = buildPositioningEvidenceEnvelope(input.positioningEvidence, knowledgeCutoff);
  const regime = buildRegimeAssessmentContract({ marketPricing, positioning }, knowledgeCutoff);
  const horizonSynthesis = buildHorizonSynthesisContract({
    eventImpact: input.eventImpact,
    goldTransmission: input.goldTransmission,
    marketPricing,
    positioning,
    regime,
  }, knowledgeCutoff);
  const committee = buildCommitteeV2Gate({
    horizonSynthesis,
    providerAuthorization: input.authorizations.provider,
    costAuthorization: input.authorizations.cost,
  }, knowledgeCutoff);
  const prePm = buildPrePmEvidenceRiskGate({
    committee,
    evidenceGraph: input.evidenceGraph,
  }, knowledgeCutoff);
  const portfolioManager = buildPortfolioManagerGate({
    prePm,
    portfolioPolicyAuthorization: input.authorizations.portfolioPolicy,
    portfolioState: input.portfolioState,
  }, knowledgeCutoff);
  const finalActionRisk = buildFinalActionRiskGate({
    portfolioManager,
    riskPolicyAuthorization: input.authorizations.riskPolicy,
    brokerConstraintsVersion: input.brokerConstraintsVersion,
  }, knowledgeCutoff);
  const action = buildActionAbstentionGate({
    finalRisk: finalActionRisk,
    executionAuthorization: input.authorizations.execution,
    brokerConnection: input.brokerConnection,
  }, knowledgeCutoff);
  const commandCenter = buildCommandCenterProjection({
    action,
    runtimeEvidence: input.runtimeEvidence,
  }, knowledgeCutoff);
  const alert = buildAlertSuppressionGate({
    commandCenter,
    alertPolicyAuthorization: input.authorizations.alertPolicy,
    deliveryAuthorization: input.authorizations.delivery,
    recipientPolicyVersion: input.recipientPolicyVersion,
  }, knowledgeCutoff);
  const acceptance = buildInstitutionalAcceptanceGate({
    alert,
    evidence: input.acceptanceEvidence,
  }, knowledgeCutoff);

  const stages: DecisionChainStages = {
    marketPricing, positioning, regime, horizonSynthesis, committee, prePm,
    portfolioManager, finalActionRisk, action, commandCenter, alert, acceptance,
  };
  const chain: VerifiableDecisionChain = {
    schemaVersion: DECISION_CHAIN_SCHEMA_VERSION,
    algorithmVersion: DECISION_CHAIN_ALGORITHM_VERSION,
    mode: 'DRY_RUN',
    chainState: 'HOLD',
    execution: 'FORBIDDEN',
    knowledgeCutoff,
    trace: buildTrace(stages),
    stages,
  };
  const violations = verifyDecisionChainIntegrity(chain);
  return {
    ...chain,
    inputFindings,
    integrity: violations.length === 0 ? 'CONSISTENT' : 'VIOLATED',
    violations,
  };
}

/**
 * Canonical JSON: object keys sorted by code unit, arrays in order, no
 * whitespace. Values JSON cannot represent exactly are rejected rather than
 * silently coerced, so two equal digests imply equal chain content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonicalJson: unsupported object');
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        if (record[key] === undefined) throw new TypeError(`canonicalJson: undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      }).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** SHA-256 replay digest of the canonical chain result (Web Crypto only). */
export async function computeDecisionChainDigest(result: DecisionChainDryRunResult): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(result));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
