/**
 * XAU V2 — pure US DOL weekly unemployment-insurance claims adapter.
 *
 * The input is a reviewed, lossless projection of one retained official DOL
 * weekly claims release. Fetching, PDF parsing, persistence, identity lookup,
 * runtime orchestration, consensus enrichment, and CES activation are outside
 * this module.
 */

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

export const DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION =
  'dol-ui-claims-event-facts-adapter-v1' as const;
export const DOL_UI_CLAIMS_IDENTITY_STRATEGY_VERSION =
  'dol_ui_weekly_claims_v1' as const;
export const DOL_UI_CLAIMS_CANONICAL_EVENT_STATE_SCHEMA_VERSION = 2 as const;

interface WeekEndingPeriod {
  readonly kind: 'WEEK_ENDING';
  readonly date: string;
}

interface ClaimsRevision {
  readonly referencePeriod: WeekEndingPeriod;
  readonly priorPersons: number;
  readonly revisedPersons: number;
}

interface ClaimsMetricProjection {
  readonly seriesLabel:
    | 'Initial Claims (SA)'
    | 'Insured Unemployment (SA)'
    | '4-Wk Moving Average (SA)';
  readonly referencePeriod: WeekEndingPeriod;
  readonly currentPersons: number;
  readonly priorRevision: ClaimsRevision;
}

export interface DolUiWeeklyClaimsStructuredPayloadV1 {
  readonly source: {
    readonly authority: 'US_DOL_ETA';
    readonly provider: 'dol_eta';
    readonly sourceCode: 'dol_ui_weekly_claims_release';
    readonly sourceDomain: 'dol.gov';
  };
  readonly release: {
    readonly releaseFamily: 'US_JOBLESS_CLAIMS';
    readonly releaseStage: 'SINGLE';
    readonly releaseNumberRaw: string | null;
    readonly headerTitle: string | null;
    readonly publicReleaseAtRaw: string | null;
    readonly artifactPath: string | null;
  };
  readonly summary: {
    readonly initialClaims: ClaimsMetricProjection | null;
    readonly continuingClaims: ClaimsMetricProjection | null;
    readonly initialClaimsFourWeekAverage: ClaimsMetricProjection | null;
  };
}

export interface DolUiClaimsReleaseIdentityProposal {
  readonly authorityNamespace: 'xau_v2:official_release:us_dol_eta:v1';
  readonly identityType: 'official_release_id:dol_ui_weekly_claims_v1';
  readonly identityValue: string;
}

interface KnownValue {
  readonly state: 'KNOWN';
  readonly value: string;
}

interface UnknownValue {
  readonly state: 'UNKNOWN';
  readonly value: null;
}

interface CanonicalPriorPeriod {
  readonly reference_period: WeekEndingPeriod;
  readonly prior_value: KnownValue;
  readonly revised_value: KnownValue;
}

export interface DolUiClaimsCanonicalMetric {
  readonly metric_code:
    | 'CLAIMS_4WK_AVERAGE'
    | 'CONTINUING_CLAIMS'
    | 'INITIAL_CLAIMS';
  readonly reference_period: WeekEndingPeriod;
  readonly unit: 'THOUSANDS_OF_PERSONS';
  readonly actual: KnownValue;
  readonly consensus: UnknownValue;
  readonly prior_periods: readonly CanonicalPriorPeriod[];
}

export interface DolUiClaimsCanonicalEventStateV2 {
  readonly event_type: 'STATISTICAL_RELEASE';
  readonly subject: string;
  readonly detail: null;
  readonly facts: {
    readonly release_family: 'US_JOBLESS_CLAIMS';
    readonly metrics: readonly DolUiClaimsCanonicalMetric[];
  };
}

