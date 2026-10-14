/**
 * TR-0 — offline advisory-only canonical JSON transport contract.
 *
 * NOT an HTTP handler, browser endpoint, live source, authentication, signature,
 * execution interface, or runtime integration. Deliberately downstream of UI-0.
 * A structurally valid packet still has zero authority and unverified provenance.
 */
import {
  ADVISORY_UI_SCHEMA_VERSION, ADVISORY_UI_ALGORITHM_VERSION,
  buildInstitutionalAdvisoryUi, type AdvisoryUiViewModel,
} from './contract.js';
import { HORIZONS } from '../horizon_engine/contract.js';

export const ADVISORY_TRANSPORT_SCHEMA_VERSION = 'xau.offline-advisory-transport.v1' as const;
export const ADVISORY_TRANSPORT_ALGORITHM_VERSION = 'offline-canonical-readonly-transport-1.0.0' as const;
export const ADVISORY_TRANSPORT_MAX_BYTES = 16384 as const;

const REASONS = [
  'INVALID_CLAIMED_CUTOFF',
  'INVALID_INPUT_SHAPE',
  'COMMAND_CENTER_CLAIM_REJECTED',
  'ALERT_CLAIM_REJECTED',
  'ACCEPTANCE_CLAIM_REJECTED',
  'SOURCE_ATTESTATION_NOT_AVAILABLE',
  'UI_RUNTIME_NOT_AUTHORIZED',
] as const;

export interface OfflineAdvisoryTransportPacket {
  readonly schemaVersion: typeof ADVISORY_TRANSPORT_SCHEMA_VERSION;
  readonly algorithmVersion: typeof ADVISORY_TRANSPORT_ALGORITHM_VERSION;
  readonly mediaType: 'application/json';
  readonly mode: 'OFFLINE_CONTRACT_ONLY';
  readonly origin: 'UNVERIFIED';
  readonly transport: 'NOT_CONNECTED';
  readonly actionability: 'NONE';
  readonly advisory: AdvisoryUiViewModel;
}

export type TransportRejectReason =
  | 'NOT_A_STRING' | 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON'
  | 'NON_CANONICAL_JSON' | 'UNSUPPORTED_PACKET' | 'UNSAFE_ADVISORY';

export type OfflineAdvisoryInspection =
  | {
      readonly status: 'REJECTED';
      readonly reason: TransportRejectReason;
      readonly packet: null;
    }
  | {
      /** Structural validity only; never a source, broker or approval proof. */
      readonly status: 'STRUCTURALLY_VALID_UNVERIFIED';
      readonly reason: null;
      readonly packet: OfflineAdvisoryTransportPacket;
    };

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keysExactly = (value: ObjectValue, keys: readonly string[]) =>
  Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));

function safeReasons(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2 || value.length > REASONS.length) return false;
  if (!value.every((code: unknown) => typeof code === 'string' && REASONS.includes(code as typeof REASONS[number]))) {
    return false;
  }
  if (!value.includes('SOURCE_ATTESTATION_NOT_AVAILABLE')
      || !value.includes('UI_RUNTIME_NOT_AUTHORIZED')) return false;
  const indices = value.map((code: typeof REASONS[number]) => REASONS.indexOf(code));
  return indices.every((index: number, pos: number) => pos === 0 || index > indices[pos - 1]);
}

