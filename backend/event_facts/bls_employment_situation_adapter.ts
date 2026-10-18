/**
 * XAU V2 — pure US BLS Employment Situation / NFP release adapter.
 *
 * The input is a reviewed, lossless projection of one retained official BLS
 * Employment Situation release. Fetching, HTML parsing, persistence, identity
 * lookup, runtime orchestration, consensus enrichment, and CES activation are
 * deliberately outside this module.
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

export const BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION =
  'bls-employment-event-facts-adapter-v1' as const;
export const BLS_EMPLOYMENT_IDENTITY_STRATEGY_VERSION =
  'bls_employment_situation_v1' as const;
export const BLS_EMPLOYMENT_CANONICAL_EVENT_STATE_SCHEMA_VERSION = 2 as const;

interface MonthPeriod {
  readonly kind: 'MONTH';
  readonly year: number;
  readonly month: number;
}

interface PayrollRevision {
  readonly referencePeriod: MonthPeriod;
  readonly priorChangeThousands: number;
  readonly revisedChangeThousands: number;
}

export interface BlsEmploymentStructuredPayloadV1 {
  readonly source: {
    readonly authority: 'US_BLS';
    readonly provider: 'bls';
    readonly sourceCode: 'bls_employment_situation_release';
    readonly sourceDomain: 'bls.gov';
  };
  readonly release: {
    readonly releaseFamily: 'US_NFP';
    readonly releaseStage: 'SINGLE';
    readonly releaseId: string | null;
    readonly headerTitle: string | null;
    readonly publicReleaseAtRaw: string | null;
    readonly archivePath: string | null;
  };
  readonly summary: {
    readonly artifactPath: string | null;
    readonly referencePeriod: MonthPeriod | null;
    readonly payroll: {
      readonly seriesId: 'CES0000000001';
      readonly currentChangeThousands: number;
      readonly priorRevisions: readonly PayrollRevision[] | null;
    } | null;
    readonly unemploymentRate: {
      readonly seriesId: 'LNS14000000';
      readonly levelPercent: number;
    } | null;
    readonly averageHourlyEarningsMom: {
      readonly seriesId: 'CES0500000003';
      readonly monthOverMonthPercent: number;
    } | null;
  };
}

export interface BlsEmploymentReleaseIdentityProposal {
  readonly authorityNamespace: 'xau_v2:official_release:us_bls:v1';
  readonly identityType: 'official_release_id:bls_employment_situation_v1';
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
  readonly reference_period: MonthPeriod;
  readonly prior_value: KnownValue;
  readonly revised_value: KnownValue;
}

export interface BlsEmploymentCanonicalMetric {
  readonly metric_code:
    | 'AVG_HOURLY_EARNINGS_MOM'
    | 'NFP_PAYROLL_CHANGE'
    | 'UNEMPLOYMENT_RATE';
  readonly reference_period: MonthPeriod;
  readonly unit: 'PERCENT_CHANGE_MOM' | 'THOUSANDS_OF_PERSONS' | 'LEVEL_PERCENT';
  readonly actual: KnownValue;
  readonly consensus: UnknownValue;
  readonly prior_periods: readonly CanonicalPriorPeriod[];
}

export interface BlsEmploymentCanonicalEventStateV2 {
  readonly event_type: 'STATISTICAL_RELEASE';
  readonly subject: string;
  readonly detail: null;
  readonly facts: {
    readonly release_family: 'US_NFP';
    readonly metrics: readonly BlsEmploymentCanonicalMetric[];
  };
}

export interface BlsEmploymentResolvedResult {
  readonly kind: 'RESOLVED';
  readonly adapterVersion: typeof BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION;
  readonly releaseIdentity: BlsEmploymentReleaseIdentityProposal;
  readonly canonicalEventStateSchemaVersion:
    typeof BLS_EMPLOYMENT_CANONICAL_EVENT_STATE_SCHEMA_VERSION;
  readonly canonicalEventState: BlsEmploymentCanonicalEventStateV2;
  /** UTC instant stated by the release text; null when it cannot be read exactly (B3). */
  readonly publishedAt: string | null;
}

export interface BlsEmploymentNonResolvedResult {
  readonly kind: 'UNAVAILABLE' | 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED';
  readonly adapterVersion: typeof BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION;
  readonly reason: string;
}

export type BlsEmploymentAdapterResult =
  | BlsEmploymentResolvedResult
  | BlsEmploymentNonResolvedResult;

const SOURCE_KEYS = ['authority', 'provider', 'sourceCode', 'sourceDomain'] as const;
const RELEASE_KEYS = [
  'releaseFamily', 'releaseStage', 'releaseId', 'headerTitle',
  'publicReleaseAtRaw', 'archivePath',
] as const;
const SUMMARY_KEYS = [
  'artifactPath', 'referencePeriod', 'payroll', 'unemploymentRate',
  'averageHourlyEarningsMom',
] as const;
const PERIOD_KEYS = ['kind', 'year', 'month'] as const;
const PAYROLL_KEYS = ['seriesId', 'currentChangeThousands', 'priorRevisions'] as const;
const REVISION_KEYS = [
  'referencePeriod', 'priorChangeThousands', 'revisedChangeThousands',
] as const;
const RATE_KEYS = ['seriesId', 'levelPercent'] as const;
const AHE_KEYS = ['seriesId', 'monthOverMonthPercent'] as const;
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
  kind: BlsEmploymentNonResolvedResult['kind'],
  reason: string,
): BlsEmploymentNonResolvedResult {
  return { kind, adapterVersion: BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION, reason };
}

