/**
 * XAU V2 — pure US BLS Employment Situation / NFP release adapter.
 *
 * The input is a reviewed, lossless projection of one retained official BLS
 * Employment Situation release. Fetching, HTML parsing, persistence, identity
 * lookup, runtime orchestration, consensus enrichment, and CES activation are
 * deliberately outside this module.
 */

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
    || summary.payroll.priorRevisions === null
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
