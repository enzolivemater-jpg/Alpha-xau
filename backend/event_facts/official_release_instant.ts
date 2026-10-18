/**
 * B3: publication instant of an official US release, and the admission of an
 * event version built from it.
 *
 * The BLS, DOL and BEA release texts state a US Eastern wall-clock time
 * ("8:30 a.m. (ET) Friday, September 11, 2026", "8:30 A.M. (Eastern) ...",
 * "EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, ..."). The instant is converted to
 * UTC with the US daylight-saving rule in force since 2007. Anything that does
 * not match exactly, names the wrong weekday, contradicts the daylight-saving
 * state (EDT in winter) or falls in a transition hour is null, never guessed.
 *
 * The four adapters stay import-free (tests load them directly), so each one
 * carries a byte-identical copy of the block between the BEGIN / END markers;
 * tests/test_official_release_instant.mjs fails if a copy drifts.
 *
 * Pure integer calendar arithmetic: no clock, Date object, network or environment.
 */

import { isStrictTimestamp, isStrictlyAfter } from '../shared/strict_timestamp.js';

export const OFFICIAL_RELEASE_INSTANT_ALGORITHM_VERSION = 'official-release-instant-us-eastern-1.0.0' as const;

// BEGIN official-release-instant (B3) — keep byte-identical in the four adapters
const RELEASE_INSTANT_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RELEASE_INSTANT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const RELEASE_INSTANT_CLOCK = '([1-9]|1[0-2]):([0-5]\\d) (a\\.m\\.|p\\.m\\.|A\\.M\\.|P\\.M\\.)';
const RELEASE_INSTANT_DAY = `(${RELEASE_INSTANT_WEEKDAYS.join('|')}), (${RELEASE_INSTANT_MONTHS.join('|')}) ([1-9]|[12]\\d|3[01]), (\\d{4})`;
const RELEASE_INSTANT_FORMATS = [
  new RegExp(`^${RELEASE_INSTANT_CLOCK} \\((ET|Eastern)\\) ${RELEASE_INSTANT_DAY}$`),
  new RegExp(`^EMBARGOED UNTIL RELEASE AT ${RELEASE_INSTANT_CLOCK} (EDT|EST), ${RELEASE_INSTANT_DAY}$`),
];

/** Days since 1970-01-01 of a proleptic Gregorian date (month 1-12). */
function releaseInstantDays(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

/** Inverse of releaseInstantDays. */
function releaseInstantCivil(days: number): readonly [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, doy - Math.floor((153 * mp + 2) / 5) + 1];
}

/** 0 = Sunday; 1970-01-01 was a Thursday. */
function releaseInstantWeekday(days: number): number {
  return ((days % 7) + 11) % 7;
}

/**
 * UTC instant (`YYYY-MM-DDTHH:MM:00.000Z`) stated by an official US release
 * text in Eastern time, or null when it cannot be read exactly.
 */
function officialReleaseInstantUtc(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const match = RELEASE_INSTANT_FORMATS[0].exec(raw) ?? RELEASE_INSTANT_FORMATS[1].exec(raw);
  if (match === null) return null;
  const [, hourText, minuteText, meridiem, zone, weekday, monthName, dayText, yearText] = match;
  const year = Number(yearText);
  const month = RELEASE_INSTANT_MONTHS.indexOf(monthName) + 1;
  const day = Number(dayText);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthLength = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (year < 2007 || day > monthLength) return null; // the daylight-saving rule below holds from 2007
  const days = releaseInstantDays(year, month, day);
  if (RELEASE_INSTANT_WEEKDAYS[releaseInstantWeekday(days)] !== weekday) return null;
  const minutes = ((Number(hourText) % 12) + (meridiem.toLowerCase() === 'p.m.' ? 12 : 0)) * 60 + Number(minuteText);
  // EDT from 02:00 EST on the second Sunday of March to 02:00 EDT on the first Sunday of November.
  const start = 8 + ((7 - releaseInstantWeekday(releaseInstantDays(year, 3, 1))) % 7);
  const end = 1 + ((7 - releaseInstantWeekday(releaseInstantDays(year, 11, 1))) % 7);
  let daylight: boolean;
  if (month === 3 && day === start) {
    if (minutes >= 120 && minutes < 180) return null; // does not exist
    daylight = minutes >= 180;
  } else if (month === 11 && day === end) {
    if (minutes >= 60 && minutes < 120) return null; // ambiguous
    daylight = minutes < 60;
  } else {
    daylight = (month > 3 || (month === 3 && day > start)) && (month < 11 || (month === 11 && day < end));
  }
  if ((zone === 'EDT' && !daylight) || (zone === 'EST' && daylight)) return null;
  const utcMinutes = minutes + (daylight ? 240 : 300);
  const [y, m, d] = releaseInstantCivil(days + Math.floor(utcMinutes / 1440));
  const two = (value: number) => String(value).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${two(m)}-${two(d)}T${two(Math.floor((utcMinutes % 1440) / 60))}:${two(utcMinutes % 60)}:00.000Z`;
}
// END official-release-instant (B3)

/** Reference parser; every adapter's `publishedAt` must equal it. */
export const parseOfficialReleaseInstant = officialReleaseInstantUtc;

export type OfficialReleaseAdmissionReason =
  | 'ADAPTER_NOT_RESOLVED'
  | 'RELEASE_INSTANT_UNKNOWN'
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'KNOWN_BEFORE_OFFICIAL_RELEASE';

export type OfficialReleaseAdmission =
  | { readonly kind: 'ADMITTED'; readonly reason: null; readonly publishedAt: string }
  | { readonly kind: 'REFUSED'; readonly reason: OfficialReleaseAdmissionReason; readonly publishedAt: string | null };

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Whether an event version built from this adapter result may carry this
 * knowledge cutoff: only a RESOLVED result with a known publication instant,
 * and a strict cutoff not earlier than that instant (exact to the nanosecond).
 * Never throws.
 */
export function admitEventVersionAtOfficialRelease(adapterResult: unknown, knowledgeCutoff: unknown): OfficialReleaseAdmission {
  let publishedAt: unknown;
  try {
    if (typeof adapterResult !== 'object' || adapterResult === null || Array.isArray(adapterResult)
        || (adapterResult as { kind?: unknown }).kind !== 'RESOLVED') {
      return { kind: 'REFUSED', reason: 'ADAPTER_NOT_RESOLVED', publishedAt: null };
    }
    publishedAt = (adapterResult as { publishedAt?: unknown }).publishedAt;
  } catch {
    return { kind: 'REFUSED', reason: 'ADAPTER_NOT_RESOLVED', publishedAt: null };
  }
  if (typeof publishedAt !== 'string' || !INSTANT.test(publishedAt) || !isStrictTimestamp(publishedAt)) {
    return { kind: 'REFUSED', reason: 'RELEASE_INSTANT_UNKNOWN', publishedAt: null };
  }
  if (!isStrictTimestamp(knowledgeCutoff)) {
    return { kind: 'REFUSED', reason: 'INVALID_KNOWLEDGE_CUTOFF', publishedAt };
  }
  if (isStrictlyAfter(publishedAt, knowledgeCutoff)) {
    return { kind: 'REFUSED', reason: 'KNOWN_BEFORE_OFFICIAL_RELEASE', publishedAt };
  }
  return { kind: 'ADMITTED', reason: null, publishedAt };
}