export interface DolUiClaimsResolvedResult {
  readonly kind: 'RESOLVED';
  readonly adapterVersion: typeof DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION;
  readonly releaseIdentity: DolUiClaimsReleaseIdentityProposal;
  readonly canonicalEventStateSchemaVersion:
    typeof DOL_UI_CLAIMS_CANONICAL_EVENT_STATE_SCHEMA_VERSION;
  readonly canonicalEventState: DolUiClaimsCanonicalEventStateV2;
  /** UTC instant stated by the release text; null when it cannot be read exactly (B3). */
  readonly publishedAt: string | null;
}

export interface DolUiClaimsNonResolvedResult {
  readonly kind: 'UNAVAILABLE' | 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED';
  readonly adapterVersion: typeof DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION;
  readonly reason: string;
}

export type DolUiClaimsAdapterResult =
  | DolUiClaimsResolvedResult
  | DolUiClaimsNonResolvedResult;

const SOURCE_KEYS = ['authority', 'provider', 'sourceCode', 'sourceDomain'] as const;
const RELEASE_KEYS = [
  'releaseFamily', 'releaseStage', 'releaseNumberRaw', 'headerTitle',
  'publicReleaseAtRaw', 'artifactPath',
] as const;
const SUMMARY_KEYS = [
  'initialClaims', 'continuingClaims', 'initialClaimsFourWeekAverage',
] as const;
const METRIC_KEYS = [
  'seriesLabel', 'referencePeriod', 'currentPersons', 'priorRevision',
] as const;
const REVISION_KEYS = ['referencePeriod', 'priorPersons', 'revisedPersons'] as const;
const PERIOD_KEYS = ['kind', 'date'] as const;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function nonResolved(
  kind: DolUiClaimsNonResolvedResult['kind'],
  reason: string,
): DolUiClaimsNonResolvedResult {
  return { kind, adapterVersion: DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION, reason };
}

interface ParsedDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly ordinal: number;
}

function parseWeekEnding(value: unknown): ParsedDate | null {
  if (!isRecord(value) || !hasExactKeys(value, PERIOD_KEYS)
      || value.kind !== 'WEEK_ENDING' || typeof value.date !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.date);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthLengths[month - 1]) return null;
  const previousYear = year - 1;
  let ordinal = previousYear * 365
    + Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400);
  for (let index = 0; index < month - 1; index += 1) ordinal += monthLengths[index];
  ordinal += day - 1;
  // Proleptic Gregorian 0001-01-01 is Monday; DOL national weeks end Saturday.
  if (ordinal % 7 !== 5) return null;
  return { year, month, day, ordinal };
}

function canonicalPersonsAsThousands(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < 0 || value > 999_999_999) return null;
  const whole = Math.floor(value / 1000);
  const remainder = value % 1000;
  if (remainder === 0) return String(whole);
  return `${whole}.${String(remainder).padStart(3, '0').replace(/0+$/, '')}`;
}

function canonicalReleaseId(raw: string): string {
  return raw.replace(/^USDL /, 'USDL-');
}

function canonicalIdentityValue(releaseId: string): string {
  return JSON.stringify({
    authority: 'us_dol_eta',
    release_family: 'US_JOBLESS_CLAIMS',
    release_id: releaseId,
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: DOL_UI_CLAIMS_IDENTITY_STRATEGY_VERSION,
  });
}

function validateOuterShape(input: unknown): DolUiClaimsNonResolvedResult | null {
  if (!isRecord(input) || !hasExactKeys(input, ['source', 'release', 'summary'])) {
    return nonResolved('MALFORMED', 'INVALID_PAYLOAD_SHAPE');
  }
  if (!isRecord(input.source) || !hasExactKeys(input.source, SOURCE_KEYS)) {
    return nonResolved('MALFORMED', 'INVALID_SOURCE_SHAPE');
  }
  if (!isRecord(input.release) || !hasExactKeys(input.release, RELEASE_KEYS)) {
    return nonResolved('MALFORMED', 'INVALID_RELEASE_SHAPE');
  }
  if (!isRecord(input.summary) || !hasExactKeys(input.summary, SUMMARY_KEYS)) {
    return nonResolved('MALFORMED', 'INVALID_SUMMARY_SHAPE');
  }
  return null;
}

