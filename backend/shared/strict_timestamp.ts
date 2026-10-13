/**
 * Strict ISO-8601 timestamp with an explicit zone, shared by the V2 gates.
 *
 * `Date.parse` silently normalizes impossible civil times (`2026-02-30` is
 * read as 2 March, `24:00:00` as the next day). A knowledge cutoff or an
 * observation time must never be shifted that way, so the calendar and clock
 * components are checked before parsing. Accepted shape is unchanged:
 * `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|±HH:MM)`.
 */

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

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
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isStrictTimestamp(value: unknown): value is string {
  return parseStrictTimestamp(value) !== null;
}
