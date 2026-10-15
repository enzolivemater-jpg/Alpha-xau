/**
 * DATA-4E — offline compilation of an operator-declared, bounded capture plan.
 *
 * This module never invents schedules or calls a provider, clock, database,
 * scheduler or broker. It validates an explicit UTC-only plan against DATA-2
 * CAPTURE_SERIES and passes the canonical slots to DATA-4A unchanged.
 * Operator-declared budgets are internal caps, NEVER verified provider quotas.
 * No output proves calendar completeness, source authenticity or market trust.
 */
import { CAPTURE_SERIES } from './evidence_capture.js';
import { parseStrictTimestampNanos } from '../shared/strict_timestamp.js';
import type { CaptureContinuityPlan, PlannedCaptureSlot } from './capture_continuity.js';

export const CAPTURE_SCHEDULE_SCHEMA_VERSION = 'xau.capture-schedule-policy.v1' as const;
export const CAPTURE_SCHEDULE_ALGORITHM_VERSION = 'capture-schedule-explicit-utc-1.0.0' as const;

export interface DeclaredCaptureWindow {
  readonly slotId: string;
  readonly earliestAt: string;
  readonly deadlineAt: string;
}
export interface DeclaredCaptureSeries {
  readonly provider: 'fred' | 'twelve_data';
  readonly symbol: PlannedCaptureSlot['symbol'];
  readonly sourceRecordId: string;
  readonly windows: readonly DeclaredCaptureWindow[];
}
export interface DeclaredCaptureSchedule {
  readonly schemaVersion: typeof CAPTURE_SCHEDULE_SCHEMA_VERSION;
  readonly planId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Operator budget, NOT the supplier's confirmed quota. */
  readonly requestBudgets: {
    readonly fred: number;
    readonly twelve_data: number;
  };
  /** Every intended slot must be explicitly provided; no recurrence inferred. */
  readonly series: readonly DeclaredCaptureSeries[];
}
export interface CompiledCaptureSchedule {
  readonly schemaVersion: typeof CAPTURE_SCHEDULE_SCHEMA_VERSION;
  readonly algorithmVersion: typeof CAPTURE_SCHEDULE_ALGORITHM_VERSION;
  readonly plan: CaptureContinuityPlan;
  readonly plannedRequests: number;
  readonly plannedByProvider: { readonly fred: number; readonly twelve_data: number };
  readonly calendarCompleteness: 'NOT_PROVEN';
  readonly supplierQuotaApproval: 'NOT_PROVEN';
  readonly providerAuthenticity: 'NOT_PROVEN';
  readonly archiveCoverage: 'NOT_ESTABLISHED';
  readonly authorization: 'OFFLINE_ONLY';
  readonly decision: 'HOLD';
  readonly execution: 'FORBIDDEN';
}

const LIMIT = 512;
const MAX_WINDOW_NANOS = 7n * 24n * 60n * 60n * 1_000_000_000n;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const hasExactly = (x: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(x).sort();
  const required = [...keys].sort();
  return actual.length === required.length && actual.every((key, i) => key === required[i]);
};
const safeUtc = (x: unknown): bigint | null =>
  typeof x === 'string' && UTC_MILLIS.test(x) ? parseStrictTimestampNanos(x) : null;
const cmpStr = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const refuse = (reason: string): never => { throw new Error('CAPTURE_SCHEDULE_' + reason); };

