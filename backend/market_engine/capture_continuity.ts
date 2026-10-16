/**
 * DATA-4 — pure, fail-closed accounting of explicitly scheduled market captures.
 *
 * OFFLINE planning/receipt audit, not a collector, clock, scheduler or a source
 * of truth for market coverage. The caller supplies all slots and receipts.
 * Complete accounting does not prove schedule exhaustiveness or authenticity.
 * Neither DATA-1 coverage nor MP-0 trust can be upgraded by this module.
 */
import { CAPTURE_SERIES } from './evidence_capture.js';
import type { MarketSymbol } from './types.js';
import { parseStrictTimestampNanos } from '../shared/strict_timestamp.js';

export const CAPTURE_CONTINUITY_SCHEMA_VERSION = 'xau.capture-continuity.v1' as const;
export const CAPTURE_CONTINUITY_ALGORITHM_VERSION = 'capture-continuity-receipt-audit-1.0.0' as const;

export interface PlannedCaptureSlot {
  readonly slotId: string;
  readonly provider: 'fred' | 'twelve_data';
  readonly symbol: MarketSymbol;
  readonly sourceRecordId: string;
  readonly earliestAt: string;
  readonly deadlineAt: string;
}

export interface CaptureContinuityPlan {
  readonly planId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Explicit slots provided by an independently governed scheduler. */
  readonly slots: readonly PlannedCaptureSlot[];
}

export interface CaptureAttemptReceipt {
  readonly slotId: string;
  /** When the outcome first became known; not provider observation time. */
  readonly receivedAt: string;
  readonly outcome: 'CAPTURED' | 'FAILED';
  /** Digest of exact bytes; a hash alone never authenticates the provider. */
  readonly rawPayloadDigest: string | null;
}

export type ContinuityAuditReason =
  | 'INVALID_CUTOFF'
  | 'INVALID_PLAN'
  | 'INVALID_SLOT'
  | 'DUPLICATE_SLOT'
  | 'INVALID_RECEIPT'
  | 'UNKNOWN_SLOT'
  | 'DUPLICATE_RECEIPT'
  | 'WINDOW_STILL_OPEN'
  | 'RECEIPT_MISSING'
  | 'CAPTURE_LATE'
  | 'PROVIDER_FAILED';

export interface CaptureContinuityAudit {
  readonly schemaVersion: typeof CAPTURE_CONTINUITY_SCHEMA_VERSION;
  readonly planId: string | null;
  readonly knowledgeCutoff: string;
  /** ATTEMPTS_RECORDED says only that every declared slot was accounted for. */
  readonly status: 'INVALID' | 'INCOMPLETE' | 'ATTEMPTS_RECORDED';
  readonly reasons: readonly ContinuityAuditReason[];
  readonly plannedSlots: number;
  readonly dueSlots: number;
  readonly capturedSlots: number;
  readonly failedSlots: number;
  readonly missingSlots: number;
  readonly lateSlots: number;
  readonly providerAuthenticity: 'NOT_PROVEN';
  readonly archiveCoverage: 'NOT_ESTABLISHED';
  readonly decision: 'HOLD';
  readonly execution: 'FORBIDDEN';
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REASON_ORDER: readonly ContinuityAuditReason[] = [
  'INVALID_CUTOFF', 'INVALID_PLAN', 'INVALID_SLOT', 'DUPLICATE_SLOT',
  'INVALID_RECEIPT', 'UNKNOWN_SLOT', 'DUPLICATE_RECEIPT',
  'WINDOW_STILL_OPEN', 'RECEIPT_MISSING', 'CAPTURE_LATE', 'PROVIDER_FAILED',
];
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).sort().join('|') === [...keys].sort().join('|');
const parseTime = (v: unknown) => parseStrictTimestampNanos(v);

