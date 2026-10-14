/** Provider-independent Positioning P-0 evidence contract. No signal inference. */

import { parseStrictTimestamp } from '../shared/strict_timestamp.js';

export const POSITIONING_SCHEMA_VERSION = 'xau.positioning-evidence.v1' as const;
export const POSITIONING_ALGORITHM_VERSION = 'positioning-evidence-normalizer-1.0.0' as const;

export type PositioningUnit = 'CONTRACTS' | 'PERCENT' | 'RATIO' | 'INDEX';
export type PositioningEvidenceState = 'EVIDENCE_READY' | 'ABSTAIN';
export type PositioningReasonCode =
  | 'NO_POSITIONING_EVIDENCE'
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'INVALID_EVIDENCE_SHAPE'
  | 'INVALID_EVIDENCE_VALUE'
  | 'DUPLICATE_EVIDENCE_KEY'
  | 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'
  | 'METHODOLOGY_NOT_APPROVED';

export interface PositioningEvidenceInput {
  readonly sourceAuthority: string;
  readonly datasetCode: string;
  readonly instrumentCode: string;
  readonly metricCode: string;
  readonly value: number;
  readonly unit: PositioningUnit;
  readonly periodEnd: string;
  readonly publishedAt: string;
  readonly observedAt: string;
  readonly artifactId: string;
  readonly revision: string | null;
}

export interface PositioningEvidenceEnvelope {
  readonly schemaVersion: typeof POSITIONING_SCHEMA_VERSION;
  readonly algorithmVersion: typeof POSITIONING_ALGORITHM_VERSION;
  readonly evidenceState: PositioningEvidenceState;
  /** P-0 never infers crowdedness, direction, percentile or trade intent. */
  readonly positioningState: 'UNAVAILABLE';
  readonly reasonCodes: readonly PositioningReasonCode[];
  readonly knowledgeCutoff: string;
  readonly observedThrough: string | null;
  readonly sourceAuthorities: readonly string[];
  readonly evidence: readonly PositioningEvidenceInput[];
}

const INPUT_KEYS = [
  'artifactId', 'datasetCode', 'instrumentCode', 'metricCode', 'observedAt',
  'periodEnd', 'publishedAt', 'revision', 'sourceAuthority', 'unit', 'value',
] as const;
const UNITS = new Set<PositioningUnit>(['CONTRACTS', 'PERCENT', 'RATIO', 'INDEX']);
const CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const INSTRUMENT = /^[A-Z0-9][A-Z0-9_.:/-]{0,31}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function timestampMs(value: string): number | null {
  return parseStrictTimestamp(value);
}

function isCivilDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function exactInputShape(value: PositioningEvidenceInput): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === INPUT_KEYS.length && keys.every((key, index) => key === INPUT_KEYS[index]);
}

function evidenceKey(value: PositioningEvidenceInput): string {
  return [
    value.sourceAuthority, value.datasetCode, value.instrumentCode,
    value.metricCode, value.periodEnd, value.revision ?? '',
  ].join('\u001f');
}

/**
 * Code-unit order, independent of the host locale. `localeCompare` follows
 * ICU collation: it varies with the process locale and ignores the `\u001f`
 * key separator, so distinct identities could compare equal.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEvidence(a: PositioningEvidenceInput, b: PositioningEvidenceInput): number {
  return compareCodeUnits(evidenceKey(a), evidenceKey(b))
    || compareCodeUnits(a.publishedAt, b.publishedAt)
    || compareCodeUnits(a.observedAt, b.observedAt)
    || compareCodeUnits(a.artifactId, b.artifactId);
}

/** Same invariant as the persistence schema: evidence is retained after publication. */
function publishedNotAfterObserved(value: PositioningEvidenceInput): boolean {
  const published = timestampMs(value.publishedAt);
  const observed = timestampMs(value.observedAt);
  return published !== null && observed !== null && published <= observed;
}

function validShape(value: PositioningEvidenceInput): boolean {
  return exactInputShape(value)
    && CODE.test(value.sourceAuthority)
    && CODE.test(value.datasetCode)
    && INSTRUMENT.test(value.instrumentCode)
    && CODE.test(value.metricCode)
    && UNITS.has(value.unit)
    && isCivilDate(value.periodEnd)
    && publishedNotAfterObserved(value)
    && typeof value.artifactId === 'string'
    && value.artifactId.length > 0
    && value.artifactId.length <= 256
    && (value.revision === null
      || (typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 64));
}

/**
 * Validates and sorts retained positioning evidence at an explicit cutoff.
 * The result deliberately keeps `positioningState=UNAVAILABLE`: approving a
 * source is not the same decision as approving a directional methodology.
 */
export function buildPositioningEvidenceEnvelope(
  inputs: readonly PositioningEvidenceInput[],
  knowledgeCutoff: string,
): PositioningEvidenceEnvelope {
  const reasons = new Set<PositioningReasonCode>();
  const cutoffMs = timestampMs(knowledgeCutoff);
  if (cutoffMs === null) reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  if (inputs.length === 0) reasons.add('NO_POSITIONING_EVIDENCE');

  const seen = new Set<string>();
  const observedTimes: number[] = [];
  const validInputs: PositioningEvidenceInput[] = [];
  for (const input of inputs) {
    if (!validShape(input)) {
      reasons.add('INVALID_EVIDENCE_SHAPE');
      continue;
    }
    if (!Number.isFinite(input.value)) {
      reasons.add('INVALID_EVIDENCE_VALUE');
      continue;
    }
    validInputs.push(input);
    const key = evidenceKey(input);
    if (seen.has(key)) reasons.add('DUPLICATE_EVIDENCE_KEY');
    seen.add(key);

    const publishedMs = timestampMs(input.publishedAt);
    const observedMs = timestampMs(input.observedAt);
    if (observedMs !== null) observedTimes.push(observedMs);
    if (cutoffMs !== null && ((publishedMs !== null && publishedMs > cutoffMs)
      || (observedMs !== null && observedMs > cutoffMs))) {
      reasons.add('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF');
    }
  }

  reasons.add('METHODOLOGY_NOT_APPROVED');
  const blocking = [
    'NO_POSITIONING_EVIDENCE', 'INVALID_KNOWLEDGE_CUTOFF',
    'INVALID_EVIDENCE_SHAPE', 'INVALID_EVIDENCE_VALUE',
    'DUPLICATE_EVIDENCE_KEY', 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF',
  ] satisfies readonly PositioningReasonCode[];
  const ordered = [
    'NO_POSITIONING_EVIDENCE', 'INVALID_KNOWLEDGE_CUTOFF',
    'INVALID_EVIDENCE_SHAPE', 'INVALID_EVIDENCE_VALUE',
    'DUPLICATE_EVIDENCE_KEY', 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF',
    'METHODOLOGY_NOT_APPROVED',
  ] satisfies readonly PositioningReasonCode[];

  const evidence = validInputs.map((input) => ({ ...input })).sort(compareEvidence);
  return {
    schemaVersion: POSITIONING_SCHEMA_VERSION,
    algorithmVersion: POSITIONING_ALGORITHM_VERSION,
    evidenceState: blocking.some((reason) => reasons.has(reason)) ? 'ABSTAIN' : 'EVIDENCE_READY',
    positioningState: 'UNAVAILABLE',
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    observedThrough: observedTimes.length > 0
      ? new Date(Math.max(...observedTimes)).toISOString()
      : null,
    sourceAuthorities: [...new Set(validInputs.map((input) => input.sourceAuthority))].sort(),
    evidence,
  };
}