/** Fail-closed: rejects unknown keys, invented frequencies and unbounded plans. */
export function compileCaptureSchedule(input: unknown): CompiledCaptureSchedule {
  if (!isRecord(input) || !hasExactly(input, [
    'schemaVersion', 'planId', 'windowStart', 'windowEnd', 'requestBudgets', 'series',
  ]) || input.schemaVersion !== CAPTURE_SCHEDULE_SCHEMA_VERSION
      || typeof input.planId !== 'string' || !IDENTIFIER.test(input.planId)) {
    return refuse('INVALID_POLICY');
  }
  const from = safeUtc(input.windowStart);
  const to = safeUtc(input.windowEnd);
  if (from === null || to === null || from >= to || to - from > MAX_WINDOW_NANOS) {
    return refuse('INVALID_WINDOW');
  }
  if (!isRecord(input.requestBudgets) || !hasExactly(input.requestBudgets, ['fred', 'twelve_data'])) {
    return refuse('INVALID_BUDGET');
  }
  for (const provider of ['fred', 'twelve_data'] as const) {
    const budget = input.requestBudgets[provider];
    if (!Number.isSafeInteger(budget) || (budget as number) < 0 || (budget as number) > LIMIT) {
      return refuse('INVALID_BUDGET');
    }
  }
  if (!Array.isArray(input.series) || input.series.length === 0
      || input.series.length > CAPTURE_SERIES.length) {
    return refuse('INVALID_SERIES');
  }

  const registered = new Set<string>();
  const ids = new Set<string>();
  const plannedByProvider = { fred: 0, twelve_data: 0 };
  const slots: PlannedCaptureSlot[] = [];
  for (const entry of input.series) {
    if (!isRecord(entry) || !hasExactly(entry, ['provider', 'symbol', 'sourceRecordId', 'windows'])
        || typeof entry.sourceRecordId !== 'string'
        || !CAPTURE_SERIES.some((registered) => registered.provider === entry.provider
          && registered.symbol === entry.symbol && registered.sourceRecordId === entry.sourceRecordId)
        || !Array.isArray(entry.windows) || entry.windows.length === 0) {
      return refuse('INVALID_SERIES');
    }
    const sourceKey = [entry.provider, entry.sourceRecordId, entry.symbol].join('\u0000');
    if (registered.has(sourceKey)) return refuse('DUPLICATE_SERIES');
    registered.add(sourceKey);
    const ordered: { slot: PlannedCaptureSlot; start: bigint; end: bigint }[] = [];
    for (const win of entry.windows) {
      if (!isRecord(win) || !hasExactly(win, ['slotId', 'earliestAt', 'deadlineAt'])
          || typeof win.slotId !== 'string' || !IDENTIFIER.test(win.slotId)
          || typeof win.earliestAt !== 'string' || typeof win.deadlineAt !== 'string') {
        return refuse('INVALID_SLOT');
      }
      const start = safeUtc(win.earliestAt);
      const end = safeUtc(win.deadlineAt);
      if (start === null || end === null || start < from || start >= end || end > to) {
        return refuse('INVALID_SLOT');
      }
      if (ids.has(win.slotId)) return refuse('DUPLICATE_SLOT');
      ids.add(win.slotId);
      ordered.push({
        start, end,
        slot: {
          slotId: win.slotId,
          provider: entry.provider as PlannedCaptureSlot['provider'],
          symbol: entry.symbol as PlannedCaptureSlot['symbol'],
          sourceRecordId: entry.sourceRecordId,
          earliestAt: win.earliestAt,
          deadlineAt: win.deadlineAt,
        },
      });
      if (ordered.length > LIMIT || slots.length + ordered.length > LIMIT) {
        return refuse('PLAN_TOO_LARGE');
      }
    }
    ordered.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1
      : cmpStr(a.slot.slotId, b.slot.slotId));
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].start < ordered[i - 1].end) return refuse('OVERLAPPING_SERIES_SLOTS');
    }
    for (const item of ordered) slots.push(item.slot);
    plannedByProvider[entry.provider as 'fred' | 'twelve_data'] += ordered.length;
  }
  for (const provider of ['fred', 'twelve_data'] as const) {
    if (plannedByProvider[provider] > (input.requestBudgets[provider] as number)) {
      return refuse('BUDGET_EXCEEDED');
    }
  }
  slots.sort((a, b) => {
    const ta = safeUtc(a.earliestAt)!;
    const tb = safeUtc(b.earliestAt)!;
    return ta < tb ? -1 : ta > tb ? 1 : cmpStr(a.slotId, b.slotId);
  });
  return {
    schemaVersion: CAPTURE_SCHEDULE_SCHEMA_VERSION,
    algorithmVersion: CAPTURE_SCHEDULE_ALGORITHM_VERSION,
    plan: {
      planId: input.planId,
      windowStart: input.windowStart as string,
      windowEnd: input.windowEnd as string,
      slots,
    },
    plannedRequests: slots.length,
    plannedByProvider,
    calendarCompleteness: 'NOT_PROVEN',
    supplierQuotaApproval: 'NOT_PROVEN',
    providerAuthenticity: 'NOT_PROVEN',
    archiveCoverage: 'NOT_ESTABLISHED',
    authorization: 'OFFLINE_ONLY',
    decision: 'HOLD',
    execution: 'FORBIDDEN',
  };
}
