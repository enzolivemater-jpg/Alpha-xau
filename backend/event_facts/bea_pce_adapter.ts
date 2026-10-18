/**
 * XAU V2 — pure US BEA Personal Income and Outlays / PCE adapter.
 *
 * The input is a reviewed projection of one immutable BEA news-release page.
 * Fetching, HTML parsing, persistence, runtime orchestration, consensus,
 * economic interpretation, and market inference are outside this module.
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

export const BEA_PCE_EVENT_FACTS_ADAPTER_VERSION =
  'bea-pce-event-facts-adapter-v1' as const;
export const BEA_PCE_IDENTITY_STRATEGY_VERSION =
  'bea_personal_income_outlays_v1' as const;
export const BEA_PCE_CANONICAL_EVENT_STATE_SCHEMA_VERSION = 2 as const;

interface MonthPeriod {
  readonly kind: 'MONTH';
  readonly year: number;
  readonly month: number;
}

interface PcePriceMetricProjection {
  readonly seriesLabel:
    | 'PCE price index'
    | 'PCE price index excluding food and energy';
  readonly changeBasis: 'PRECEDING_MONTH' | 'SAME_MONTH_YEAR_AGO';
  readonly valuePercent: number;
}

export interface BeaPceStructuredPayloadV1 {
  readonly source: {
    readonly authority: 'US_BEA';
    readonly provider: 'bea';
    readonly sourceCode: 'bea_personal_income_outlays_release';
    readonly sourceDomain: 'bea.gov';
  };
  readonly release: {
    readonly releaseFamily: 'US_PCE';
    readonly releaseStage: 'SINGLE';
    readonly releaseNumberRaw: string | null;
    readonly headerTitle: string | null;
    readonly publicReleaseAtRaw: string | null;
    readonly archivePath: string | null;
    readonly archiveSha256: string | null;
  };
  readonly summary: {
    readonly referencePeriod: MonthPeriod | null;
    readonly metrics: readonly PcePriceMetricProjection[] | null;
  };
}

export interface BeaPceReleaseIdentityProposal {
  readonly authorityNamespace: 'xau_v2:official_release:us_bea:v1';
  readonly identityType: 'official_release_id:bea_personal_income_outlays_v1';
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

export interface BeaPceCanonicalMetric {
  readonly metric_code:
    | 'PCE_CORE_MOM'
    | 'PCE_CORE_YOY'
    | 'PCE_HEADLINE_MOM'
    | 'PCE_HEADLINE_YOY';
  readonly reference_period: MonthPeriod;
  readonly unit: 'PERCENT_CHANGE_MOM' | 'PERCENT_CHANGE_YOY';
  readonly actual: KnownValue;
  readonly consensus: UnknownValue;
  readonly prior_periods: readonly [];
}

export interface BeaPceCanonicalEventStateV2 {
  readonly event_type: 'STATISTICAL_RELEASE';
  readonly subject: string;
  readonly detail: null;
  readonly facts: {
    readonly release_family: 'US_PCE';
    readonly metrics: readonly BeaPceCanonicalMetric[];
  };
}

export interface BeaPceResolvedResult {
  readonly kind: 'RESOLVED';
  readonly adapterVersion: typeof BEA_PCE_EVENT_FACTS_ADAPTER_VERSION;
  readonly releaseIdentity: BeaPceReleaseIdentityProposal;
  readonly canonicalEventStateSchemaVersion:
    typeof BEA_PCE_CANONICAL_EVENT_STATE_SCHEMA_VERSION;
  readonly canonicalEventState: BeaPceCanonicalEventStateV2;
  /** UTC instant stated by the release text; null when it cannot be read exactly (B3). */
  readonly publishedAt: string | null;
}

export interface BeaPceNonResolvedResult {
  readonly kind: 'UNAVAILABLE' | 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED';
  readonly adapterVersion: typeof BEA_PCE_EVENT_FACTS_ADAPTER_VERSION;
  readonly reason: string;
}

export type BeaPceAdapterResult = BeaPceResolvedResult | BeaPceNonResolvedResult;