function validMonthPeriod(value: unknown): value is MonthPeriod {
  if (!isRecord(value) || !hasExactKeys(value, PERIOD_KEYS)) return false;
  return value.kind === 'MONTH'
    && Number.isInteger(value.year) && Number(value.year) >= 1900 && Number(value.year) <= 9999
    && Number.isInteger(value.month) && Number(value.month) >= 1 && Number(value.month) <= 12;
}

function monthIndex(period: MonthPeriod): number {
  return period.year * 12 + period.month - 1;
}

function periodFromIndex(index: number): MonthPeriod {
  return {
    kind: 'MONTH',
    year: Math.floor(index / 12),
    month: index % 12 + 1,
  };
}

function canonicalInteger(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value === 0 ? '0' : String(value);
}

function canonicalOneDecimal(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = Math.round(value * 10);
  if (!Number.isSafeInteger(scaled) || Math.abs(value * 10 - scaled) > 1e-9) return null;
  return scaled === 0 ? '0' : String(scaled / 10);
}

function canonicalIdentityValue(releaseId: string): string {
  return JSON.stringify({
    authority: 'us_bls',
    release_family: 'US_NFP',
    release_id: releaseId,
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: BLS_EMPLOYMENT_IDENTITY_STRATEGY_VERSION,
  });
}

