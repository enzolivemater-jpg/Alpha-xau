/**
 * Consensus evidence contract C-0 (OFFLINE, provider-neutral). No source,
 * provider or methodology is approved, so consensus stays UNKNOWN.
 *
 * Event Impact V2 and Gold Transmission V2 stop at CONSENSUS_FACTS_UNAVAILABLE:
 * every official metric carries `consensus: { state: 'UNKNOWN', value: null }`.
 * C-0 defines what a consensus figure must prove before it could ever be used,
 * checked against the RESOLVED official adapter result it claims to forecast:
 * - the same release (identity type and value), metric, reference period and unit;
 * - published strictly before the official release instant (a figure published
 *   at or after the release is not a forecast) and retrieved after publication;
 * - known at the knowledge cutoff (published and retrieved not after it);
 * - one figure per source, dataset, statistic, metric, period and revision.
 * Valid figures are kept and counted per metric; the envelope still abstains
 * with CONSENSUS_SOURCE_NOT_APPROVED and CONSENSUS_METHODOLOGY_NOT_APPROVED,
 * every metric's consensus stays UNKNOWN and no surprise (actual minus
 * consensus) is ever computed. Pure: no clock, network, database or environment.
 */

import { isStrictTimestamp, isStrictlyAfter } from '../shared/strict_timestamp.js';

export const CONSENSUS_EVIDENCE_SCHEMA_VERSION = 'xau.consensus-evidence.v1' as const;
export const CONSENSUS_EVIDENCE_ALGORITHM_VERSION = 'consensus-evidence-normalizer-1.0.0' as const;

export type ConsensusReasonCode =
  | 'RELEASE_NOT_RESOLVED'
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'NO_CONSENSUS_EVIDENCE'
  | 'INVALID_EVIDENCE_SHAPE'
  | 'RELEASE_IDENTITY_MISMATCH'
  | 'METRIC_NOT_IN_RELEASE'
  | 'REFERENCE_PERIOD_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'CONSENSUS_NOT_BEFORE_RELEASE'
  | 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'
  | 'DUPLICATE_EVIDENCE_KEY'
  | 'CONSENSUS_SOURCE_NOT_APPROVED'
  | 'CONSENSUS_METHODOLOGY_NOT_APPROVED';

export type ConsensusReferencePeriod =
  | { readonly kind: 'MONTH'; readonly year: number; readonly month: number }
  | { readonly kind: 'WEEK_ENDING'; readonly date: string };

export interface ConsensusEvidenceInput {
  readonly sourceAuthority: string;
  readonly datasetCode: string;
  readonly statistic: 'MEDIAN' | 'MEAN';
  readonly releaseIdentityType: string;
  readonly releaseIdentityValue: string;
  readonly metricCode: string;
  readonly referencePeriod: ConsensusReferencePeriod;
  readonly unit: string;
  /** Decimal text in the official metric's unit, as the official `actual` is written. */
  readonly value: string;
  readonly publishedAt: string;
  readonly observedAt: string;
  readonly artifactId: string;
  readonly revision: string | null;
}

export interface ConsensusMetricView {
  readonly metricCode: string;
  readonly referencePeriod: ConsensusReferencePeriod;
  readonly unit: string;
  /** Always UNKNOWN in C-0, whatever the evidence. */
  readonly consensus: { readonly state: 'UNKNOWN'; readonly value: null };
  readonly validEvidenceCount: number;
}

export interface ConsensusEvidenceEnvelope {
  readonly schemaVersion: typeof CONSENSUS_EVIDENCE_SCHEMA_VERSION;
  readonly algorithmVersion: typeof CONSENSUS_EVIDENCE_ALGORITHM_VERSION;
  readonly evidenceState: 'ABSTAIN';
  readonly consensusState: 'UNKNOWN';
  readonly reasonCodes: readonly ConsensusReasonCode[];
  readonly knowledgeCutoff: string;
  readonly releasePublishedAt: string | null;
  readonly metrics: readonly ConsensusMetricView[];
  /** Valid figures, in code-unit order of their identity. */
  readonly evidence: readonly ConsensusEvidenceInput[];
  /** Index (in the input) and reason of every refused figure. */
  readonly refused: readonly { readonly index: number; readonly reason: ConsensusReasonCode }[];
}

