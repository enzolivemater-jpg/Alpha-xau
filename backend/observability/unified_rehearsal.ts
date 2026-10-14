/**
 * Integration-only pure composition. It invokes the existing canonical
 * CHAIN-0 exactly once and projects it through independently reviewed
 * OBS-0, EVIDENCE-0, UI-0, TR-0 and TV-2.
 *
 * This is NOT a second decision engine or a production endpoint.
 * No broker, provider, HTTP, database, wall clock, I/O or execution.
 */
import {
  evaluateDecisionChain, DECISION_CHAIN_SCHEMA_VERSION,
  DECISION_CHAIN_ALGORITHM_VERSION, type DecisionChainOutcome,
} from '../decision_chain/dry_run.js';
import {
  buildTerminalView, type TerminalDataOrigin,
} from '../decision_chain/terminal_view.js';
import { buildOfflineAuditReceipt } from '../observability/offline_receipt.js';
import { buildEvidenceEligibilityManifest } from '../observability/evidence_manifest.js';
import { buildInstitutionalAdvisoryUi } from '../advisory_ui/contract.js';
import {
  encodeOfflineAdvisoryPacket, inspectOfflineAdvisoryPacket,
} from '../advisory_ui/transport_contract.js';
import { isStrictTimestamp } from '../shared/temporal_contract.js';

/**
 * JSON/JS callers are not trusted merely because they satisfy a TS interface.
 * Read own data descriptors without running accessors; never allow a caller to
 * label a fixture as a live feed or inject unbounded display metadata.
 * This label is an unverified local claim, not evidence provenance.
 */
function safeLocalOrigin(raw: unknown): {
  readonly kind: TerminalDataOrigin;
  readonly label: string;
} {
  const fallback = { kind: 'LOCAL_SCENARIO', label: 'SIMULATED:unverified-local-origin' } as const;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  let fields: PropertyDescriptorMap;
  try {
    fields = Object.getOwnPropertyDescriptors(raw);
  } catch {
    return fallback;
  }
  if (Reflect.ownKeys(fields).length !== 2 || !fields.kind || !fields.label
      || !Object.hasOwn(fields.kind, 'value') || !Object.hasOwn(fields.label, 'value')) {
    return fallback;
  }
  const kind: unknown = fields.kind.value;
  const label: unknown = fields.label.value;
  if ((kind !== 'GOLDEN_FIXTURE' && kind !== 'LOCAL_INPUT_FILE' && kind !== 'LOCAL_SCENARIO')
      || typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
    return fallback;
  }
  return { kind, label: `SIMULATED:${label}` };
}

export const UNIFIED_REHEARSAL_SCHEMA_VERSION = 'xau.unified-offline-rehearsal.v1' as const;
export const UNIFIED_REHEARSAL_ALGORITHM_VERSION = 'unified-readonly-cross-contract-1.0.1' as const;

export interface UnifiedOfflineInput {
  readonly chainInput: unknown;
  readonly knowledgeCutoff: unknown;
  /** Unauthenticated, caller-supplied claims, never admitted as trade evidence. */
  readonly evidenceClaims: readonly unknown[];
  readonly origin: { readonly kind: TerminalDataOrigin; readonly label: string };
  /** Explicit local generation claim; no hidden wall-clock reads. */
  readonly generatedAt: string;
}

/** Returns only an advisory, structurally unverified HOLD evaluation. */
export async function runUnifiedOfflineRehearsal(raw: UnifiedOfflineInput) {
  const knowledgeCutoff = raw.knowledgeCutoff;
  const cutoff = isStrictTimestamp(knowledgeCutoff) ? knowledgeCutoff : '';
  // Strict TIME-0 validation is a preflight, not a notice after twelve stages.
  // The legacy CHAIN-0 parser intentionally accepts a broader timestamp syntax.
  // On malformed cutoffs we reject *before* invoking that canonical chain.
  const outcome: DecisionChainOutcome = cutoff !== ''
    ? evaluateDecisionChain(raw.chainInput, cutoff)
    : {
        kind: 'REJECTED', schemaVersion: DECISION_CHAIN_SCHEMA_VERSION,
        algorithmVersion: DECISION_CHAIN_ALGORITHM_VERSION,
        mode: 'DRY_RUN', chainState: 'HOLD', execution: 'FORBIDDEN',
        failedAt: 'INPUT',
        inputErrors: [{ path: '<knowledgeCutoff>', code: 'INVALID_VALUE' }],
        stageError: null,
      };
  const receipt = outcome.kind === 'COMPLETED'
    ? await buildOfflineAuditReceipt(outcome.result)
    : null;
  // A rejected receipt never mints or retains a digest, even if CHAIN-0
  // produced an object. It also cannot reach the terminal as a completed run.
  const audited = outcome.kind === 'COMPLETED'
    && receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
    && receipt.fingerprint !== null;
  const digest = audited ? receipt.fingerprint : null;
  const visibleOutcome: DecisionChainOutcome = outcome.kind === 'COMPLETED' && !audited
    ? {
        kind: 'REJECTED', schemaVersion: DECISION_CHAIN_SCHEMA_VERSION,
        algorithmVersion: DECISION_CHAIN_ALGORITHM_VERSION,
        mode: 'DRY_RUN', chainState: 'HOLD', execution: 'FORBIDDEN',
        failedAt: 'INPUT', inputErrors: [],
        stageError: 'AUDIT_RECEIPT_REJECTED',
      }
    : outcome;
  const terminal = buildTerminalView(
    visibleOutcome, digest, safeLocalOrigin(raw.origin),
    isStrictTimestamp(raw.generatedAt) ? raw.generatedAt : 'INVALID_LOCAL_TIMESTAMP',
  );
  const evidence = buildEvidenceEligibilityManifest(raw.evidenceClaims, cutoff);

  // On ANY rejection or failed receipt, no upstream claim is promoted to UI.
  const claims = outcome.kind === 'COMPLETED'
    && receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
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
    mode: 'OFFLINE_ONLY' as const,
    decision: 'HOLD' as const,
    execution: 'FORBIDDEN' as const,
    authorization: 'NONE' as const,
    provenance: 'UNVERIFIED' as const,
    outcome: visibleOutcome.kind,
    terminal,
    receipt,
    evidence,
    advisory,
    transport,
  };
}
