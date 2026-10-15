/**
 * DATA-4G: OFFLINE review of collection prerequisites, never an authorization.
 * All evidence is metadata/reference only; credentials and supplier bodies
 * must never be supplied. Even READY_FOR_HUMAN_REVIEW is not executable.
 */
import { parseStrictTimestampNanos } from '../shared/strict_timestamp.js';

export const COLLECTOR_READINESS_SCHEMA_VERSION = 'xau.collector-readiness.v1' as const;
export const COLLECTOR_READINESS_ALGORITHM_VERSION = 'collector-readiness-metadata-1.0.0' as const;

export const REQUIRED_COLLECTOR_GATES = [
  'SUPPLIER_RIGHTS', 'SOURCE_CALENDAR', 'RATE_COST', 'SECRETS_NETWORK',
  'SOURCE_PROVENANCE', 'DURABLE_STORAGE', 'RECOVERY', 'MARKET_COMPLETENESS',
  'SECURITY_OPERATIONS', 'PRODUCTION_AUTHORIZATION', 'TRADING_AUTHORIZATION',
] as const;
type GateId = (typeof REQUIRED_COLLECTOR_GATES)[number];
type GateStatus = 'PENDING' | 'REJECTED' | 'APPROVED';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const gateSet: ReadonlySet<string> = new Set(REQUIRED_COLLECTOR_GATES);
const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const instant = (x: unknown): bigint | null =>
  typeof x === 'string' && UTC.test(x) ? parseStrictTimestampNanos(x) : null;
const identifier = (x: unknown) => typeof x === 'string' && ID.test(x);
const nonempty = (x: unknown) => typeof x === 'string'
  && x.trim().length > 0 && x.length <= 512 && !/[\r\n]/.test(x);

const GATE_KEYS = [
  'gate_id', 'status', 'evidence_reference', 'evidence_digest', 'reviewer',
  'reviewed_at_utc', 'expiry_or_review_due', 'scope', 'version', 'rejection_reasons',
] as const;

export interface CollectorGateReview {
  gate_id: GateId;
  status: GateStatus;
  evidence_reference: string | null;
  evidence_digest: string | null;
  reviewer: string | null;
  reviewed_at_utc: string | null;
  expiry_or_review_due: string | null;
  scope: string | null;
  version: string | null;
  rejection_reasons: string[];
}

export interface CollectorReadinessResult {
  readonly schemaVersion: typeof COLLECTOR_READINESS_SCHEMA_VERSION;
  readonly algorithmVersion: typeof COLLECTOR_READINESS_ALGORITHM_VERSION;
  readonly status: 'INCOMPLETE' | 'READY_FOR_HUMAN_REVIEW';
  readonly missingGates: readonly GateId[];
  readonly unapprovedGates: readonly GateId[];
  readonly authorization: 'OFFLINE_ONLY';
  readonly decision: 'HOLD';
  readonly execution: 'FORBIDDEN';
  readonly providerAuthenticity: 'NOT_PROVEN';
  readonly calendarCompleteness: 'NOT_PROVEN';
}

export function evaluateCollectorReadiness(packet: unknown, cutoffInput: unknown): CollectorReadinessResult {
  const cutoff = instant(cutoffInput);
  if (cutoff === null) throw new Error('COLLECTOR_READINESS_INVALID_CUTOFF');
  if (!isRecord(packet) || !exact(packet, ['schemaVersion', 'planId', 'gates'])
    || packet.schemaVersion !== COLLECTOR_READINESS_SCHEMA_VERSION
    || !identifier(packet.planId) || !Array.isArray(packet.gates)
    || packet.gates.length > REQUIRED_COLLECTOR_GATES.length) {
    throw new Error('COLLECTOR_READINESS_INVALID_PACKET');
  }
  const gates = new Map<string, CollectorGateReview>();
  for (const raw of packet.gates) {
    if (!isRecord(raw) || !exact(raw, GATE_KEYS) || !gateSet.has(String(raw.gate_id))
      || gates.has(String(raw.gate_id))
      || !['PENDING', 'REJECTED', 'APPROVED'].includes(String(raw.status))
      || !Array.isArray(raw.rejection_reasons) || raw.rejection_reasons.length > 20
      || !raw.rejection_reasons.every(x => nonempty(x) && ID.test(x))
      || raw.evidence_reference !== null && !nonempty(raw.evidence_reference)
      || raw.evidence_digest !== null && !(typeof raw.evidence_digest === 'string' && SHA.test(raw.evidence_digest))
      || raw.reviewer !== null && !identifier(raw.reviewer)
      || raw.scope !== null && !identifier(raw.scope)
      || raw.version !== null && !identifier(raw.version)
      || raw.reviewed_at_utc !== null && instant(raw.reviewed_at_utc) === null
      || raw.expiry_or_review_due !== null && instant(raw.expiry_or_review_due) === null) {
      throw new Error('COLLECTOR_READINESS_INVALID_GATE');
    }
    const gate = raw as unknown as CollectorGateReview;
    if (gate.status === 'APPROVED' && (
      !gate.evidence_reference || !gate.evidence_digest || !gate.reviewer
      || !gate.reviewed_at_utc || !gate.expiry_or_review_due || !gate.scope
      || !gate.version || gate.scope !== packet.planId || gate.rejection_reasons.length !== 0
      || instant(gate.reviewed_at_utc)! > cutoff
      || instant(gate.expiry_or_review_due)! <= cutoff
      || instant(gate.expiry_or_review_due)! <= instant(gate.reviewed_at_utc)!
    )) throw new Error('COLLECTOR_READINESS_INVALID_APPROVAL');
    if (gate.status === 'REJECTED' && gate.rejection_reasons.length === 0)
      throw new Error('COLLECTOR_READINESS_MISSING_REJECTION_REASON');
    if (gate.status === 'PENDING' && gate.rejection_reasons.length !== 0)
      throw new Error('COLLECTOR_READINESS_INVALID_PENDING');
    gates.set(gate.gate_id, gate);
  }
  const missingGates = REQUIRED_COLLECTOR_GATES.filter(g => !gates.has(g));
  const unapprovedGates = REQUIRED_COLLECTOR_GATES.filter(g => gates.has(g)
    && gates.get(g)!.status !== 'APPROVED');
  return {
    schemaVersion: COLLECTOR_READINESS_SCHEMA_VERSION,
    algorithmVersion: COLLECTOR_READINESS_ALGORITHM_VERSION,
    status: missingGates.length === 0 && unapprovedGates.length === 0
      ? 'READY_FOR_HUMAN_REVIEW' : 'INCOMPLETE',
    missingGates, unapprovedGates,
    authorization: 'OFFLINE_ONLY', decision: 'HOLD', execution: 'FORBIDDEN',
    providerAuthenticity: 'NOT_PROVEN', calendarCompleteness: 'NOT_PROVEN',
  };
}