function safeAdvisory(value: unknown): value is AdvisoryUiViewModel {
  if (!object(value) || !keysExactly(value, [
    'schemaVersion', 'algorithmVersion', 'mode', 'provenance', 'deployment',
    'systemState', 'decision', 'execution', 'scenarioTreeStatus',
    'recommendation', 'tradeTicket', 'positionSize', 'alertDelivery',
    'alertPayload', 'productionReadiness', 'claimedKnowledgeCutoff',
    'horizons', 'reasonCodes',
  ])) return false;
  if (value.schemaVersion !== ADVISORY_UI_SCHEMA_VERSION
    || value.algorithmVersion !== ADVISORY_UI_ALGORITHM_VERSION
    || value.mode !== 'OFFLINE_CONTRACT_ONLY'
    || value.provenance !== 'UNVERIFIED'
    || value.deployment !== 'NOT_CONNECTED'
    || value.systemState !== 'HOLD'
    || value.decision !== 'ABSTAIN'
    || value.execution !== 'FORBIDDEN'
    || value.scenarioTreeStatus !== 'UNAVAILABLE'
    || value.recommendation !== null || value.tradeTicket !== null
    || value.positionSize !== null || value.alertDelivery !== 'SUPPRESSED'
    || value.alertPayload !== null || value.productionReadiness !== 'HOLD'
    || !safeReasons(value.reasonCodes)) return false;

  // This check validates *calendar format*, not provenance or a real release.
  const cutoff = value.claimedKnowledgeCutoff;
  if (cutoff !== null && typeof cutoff !== 'string') return false;
  if (buildInstitutionalAdvisoryUi(null, cutoff).claimedKnowledgeCutoff !== cutoff) return false;
  if (cutoff === null && !(value.reasonCodes as string[]).includes('INVALID_CLAIMED_CUTOFF')) return false;
  if (cutoff !== null && (value.reasonCodes as string[]).includes('INVALID_CLAIMED_CUTOFF')) return false;

  if (!Array.isArray(value.horizons) || value.horizons.length !== HORIZONS.length) return false;
  return HORIZONS.every((expected, index) => {
    const horizon: unknown = (value.horizons as unknown[])[index];
    return object(horizon)
      && keysExactly(horizon, ['horizon', 'state', 'direction', 'confidence', 'target'])
      && horizon.horizon === expected && horizon.state === 'UNAVAILABLE'
      && horizon.direction === 'UNAVAILABLE'
      && horizon.confidence === null && horizon.target === null;
  });
}

/** The only available writer builds a safe view from untrusted upstream claims.
 * Deliberately no send(), fetch(), publish(), runtime version or destination.
 */
export function encodeOfflineAdvisoryPacket(claims: unknown, cutoff: unknown): string {
  const advisory = buildInstitutionalAdvisoryUi(claims, cutoff);
  const packet: OfflineAdvisoryTransportPacket = {
    schemaVersion: ADVISORY_TRANSPORT_SCHEMA_VERSION,
    algorithmVersion: ADVISORY_TRANSPORT_ALGORITHM_VERSION,
    mediaType: 'application/json', mode: 'OFFLINE_CONTRACT_ONLY',
    origin: 'UNVERIFIED', transport: 'NOT_CONNECTED', actionability: 'NONE',
    advisory,
  };
  return JSON.stringify(packet);
}

function rejected(reason: TransportRejectReason): OfflineAdvisoryInspection {
  return { status: 'REJECTED', reason, packet: null };
}

/** Parses exactly the canonical offline protocol. Accepting only certifies
 * safe SHAPE; coherent forged JSON is still untrusted, non-live and non-actionable.
 * No dates, IDs, source claims or other fields are promoted to authority.
 */
export function inspectOfflineAdvisoryPacket(raw: unknown): OfflineAdvisoryInspection {
  if (typeof raw !== 'string') return rejected('NOT_A_STRING');
  // The UTF-16 bound is a safe early rejection: UTF-8 bytes >= code units.
  if (raw.length > ADVISORY_TRANSPORT_MAX_BYTES) return rejected('PAYLOAD_TOO_LARGE');
  if (new TextEncoder().encode(raw).byteLength > ADVISORY_TRANSPORT_MAX_BYTES) {
    return rejected('PAYLOAD_TOO_LARGE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rejected('INVALID_JSON');
  }
  // Exact byte representation rejects duplicate keys, whitespace, reorderings,
  // noncanonical numeric forms and JSON parser normalization ambiguity.
  if (JSON.stringify(parsed) !== raw) return rejected('NON_CANONICAL_JSON');
  if (!object(parsed) || !keysExactly(parsed, [
    'schemaVersion', 'algorithmVersion', 'mediaType', 'mode',
    'origin', 'transport', 'actionability', 'advisory',
  ])) return rejected('UNSUPPORTED_PACKET');
  if (parsed.schemaVersion !== ADVISORY_TRANSPORT_SCHEMA_VERSION
    || parsed.algorithmVersion !== ADVISORY_TRANSPORT_ALGORITHM_VERSION
    || parsed.mediaType !== 'application/json'
    || parsed.mode !== 'OFFLINE_CONTRACT_ONLY'
    || parsed.origin !== 'UNVERIFIED'
    || parsed.transport !== 'NOT_CONNECTED'
    || parsed.actionability !== 'NONE') return rejected('UNSUPPORTED_PACKET');
  if (!safeAdvisory(parsed.advisory)) return rejected('UNSAFE_ADVISORY');
  return {
    status: 'STRUCTURALLY_VALID_UNVERIFIED',
    reason: null,
    packet: parsed as unknown as OfflineAdvisoryTransportPacket,
  };
}
