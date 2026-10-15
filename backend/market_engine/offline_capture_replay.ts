/**
 * DATA-4F — purely simulated provider-attempt orchestration.
 *
 * No HTTP requests, scheduler, env, secrets, database or runtime clock.
 * Inputs are an explicit DATA-4E policy and an operator-provided mock trace.
 * Retry budgets are local simulation caps, NOT supplier-approved quotas.
 * A simulated receipt is never evidence of an actual provider request.
 */
import { compileCaptureSchedule } from './capture_schedule.js';
import { auditCaptureContinuity, type CaptureAttemptReceipt } from './capture_continuity.js';
import { parseStrictTimestampNanos } from '../shared/strict_timestamp.js';

export const OFFLINE_CAPTURE_REPLAY_SCHEMA_VERSION = 'xau.offline-capture-replay.v1' as const;
export const OFFLINE_CAPTURE_REPLAY_ALGORITHM_VERSION = 'offline-capture-replay-transition-1.0.0' as const;

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_TRACE_EVENTS = 2048;
const MAX_TOTAL_REQUESTS = 2048;
const FAILURE_CODES = new Set(['TIMEOUT', 'QUOTA', 'HTTP_ERROR', 'TRANSPORT_ERROR', 'PARSE_REJECTED', 'OTHER']);
const isObj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (r: Record<string, unknown>, keys: readonly string[]) => {
  const a = Object.keys(r).sort();
  const b = [...keys].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
};
const instant = (x: unknown): bigint | null =>
  typeof x === 'string' && UTC.test(x) ? parseStrictTimestampNanos(x) : null;
const fail = (code: string): never => { throw new Error('OFFLINE_CAPTURE_' + code); };
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export interface MockCaptureAttempt {
  readonly slotId: string;
  readonly attempt: number; // 1..maxAttempts; uniquely identifies a retry
  readonly at: string; // the mock outcome time, NOT first DB knowledge
  readonly outcome: 'CAPTURED' | 'RETRYABLE_FAILURE' | 'FAILED';
  readonly rawPayloadDigest: string | null;
  readonly failureCode: 'TIMEOUT' | 'QUOTA' | 'HTTP_ERROR' |
    'TRANSPORT_ERROR' | 'PARSE_REJECTED' | 'OTHER' | null;
}
export interface OfflineCaptureRetryPolicy {
  readonly maxAttemptsPerSlot: number; // 1..5
  readonly minimumRetryDelayMs: number; // 1s..1h
  readonly maxProviderAttempts: {
    readonly fred: number; // internal simulation safety bound only
    readonly twelve_data: number;
  };
}
export interface OfflineCaptureReplay {
  readonly schemaVersion: typeof OFFLINE_CAPTURE_REPLAY_SCHEMA_VERSION;
  readonly algorithmVersion: typeof OFFLINE_CAPTURE_REPLAY_ALGORITHM_VERSION;
  readonly cutoff: string;
  readonly planId: string;
  readonly simulationOnly: true;
  readonly status: 'SIMULATED' | 'SIMULATED_INCOMPLETE';
  readonly attemptsAccepted: number;
  readonly attemptsByProvider: { readonly fred: number; readonly twelve_data: number };
  readonly pendingRetrySlots: readonly string[];
  readonly simulatedReceipts: readonly CaptureAttemptReceipt[];
  readonly audit: ReturnType<typeof auditCaptureContinuity>;
  readonly providerAuthenticity: 'NOT_PROVEN';
  readonly archiveCoverage: 'NOT_ESTABLISHED';
  readonly authorization: 'OFFLINE_ONLY';
  readonly decision: 'HOLD';
  readonly execution: 'FORBIDDEN';
}

/**
 * Recompute from the immutable mock trace for any cutoff. Interrupted runs
 * resume by re-supplying the same events; identical retransmission is
 * idempotent and divergent retransmission is rejected. No stored state.
 */
