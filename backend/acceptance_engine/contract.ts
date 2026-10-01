/** E2E-0: institutional acceptance manifest and fail-closed gate. */

import { ALERT_ALGORITHM_VERSION, ALERT_SCHEMA_VERSION } from '../alert_engine/contract.js';

export const ACCEPTANCE_SCHEMA_VERSION = 'xau.institutional-acceptance.v1' as const;
export const ACCEPTANCE_ALGORITHM_VERSION = 'institutional-acceptance-gate-1.0.0' as const;

export const ACCEPTANCE_EVIDENCE_KEYS = [
  'restorableRecoveryPoint',
  'productionMigrationsApplied',
  'officialBundleLiveProven',
  'runtimeDeploymentProven',
  'providerPoliciesApproved',
  'semanticMethodsApproved',
  'portfolioRiskPoliciesApproved',
  'alertDeliveryPolicyApproved',
  'goldenPathReplayProven',
  'incidentRecoveryProven',
  'executionAuthorityApproved',
] as const;

export type AcceptanceEvidenceKey = typeof ACCEPTANCE_EVIDENCE_KEYS[number];
export type AcceptanceReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'ALERT_VERSION_MISMATCH'
  | 'ALERT_CUTOFF_MISMATCH'
  | 'ALERT_NOT_DELIVERABLE'
  | 'REQUIRED_EVIDENCE_MISSING'
  | 'E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED';

export interface InstitutionalAcceptanceInput {
  readonly alert: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: string;
    readonly delivery: string;
    readonly knowledgeCutoff: string;
  };
  readonly evidence: Readonly<Record<AcceptanceEvidenceKey, boolean>>;
}

export interface InstitutionalAcceptanceEnvelope {
  readonly schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ACCEPTANCE_ALGORITHM_VERSION;
  readonly acceptanceState: 'NOT_ACCEPTED';
  readonly productionReadiness: 'HOLD';
  readonly acceptanceRun: null;
  readonly report: null;
  readonly evidence: Readonly<Record<AcceptanceEvidenceKey, boolean>>;
  readonly missingEvidence: readonly AcceptanceEvidenceKey[];
  readonly reasonCodes: readonly AcceptanceReasonCode[];
  readonly knowledgeCutoff: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** E2E-0 records missing proof but never runs or grants acceptance. */
export function buildInstitutionalAcceptanceGate(
  input: InstitutionalAcceptanceInput,
  knowledgeCutoff: string,
): InstitutionalAcceptanceEnvelope {
  const reasons = new Set<AcceptanceReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.alert.schemaVersion !== ALERT_SCHEMA_VERSION
      || input.alert.algorithmVersion !== ALERT_ALGORITHM_VERSION) {
    reasons.add('ALERT_VERSION_MISMATCH');
  }
  if (input.alert.knowledgeCutoff !== knowledgeCutoff) reasons.add('ALERT_CUTOFF_MISMATCH');
  if (input.alert.state !== 'READY' || input.alert.delivery !== 'AUTHORIZED') {
    reasons.add('ALERT_NOT_DELIVERABLE');
  }

  const evidence = Object.fromEntries(
    ACCEPTANCE_EVIDENCE_KEYS.map((key) => [key, input.evidence[key] === true]),
  ) as unknown as Readonly<Record<AcceptanceEvidenceKey, boolean>>;
  const missingEvidence = ACCEPTANCE_EVIDENCE_KEYS.filter((key) => !evidence[key]);
  if (missingEvidence.length > 0) reasons.add('REQUIRED_EVIDENCE_MISSING');
  reasons.add('E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'ALERT_VERSION_MISMATCH', 'ALERT_CUTOFF_MISMATCH',
    'ALERT_NOT_DELIVERABLE', 'REQUIRED_EVIDENCE_MISSING',
    'E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED',
  ] satisfies readonly AcceptanceReasonCode[];

  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    algorithmVersion: ACCEPTANCE_ALGORITHM_VERSION,
    acceptanceState: 'NOT_ACCEPTED',
    productionReadiness: 'HOLD',
    acceptanceRun: null,
    report: null,
    evidence,
    missingEvidence,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
  };
}
