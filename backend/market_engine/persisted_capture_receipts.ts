/**
 * DATA-4C — PURE adapter for bounded PostgreSQL DATA-4B receipt RPC rows.
 *
 * Does not call PostgreSQL or a provider. The RPC caller must supply a
 * complete-or-error result for the requested cutoff. Never use collector-
 * claimed source_received_at as first-knowledge: recorded_at is DB-owned.
 * No raw bodies or secrets enter this adapter; it grants no source trust.
 */
import {
  auditCaptureContinuity,
  type CaptureAttemptReceipt,
  type CaptureContinuityAudit,
} from './capture_continuity.js';
import { CAPTURE_SERIES } from './evidence_capture.js';
import { parseStrictTimestampNanos } from '../shared/strict_timestamp.js';

export const PERSISTED_CAPTURE_RECEIPTS_SCHEMA_VERSION = 'xau.persisted-capture-receipts.v1' as const;
export const PERSISTED_CAPTURE_RECEIPTS_ALGORITHM_VERSION = 'persisted-capture-receipts-audit-adapter-1.1.0' as const;

export interface PersistedCaptureReceiptRow {
  readonly plan_id: string;
  readonly slot_id: string;
  readonly provider: string;
  readonly source_record_id: string;
  readonly symbol: string;
  readonly outcome: string;
  readonly source_received_at: string;
  readonly recorded_at: string;
  readonly failure_code: string | null;
  readonly content_sha256: string | null;
}

const KEYS = [
  'plan_id', 'slot_id', 'provider', 'source_record_id', 'symbol', 'outcome',
  'source_received_at', 'recorded_at', 'failure_code', 'content_sha256',
].sort();
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HEX = /^[0-9a-f]{64}$/;
const FAIL_CODES = new Set([
  'HTTP_ERROR', 'TIMEOUT', 'QUOTA', 'TRANSPORT_ERROR', 'PARSE_REJECTED', 'OTHER',
]);
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>) => {
  const names = Object.keys(v).sort();
  return names.length === KEYS.length && names.every((k, i) => k === KEYS[i]);
};
const die = (index: number): never => { throw new Error('CAPTURE_RPC_ROW_INVALID_' + index); };

/**
 * Fail-closed normalization of *all* bounded RPC rows, with DB recorded_at
 * used for as-of and deadline checks. No data is dropped or truncated.
 */
export function normalizePersistedCaptureReceipts(
  rows: unknown, knowledgeCutoff: string,
): readonly CaptureAttemptReceipt[] {
  const cutoff = parseStrictTimestampNanos(knowledgeCutoff);
  if (cutoff === null) throw new Error('CAPTURE_RPC_CUTOFF_INVALID');
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('CAPTURE_RPC_RESULT_INVALID');
  const result: CaptureAttemptReceipt[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!obj(r) || !exactKeys(r)
      || typeof r.plan_id !== 'string' || !IDENTIFIER.test(r.plan_id)
      || typeof r.slot_id !== 'string' || !IDENTIFIER.test(r.slot_id)
      || typeof r.source_record_id !== 'string'
      || !CAPTURE_SERIES.some((s) => s.provider === r.provider && s.symbol === r.symbol
        && s.sourceRecordId === r.source_record_id)
      || typeof r.source_received_at !== 'string' || typeof r.recorded_at !== 'string') die(i);
    const sourceReceived = parseStrictTimestampNanos(r.source_received_at);
    const dbRecorded = parseStrictTimestampNanos(r.recorded_at);
    if (sourceReceived === null || dbRecorded === null
      || sourceReceived > dbRecorded || dbRecorded > cutoff) die(i);
    const captured = r.outcome === 'CAPTURED';
    const failed = r.outcome === 'FAILED';
    if ((!captured && !failed)
      || (captured && (typeof r.content_sha256 !== 'string'
        || !HEX.test(r.content_sha256) || r.failure_code !== null))
      || (failed && (r.content_sha256 !== null
        || typeof r.failure_code !== 'string' || !FAIL_CODES.has(r.failure_code)))) die(i);
    const id = r.plan_id + '\u0000' + r.slot_id;
    if (seen.has(id)) die(i);
    seen.add(id);
    result.push({
      slotId: r.slot_id,
      // This is first known to PostgreSQL, not a trust claim about the source.
      receivedAt: r.recorded_at,
      outcome: r.outcome,
      rawPayloadDigest: captured ? 'sha256:' + r.content_sha256 : null,
    } as CaptureAttemptReceipt);
  }
  // Sort independently of transport/SQL row ordering for stable audit output.
  result.sort((a, b) => {
    const ta = parseStrictTimestampNanos(a.receivedAt)!;
    const tb = parseStrictTimestampNanos(b.receivedAt)!;
    return ta < tb ? -1 : ta > tb ? 1 : a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0;
  });
  return result;
}

/** Identical DATA-4A policy, no separate logic for coverage or confidence. */
export function auditPersistedCaptureContinuity(
  plan: unknown, rpcRows: unknown, knowledgeCutoff: string,
): CaptureContinuityAudit {
  if (!obj(plan) || typeof plan.planId !== 'string' || !IDENTIFIER.test(plan.planId)) {
    throw new Error('CAPTURE_RPC_PLAN_INVALID');
  }
  const receipts = normalizePersistedCaptureReceipts(rpcRows, knowledgeCutoff);
  if (!Array.isArray(rpcRows) || rpcRows.some((r: PersistedCaptureReceiptRow) => r.plan_id !== plan.planId)) {
    throw new Error('CAPTURE_RPC_PLAN_MISMATCH');
  }
  return auditCaptureContinuity(plan, receipts, knowledgeCutoff);
}