export function replayOfflineCaptureAttempts(
  declaredPolicy: unknown,
  traceInput: unknown,
  cutoffInput: string,
  retryInput: unknown,
): OfflineCaptureReplay {
  const compiled = compileCaptureSchedule(declaredPolicy);
  const cutoff = instant(cutoffInput);
  if (cutoff === null) fail('INVALID_CUTOFF');
  if (!isObj(retryInput) || !exact(retryInput, [
    'maxAttemptsPerSlot', 'minimumRetryDelayMs', 'maxProviderAttempts',
  ]) || !Number.isSafeInteger(retryInput.maxAttemptsPerSlot)
    || (retryInput.maxAttemptsPerSlot as number) < 1
    || (retryInput.maxAttemptsPerSlot as number) > 5
    || !Number.isSafeInteger(retryInput.minimumRetryDelayMs)
    || (retryInput.minimumRetryDelayMs as number) < 1000
    || (retryInput.minimumRetryDelayMs as number) > 3_600_000
    || !isObj(retryInput.maxProviderAttempts)
    || !exact(retryInput.maxProviderAttempts, ['fred', 'twelve_data'])) {
    fail('INVALID_RETRY_POLICY');
  }
  // The runtime guards above justify this narrow contract type.
  const retry = retryInput as OfflineCaptureRetryPolicy;
  const limits = retry.maxProviderAttempts;
  for (const provider of ['fred', 'twelve_data'] as const) {
    const cap = limits[provider];
    if (!Number.isSafeInteger(cap) || (cap as number) < compiled.plannedByProvider[provider]
      || (cap as number) > MAX_TOTAL_REQUESTS) fail('INVALID_RETRY_BUDGET');
  }
  if (!Array.isArray(traceInput) || traceInput.length > MAX_TRACE_EVENTS) fail('INVALID_TRACE');

  type KnownSlot = {
    provider: 'fred' | 'twelve_data';
    start: bigint;
    end: bigint;
    attempts: MockCaptureAttempt[];
  };
  const slots = new Map<string, KnownSlot>();
  for (const slot of compiled.plan.slots) {
    slots.set(slot.slotId, {
      provider: slot.provider,
      start: instant(slot.earliestAt)!,
      end: instant(slot.deadlineAt)!,
      attempts: [],
    });
  }

  // Exact per-slot attempt identity. Duplicate delivery is not a new call;
  // conflicting replays are evidence tampering, never "last writer wins".
  const seen = new Map<string, string>();
  for (const item of traceInput as unknown[]) {
    if (!isObj(item) || !exact(item, [
      'slotId', 'attempt', 'at', 'outcome', 'rawPayloadDigest', 'failureCode',
    ]) || typeof item.slotId !== 'string'
      || !Number.isSafeInteger(item.attempt)
      || (item.attempt as number) < 1 || (item.attempt as number) > 5) {
      fail('INVALID_ATTEMPT');
    }
    const at = instant(item.at);
    if (at === null) fail('INVALID_ATTEMPT_TIME');
    if ((at as bigint) > (cutoff as bigint)) continue; // Never consult the future's outcome or digest.
    const slot = slots.get(item.slotId);
    if (!slot) fail('UNKNOWN_SLOT');
    if ((at as bigint) < slot!.start || (at as bigint) > slot!.end) fail('ATTEMPT_OUTSIDE_SLOT');
    const captured = item.outcome === 'CAPTURED';
    const error = item.outcome === 'RETRYABLE_FAILURE' || item.outcome === 'FAILED';
    if ((!captured && !error)
        || (captured && (typeof item.rawPayloadDigest !== 'string'
          || !DIGEST.test(item.rawPayloadDigest) || item.failureCode !== null))
        || (error && (item.rawPayloadDigest !== null
          || typeof item.failureCode !== 'string' || !FAILURE_CODES.has(item.failureCode)))) {
      fail('INVALID_OUTCOME');
    }
    if ((item.attempt as number) > retry.maxAttemptsPerSlot) {
      fail('RETRY_LIMIT_EXCEEDED');
    }
    const id = item.slotId + '\u0000' + item.attempt;
    const normalized = JSON.stringify({
      slotId: item.slotId, attempt: item.attempt, at: item.at,
      outcome: item.outcome, rawPayloadDigest: item.rawPayloadDigest,
      failureCode: item.failureCode,
    });
    const prior = seen.get(id);
    if (prior !== undefined) {
      if (prior !== normalized) fail('CONFLICTING_ATTEMPT_REPLAY');
      continue;
    }
    seen.set(id, normalized);
    slot!.attempts.push(item as unknown as MockCaptureAttempt);
  }

  let attemptsAccepted = 0;
  const attemptsByProvider = { fred: 0, twelve_data: 0 };
  const simulatedReceipts: CaptureAttemptReceipt[] = [];
  const pendingRetrySlots: string[] = [];
  const wait = BigInt(retry.minimumRetryDelayMs) * 1_000_000n;
  for (const [id, slot] of slots) {
    slot.attempts.sort((a, b) => a.attempt - b.attempt);
    let previous: MockCaptureAttempt | null = null;
    for (const ev of slot.attempts) {
      const expected = previous === null ? 1 : previous.attempt + 1;
      if (ev.attempt !== expected) fail('ATTEMPT_SEQUENCE_GAP');
      if (previous !== null) {
        if (previous.outcome !== 'RETRYABLE_FAILURE') fail('RETRY_AFTER_TERMINAL');
        const delta = instant(ev.at)! - instant(previous.at)!;
        if (delta < wait) fail('RETRY_TOO_EARLY');
      }
      previous = ev;
      attemptsAccepted++;
      attemptsByProvider[slot.provider]++;
      if (attemptsByProvider[slot.provider] > (limits[slot.provider] as number)) {
        fail('PROVIDER_ATTEMPT_BUDGET_EXCEEDED');
      }
    }
    if (previous === null) continue;
    if (previous.outcome === 'RETRYABLE_FAILURE') {
      // No invented terminal success or failure. A retryable failure without
      // another explicit event remains unaccounted for, even at deadline.
      if (previous.attempt < retry.maxAttemptsPerSlot
        && instant(previous.at)! + wait <= slot.end) pendingRetrySlots.push(id);
      continue;
    }
    simulatedReceipts.push({
      slotId: id,
      receivedAt: previous.at,
      outcome: previous.outcome === 'CAPTURED' ? 'CAPTURED' : 'FAILED',
      rawPayloadDigest: previous.outcome === 'CAPTURED' ? previous.rawPayloadDigest : null,
    });
  }
  simulatedReceipts.sort((a, b) => cmp(a.slotId, b.slotId));
  pendingRetrySlots.sort(cmp);
  const audit = auditCaptureContinuity(compiled.plan, simulatedReceipts, cutoffInput);
  return {
    schemaVersion: OFFLINE_CAPTURE_REPLAY_SCHEMA_VERSION,
    algorithmVersion: OFFLINE_CAPTURE_REPLAY_ALGORITHM_VERSION,
    cutoff: cutoffInput,
    planId: compiled.plan.planId,
    simulationOnly: true,
    status: audit.status === 'ATTEMPTS_RECORDED' ? 'SIMULATED' : 'SIMULATED_INCOMPLETE',
    attemptsAccepted, attemptsByProvider,
    pendingRetrySlots, simulatedReceipts, audit,
    providerAuthenticity: 'NOT_PROVEN',
    archiveCoverage: 'NOT_ESTABLISHED',
    authorization: 'OFFLINE_ONLY', decision: 'HOLD', execution: 'FORBIDDEN',
  };
}
