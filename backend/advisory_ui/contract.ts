/**
 * UI-0: pure offline, non-actionable view model for the institutional V2 gate.
 * No DOM, HTTP, clock, DB, broker, alerts, persistence, or production entrypoint.
 * Structural consistency of caller-supplied claims does NOT attest origin.
 */
import {
  COMMAND_CENTER_ALGORITHM_VERSION, COMMAND_CENTER_LINEAGE, COMMAND_CENTER_SCHEMA_VERSION,
} from '../command_center/contract.js';
import { ALERT_ALGORITHM_VERSION, ALERT_SCHEMA_VERSION } from '../alert_engine/contract.js';
import {
  ACCEPTANCE_ALGORITHM_VERSION, ACCEPTANCE_EVIDENCE_KEYS, ACCEPTANCE_SCHEMA_VERSION,
} from '../acceptance_engine/contract.js';
import { HORIZONS } from '../horizon_engine/contract.js';

export const ADVISORY_UI_SCHEMA_VERSION = 'xau.institutional-advisory-ui.v1' as const;
export const ADVISORY_UI_ALGORITHM_VERSION = 'institutional-offline-hold-projection-1.0.0' as const;

export type AdvisoryUiReason =
  | 'INVALID_CLAIMED_CUTOFF'
  | 'INVALID_INPUT_SHAPE'
  | 'COMMAND_CENTER_CLAIM_REJECTED'
  | 'ALERT_CLAIM_REJECTED'
  | 'ACCEPTANCE_CLAIM_REJECTED'
  | 'SOURCE_ATTESTATION_NOT_AVAILABLE'
  | 'UI_RUNTIME_NOT_AUTHORIZED';

export interface AdvisoryUiViewModel {
  readonly schemaVersion: typeof ADVISORY_UI_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ADVISORY_UI_ALGORITHM_VERSION;
  readonly mode: 'OFFLINE_CONTRACT_ONLY';
  readonly provenance: 'UNVERIFIED';
  readonly deployment: 'NOT_CONNECTED';
  readonly systemState: 'HOLD';
  readonly decision: 'ABSTAIN';
  readonly execution: 'FORBIDDEN';
  readonly scenarioTreeStatus: 'UNAVAILABLE';
  readonly recommendation: null;
  readonly tradeTicket: null;
  readonly positionSize: null;
  readonly alertDelivery: 'SUPPRESSED';
  readonly alertPayload: null;
  readonly productionReadiness: 'HOLD';
  /** A caller CLAIM; this does not imply a live or authenticated timestamp. */
  readonly claimedKnowledgeCutoff: string | null;
  readonly horizons: ReadonlyArray<{
    readonly horizon: typeof HORIZONS[number];
    readonly state: 'UNAVAILABLE';
    readonly direction: 'UNAVAILABLE';
    readonly confidence: null;
    readonly target: null;
  }>;
  readonly reasonCodes: readonly AdvisoryUiReason[];
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactFields = (value: JsonObject, fields: readonly string[]): boolean =>
  Object.keys(value).length === fields.length && Object.keys(value).every((field) => fields.includes(field));
const reasons = (value: unknown, mandatory: string): boolean =>
  Array.isArray(value) && value.length <= 64 && value.includes(mandatory)
  && value.every((reason: unknown) => typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(reason))
  && new Set(value).size === value.length;

// Strict offset-aware calendar validation, with no clock or Date parsing.
function validCutoff(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) return false;
  if (match[7] !== 'Z') {
    const tzHour = Number(match[7].slice(1, 3));
    const tzMinute = Number(match[7].slice(4, 6));
    if (tzHour > 14 || tzMinute > 59 || (tzHour === 14 && tzMinute !== 0)) return false;
  }
  return true;
}

const CC_FIELDS = [
  'schemaVersion', 'algorithmVersion', 'mode', 'systemState', 'banner',
  'decision', 'execution', 'scenarioTreeStatus', 'tradeTicket',
  'actionReasonCodes', 'reasonCodes', 'knowledgeCutoff', 'lineage', 'observability',
];
const ALERT_FIELDS = [
  'schemaVersion', 'algorithmVersion', 'state', 'delivery', 'dedupeKey',
  'expiresAt', 'acknowledgementState', 'escalation', 'recipient', 'channel',
  'payload', 'reasonCodes', 'knowledgeCutoff',
];
const ACCEPTANCE_FIELDS = [
  'schemaVersion', 'algorithmVersion', 'acceptanceState', 'productionReadiness',
  'acceptanceRun', 'report', 'evidence', 'missingEvidence', 'reasonCodes', 'knowledgeCutoff',
];