const SOURCE_KEYS = ['authority', 'provider', 'sourceCode', 'sourceDomain'] as const;
const RELEASE_KEYS = [
  'archivePath', 'archiveSha256', 'headerTitle', 'publicReleaseAtRaw',
  'releaseFamily', 'releaseNumberRaw', 'releaseStage',
] as const;
const SUMMARY_KEYS = ['metrics', 'referencePeriod'] as const;
const PERIOD_KEYS = ['kind', 'month', 'year'] as const;
const METRIC_KEYS = ['changeBasis', 'seriesLabel', 'valuePercent'] as const;
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
  kind: BeaPceNonResolvedResult['kind'],
  reason: string,
): BeaPceNonResolvedResult {
  return { kind, adapterVersion: BEA_PCE_EVENT_FACTS_ADAPTER_VERSION, reason };
}

function canonicalOneDecimalPercent(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = Math.round(value * 10);
  if (!Number.isSafeInteger(scaled) || Math.abs(value * 10 - scaled) > 1e-9) return null;
  if (scaled === 0) return '0';
  const canonical = String(scaled / 10);
  return /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(canonical) ? canonical : null;
}

function canonicalReleaseId(raw: string): string {
  return raw.replace(/^BEA /, 'BEA-').replace('–', '-');
}

function canonicalIdentityValue(releaseId: string): string {
  return JSON.stringify({
    authority: 'us_bea',
    release_family: 'US_PCE',
    release_id: releaseId,
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: BEA_PCE_IDENTITY_STRATEGY_VERSION,
  });
}

