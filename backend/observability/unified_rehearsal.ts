/**
 * Integration-only pure composition. It invokes the existing canonical
 * CHAIN-0 exactly once and projects it through independently reviewed
 * OBS-0, EVIDENCE-0, UI-0, TR-0 and TV-2.
 *
 * This is NOT a second decision engine or a production endpoint.
 * No broker, provider, HTTP, database, wall clock, I/O or execution.
 */
import { evaluateDecisionChain } from '../decision_chain/dry_run.js';
import {
  buildTerminalView, type TerminalDataOrigin,
} from '../decision_chain/terminal_view.js';
import { buildOfflineAuditReceipt, type OfflineAuditReceipt } from '../observability/offline_receipt.js';
import { buildEvidenceEligibilityManifest } from '../observability/evidence_manifest.js';
import { buildInstitutionalAdvisoryUi } from '../advisory_ui/contract.js';
import {
  encodeOfflineAdvisoryPacket, inspectOfflineAdvisoryPacket,
} from '../advisory_ui/transport_contract.js';
import { compareStrictInstants, isStrictTimestamp } from '../shared/temporal_contract.js';

export const UNIFIED_REHEARSAL_SCHEMA_VERSION = 'xau.unified-offline-rehearsal.v2' as const;
export const UNIFIED_REHEARSAL_ALGORITHM_VERSION = 'unified-readonly-cross-contract-1.2.0' as const;

export interface UnifiedOfflineInput {
  readonly chainInput: unknown;
  readonly knowledgeCutoff: unknown;
  /** Unauthenticated, caller-supplied claims, never admitted as trade evidence. */
  readonly evidenceClaims: readonly unknown[];
  readonly origin: { readonly kind: TerminalDataOrigin; readonly label: string };
  /** Explicit local generation claim; no hidden wall-clock reads. */
  readonly generatedAt: string;
}

/**
 * The integration harness is callable from JavaScript, not only checked TS.
 * Treat the complete caller envelope as untrusted JSON-like input. Never
 * allow forged LIVE origins, extra authority keys, getters, malformed dates
 * or reversed generation/cutoff chronology into the terminal projection.
 * On rejection, deliberately pass an invalid CHAIN-0 input; CHAIN-0 owns
 * the resulting REJECTED/HOLD projection and no receipt may be minted.
 */
const ENVELOPE_KEYS = ['chainInput', 'knowledgeCutoff', 'evidenceClaims', 'origin', 'generatedAt'] as const;
const ORIGIN_KEYS = ['kind', 'label'] as const;
const LOCAL_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  'GOLDEN_FIXTURE', 'LOCAL_INPUT_FILE', 'LOCAL_SCENARIO',
]);
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;
const MAX_EVIDENCE_CLAIMS = 512;

function dataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => Object.prototype.hasOwnProperty.call(descriptor, 'value'));
}

function exactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === expected.length && own.every((key) =>
    typeof key === 'string' && expected.includes(key));
}

function rejectedEnvelope(): UnifiedOfflineInput {
  return {
    chainInput: null,
    knowledgeCutoff: '',
    evidenceClaims: [],
    origin: { kind: 'LOCAL_SCENARIO', label: 'unverified-local-input' },
    generatedAt: '',
  };
}

function normalizeEnvelope(raw: unknown): UnifiedOfflineInput {
  try {
    if (!dataRecord(raw) || !exactOwnKeys(raw, ENVELOPE_KEYS)) return rejectedEnvelope();
    const origin = raw.origin;
    if (!dataRecord(origin) || !exactOwnKeys(origin, ORIGIN_KEYS)
        || typeof origin.kind !== 'string' || !LOCAL_ORIGIN_KINDS.has(origin.kind)
        || typeof origin.label !== 'string' || !SAFE_LABEL.test(origin.label)
        || !isStrictTimestamp(raw.knowledgeCutoff)
        || !isStrictTimestamp(raw.generatedAt)
        || compareStrictInstants(raw.generatedAt, raw.knowledgeCutoff) !== 0
          && compareStrictInstants(raw.generatedAt, raw.knowledgeCutoff) !== 1
        || !Array.isArray(raw.evidenceClaims)
        || raw.evidenceClaims.length > MAX_EVIDENCE_CLAIMS) {
      return rejectedEnvelope();
    }
    return {
      chainInput: raw.chainInput,
      knowledgeCutoff: raw.knowledgeCutoff,
      evidenceClaims: raw.evidenceClaims,
      origin: { kind: origin.kind as TerminalDataOrigin, label: origin.label },
      generatedAt: raw.generatedAt,
    };
  } catch {
    // Hostile JS proxies/accessors must not claim a completed offline run.
    return rejectedEnvelope();
  }
}

/**
 * One audit authority within this OFFLINE experiment: the reviewed OBS-0
 * receipt. A rejected, absent or malformed receipt must never be replaced
 * with a fresh digest directly from CHAIN-0. A digest is NOT a signature.
 */
export function fingerprintFromAcceptedReceipt(receipt: OfflineAuditReceipt | null): string | null {
  if (receipt === null
      || receipt.verification !== 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
      || receipt.mode !== 'OFFLINE_ONLY'
      || receipt.authorization !== 'NONE'
      || receipt.provenance !== 'UNVERIFIED'
      || receipt.execution !== 'FORBIDDEN'
      || !Array.isArray(receipt.problems)
      || receipt.problems.length !== 0
      || typeof receipt.fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(receipt.fingerprint)) {
    return null;
  }
  return receipt.fingerprint;
}

/** Returns only an advisory, structurally unverified HOLD evaluation. */
export async function runUnifiedOfflineRehearsal(raw: unknown) {
  const input = normalizeEnvelope(raw);
  const knowledgeCutoff = input.knowledgeCutoff;
  const cutoff = isStrictTimestamp(knowledgeCutoff) ? knowledgeCutoff : '';
  // The chain owns all twelve stages. No reenactment of the older ten-stage
  // orchestrator; no implicit promotion of evidence or authorizations.
  const outcome = evaluateDecisionChain(input.chainInput, cutoff);
  const receipt = outcome.kind === 'COMPLETED'
    ? await buildOfflineAuditReceipt(outcome.result)
    : null;
  const digest = fingerprintFromAcceptedReceipt(receipt);
  const terminal = buildTerminalView(outcome, digest, input.origin, input.generatedAt);
  const evidence = buildEvidenceEligibilityManifest(input.evidenceClaims, cutoff);

  // On ANY rejection or failed receipt, no upstream claim is promoted to UI.
  const claims = outcome.kind === 'COMPLETED'
    && digest !== null
    ? {
        commandCenter: outcome.result.stages.commandCenter,
        alerts: outcome.result.stages.alert,
        acceptance: outcome.result.stages.acceptance,
      }
    : null;
  const advisory = buildInstitutionalAdvisoryUi(claims, cutoff);
  const transport = inspectOfflineAdvisoryPacket(
    encodeOfflineAdvisoryPacket(claims, cutoff),
  );
  return {
    schemaVersion: UNIFIED_REHEARSAL_SCHEMA_VERSION,
    algorithmVersion: UNIFIED_REHEARSAL_ALGORITHM_VERSION,
    mode: 'OFFLINE_ONLY' as const,
    decision: 'HOLD' as const,
    execution: 'FORBIDDEN' as const,
    authorization: 'NONE' as const,
    provenance: 'UNVERIFIED' as const,
    outcome: outcome.kind,
    terminal,
    receipt,
    evidence,
    advisory,
    transport,
  };
}
