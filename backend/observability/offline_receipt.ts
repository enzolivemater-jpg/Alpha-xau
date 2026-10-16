/**
 * OBS-0 v2 — deterministic, read-only audit receipt of the canonical TV-2 CHAIN-0.
 *
 * Never sign, attest, authorize or deliver. The SHA-256 digest comes from the
 * same 12-stage chain object used by the terminal, not a second orchestrator.
 * Reject unknown/positive/runtime fields and malformed or future cutoffs.
 */
import {
  DECISION_CHAIN_SCHEMA_VERSION,
  DECISION_CHAIN_ALGORITHM_VERSION,
  DECISION_CHAIN_STAGES,
  computeDecisionChainDigest,
  verifyDecisionChainIntegrity,
  type DecisionChainDryRunResult,
  type DecisionChainStageTrace,
} from '../decision_chain/dry_run.js';
import { isStrictTimestamp } from '../shared/temporal_contract.js';

export const OFFLINE_RECEIPT_SCHEMA_VERSION = 'xau.offline-audit-receipt.v2' as const;
export const OFFLINE_RECEIPT_ALGORITHM_VERSION = 'canonical-chain-hold-receipt-2.0.0' as const;

export type ReceiptProblem =
  | 'CHAIN_SHAPE_INVALID' | 'CHAIN_IDENTITY_INVALID' | 'CHAIN_MODE_INVALID'
  | 'CHAIN_STATE_INVALID' | 'CUTOFF_INVALID' | 'STAGE_SHAPE_INVALID'
  | 'STAGE_INTEGRITY_INVALID' | 'UNSAFE_OUTPUT_PRESENT';

export interface OfflineAuditReceipt {
  readonly schemaVersion: typeof OFFLINE_RECEIPT_SCHEMA_VERSION;
  readonly algorithmVersion: typeof OFFLINE_RECEIPT_ALGORITHM_VERSION;
  readonly mode: 'OFFLINE_ONLY';
  readonly verification: 'STRUCTURALLY_VALID_HOLD_UNVERIFIED' | 'REJECTED';
  readonly authorization: 'NONE';
  readonly provenance: 'UNVERIFIED';
  readonly execution: 'FORBIDDEN';
  readonly knowledgeCutoff: string | null;
  /** Not a digital signature, source attestation or production evidence. */
  readonly fingerprint: string | null;
  readonly problems: readonly ReceiptProblem[];
  readonly lineage: readonly DecisionChainStageTrace[];
}

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: JsonObject, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && Object.keys(v).every((k) => keys.includes(k));

const TOP_LEVEL = [
  'schemaVersion', 'algorithmVersion', 'mode', 'chainState', 'execution',
  'integrity', 'violations', 'knowledgeCutoff', 'inputFindings', 'trace', 'stages',
] as const;
const STAGE_KEYS = [
  'marketPricing', 'positioning', 'regime', 'horizonSynthesis', 'committee',
  'prePm', 'portfolioManager', 'finalActionRisk', 'action', 'commandCenter',
  'alert', 'acceptance',
] as const;
const PROBLEM_ORDER: readonly ReceiptProblem[] = [
  'CHAIN_SHAPE_INVALID', 'CHAIN_IDENTITY_INVALID', 'CHAIN_MODE_INVALID',
  'CHAIN_STATE_INVALID', 'CUTOFF_INVALID', 'STAGE_SHAPE_INVALID',
  'STAGE_INTEGRITY_INVALID', 'UNSAFE_OUTPUT_PRESENT',
];
const expectedCodes = (codes: unknown): codes is string[] =>
  Array.isArray(codes) && codes.length <= 128
  && codes.every((c) => typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(c))
  && new Set(codes).size === codes.length;

