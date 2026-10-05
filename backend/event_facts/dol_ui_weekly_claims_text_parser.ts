/**
 * XAU V2 — deterministic parser for a retained pdftotext projection of the
 * official US DOL weekly unemployment-insurance claims PDF.
 *
 * This module performs no fetch, PDF decoding, persistence, identity lookup,
 * clock read, or market inference. The caller must retain and authenticate the
 * source PDF separately; this parser only converts reviewed official text into
 * the strict structured payload accepted by the claims adapter.
 */

import type { DolUiWeeklyClaimsStructuredPayloadV1 } from './dol_ui_weekly_claims_adapter.ts';

export const DOL_UI_CLAIMS_TEXT_PARSER_VERSION =
  'dol-ui-claims-text-parser-v1' as const;

export interface DolUiClaimsTextParseSuccess {
  readonly kind: 'PARSED';
  readonly parserVersion: typeof DOL_UI_CLAIMS_TEXT_PARSER_VERSION;
  readonly payload: DolUiWeeklyClaimsStructuredPayloadV1;
}

export interface DolUiClaimsTextParseFailure {
  readonly kind: 'UNAVAILABLE' | 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED';
  readonly parserVersion: typeof DOL_UI_CLAIMS_TEXT_PARSER_VERSION;
  readonly reason: string;
}

export type DolUiClaimsTextParseResult =
  | DolUiClaimsTextParseSuccess
  | DolUiClaimsTextParseFailure;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function failure(
  kind: DolUiClaimsTextParseFailure['kind'],
  reason: string,
): DolUiClaimsTextParseFailure {
  return { kind, parserVersion: DOL_UI_CLAIMS_TEXT_PARSER_VERSION, reason };
}

function exactSingleMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function parsePersons(raw: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2}(?:,\d{3})*)$/.test(raw)) return null;
  const value = Number(raw.replaceAll(',', ''));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function monthLength(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function ordinal(date: CalendarDate): number {
  const previousYear = date.year - 1;
  let value = previousYear * 365
    + Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400);
  for (let month = 1; month < date.month; month += 1) {
    value += monthLength(date.year, month);
  }
  return value + date.day - 1;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function minusSevenDays(date: CalendarDate): CalendarDate {
  let { year, month, day } = date;
  day -= 7;
  if (day < 1) {
    month -= 1;
    if (month < 1) {
      year -= 1;
      month = 12;
    }
    day += monthLength(year, month);
  }
  return { year, month, day };
}

function iso(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function parseMonthDay(raw: string, releaseDate: CalendarDate): CalendarDate | null {
  const match = /^([A-Z][a-z]+) ([1-9]|[12]\d|3[01])$/.exec(raw);
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1] as typeof MONTHS[number]) + 1;
  const day = Number(match[2]);
  if (month === 0) return null;
  const year = month > releaseDate.month ? releaseDate.year - 1 : releaseDate.year;
  if (day > monthLength(year, month)) return null;
  return { year, month, day };
}

function parseReleaseDate(raw: string): CalendarDate | null {
  const match = /^8:30 A\.M\. \(Eastern\) Thursday, ([A-Z][a-z]+) ([1-9]|[12]\d|3[01]), (\d{4})$/.exec(raw);
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1] as typeof MONTHS[number]) + 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month === 0 || year < 1900 || day > monthLength(year, month)) return null;
  const date = { year, month, day };
  // Proleptic Gregorian 0001-01-01 is Monday; this grammar says Thursday.
  return ordinal(date) % 7 === 3 ? date : null;
}