const KEYS = ['artifactId', 'datasetCode', 'metricCode', 'observedAt', 'publishedAt', 'referencePeriod', 'releaseIdentityType',
  'releaseIdentityValue', 'revision', 'sourceAuthority', 'statistic', 'unit', 'value'] as const;
const CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const METRIC = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECIMAL = /^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
const ARTIFACT = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ORDER: readonly ConsensusReasonCode[] = [
  'RELEASE_NOT_RESOLVED', 'INVALID_KNOWLEDGE_CUTOFF', 'NO_CONSENSUS_EVIDENCE', 'INVALID_EVIDENCE_SHAPE',
  'RELEASE_IDENTITY_MISMATCH', 'METRIC_NOT_IN_RELEASE', 'REFERENCE_PERIOD_MISMATCH', 'UNIT_MISMATCH',
  'CONSENSUS_NOT_BEFORE_RELEASE', 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF', 'DUPLICATE_EVIDENCE_KEY',
  'CONSENSUS_SOURCE_NOT_APPROVED', 'CONSENSUS_METHODOLOGY_NOT_APPROVED',
];

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const exactKeys = (value: Rec, keys: readonly string[]) => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === [...keys].sort()[i]);
};

function civilDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function validPeriod(value: unknown): value is ConsensusReferencePeriod {
  if (!isRecord(value)) return false;
  if (value.kind === 'MONTH') {
    return exactKeys(value, ['kind', 'month', 'year']) && Number.isInteger(value.year) && (value.year as number) >= 1900
      && (value.year as number) <= 9999 && Number.isInteger(value.month) && (value.month as number) >= 1 && (value.month as number) <= 12;
  }
  return value.kind === 'WEEK_ENDING' && exactKeys(value, ['date', 'kind']) && civilDate(value.date);
}

const samePeriod = (a: ConsensusReferencePeriod, b: unknown): boolean => validPeriod(b) && (a.kind === 'MONTH'
  ? b.kind === 'MONTH' && a.year === b.year && a.month === b.month
  : b.kind === 'WEEK_ENDING' && a.date === b.date);

function validShape(value: unknown): value is ConsensusEvidenceInput {
  if (!isRecord(value) || !exactKeys(value, KEYS)) return false;
  return text(value.sourceAuthority, CODE) && text(value.datasetCode, CODE)
    && (value.statistic === 'MEDIAN' || value.statistic === 'MEAN')
    && typeof value.releaseIdentityType === 'string' && value.releaseIdentityType.length > 0 && value.releaseIdentityType.length <= 128
    && typeof value.releaseIdentityValue === 'string' && value.releaseIdentityValue.length > 0 && value.releaseIdentityValue.length <= 1024
    && text(value.metricCode, METRIC) && validPeriod(value.referencePeriod) && text(value.unit, METRIC)
    && text(value.value, DECIMAL) && isStrictTimestamp(value.publishedAt) && isStrictTimestamp(value.observedAt)
    && !isStrictlyAfter(value.publishedAt as string, value.observedAt as string)
    && text(value.artifactId, ARTIFACT) && (value.revision === null || text(value.revision, REVISION));
}

const keyOf = (e: ConsensusEvidenceInput) => [e.sourceAuthority, e.datasetCode, e.statistic, e.metricCode,
  e.referencePeriod.kind === 'MONTH' ? `${e.referencePeriod.year}-${e.referencePeriod.month}` : e.referencePeriod.date,
  e.revision ?? ''].join('\u001f');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface ReleaseMetric { readonly metric_code: string; readonly reference_period: ConsensusReferencePeriod; readonly unit: string }

/** The RESOLVED official adapter result's identity, instant and metrics, or null. Never throws. */
function releaseOf(adapterResult: unknown): { identityType: string; identityValue: string; publishedAt: string; metrics: ReleaseMetric[] } | null {
  try {
    if (!isRecord(adapterResult) || adapterResult.kind !== 'RESOLVED') return null;
    const identity = adapterResult.releaseIdentity;
    const state = adapterResult.canonicalEventState;
    if (!isRecord(identity) || typeof identity.identityType !== 'string' || typeof identity.identityValue !== 'string') return null;
    if (!isStrictTimestamp(adapterResult.publishedAt)) return null;
    if (!isRecord(state) || !isRecord(state.facts) || !Array.isArray(state.facts.metrics)) return null;
    const metrics: ReleaseMetric[] = [];
    for (const m of state.facts.metrics) {
      if (!isRecord(m) || typeof m.metric_code !== 'string' || typeof m.unit !== 'string' || !validPeriod(m.reference_period)) return null;
      metrics.push({ metric_code: m.metric_code, unit: m.unit, reference_period: m.reference_period });
    }
    return { identityType: identity.identityType, identityValue: identity.identityValue, publishedAt: adapterResult.publishedAt as string, metrics };
  } catch {
    return null;
  }
}

