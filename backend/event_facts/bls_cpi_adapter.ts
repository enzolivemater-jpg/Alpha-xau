/**
 * XAU V2 EF-2 — pure US BLS CPI release adapter.
 *
 * This module consumes a reviewed, lossless projection of two official BLS
 * artifacts: the archived CPI news-release header and the matching archived
 * News Release Table 1 XLSX. Fetching, XLSX parsing, persistence, identity
 * claim lookup, runtime orchestration, and CES V2 activation are deliberately
 * outside this module.
 */

export const BLS_CPI_EVENT_FACTS_ADAPTER_VERSION =
  'bls-cpi-event-facts-adapter-v1' as const;
export const BLS_CPI_IDENTITY_STRATEGY_VERSION = 'bls_cpi_v1' as const;
export const BLS_CPI_CANONICAL_EVENT_STATE_SCHEMA_VERSION = 2 as const;

export interface BlsCpiStructuredPayloadV1 {
  readonly source: {
    readonly authority: 'US_BLS';
    readonly provider: 'bls';
    readonly sourceCode: 'bls_cpi_release';
    readonly sourceDomain: 'bls.gov';
  };
  readonly release: {
    readonly releaseFamily: 'US_CPI';
    readonly releaseStage: 'SINGLE';
    readonly releaseId: string | null;
    readonly headerTitle: string | null;
    readonly publicReleaseAtRaw: string | null;
    readonly archivePath: string | null;
  };
  readonly table1: {
    readonly artifactPath: string | null;
    readonly tableTitle: string | null;
    readonly referencePeriod: {
      readonly kind: 'MONTH';
      readonly year: number;
      readonly month: number;
    } | null;
    readonly columns: {
      readonly unadjustedYoY: string | null;
      readonly seasonallyAdjustedMoM: string | null;
    };
    readonly rows: readonly {
      readonly expenditureCategory: string;
      readonly unadjustedYoY: number;
      readonly seasonallyAdjustedMoM: number;
    }[] | null;
  };
}

export interface ReleaseIdentityProposal {
  readonly authorityNamespace: 'xau_v2:official_release:us_bls:v1';
  readonly identityType: 'official_release_id:bls_cpi_v1';
  readonly identityValue: string;
}

export interface CanonicalKnownValue {
  readonly state: 'KNOWN';
  readonly value: string;
}

export interface CanonicalUnknownValue {
  readonly state: 'UNKNOWN';
  readonly value: null;
}

export interface BlsCpiCanonicalMetric {
  readonly metric_code:
    | 'CPI_HEADLINE_MOM'
    | 'CPI_HEADLINE_YOY'
    | 'CPI_CORE_MOM'
    | 'CPI_CORE_YOY';
  readonly reference_period: {
    readonly kind: 'MONTH';
    readonly year: number;
    readonly month: number;
  };
  readonly unit: 'PERCENT_CHANGE_MOM' | 'PERCENT_CHANGE_YOY';
  readonly actual: CanonicalKnownValue;
  readonly consensus: CanonicalUnknownValue;
  readonly prior_periods: readonly [];
}

export interface BlsCpiCanonicalEventStateV2 {
  readonly event_type: 'STATISTICAL_RELEASE';
  readonly subject: string;
  readonly detail: null;
  readonly facts: {
    readonly release_family: 'US_CPI';
    readonly metrics: readonly BlsCpiCanonicalMetric[];
  };
}

export interface BlsCpiResolvedResult {
  readonly kind: 'RESOLVED';
  readonly adapterVersion: typeof BLS_CPI_EVENT_FACTS_ADAPTER_VERSION;
  readonly releaseIdentity: ReleaseIdentityProposal;
  readonly canonicalEventStateSchemaVersion:
    typeof BLS_CPI_CANONICAL_EVENT_STATE_SCHEMA_VERSION;
  readonly canonicalEventState: BlsCpiCanonicalEventStateV2;
}

export interface BlsCpiNonResolvedResult {
  readonly kind: 'UNAVAILABLE' | 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED';
  readonly adapterVersion: typeof BLS_CPI_EVENT_FACTS_ADAPTER_VERSION;
  readonly reason: string;
}

export type BlsCpiAdapterResult = BlsCpiResolvedResult | BlsCpiNonResolvedResult;

const SOURCE_KEYS = ['authority', 'provider', 'sourceCode', 'sourceDomain'] as const;
const RELEASE_KEYS = [
  'releaseFamily', 'releaseStage', 'releaseId', 'headerTitle',
  'publicReleaseAtRaw', 'archivePath',
] as const;
const TABLE_KEYS = [
  'artifactPath', 'tableTitle', 'referencePeriod', 'columns', 'rows',
] as const;
const PERIOD_KEYS = ['kind', 'year', 'month'] as const;
const COLUMN_KEYS = ['unadjustedYoY', 'seasonallyAdjustedMoM'] as const;
const ROW_KEYS = ['expenditureCategory', 'unadjustedYoY', 'seasonallyAdjustedMoM'] as const;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const MONTH_ABBREVIATIONS = [
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.',
  'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.',
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
  kind: BlsCpiNonResolvedResult['kind'],
  reason: string,
): BlsCpiNonResolvedResult {
  return { kind, adapterVersion: BLS_CPI_EVENT_FACTS_ADAPTER_VERSION, reason };
}

function isNullOrNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.trim() === value);
}

function canonicalOneDecimalCell(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = Math.round(value * 10);
  if (!Number.isSafeInteger(scaled) || Math.abs(value * 10 - scaled) > 1e-9) return null;
  if (scaled === 0) return '0';
  const canonical = String(scaled / 10);
  return /^-?(0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(canonical)
    ? canonical
    : null;
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function expectedArtifactPath(year: number, month: number): string {
  return `/cpi/tables/supplemental-files/news-release-table1-${year}${String(month).padStart(2, '0')}.xlsx`;
}

function canonicalIdentityValue(releaseId: string): string {
  // Keys are deliberately written in lexicographic order per EF-1.
  return JSON.stringify({
    authority: 'us_bls',
    release_family: 'US_CPI',
    release_id: releaseId,
    release_stage: 'SINGLE',
    strategy: 'OFFICIAL_RELEASE_ID',
    strategy_version: BLS_CPI_IDENTITY_STRATEGY_VERSION,
  });
}

function validateOuterShape(input: unknown): BlsCpiNonResolvedResult | null {
  if (!isRecord(input) || !hasExactKeys(input, ['source', 'release', 'table1'])) {
    return nonResolved('MALFORMED', 'INVALID_PAYLOAD_SHAPE');
  }
  if (!isRecord(input.source) || !hasExactKeys(input.source, SOURCE_KEYS)) {
    return nonResolved('MALFORMED', 'INVALID_SOURCE_SHAPE');
  }
  if (!isRecord(input.release) || !hasExactKeys(input.release, RELEASE_KEYS)) {
    return nonResolved('MALFORMED', 'INVALID_RELEASE_SHAPE');
  }
  if (!isRecord(input.table1) || !hasExactKeys(input.table1, TABLE_KEYS)) {
    return nonResolved('MALFORMED', 'INVALID_TABLE1_SHAPE');
  }
  return null;
}

export function resolveBlsCpiReleaseIdentity(input: unknown):
  ReleaseIdentityProposal | BlsCpiNonResolvedResult {
  const shapeError = validateOuterShape(input);
  if (shapeError !== null) return shapeError;
  const payload = input as unknown as BlsCpiStructuredPayloadV1;

  if (
    payload.source.authority !== 'US_BLS'
    || payload.source.provider !== 'bls'
    || payload.source.sourceCode !== 'bls_cpi_release'
    || payload.source.sourceDomain !== 'bls.gov'
    || payload.release.releaseFamily !== 'US_CPI'
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
    identityType: 'official_release_id:bls_cpi_v1',
    identityValue: canonicalIdentityValue(payload.release.releaseId),
  };
}

export function mapBlsCpiReleaseToEventFacts(input: unknown): BlsCpiAdapterResult {
  const identity = resolveBlsCpiReleaseIdentity(input);
  if ('kind' in identity) return identity;
  const payload = input as BlsCpiStructuredPayloadV1;
  const { release, table1 } = payload;

  if (!isRecord(table1.columns) || !hasExactKeys(table1.columns, COLUMN_KEYS)) {
    return nonResolved('MALFORMED', 'OFFICIAL_EVIDENCE_MALFORMED');
  }
  if (
    release.headerTitle === null
    || release.publicReleaseAtRaw === null
    || release.archivePath === null
    || table1.artifactPath === null
    || table1.tableTitle === null
    || table1.referencePeriod === null
    || table1.columns.unadjustedYoY === null
    || table1.columns.seasonallyAdjustedMoM === null
    || table1.rows === null
  ) {
    return nonResolved('UNAVAILABLE', 'REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE');
  }
  if (
    !isNullOrNonEmptyString(release.headerTitle)
    || !isNullOrNonEmptyString(release.publicReleaseAtRaw)
    || !isNullOrNonEmptyString(release.archivePath)
    || !isNullOrNonEmptyString(table1.artifactPath)
    || !isNullOrNonEmptyString(table1.tableTitle)
    || !isRecord(table1.referencePeriod)
    || !hasExactKeys(table1.referencePeriod, PERIOD_KEYS)
    || !Array.isArray(table1.rows)
  ) {
    return nonResolved('MALFORMED', 'OFFICIAL_EVIDENCE_MALFORMED');
  }

  const { year, month } = table1.referencePeriod;
  if (
    table1.referencePeriod.kind !== 'MONTH'
    || !Number.isInteger(year)
    || year < 1900
    || year > 9999
    || !Number.isInteger(month)
    || month < 1
    || month > 12
  ) {
    return nonResolved('MALFORMED', 'REFERENCE_PERIOD_MALFORMED');
  }
  if (!/^\/news\.release\/archives\/cpi_\d{8}\.htm$/.test(release.archivePath)) {
    return nonResolved('MALFORMED', 'RELEASE_ARCHIVE_PATH_MALFORMED');
  }

  const monthName = MONTH_NAMES[month - 1];
  const monthAbbreviation = MONTH_ABBREVIATIONS[month - 1];
  const previous = previousMonth(year, month);
  const previousAbbreviation = MONTH_ABBREVIATIONS[previous.month - 1];
  const expectedReleaseTitle = `CONSUMER PRICE INDEX - ${monthName.toUpperCase()} ${year}`;
  const expectedTableTitle = 'Table 1. Consumer Price Index for All Urban Consumers (CPI-U): '
    + `U.S. city average, by expenditure category, ${monthName} ${year}`;
  const expectedYoY = `${monthAbbreviation} ${year - 1}-${monthAbbreviation} ${year}`;
  const expectedMoM = `${previousAbbreviation} ${previous.year}-${monthAbbreviation} ${year}`;

  if (
    release.headerTitle !== expectedReleaseTitle
    || table1.tableTitle !== expectedTableTitle
    || table1.artifactPath !== expectedArtifactPath(year, month)
    || table1.columns.unadjustedYoY !== expectedYoY
    || table1.columns.seasonallyAdjustedMoM !== expectedMoM
  ) {
    return nonResolved('CONFLICT', 'RELEASE_TABLE_PERIOD_CONFLICT');
  }
  if (table1.rows.length !== 2) {
    return nonResolved('MALFORMED', 'REQUIRED_TABLE_ROWS_MALFORMED');
  }
  for (const row of table1.rows) {
    if (!isRecord(row) || !hasExactKeys(row, ROW_KEYS)) {
      return nonResolved('MALFORMED', 'TABLE_ROW_SHAPE_MALFORMED');
    }
  }
  const headlineRows = table1.rows.filter(row => row.expenditureCategory === 'All items');
  const coreRows = table1.rows.filter(
    row => row.expenditureCategory === 'All items less food and energy',
  );
  if (headlineRows.length !== 1 || coreRows.length !== 1) {
    return nonResolved('MALFORMED', 'REQUIRED_TABLE_ROWS_MISSING_OR_DUPLICATED');
  }

  const headlineMoM = canonicalOneDecimalCell(headlineRows[0].seasonallyAdjustedMoM);
  const headlineYoY = canonicalOneDecimalCell(headlineRows[0].unadjustedYoY);
  const coreMoM = canonicalOneDecimalCell(coreRows[0].seasonallyAdjustedMoM);
  const coreYoY = canonicalOneDecimalCell(coreRows[0].unadjustedYoY);
  if (headlineMoM === null || headlineYoY === null || coreMoM === null || coreYoY === null) {
    return nonResolved('MALFORMED', 'REQUIRED_TABLE_VALUE_MALFORMED');
  }

  const referencePeriod = { kind: 'MONTH' as const, year, month };
  const consensus = { state: 'UNKNOWN' as const, value: null };
  const priorPeriods = [] as const;
  const metrics: readonly BlsCpiCanonicalMetric[] = [
    {
      metric_code: 'CPI_CORE_MOM',
      reference_period: referencePeriod,
      unit: 'PERCENT_CHANGE_MOM',
      actual: { state: 'KNOWN', value: coreMoM },
      consensus,
      prior_periods: priorPeriods,
    },
    {
      metric_code: 'CPI_CORE_YOY',
      reference_period: referencePeriod,
      unit: 'PERCENT_CHANGE_YOY',
      actual: { state: 'KNOWN', value: coreYoY },
      consensus,
      prior_periods: priorPeriods,
    },
    {
      metric_code: 'CPI_HEADLINE_MOM',
      reference_period: referencePeriod,
      unit: 'PERCENT_CHANGE_MOM',
      actual: { state: 'KNOWN', value: headlineMoM },
      consensus,
      prior_periods: priorPeriods,
    },
    {
      metric_code: 'CPI_HEADLINE_YOY',
      reference_period: referencePeriod,
      unit: 'PERCENT_CHANGE_YOY',
      actual: { state: 'KNOWN', value: headlineYoY },
      consensus,
      prior_periods: priorPeriods,
    },
  ];

  return {
    kind: 'RESOLVED',
    adapterVersion: BLS_CPI_EVENT_FACTS_ADAPTER_VERSION,
    releaseIdentity: identity,
    canonicalEventStateSchemaVersion: BLS_CPI_CANONICAL_EVENT_STATE_SCHEMA_VERSION,
    canonicalEventState: {
      event_type: 'STATISTICAL_RELEASE',
      subject: `US Bureau of Labor Statistics releases ${monthName} ${year} Consumer Price Index`,
      detail: null,
      facts: { release_family: 'US_CPI', metrics },
    },
  };
}
