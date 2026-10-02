/**
 * XAU V2 — pure US DOL weekly unemployment-insurance claims adapter.
 *
 * The input is a reviewed, lossless projection of one retained official DOL
 * weekly claims release. Fetching, PDF parsing, persistence, identity lookup,
 * runtime orchestration, consensus enrichment, and CES activation are outside
 * this module.
 */

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
