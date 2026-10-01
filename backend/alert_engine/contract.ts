/** AL-0: deterministic alert suppression and deduplication contract. */

import {
  COMMAND_CENTER_ALGORITHM_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
} from '../command_center/contract.js';

export const ALERT_SCHEMA_VERSION = 'xau.alert-suppression.v1' as const;
export const ALERT_ALGORITHM_VERSION = 'alert-suppression-gate-1.0.0' as const;

export type AlertReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'COMMAND_CENTER_VERSION_MISMATCH'
  | 'COMMAND_CENTER_CUTOFF_MISMATCH'
  | 'COMMAND_CENTER_NOT_ACTIONABLE'
  | 'ALERT_POLICY_NOT_APPROVED'
  | 'DELIVERY_NOT_AUTHORIZED'
  | 'RECIPIENT_POLICY_UNAVAILABLE'
  | 'ALERT_HORIZON_NOT_APPROVED'
  | 'ALERT_METHOD_NOT_APPROVED';

export interface AlertGateInput {
  readonly commandCenter: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly systemState: string;
    readonly decision: string;
    readonly execution: string;
    readonly reasonCodes: readonly string[];
    readonly knowledgeCutoff: string;
  };
  readonly alertPolicyAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
  readonly deliveryAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
  readonly recipientPolicyVersion: string | null;
}

export interface AlertSuppressionEnvelope {
  readonly schemaVersion: typeof ALERT_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ALERT_ALGORITHM_VERSION;
  readonly state: 'SUPPRESSED';
  readonly delivery: 'FORBIDDEN';
  readonly dedupeKey: string;
  readonly expiresAt: null;
  readonly acknowledgementState: 'UNAVAILABLE';
  readonly escalation: 'FORBIDDEN';
  readonly recipient: null;
  readonly channel: null;
  readonly payload: null;
  readonly reasonCodes: readonly AlertReasonCode[];
  readonly knowledgeCutoff: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function buildDedupeKey(input: AlertGateInput, cutoff: string): string {
  const upstreamReasons = [...new Set(input.commandCenter.reasonCodes)].sort().join(',');
  return [
    ALERT_SCHEMA_VERSION,
    input.commandCenter.schemaVersion,
    input.commandCenter.algorithmVersion,
    cutoff,
    input.commandCenter.systemState,
    input.commandCenter.decision,
    input.commandCenter.execution,
    upstreamReasons,
  ].join('|');
}

/** AL-0 never resolves recipients, channels, payloads, expiry or escalation. */
export function buildAlertSuppressionGate(
  input: AlertGateInput,
  knowledgeCutoff: string,
): AlertSuppressionEnvelope {
  const reasons = new Set<AlertReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.commandCenter.schemaVersion !== COMMAND_CENTER_SCHEMA_VERSION
      || input.commandCenter.algorithmVersion !== COMMAND_CENTER_ALGORITHM_VERSION) {
    reasons.add('COMMAND_CENTER_VERSION_MISMATCH');
  }
  if (input.commandCenter.knowledgeCutoff !== knowledgeCutoff) {
    reasons.add('COMMAND_CENTER_CUTOFF_MISMATCH');
  }
  if (input.commandCenter.systemState !== 'READY'
      || input.commandCenter.decision !== 'ACTIONABLE'
      || input.commandCenter.execution !== 'AUTHORIZED') {
    reasons.add('COMMAND_CENTER_NOT_ACTIONABLE');
  }
  if (input.alertPolicyAuthorization !== 'AUTHORIZED') reasons.add('ALERT_POLICY_NOT_APPROVED');
  if (input.deliveryAuthorization !== 'AUTHORIZED') reasons.add('DELIVERY_NOT_AUTHORIZED');
  if (input.recipientPolicyVersion === null) reasons.add('RECIPIENT_POLICY_UNAVAILABLE');
  reasons.add('ALERT_HORIZON_NOT_APPROVED');
  reasons.add('ALERT_METHOD_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF', 'COMMAND_CENTER_VERSION_MISMATCH',
    'COMMAND_CENTER_CUTOFF_MISMATCH', 'COMMAND_CENTER_NOT_ACTIONABLE',
    'ALERT_POLICY_NOT_APPROVED', 'DELIVERY_NOT_AUTHORIZED',
    'RECIPIENT_POLICY_UNAVAILABLE', 'ALERT_HORIZON_NOT_APPROVED',
    'ALERT_METHOD_NOT_APPROVED',
  ] satisfies readonly AlertReasonCode[];

  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    algorithmVersion: ALERT_ALGORITHM_VERSION,
    state: 'SUPPRESSED',
    delivery: 'FORBIDDEN',
    dedupeKey: buildDedupeKey(input, knowledgeCutoff),
    expiresAt: null,
    acknowledgementState: 'UNAVAILABLE',
    escalation: 'FORBIDDEN',
    recipient: null,
    channel: null,
    payload: null,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
  };
}
