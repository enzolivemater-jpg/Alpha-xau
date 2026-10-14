/**
 * Integration-only pure composition. It invokes the existing canonical
 * CHAIN-0 exactly once and projects it through independently reviewed
 * OBS-0, EVIDENCE-0, UI-0, TR-0 and TV-2.
 *
 * This is NOT a second decision engine or a production endpoint.
 * No broker, provider, HTTP, database, wall clock, I/O or execution.
 */
import {
  evaluateDecisionChain, computeDecisionChainDigest,
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

export const UNIFIED_REHEARSAL_SCHEMA_VERSION = 'xau.unified-offline-rehearsal.v1' as const;
export const UNIFIED_REHEARSAL_ALGORITHM_VERSION = 'unified-readonly-cross-contract-1.0.0' as const;

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
  // The chain owns all twelve stages. No reenactment of the older ten-stage
  // orchestrator; no implicit promotion of evidence or authorizations.
  const outcome = evaluateDecisionChain(raw.chainInput, cutoff);
  const receipt = outcome.kind === 'COMPLETED'
    ? await buildOfflineAuditReceipt(outcome.result)
    : null;
  const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
    ? receipt.fingerprint
    : outcome.kind === 'COMPLETED'
      ? await computeDecisionChainDigest(outcome.result)
      : null;
  const terminal = buildTerminalView(outcome, digest, raw.origin, raw.generatedAt);
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
    outcome: outcome.kind,
    terminal,
    receipt,
    evidence,
    advisory,
    transport,
  };
}