export function buildConsensusEvidenceEnvelope(
  adapterResult: unknown,
  rawEvidence: unknown,
  requestedCutoff: unknown,
): ConsensusEvidenceEnvelope {
  const reasons = new Set<ConsensusReasonCode>(['CONSENSUS_SOURCE_NOT_APPROVED', 'CONSENSUS_METHODOLOGY_NOT_APPROVED']);
  const knowledgeCutoff = typeof requestedCutoff === 'string' ? requestedCutoff : '';
  const cutoffOk = isStrictTimestamp(knowledgeCutoff);
  if (!cutoffOk) reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  const release = releaseOf(adapterResult);
  if (release === null) reasons.add('RELEASE_NOT_RESOLVED');
  const inputs: readonly unknown[] = Array.isArray(rawEvidence) ? rawEvidence : [];
  if (!Array.isArray(rawEvidence)) reasons.add('INVALID_EVIDENCE_SHAPE');
  else if (inputs.length === 0) reasons.add('NO_CONSENSUS_EVIDENCE');

  const refused: { index: number; reason: ConsensusReasonCode }[] = [];
  const kept: ConsensusEvidenceInput[] = [];
  const seen = new Set<string>();
  inputs.forEach((raw, index) => {
    const refuse = (reason: ConsensusReasonCode) => { reasons.add(reason); refused.push({ index, reason }); };
    let shapeOk = false;
    try { shapeOk = validShape(raw); } catch { shapeOk = false; }
    if (!shapeOk) return refuse('INVALID_EVIDENCE_SHAPE');
    const e = raw as ConsensusEvidenceInput;
    if (release === null) return refuse('RELEASE_NOT_RESOLVED');
    if (e.releaseIdentityType !== release.identityType || e.releaseIdentityValue !== release.identityValue) return refuse('RELEASE_IDENTITY_MISMATCH');
    const metric = release.metrics.find((m) => m.metric_code === e.metricCode);
    if (!metric) return refuse('METRIC_NOT_IN_RELEASE');
    if (!samePeriod(metric.reference_period, e.referencePeriod)) return refuse('REFERENCE_PERIOD_MISMATCH');
    if (metric.unit !== e.unit) return refuse('UNIT_MISMATCH');
    if (!isStrictlyAfter(release.publishedAt, e.publishedAt)) return refuse('CONSENSUS_NOT_BEFORE_RELEASE');
    if (!cutoffOk || isStrictlyAfter(e.publishedAt, knowledgeCutoff) || isStrictlyAfter(e.observedAt, knowledgeCutoff)) {
      return refuse('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF');
    }
    const key = keyOf(e);
    if (seen.has(key)) return refuse('DUPLICATE_EVIDENCE_KEY');
    seen.add(key);
    kept.push({ ...e, referencePeriod: { ...e.referencePeriod } as ConsensusReferencePeriod });
  });
  kept.sort((a, b) => compare(keyOf(a), keyOf(b)) || compare(a.publishedAt, b.publishedAt) || compare(a.artifactId, b.artifactId));

  return {
    schemaVersion: CONSENSUS_EVIDENCE_SCHEMA_VERSION,
    algorithmVersion: CONSENSUS_EVIDENCE_ALGORITHM_VERSION,
    evidenceState: 'ABSTAIN',
    consensusState: 'UNKNOWN',
    reasonCodes: ORDER.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    releasePublishedAt: release?.publishedAt ?? null,
    metrics: (release?.metrics ?? []).map((m) => ({
      metricCode: m.metric_code,
      referencePeriod: { ...m.reference_period } as ConsensusReferencePeriod,
      unit: m.unit,
      consensus: { state: 'UNKNOWN' as const, value: null },
      validEvidenceCount: kept.filter((e) => e.metricCode === m.metric_code).length,
    })),
    evidence: kept,
    refused,
  };
}