/** Deterministic and as-of: receipts learned after cutoff are not used. */
export function auditCaptureContinuity(
  planInput: unknown, receiptsInput: unknown, requestedCutoff: string,
): CaptureContinuityAudit {
  const reasons = new Set<ContinuityAuditReason>();
  // The cutoff is echoed into the audit. JavaScript callers can pass a
  // non-string (NaN, undefined...) that no canonical hash accepts: it is an
  // invalid cutoff, reported as such with an empty echo.
  const knowledgeCutoff: string = typeof requestedCutoff === 'string' ? requestedCutoff : '';
  const cutoff = parseTime(knowledgeCutoff);
  if (cutoff === null) reasons.add('INVALID_CUTOFF');
  const result = (counts: {
    planned?: number; due?: number; captured?: number; failed?: number; missing?: number; late?: number;
  } = {}): CaptureContinuityAudit => {
    const sorted = [...reasons].sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
    const invalid = sorted.some((r) => REASON_ORDER.indexOf(r) <= REASON_ORDER.indexOf('DUPLICATE_RECEIPT'));
    return {
      schemaVersion: CAPTURE_CONTINUITY_SCHEMA_VERSION,
      planId: isObject(planInput) && typeof planInput.planId === 'string' ? planInput.planId : null,
      knowledgeCutoff,
      status: invalid ? 'INVALID' : sorted.length ? 'INCOMPLETE' : 'ATTEMPTS_RECORDED',
      reasons: sorted,
      plannedSlots: counts.planned ?? 0,
      dueSlots: counts.due ?? 0,
      capturedSlots: counts.captured ?? 0,
      failedSlots: counts.failed ?? 0,
      missingSlots: counts.missing ?? 0,
      lateSlots: counts.late ?? 0,
      providerAuthenticity: 'NOT_PROVEN',
      archiveCoverage: 'NOT_ESTABLISHED',
      decision: 'HOLD',
      execution: 'FORBIDDEN',
    };
  };
  if (cutoff === null) return result();
  if (!isObject(planInput) || !hasKeys(planInput, ['planId', 'windowStart', 'windowEnd', 'slots'])
      || typeof planInput.planId !== 'string' || !IDENTIFIER.test(planInput.planId)
      || !Array.isArray(planInput.slots) || planInput.slots.length === 0
      || !Array.isArray(receiptsInput)) {
    reasons.add('INVALID_PLAN');
    return result();
  }
  const from = parseTime(planInput.windowStart);
  const to = parseTime(planInput.windowEnd);
  if (from === null || to === null || from >= to) {
    reasons.add('INVALID_PLAN');
    return result();
  }

  const slots = new Map<string, { earliest: bigint; deadline: bigint }>();
  for (const raw of planInput.slots) {
    if (!isObject(raw) || !hasKeys(raw, ['slotId', 'provider', 'symbol', 'sourceRecordId', 'earliestAt', 'deadlineAt'])
        || typeof raw.slotId !== 'string' || !IDENTIFIER.test(raw.slotId)
        || typeof raw.sourceRecordId !== 'string'
        || !CAPTURE_SERIES.some((s) => s.provider === raw.provider && s.symbol === raw.symbol
          && s.sourceRecordId === raw.sourceRecordId)) {
      reasons.add('INVALID_SLOT');
      continue;
    }
    const earliest = parseTime(raw.earliestAt);
    const deadline = parseTime(raw.deadlineAt);
    if (earliest === null || deadline === null || earliest > deadline || earliest < from || deadline > to) {
      reasons.add('INVALID_SLOT');
      continue;
    }
    if (slots.has(raw.slotId)) {
      reasons.add('DUPLICATE_SLOT');
      continue;
    }
    slots.set(raw.slotId, { earliest, deadline });
  }
  if (reasons.size) return result({ planned: planInput.slots.length });

  const known = new Map<string, { received: bigint; receipt: CaptureAttemptReceipt }>();
  for (const raw of receiptsInput) {
    if (!isObject(raw) || typeof raw.receivedAt !== 'string' || parseTime(raw.receivedAt) === null) {
      reasons.add('INVALID_RECEIPT');
      continue;
    }
    const received = parseTime(raw.receivedAt)!;
    if (received > cutoff) continue; // Never consult a future result during historical audit.
    if (!hasKeys(raw, ['slotId', 'receivedAt', 'outcome', 'rawPayloadDigest'])
        || typeof raw.slotId !== 'string'
        || (raw.outcome !== 'CAPTURED' && raw.outcome !== 'FAILED')
        || (raw.outcome === 'CAPTURED' && (typeof raw.rawPayloadDigest !== 'string'
          || !DIGEST.test(raw.rawPayloadDigest)))
        || (raw.outcome === 'FAILED' && raw.rawPayloadDigest !== null)) {
      reasons.add('INVALID_RECEIPT');
      continue;
    }
    if (!slots.has(raw.slotId)) {
      reasons.add('UNKNOWN_SLOT');
      continue;
    }
    if (known.has(raw.slotId)) {
      reasons.add('DUPLICATE_RECEIPT');
      continue;
    }
    known.set(raw.slotId, { received, receipt: raw as unknown as CaptureAttemptReceipt });
  }
  if (reasons.size) return result({ planned: slots.size });

  if (cutoff < to) reasons.add('WINDOW_STILL_OPEN');
  let due = 0, captured = 0, failed = 0, missing = 0, late = 0;
  for (const [slotId, { earliest, deadline }] of slots) {
    if (deadline > cutoff) continue;
    due++;
    const rec = known.get(slotId);
    if (!rec) { missing++; reasons.add('RECEIPT_MISSING'); continue; }
    if (rec.received < earliest || rec.received > deadline) {
      late++; reasons.add('CAPTURE_LATE');
    }
    if (rec.receipt.outcome === 'FAILED') { failed++; reasons.add('PROVIDER_FAILED'); }
    else captured++;
  }
  return result({ planned: slots.size, due, captured, failed, missing, late });
}