export function resolveDolUiClaimsReleaseIdentity(input: unknown):
  DolUiClaimsReleaseIdentityProposal | DolUiClaimsNonResolvedResult {
  const shapeError = validateOuterShape(input);
  if (shapeError !== null) return shapeError;
  const payload = input as unknown as DolUiWeeklyClaimsStructuredPayloadV1;
  if (
    payload.source.authority !== 'US_DOL_ETA'
    || payload.source.provider !== 'dol_eta'
    || payload.source.sourceCode !== 'dol_ui_weekly_claims_release'
    || payload.source.sourceDomain !== 'dol.gov'
    || payload.release.releaseFamily !== 'US_JOBLESS_CLAIMS'
    || payload.release.releaseStage !== 'SINGLE'
  ) {
    return nonResolved('UNSUPPORTED', 'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE');
  }
  if (payload.release.releaseNumberRaw === null) {
    return nonResolved('UNAVAILABLE', 'OFFICIAL_RELEASE_NUMBER_UNAVAILABLE');
  }
  if (typeof payload.release.releaseNumberRaw !== 'string'
      || !/^USDL \d{2}-\d{4}-NAT$/.test(payload.release.releaseNumberRaw)) {
    return nonResolved('MALFORMED', 'OFFICIAL_RELEASE_NUMBER_MALFORMED');
  }
  return {
    authorityNamespace: 'xau_v2:official_release:us_dol_eta:v1',
    identityType: 'official_release_id:dol_ui_weekly_claims_v1',
    identityValue: canonicalIdentityValue(
      canonicalReleaseId(payload.release.releaseNumberRaw),
    ),
  };
}

interface ValidatedMetric {
  readonly reference: WeekEndingPeriod;
  readonly referenceDate: ParsedDate;
  readonly actual: string;
  readonly prior: CanonicalPriorPeriod;
}

function validateMetric(
  value: unknown,
  expectedLabel: ClaimsMetricProjection['seriesLabel'],
): ValidatedMetric | DolUiClaimsNonResolvedResult {
  if (!isRecord(value) || !hasExactKeys(value, METRIC_KEYS)
      || value.seriesLabel !== expectedLabel
      || !isRecord(value.priorRevision)
      || !hasExactKeys(value.priorRevision, REVISION_KEYS)) {
    return nonResolved('MALFORMED', 'CLAIMS_METRIC_SHAPE_MALFORMED');
  }
  const referenceDate = parseWeekEnding(value.referencePeriod);
  const priorDate = parseWeekEnding(value.priorRevision.referencePeriod);
  if (referenceDate === null || priorDate === null) {
    return nonResolved('MALFORMED', 'WEEK_ENDING_PERIOD_MALFORMED');
  }
  if (referenceDate.ordinal - priorDate.ordinal !== 7) {
    return nonResolved('CONFLICT', 'PRIOR_REVISION_PERIOD_CONFLICT');
  }
  const referencePeriod = value.referencePeriod as WeekEndingPeriod;
  const priorPeriod = value.priorRevision.referencePeriod as WeekEndingPeriod;
  const actual = canonicalPersonsAsThousands(value.currentPersons);
  const prior = canonicalPersonsAsThousands(value.priorRevision.priorPersons);
  const revised = canonicalPersonsAsThousands(value.priorRevision.revisedPersons);
  if (actual === null || prior === null || revised === null) {
    return nonResolved('MALFORMED', 'CLAIMS_VALUE_MALFORMED');
  }
  return {
    reference: { kind: 'WEEK_ENDING', date: referencePeriod.date },
    referenceDate,
    actual,
    prior: {
      reference_period: {
        kind: 'WEEK_ENDING',
        date: priorPeriod.date,
      },
      prior_value: { state: 'KNOWN', value: prior },
      revised_value: { state: 'KNOWN', value: revised },
    },
  };
}

