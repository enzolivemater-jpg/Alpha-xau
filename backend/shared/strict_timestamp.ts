/**
 * Strict ISO-8601 timestamp with an explicit zone, shared by the V2 gates.
 *
 * `Date.parse` silently normalizes impossible civil times (`2026-02-30` is
 * read as 2 March, `24:00:00` as the next day). A knowledge cutoff or an
 * observation time must never be shifted that way, so the calendar and clock
 * components are checked before parsing. Accepted shape is unchanged:
 * `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|±HH:MM)`.
 */

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Epoch milliseconds of a valid timestamp, or null. Never throws. */
export function parseStrictTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = SHAPE.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // Same zone policy as TIME-0 (temporal_contract.ts): real UTC offsets only,
  // and RFC3339 `-00:00` (unknown local offset) is not an attested instant.
  if (match[7] !== undefined) {
    const zoneHours = Number(match[8]);
    const zoneMinutes = Number(match[9]);
    if (zoneHours > 14 || zoneMinutes > 59 || (zoneHours === 14 && zoneMinutes !== 0)) return null;
    if (match[7] === '-' && zoneHours === 0 && zoneMinutes === 0) return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isStrictTimestamp(value: unknown): value is string {
  return parseStrictTimestamp(value) !== null;
}

/**
 * Exact instant in nanoseconds since the epoch, or null. `Date.parse` keeps
 * only milliseconds, so `14:15:00.0005Z` would compare equal to a
 * `14:15:00Z` cutoff; every "after the cutoff" test compares this value.
 */
export function parseStrictTimestampNanos(value: unknown): bigint | null {
  const milliseconds = parseStrictTimestamp(value);
  if (milliseconds === null) return null;
  const fraction = /\.(\d+)/.exec(value as string)?.[1] ?? '';
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.slice(3).padEnd(6, '0'));
}

/** True when both timestamps are valid and `value` is strictly after `reference`. */
export function isStrictlyAfter(value: unknown, reference: unknown): boolean {
  const a = parseStrictTimestampNanos(value);
  const b = parseStrictTimestampNanos(reference);
  return a !== null && b !== null && a > b;
}