export function parseDolUiWeeklyClaimsText(input: unknown): DolUiClaimsTextParseResult {
  if (typeof input !== 'string' || input.length === 0) {
    return failure('UNAVAILABLE', 'OFFICIAL_TEXT_UNAVAILABLE');
  }
  if (input.length > 1_000_000 || input.includes('\u0000')) {
    return failure('MALFORMED', 'OFFICIAL_TEXT_MALFORMED');
  }

  const text = input.replace(/\s+/g, ' ').trim();
  if (!text.includes('UNEMPLOYMENT INSURANCE WEEKLY CLAIMS')) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_OFFICIAL_RELEASE');
  }

  const publication = exactSingleMatch(
    text,
    /TRANSMISSION OF MATERIALS IN THIS RELEASE IS EMBARGOED UNTIL (8:30 A\.M\. \(Eastern\) Thursday, [A-Z][a-z]+ (?:[1-9]|[12]\d|3[01]), \d{4})/g,
  );
  const releaseNumber = exactSingleMatch(
    text,
    /Release Number: (USDL \d{2}-\d{4}-NAT)(?:\s|$)/g,
  );
  const initial = exactSingleMatch(
    text,
    /In the week ending ([A-Z][a-z]+ (?:[1-9]|[12]\d|3[01])), the advance figure for seasonally adjusted initial claims was ([\d,]+),.*?The previous week's level was revised (?:up|down) by [\d,]+ from ([\d,]+) to ([\d,]+)\. The 4-week moving average was ([\d,]+),.*?The previous week's average was revised (?:up|down) by [\d,]+ from ([\d,]+) to ([\d,]+)\./g,
  );
  const continuing = exactSingleMatch(
    text,
    /The advance number for seasonally adjusted insured unemployment during the week ending ([A-Z][a-z]+ (?:[1-9]|[12]\d|3[01])) was ([\d,]+),.*?The previous week's level was revised (?:up|down) by [\d,]+ from ([\d,]+) to ([\d,]+)\./g,
  );
  if (publication === null || releaseNumber === null
      || initial === null || continuing === null) {
    return failure('MALFORMED', 'REQUIRED_OFFICIAL_TEXT_EVIDENCE_MISSING_OR_AMBIGUOUS');
  }

  const releaseDate = parseReleaseDate(publication[1]);
  if (releaseDate === null) return failure('MALFORMED', 'PUBLICATION_DATE_MALFORMED');
  const initialDate = parseMonthDay(initial[1], releaseDate);
  const continuingDate = parseMonthDay(continuing[1], releaseDate);
  if (initialDate === null || continuingDate === null) {
    return failure('MALFORMED', 'WEEK_ENDING_DATE_MALFORMED');
  }
  if (
    ordinal(releaseDate) - ordinal(initialDate) < 1
    || ordinal(releaseDate) - ordinal(initialDate) > 7
    || ordinal(initialDate) - ordinal(continuingDate) !== 7
  ) {
    return failure('CONFLICT', 'OFFICIAL_PERIOD_CONFLICT');
  }

  const values = [
    initial[2], initial[3], initial[4], initial[5], initial[6], initial[7],
    continuing[2], continuing[3], continuing[4],
  ].map(parsePersons);
  if (values.some(value => value === null)) {
    return failure('MALFORMED', 'CLAIMS_VALUE_MALFORMED');
  }
  const [
    initialCurrent, initialPrior, initialRevised,
    averageCurrent, averagePrior, averageRevised,
    continuingCurrent, continuingPrior, continuingRevised,
  ] = values as number[];

  return {
    kind: 'PARSED',
    parserVersion: DOL_UI_CLAIMS_TEXT_PARSER_VERSION,
    payload: {
      source: {
        authority: 'US_DOL_ETA',
        provider: 'dol_eta',
        sourceCode: 'dol_ui_weekly_claims_release',
        sourceDomain: 'dol.gov',
      },
      release: {
        releaseFamily: 'US_JOBLESS_CLAIMS',
        releaseStage: 'SINGLE',
        releaseNumberRaw: releaseNumber[1],
        headerTitle: 'UNEMPLOYMENT INSURANCE WEEKLY CLAIMS',
        publicReleaseAtRaw: publication[1],
        artifactPath: '/ui/data.pdf',
      },
      summary: {
        initialClaims: {
          seriesLabel: 'Initial Claims (SA)',
          referencePeriod: { kind: 'WEEK_ENDING', date: iso(initialDate) },
          currentPersons: initialCurrent,
          priorRevision: {
            referencePeriod: { kind: 'WEEK_ENDING', date: iso(minusSevenDays(initialDate)) },
            priorPersons: initialPrior,
            revisedPersons: initialRevised,
          },
        },
        continuingClaims: {
          seriesLabel: 'Insured Unemployment (SA)',
          referencePeriod: { kind: 'WEEK_ENDING', date: iso(continuingDate) },
          currentPersons: continuingCurrent,
          priorRevision: {
            referencePeriod: { kind: 'WEEK_ENDING', date: iso(minusSevenDays(continuingDate)) },
            priorPersons: continuingPrior,
            revisedPersons: continuingRevised,
          },
        },
        initialClaimsFourWeekAverage: {
          seriesLabel: '4-Wk Moving Average (SA)',
          referencePeriod: { kind: 'WEEK_ENDING', date: iso(initialDate) },
          currentPersons: averageCurrent,
          priorRevision: {
            referencePeriod: { kind: 'WEEK_ENDING', date: iso(minusSevenDays(initialDate)) },
            priorPersons: averagePrior,
            revisedPersons: averageRevised,
          },
        },
      },
    },
  };
}