function validateOuterShape(input: unknown): BeaPceNonResolvedResult | null {
  if (!isRecord(input) || !hasExactKeys(input, ['release', 'source', 'summary'])) {
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

export function resolveBeaPceReleaseIdentity(input: unknown):
  BeaPceReleaseIdentityProposal | BeaPceNonResolvedResult {
  const shapeError = validateOuterShape(input);
  if (shapeError !== null) return shapeError;
  const payload = input as unknown as BeaPceStructuredPayloadV1;
  if (
    payload.source.authority !== 'US_BEA'
    || payload.source.provider !== 'bea'
    || payload.source.sourceCode !== 'bea_personal_income_outlays_release'
    || payload.source.sourceDomain !== 'bea.gov'
    || payload.release.releaseFamily !== 'US_PCE'
    || payload.release.releaseStage !== 'SINGLE'
  ) {
    return nonResolved('UNSUPPORTED', 'UNSUPPORTED_SOURCE_FAMILY_OR_STAGE');
  }
  const raw = payload.release.releaseNumberRaw;
  if (raw === null) return nonResolved('UNAVAILABLE', 'OFFICIAL_RELEASE_NUMBER_UNAVAILABLE');
  if (typeof raw !== 'string' || !/^BEA \d{2}–\d{2}$/.test(raw)) {
    return nonResolved('MALFORMED', 'OFFICIAL_RELEASE_NUMBER_MALFORMED');
  }
  return {
    authorityNamespace: 'xau_v2:official_release:us_bea:v1',
    identityType: 'official_release_id:bea_personal_income_outlays_v1',
    identityValue: canonicalIdentityValue(canonicalReleaseId(raw)),
  };
}

export function mapBeaPceReleaseToEventFacts(input: unknown): BeaPceAdapterResult {
  const identity = resolveBeaPceReleaseIdentity(input);
  if ('kind' in identity) return identity;
  const payload = input as BeaPceStructuredPayloadV1;
  const { release, summary } = payload;

  if (
    release.headerTitle === null
    || release.publicReleaseAtRaw === null
    || release.archivePath === null
    || release.archiveSha256 === null
    || summary.referencePeriod === null
    || summary.metrics === null
  ) {
    return nonResolved('UNAVAILABLE', 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE');
  }
  if (
    typeof release.headerTitle !== 'string'
    || typeof release.publicReleaseAtRaw !== 'string'
    || typeof release.archivePath !== 'string'
    || typeof release.archiveSha256 !== 'string'
    || release.headerTitle.trim() !== release.headerTitle
    || release.publicReleaseAtRaw.trim() !== release.publicReleaseAtRaw
    || !/^[0-9a-f]{64}$/.test(release.archiveSha256)
    || !isRecord(summary.referencePeriod)
    || !hasExactKeys(summary.referencePeriod, PERIOD_KEYS)
    || !Array.isArray(summary.metrics)
  ) {
    return nonResolved('MALFORMED', 'OFFICIAL_EVIDENCE_MALFORMED');
  }

  const { year, month } = summary.referencePeriod;
  if (
    summary.referencePeriod.kind !== 'MONTH'
    || !Number.isInteger(year) || year < 1900 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12
  ) {
    return nonResolved('MALFORMED', 'REFERENCE_PERIOD_MALFORMED');
  }
  const monthName = MONTH_NAMES[month - 1];
  const expectedTitle = `Personal Income and Outlays, ${monthName} ${year}`;
  const expectedPath = `/news/${year}/personal-income-and-outlays-${monthName.toLowerCase()}-${year}`;
  if (release.headerTitle !== expectedTitle || release.archivePath !== expectedPath) {
    return nonResolved('CONFLICT', 'RELEASE_PERIOD_CONFLICT');
  }
  const releaseNumber = /^BEA (\d{2})–\d{2}$/.exec(release.releaseNumberRaw ?? '');
  const publication = /^EMBARGOED UNTIL RELEASE AT 8:30 a\.m\. E[DS]T, (?:Monday|Tuesday|Wednesday|Thursday|Friday), (?:January|February|March|April|May|June|July|August|September|October|November|December) (?:[1-9]|[12]\d|3[01]), (\d{4})$/.exec(
    release.publicReleaseAtRaw,
  );
  if (
    releaseNumber === null
    || publication === null
    || Number(publication[1]) < year
    || Number(publication[1]) > year + 1
    || Number(releaseNumber[1]) !== Number(publication[1]) % 100
  ) {
    return nonResolved('CONFLICT', 'RELEASE_ID_DATE_CONFLICT');
  }

  if (summary.metrics.length !== 4) {
    return nonResolved('MALFORMED', 'REQUIRED_METRICS_MISSING_OR_DUPLICATED');
  }
  const values = new Map<string, string>();
  for (const metric of summary.metrics) {
    if (!isRecord(metric) || !hasExactKeys(metric, METRIC_KEYS)
        || (metric.seriesLabel !== 'PCE price index'
          && metric.seriesLabel !== 'PCE price index excluding food and energy')
        || (metric.changeBasis !== 'PRECEDING_MONTH'
          && metric.changeBasis !== 'SAME_MONTH_YEAR_AGO')) {
      return nonResolved('MALFORMED', 'METRIC_SHAPE_MALFORMED');
    }
    const key = `${metric.seriesLabel}\u001f${metric.changeBasis}`;
    const value = canonicalOneDecimalPercent(metric.valuePercent);
    if (values.has(key)) {
      return nonResolved('MALFORMED', 'REQUIRED_METRICS_MISSING_OR_DUPLICATED');
    }
    if (value === null) return nonResolved('MALFORMED', 'METRIC_VALUE_MALFORMED');
    values.set(key, value);
  }

  const required = [
    ['PCE_CORE_MOM', 'PCE price index excluding food and energy', 'PRECEDING_MONTH', 'PERCENT_CHANGE_MOM'],
    ['PCE_CORE_YOY', 'PCE price index excluding food and energy', 'SAME_MONTH_YEAR_AGO', 'PERCENT_CHANGE_YOY'],
    ['PCE_HEADLINE_MOM', 'PCE price index', 'PRECEDING_MONTH', 'PERCENT_CHANGE_MOM'],
    ['PCE_HEADLINE_YOY', 'PCE price index', 'SAME_MONTH_YEAR_AGO', 'PERCENT_CHANGE_YOY'],
  ] as const;
  const referencePeriod = { kind: 'MONTH' as const, year, month };
  const consensus = { state: 'UNKNOWN' as const, value: null };
  const metrics: BeaPceCanonicalMetric[] = [];
  for (const [metricCode, seriesLabel, basis, unit] of required) {
    const value = values.get(`${seriesLabel}\u001f${basis}`);
    if (value === undefined) {
      return nonResolved('MALFORMED', 'REQUIRED_METRICS_MISSING_OR_DUPLICATED');
    }
    metrics.push({
      metric_code: metricCode,
      reference_period: referencePeriod,
      unit,
      actual: { state: 'KNOWN', value },
      consensus,
      prior_periods: [],
    });
  }

  return {
    kind: 'RESOLVED',
    adapterVersion: BEA_PCE_EVENT_FACTS_ADAPTER_VERSION,
    releaseIdentity: identity,
    publishedAt: officialReleaseInstantUtc(release.publicReleaseAtRaw),
    canonicalEventStateSchemaVersion: BEA_PCE_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
    canonicalEventState: {
      event_type: 'STATISTICAL_RELEASE',
      subject: `US Bureau of Economic Analysis releases ${monthName} ${year} PCE price indexes`,
      detail: null,
      facts: { release_family: 'US_PCE', metrics },
    },
  };
}