/** Fails closed on a forged or malformed chain without minting a digest. */
export async function buildOfflineAuditReceipt(raw: unknown): Promise<OfflineAuditReceipt> {
  const problems = new Set<ReceiptProblem>();
  const input = object(raw) ? raw : {};
  const cutoff = typeof input.knowledgeCutoff === 'string' ? input.knowledgeCutoff : null;
  if (!object(raw) || !exactKeys(input, TOP_LEVEL)) problems.add('CHAIN_SHAPE_INVALID');
  if (input.schemaVersion !== DECISION_CHAIN_SCHEMA_VERSION
      || input.algorithmVersion !== DECISION_CHAIN_ALGORITHM_VERSION) {
    problems.add('CHAIN_IDENTITY_INVALID');
  }
  if (input.mode !== 'DRY_RUN') problems.add('CHAIN_MODE_INVALID');
  if (input.chainState !== 'HOLD' || input.execution !== 'FORBIDDEN'
      || input.integrity !== 'CONSISTENT' || !Array.isArray(input.violations)
      || input.violations.length !== 0) problems.add('CHAIN_STATE_INVALID');
  if (!isStrictTimestamp(cutoff)) problems.add('CUTOFF_INVALID');

  const stages = input.stages;
  const trace = input.trace;
  const stageShape = object(stages) && exactKeys(stages, STAGE_KEYS)
    && STAGE_KEYS.every((key) => object(stages[key])
      && expectedCodes((stages[key] as JsonObject).reasonCodes))
    && Array.isArray(trace) && trace.length === DECISION_CHAIN_STAGES.length
    && trace.every((entry: unknown, i: number) => object(entry)
      && exactKeys(entry, ['stage', 'schemaVersion', 'algorithmVersion', 'state', 'reasonCodes', 'knowledgeCutoff'])
      && entry.stage === DECISION_CHAIN_STAGES[i].stage
      && entry.schemaVersion === DECISION_CHAIN_STAGES[i].schemaVersion
      && entry.algorithmVersion === DECISION_CHAIN_STAGES[i].algorithmVersion
      && entry.knowledgeCutoff === cutoff && expectedCodes(entry.reasonCodes));
  if (!stageShape) problems.add('STAGE_SHAPE_INVALID');

  if (stageShape) {
    try {
      const checked = raw as DecisionChainDryRunResult;
      if (verifyDecisionChainIntegrity(checked).length !== 0) {
        problems.add('STAGE_INTEGRITY_INVALID');
      }
      const s = checked.stages;
      // Preserve OBS-0 anti-spoof proof: no provider, approved action, broker
      // ticket, scheduled alert, positive horizon, acceptance, or fake runtime.
      const allEvidenceFalse = s.acceptance.evidence !== null
        && typeof s.acceptance.evidence === 'object'
        && Object.values(s.acceptance.evidence).length === 11
        && Object.values(s.acceptance.evidence).every((value) => value === false);
      const obs = s.commandCenter.observability;
      if (s.horizonSynthesis.scenarios.length !== 5
          || s.horizonSynthesis.scenarios.some((h) => h.status !== 'ABSTAIN'
            || h.direction !== 'UNAVAILABLE' || h.probability !== null
            || h.target !== null || h.invalidation !== null || h.confidence !== null)
          || s.committee.providerInvocation !== 'FORBIDDEN'
          || s.committee.request !== null || s.committee.response !== null
          || s.committee.legacyCommitteeOutputAccepted !== false
          || s.prePm.portfolioManagerEligibility !== 'BLOCKED'
          || s.prePm.portfolioManagerInput !== null
          || s.portfolioManager.recommendation !== null
          || s.portfolioManager.sizing !== null
          || s.finalActionRisk.actionEligibility !== 'BLOCKED'
          || s.finalActionRisk.positionSize !== null
          || s.finalActionRisk.stopLoss !== null
          || s.action.order !== null || s.action.recommendation !== null
          || s.commandCenter.tradeTicket !== null
          || s.commandCenter.mode !== 'READ_ONLY'
          || obs.state !== 'CONTRACT_ONLY' || obs.correlationId !== null
          || obs.deploymentId !== null
          || s.alert.delivery !== 'FORBIDDEN' || s.alert.payload !== null
          || s.alert.recipient !== null || s.alert.channel !== null
          || s.alert.escalation !== 'FORBIDDEN' || s.alert.expiresAt !== null
          || s.acceptance.acceptanceRun !== null || s.acceptance.report !== null
          || s.acceptance.productionReadiness !== 'HOLD' || !allEvidenceFalse) {
        problems.add('UNSAFE_OUTPUT_PRESENT');
      }
    } catch {
      problems.add('STAGE_INTEGRITY_INVALID');
    }
  }

  // A result that cannot be canonically serialized (a non-finite number echoed
  // by an abstaining stage, say) cannot back a receipt: refuse it, never throw.
  let fingerprint: string | null = null;
  if (problems.size === 0) {
    try {
      fingerprint = await computeDecisionChainDigest(raw as DecisionChainDryRunResult);
    } catch {
      problems.add('STAGE_INTEGRITY_INVALID');
    }
  }
  const ordered = PROBLEM_ORDER.filter((p) => problems.has(p));
  const valid = ordered.length === 0;
  return {
    schemaVersion: OFFLINE_RECEIPT_SCHEMA_VERSION,
    algorithmVersion: OFFLINE_RECEIPT_ALGORITHM_VERSION,
    mode: 'OFFLINE_ONLY',
    verification: valid ? 'STRUCTURALLY_VALID_HOLD_UNVERIFIED' : 'REJECTED',
    authorization: 'NONE', provenance: 'UNVERIFIED', execution: 'FORBIDDEN',
    knowledgeCutoff: cutoff, fingerprint, problems: ordered,
    lineage: stageShape ? (trace as DecisionChainStageTrace[]).map((e) => ({
      stage: e.stage, schemaVersion: e.schemaVersion,
      algorithmVersion: e.algorithmVersion, state: e.state,
      reasonCodes: [...e.reasonCodes], knowledgeCutoff: e.knowledgeCutoff,
    })) : [],
  };
}
