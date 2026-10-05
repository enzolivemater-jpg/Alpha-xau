/**
 * XAU V2 — pure US BEA Personal Income and Outlays / PCE adapter.
 *
 * The input is a reviewed projection of one immutable BEA news-release page.
 * Fetching, HTML parsing, persistence, runtime orchestration, consensus,
 * economic interpretation, and market inference are outside this module.
 */

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
    canonicalEventStateSchemaVersion: BEA_PCE_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
    canonicalEventState: {
      event_type: 'STATISTICAL_RELEASE',
      subject: `US Bureau of Economic Analysis releases ${monthName} ${year} PCE price indexes`,
      detail: null,
      facts: { release_family: 'US_PCE', metrics },
    },
  };
}