export function mapDolUiWeeklyClaimsReleaseToEventFacts(input: unknown):
  DolUiClaimsAdapterResult {
  const identity = resolveDolUiClaimsReleaseIdentity(input);
  if ('kind' in identity) return identity;
  const payload = input as unknown as DolUiWeeklyClaimsStructuredPayloadV1;
  const { release, summary } = payload;
  if (
    release.headerTitle === null
    || release.publicReleaseAtRaw === null
    || release.artifactPath === null
    || summary.initialClaims === null
    || summary.continuingClaims === null
    || summary.initialClaimsFourWeekAverage === null
  ) {
    return nonResolved('UNAVAILABLE', 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE');
  }
  if (
    typeof release.headerTitle !== 'string'
    || typeof release.publicReleaseAtRaw !== 'string'
    || typeof release.artifactPath !== 'string'
    || release.headerTitle.trim() !== release.headerTitle
    || release.publicReleaseAtRaw.trim() !== release.publicReleaseAtRaw
    || release.headerTitle.length === 0
    || release.publicReleaseAtRaw.length === 0
  ) {
    return nonResolved('MALFORMED', 'OFFICIAL_EVIDENCE_MALFORMED');
  }
  if (
    release.headerTitle !== 'UNEMPLOYMENT INSURANCE WEEKLY CLAIMS'
    || release.artifactPath !== '/ui/data.pdf'
  ) {
    return nonResolved('CONFLICT', 'RELEASE_ARTIFACT_CONFLICT');
  }

  const initial = validateMetric(summary.initialClaims, 'Initial Claims (SA)');
  if ('kind' in initial) return initial;
  const continuing = validateMetric(
    summary.continuingClaims, 'Insured Unemployment (SA)',
  );
  if ('kind' in continuing) return continuing;
  const average = validateMetric(
    summary.initialClaimsFourWeekAverage, '4-Wk Moving Average (SA)',
  );
  if ('kind' in average) return average;

  if (
    initial.referenceDate.ordinal !== average.referenceDate.ordinal
    || initial.referenceDate.ordinal - continuing.referenceDate.ordinal !== 7
  ) {
    return nonResolved('CONFLICT', 'METRIC_REFERENCE_PERIOD_CONFLICT');
  }

  const consensus = { state: 'UNKNOWN' as const, value: null };
  const metrics: readonly DolUiClaimsCanonicalMetric[] = [
    {
      metric_code: 'CLAIMS_4WK_AVERAGE',
      reference_period: { ...average.reference },
      unit: 'THOUSANDS_OF_PERSONS',
      actual: { state: 'KNOWN', value: average.actual },
      consensus,
      prior_periods: [average.prior],
    },
    {
      metric_code: 'CONTINUING_CLAIMS',
      reference_period: { ...continuing.reference },
      unit: 'THOUSANDS_OF_PERSONS',
      actual: { state: 'KNOWN', value: continuing.actual },
      consensus,
      prior_periods: [continuing.prior],
    },
    {
      metric_code: 'INITIAL_CLAIMS',
      reference_period: { ...initial.reference },
      unit: 'THOUSANDS_OF_PERSONS',
      actual: { state: 'KNOWN', value: initial.actual },
      consensus,
      prior_periods: [initial.prior],
    },
  ];

  const date = initial.referenceDate;
  return {
    kind: 'RESOLVED',
    adapterVersion: DOL_UI_CLAIMS_EVENT_FACTS_ADAPTER_VERSION,
    releaseIdentity: identity,
    publishedAt: officialReleaseInstantUtc(release.publicReleaseAtRaw),
    canonicalEventStateSchemaVersion:
      DOL_UI_CLAIMS_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
    canonicalEventState: {
      event_type: 'STATISTICAL_RELEASE',
      subject: `US Department of Labor releases jobless claims report for week ending ${MONTH_NAMES[date.month - 1]} ${date.day}, ${date.year}`,
      detail: null,
      facts: { release_family: 'US_JOBLESS_CLAIMS', metrics },
    },
  };
}