function safeCommandCenter(claim: unknown, cutoff: string): boolean {
  if (!isObject(claim) || !exactFields(claim, CC_FIELDS)) return false;
  if (claim.schemaVersion !== COMMAND_CENTER_SCHEMA_VERSION
    || claim.algorithmVersion !== COMMAND_CENTER_ALGORITHM_VERSION
    || claim.mode !== 'READ_ONLY' || claim.systemState !== 'HOLD'
    || claim.banner !== 'EVIDENCE_INCOMPLETE' || claim.decision !== 'ABSTAIN'
    || claim.execution !== 'FORBIDDEN' || claim.scenarioTreeStatus !== 'UNAVAILABLE'
    || claim.tradeTicket !== null || claim.knowledgeCutoff !== cutoff
    || !reasons(claim.reasonCodes, 'COMMAND_CENTER_RUNTIME_NOT_APPROVED')
    || !Array.isArray(claim.actionReasonCodes)
    || !claim.actionReasonCodes.every((code: unknown) => typeof code === 'string')) return false;
  if (!isObject(claim.observability)
    || !exactFields(claim.observability, ['state', 'correlationId', 'deploymentId'])
    || claim.observability.state !== 'CONTRACT_ONLY'
    || claim.observability.correlationId !== null || claim.observability.deploymentId !== null) return false;
  const lineage = claim.lineage;
  if (!Array.isArray(lineage) || lineage.length !== COMMAND_CENTER_LINEAGE.length) return false;
  return COMMAND_CENTER_LINEAGE.every((expected, i) => {
    const actual: unknown = lineage[i];
    return isObject(actual) && exactFields(actual, ['stage', 'schemaVersion', 'algorithmVersion'])
      && actual.stage === expected.stage && actual.schemaVersion === expected.schemaVersion
      && actual.algorithmVersion === expected.algorithmVersion;
  });
}

function safeAlerts(claim: unknown, cutoff: string): boolean {
  return isObject(claim) && exactFields(claim, ALERT_FIELDS)
    && claim.schemaVersion === ALERT_SCHEMA_VERSION
    && claim.algorithmVersion === ALERT_ALGORITHM_VERSION
    && claim.state === 'SUPPRESSED' && claim.delivery === 'FORBIDDEN'
    && typeof claim.dedupeKey === 'string' && claim.dedupeKey.length > 0
    && claim.expiresAt === null && claim.acknowledgementState === 'UNAVAILABLE'
    && claim.escalation === 'FORBIDDEN' && claim.recipient === null
    && claim.channel === null && claim.payload === null
    && reasons(claim.reasonCodes, 'ALERT_METHOD_NOT_APPROVED')
    && claim.knowledgeCutoff === cutoff;
}

function safeAcceptance(claim: unknown, cutoff: string): boolean {
  if (!isObject(claim) || !exactFields(claim, ACCEPTANCE_FIELDS)
    || claim.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION
    || claim.algorithmVersion !== ACCEPTANCE_ALGORITHM_VERSION
    || claim.acceptanceState !== 'NOT_ACCEPTED' || claim.productionReadiness !== 'HOLD'
    || claim.acceptanceRun !== null || claim.report !== null
    || claim.knowledgeCutoff !== cutoff
    || !reasons(claim.reasonCodes, 'E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED')
    || !isObject(claim.evidence)
    || !exactFields(claim.evidence, ACCEPTANCE_EVIDENCE_KEYS)
    || !ACCEPTANCE_EVIDENCE_KEYS.every((key) => claim.evidence !== null && (claim.evidence as JsonObject)[key] === false)
    || !Array.isArray(claim.missingEvidence)
    || claim.missingEvidence.length !== ACCEPTANCE_EVIDENCE_KEYS.length) return false;
  const missingEvidence = claim.missingEvidence as unknown[];
  return ACCEPTANCE_EVIDENCE_KEYS.every((key, index) => missingEvidence[index] === key);
}

/** Always non-actionable: structurally consistent claims never prove authenticity. */
export function buildInstitutionalAdvisoryUi(
  input: unknown,
  claimedKnowledgeCutoff: unknown,
): AdvisoryUiViewModel {
  const codes: AdvisoryUiReason[] = [];
  const valid = validCutoff(claimedKnowledgeCutoff);
  const cutoff = valid ? claimedKnowledgeCutoff : null;
  if (!valid) codes.push('INVALID_CLAIMED_CUTOFF');
  if (!isObject(input) || !exactFields(input, ['commandCenter', 'alerts', 'acceptance'])) {
    codes.push('INVALID_INPUT_SHAPE');
  }
  const claims = isObject(input) ? input : {};
  if (!valid || !safeCommandCenter(claims.commandCenter, claimedKnowledgeCutoff as string)) {
    codes.push('COMMAND_CENTER_CLAIM_REJECTED');
  }
  if (!valid || !safeAlerts(claims.alerts, claimedKnowledgeCutoff as string)) {
    codes.push('ALERT_CLAIM_REJECTED');
  }
  if (!valid || !safeAcceptance(claims.acceptance, claimedKnowledgeCutoff as string)) {
    codes.push('ACCEPTANCE_CLAIM_REJECTED');
  }
  codes.push('SOURCE_ATTESTATION_NOT_AVAILABLE', 'UI_RUNTIME_NOT_AUTHORIZED');
  return {
    schemaVersion: ADVISORY_UI_SCHEMA_VERSION,
    algorithmVersion: ADVISORY_UI_ALGORITHM_VERSION,
    mode: 'OFFLINE_CONTRACT_ONLY',
    provenance: 'UNVERIFIED', deployment: 'NOT_CONNECTED',
    systemState: 'HOLD', decision: 'ABSTAIN', execution: 'FORBIDDEN',
    scenarioTreeStatus: 'UNAVAILABLE', recommendation: null, tradeTicket: null,
    positionSize: null, alertDelivery: 'SUPPRESSED', alertPayload: null,
    productionReadiness: 'HOLD', claimedKnowledgeCutoff: cutoff,
    horizons: HORIZONS.map((horizon) => ({
      horizon, state: 'UNAVAILABLE', direction: 'UNAVAILABLE', confidence: null, target: null,
    })),
    reasonCodes: codes,
  };
}
