/**
 * TIME-0: deterministic, strict RFC3339 civil-time and instant comparison.
 *
 * Explicit caller claims only. NOT a trusted clock, publication proof,
 * source attestation, replay eligibility, session calendar or trade authority.
 * Pure, no I/O or implicit wall-clock read.
 */
export const TEMPORAL_SCHEMA_VERSION = 'xau.temporal-instant.v1' as const;
export const TEMPORAL_ALGORITHM_VERSION = 'strict-gregorian-nanoseconds-1.0.0' as const;

export interface ParsedInstant {
  /** Exact UTC instant, preserves sub-millisecond precision. Do not JSON-encode BigInt. */
  readonly epochNanoseconds: bigint;
  /** Original fractional digits, 0..9. No precision is invented. */
  readonly fractionalDigits: number;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

/**
 * Strict Gregorian validation before using Date.parse for offset conversion.
 * Date.parse alone silently normalizes impossible civil dates in Node.
 * maximumFractionDigits=3 enforces the older EVIDENCE-0 millisecond contract;
 * the default 9 preserves OBS-0 / UI-0 nanosecond-level input syntax.
 */
export function parseStrictInstant(
  value: unknown,
  maximumFractionDigits: 3 | 9 = 9,
): ParsedInstant | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const zone = match[8];
  if (year === 0 || month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || fraction.length > maximumFractionDigits) return null;
  if (zone !== 'Z') {
    const zoneHours = Number(match[10]);
    const zoneMinutes = Number(match[11]);
    if (zoneHours > 14 || zoneMinutes > 59 || (zoneHours === 14 && zoneMinutes !== 0)) {
      return null;
    }
    // RFC3339 -00:00 means unknown local UTC offset, not an attested instant.
    if (zone === '-00:00') return null;
  }

  const nineDigits = fraction.padEnd(9, '0');
  const milliseconds = nineDigits.slice(0, 3);
  const subMillisecond = nineDigits.slice(3);
  const normalized = value.slice(0, 19) + '.' + milliseconds + zone;
  const epochMilliseconds = Date.parse(normalized);
  if (!Number.isSafeInteger(epochMilliseconds)) return null;
  return {
    epochNanoseconds: BigInt(epochMilliseconds) * 1_000_000n + BigInt(subMillisecond),
    fractionalDigits: fraction.length,
  };
}

export function isStrictTimestamp(
  value: unknown,
  maximumFractionDigits: 3 | 9 = 9,
): value is string {
  return parseStrictInstant(value, maximumFractionDigits) !== null;
}

/**
 * Null means malformed/missing input — never treat null as equal or ready.
 * Both UTC offsets and full nanosecond precision participate in comparison.
 */
export function compareStrictInstants(
  a: unknown,
  b: unknown,
  maximumFractionDigits: 3 | 9 = 9,
): -1 | 0 | 1 | null {
  const left = parseStrictInstant(a, maximumFractionDigits);
  const right = parseStrictInstant(b, maximumFractionDigits);
  if (left === null || right === null) return null;
  return left.epochNanoseconds < right.epochNanoseconds
    ? -1 : left.epochNanoseconds > right.epochNanoseconds ? 1 : 0;
}