function validateOuterShape(input: unknown): BlsEmploymentNonResolvedResult | null {
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

export function resolveBlsEmploymentReleaseIdentity(input: unknown):
  BlsEmploymentReleaseIdentityProposal | BlsEmploymentNonResolvedResult {
  const shapeError = validateOuterShape(input);
  if (shapeError !== null) return shapeError;
  const payload = input as unknown as BlsEmploymentStructuredPayloadV1;
  if (
    payload.source.authority !== 'US_BLS'
    || payload.source.provider !== 'bls'
    || payload.source.sourceCode !== 'bls_employment_situation_release'
    || payload.source.sourceDomain !== 'bls.gov'
    || payload.release.releaseFamily !== 'US_NFP'
    || payload.release.releaseStage !== 'SINGLE'
  ) {
    return nonResolved('UNSUPPORTED', 'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE');
  }
  if (payload.release.releaseId === null) {
    return nonResolved('UNAVAILABLE', 'OFFICIAL_RELEASE_ID_UNAVAILABLE');
  }
  if (typeof payload.release.releaseId !== 'string'
      || !/^USDL-\d{2}-\d{4}$/.test(payload.release.releaseId)) {
    return nonResolved('MALFORMED', 'OFFICIAL_RELEASE_ID_MALFORMED');
  }
  return {
    authorityNamespace: 'xau_v2:official_release:us_bls:v1',
    identityType: 'official_release_id:bls_employment_situation_v1',
    identityValue: canonicalIdentityValue(payload.release.releaseId),
  };
}

export function mapBlsEmploymentReleaseToEventFacts(input: unknown):
  BlsEmploymentAdapterResult {
  const identity = resolveBlsEmploymentReleaseIdentity(input);
  if ('kind' in identity) return identity;
  const payload = input as BlsEmploymentStructuredPayloadV1;
  const { release, summary } = payload;

  if (
    release.headerTitle === null
    || release.publicReleaseAtRaw === null
    || release.archivePath === null
    || summary.artifactPath === null
    || summary.referencePeriod === null
    || summary.payroll === null
    || summary.unemploymentRate === null
    || summary.averageHourlyEarningsMom === null
    // `payroll` may be absent (undefined): the shape check below reports it.
    || summary.payroll?.priorRevisions === null
  ) {
    return nonResolved('UNAVAILABLE', 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE');
  }
  if (
    typeof release.headerTitle !== 'string' || release.headerTitle.trim() !== release.headerTitle
    || release.headerTitle.length === 0
    || typeof release.publicReleaseAtRaw !== 'string'
    || release.publicReleaseAtRaw.trim() !== release.publicReleaseAtRaw
    || release.publicReleaseAtRaw.length === 0
    || typeof release.archivePath !== 'string'
    || typeof summary.artifactPath !== 'string'
    || !validMonthPeriod(summary.referencePeriod)
    || !isRecord(summary.payroll) || !hasExactKeys(summary.payroll, PAYROLL_KEYS)
    || !isRecord(summary.unemploymentRate)
    || !hasExactKeys(summary.unemploymentRate, RATE_KEYS)
    || !isRecord(summary.averageHourlyEarningsMom)
    || !hasExactKeys(summary.averageHourlyEarningsMom, AHE_KEYS)
    || !Array.isArray(summary.payroll.priorRevisions)
  ) {
    return nonResolved('MALFORMED', 'OFFICIAL_EVIDENCE_MALFORMED');
  }
  if (!/^\/news\.release\/archives\/empsit_\d{8}\.htm$/.test(release.archivePath)) {
    return nonResolved('MALFORMED', 'RELEASE_ARCHIVE_PATH_MALFORMED');
  }

  const reference = summary.referencePeriod;
  const expectedTitle = `THE EMPLOYMENT SITUATION - ${MONTH_NAMES[reference.month - 1].toUpperCase()} ${reference.year}`;
  if (release.headerTitle !== expectedTitle || summary.artifactPath !== release.archivePath) {
    return nonResolved('CONFLICT', 'RELEASE_SUMMARY_PERIOD_CONFLICT');
  }
  if (
    summary.payroll.seriesId !== 'CES0000000001'
    || summary.unemploymentRate.seriesId !== 'LNS14000000'
    || summary.averageHourlyEarningsMom.seriesId !== 'CES0500000003'
  ) {
    return nonResolved('UNSUPPORTED', 'UNSUPPORTED_SERIES_MAPPING');
  }

  const payrollValue = canonicalInteger(summary.payroll.currentChangeThousands);
  const unemploymentValue = canonicalOneDecimal(summary.unemploymentRate.levelPercent);
  const earningsValue = canonicalOneDecimal(
    summary.averageHourlyEarningsMom.monthOverMonthPercent,
  );
  if (payrollValue === null || unemploymentValue === null || earningsValue === null) {
    return nonResolved('MALFORMED', 'REQUIRED_SUMMARY_VALUE_MALFORMED');
  }
  if (summary.payroll.priorRevisions.length !== 2) {
    return nonResolved('UNAVAILABLE', 'TWO_PRIOR_PAYROLL_REVISIONS_REQUIRED');
  }

  const revisions: { period: MonthPeriod; prior: string; revised: string }[] = [];
  for (const revision of summary.payroll.priorRevisions) {
    if (!isRecord(revision) || !hasExactKeys(revision, REVISION_KEYS)
        || !validMonthPeriod(revision.referencePeriod)) {
      return nonResolved('MALFORMED', 'PAYROLL_REVISION_SHAPE_MALFORMED');
    }
    const prior = canonicalInteger(revision.priorChangeThousands);
    const revised = canonicalInteger(revision.revisedChangeThousands);
    if (prior === null || revised === null) {
      return nonResolved('MALFORMED', 'PAYROLL_REVISION_VALUE_MALFORMED');
    }
    revisions.push({ period: revision.referencePeriod, prior, revised });
  }
  revisions.sort((left, right) => monthIndex(left.period) - monthIndex(right.period));
  const currentIndex = monthIndex(reference);
  const requiredPeriods = [periodFromIndex(currentIndex - 2), periodFromIndex(currentIndex - 1)];
  if (!revisions.every((revision, index) =>
    monthIndex(revision.period) === monthIndex(requiredPeriods[index]))) {
    return nonResolved('CONFLICT', 'PAYROLL_REVISION_PERIOD_CONFLICT');
  }

  const consensus = { state: 'UNKNOWN' as const, value: null };
  const referencePeriod = { ...reference };
  const payrollPriorPeriods: readonly CanonicalPriorPeriod[] = revisions.map(revision => ({
    reference_period: { ...revision.period },
    prior_value: { state: 'KNOWN', value: revision.prior },
    revised_value: { state: 'KNOWN', value: revision.revised },
  }));
  const metrics: readonly BlsEmploymentCanonicalMetric[] = [
    {
      metric_code: 'AVG_HOURLY_EARNINGS_MOM',
      reference_period: referencePeriod,
      unit: 'PERCENT_CHANGE_MOM',
      actual: { state: 'KNOWN', value: earningsValue },
      consensus,
      prior_periods: [],
    },
    {
      metric_code: 'NFP_PAYROLL_CHANGE',
      reference_period: referencePeriod,
      unit: 'THOUSANDS_OF_PERSONS',
      actual: { state: 'KNOWN', value: payrollValue },
      consensus,
      prior_periods: payrollPriorPeriods,
    },
    {
      metric_code: 'UNEMPLOYMENT_RATE',
      reference_period: referencePeriod,
      unit: 'LEVEL_PERCENT',
      actual: { state: 'KNOWN', value: unemploymentValue },
      consensus,
      prior_periods: [],
    },
  ];

  const monthName = MONTH_NAMES[reference.month - 1];
  return {
    kind: 'RESOLVED',
    adapterVersion: BLS_EMPLOYMENT_EVENT_FACTS_ADAPTER_VERSION,
    releaseIdentity: identity,
    publishedAt: officialReleaseInstantUtc(release.publicReleaseAtRaw),
    canonicalEventStateSchemaVersion:
      BLS_EMPLOYMENT_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
    canonicalEventState: {
      event_type: 'STATISTICAL_RELEASE',
      subject: `US Bureau of Labor Statistics releases ${monthName} ${reference.year} Employment Situation`,
      detail: null,
      facts: { release_family: 'US_NFP', metrics },
    },
  };
}
