/** P-1 adapter from persisted rows to the P-0 evidence-only envelope. */

import {
  buildPositioningEvidenceEnvelope,
  type PositioningEvidenceEnvelope,
  type PositioningEvidenceInput,
  type PositioningUnit,
} from './evidence_contract.js';
import { parseStrictTimestamp } from '../shared/strict_timestamp.js';

export const POSITIONING_PERSISTENCE_SCHEMA_VERSION = 'xau.positioning-persistence.v1' as const;
export const POSITIONING_PERSISTENCE_ALGORITHM_VERSION = 'positioning-persisted-evidence-adapter-1.0.0' as const;

export interface PositioningEvidenceRpcRow {
  readonly evidence_id: string;
  readonly source_authority: string;
  readonly dataset_code: string;
  readonly instrument_code: string;
  readonly metric_code: string;
  readonly value: number | string;
  readonly unit: string;
  readonly period_end: string;
  readonly published_at: string;
  readonly observed_at: string;
  readonly artifact_id: string;
  readonly revision: string | null;
}

export interface PersistedPositioningEvidence {
  readonly schemaVersion: typeof POSITIONING_PERSISTENCE_SCHEMA_VERSION;
  readonly algorithmVersion: typeof POSITIONING_PERSISTENCE_ALGORITHM_VERSION;
  readonly knowledgeCutoff: string;
  readonly persistence: {
    readonly relation: 'positioning_evidence_observations';
    readonly readRpc: 'fn_positioning_evidence_as_of';
    readonly historyCompleteness: 'COMPLETE_OR_ERROR';
    readonly runtimeWiring: 'NOT_ACTIVATED';
    readonly providerApproval: 'NONE';
  };
  readonly evidence: PositioningEvidenceEnvelope;
}

const RPC_KEYS = [
  'artifact_id', 'dataset_code', 'evidence_id', 'instrument_code', 'metric_code',
  'observed_at', 'period_end', 'published_at', 'revision', 'source_authority',
  'unit', 'value',
] as const;
const CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const INSTRUMENT = /^[A-Z0-9][A-Z0-9_.:/-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const UNITS: ReadonlySet<string> = new Set(['CONTRACTS', 'PERCENT', 'RATIO', 'INDEX']);

function exactKeys(row: object): boolean {
  const keys = Object.keys(row).sort();
  return keys.length === RPC_KEYS.length && keys.every((key, index) => key === RPC_KEYS[index]);
}

const text = (value: unknown, pattern: RegExp): boolean => typeof value === 'string' && pattern.test(value);

function civilDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function timestamp(value: unknown): { readonly ms: number; readonly canonical: string } | null {
  const ms = parseStrictTimestamp(value);
  if (ms === null) return null;
  return { ms, canonical: new Date(ms).toISOString() };
}

/** PostgREST NUMERIC arrives as plain decimal text; `Number()` would also read "0x10" as 16. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function normalizePositioningEvidenceRows(
  rows: readonly PositioningEvidenceRpcRow[],
): readonly PositioningEvidenceInput[] {
  // An RPC error object or null is not a row set.
  if (!Array.isArray(rows)) throw new Error('P1_RPC_RESULT_INVALID');
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || !exactKeys(row)) {
      throw new Error(`P1_RPC_ROW_${index}_SHAPE_INVALID`);
    }
    // RegExp.test() coerces: an undefined, an array or an object would pass as text.
    if (!text(row.evidence_id, UUID) || !text(row.source_authority, CODE)
        || !text(row.dataset_code, CODE) || !text(row.instrument_code, INSTRUMENT)
        || !text(row.metric_code, CODE) || !UNITS.has(row.unit)
        || !civilDate(row.period_end) || typeof row.artifact_id !== 'string'
        || row.artifact_id.trim() !== row.artifact_id
        || row.artifact_id.length < 1 || row.artifact_id.length > 256
        || (row.revision !== null
          && (typeof row.revision !== 'string' || !REVISION.test(row.revision)))) {
      throw new Error(`P1_RPC_ROW_${index}_IDENTITY_INVALID`);
    }
    const value = typeof row.value === 'number' ? row.value
      : typeof row.value === 'string' && DECIMAL.test(row.value.trim())
        ? Number(row.value.trim()) : Number.NaN;
    const published = timestamp(row.published_at);
    const observed = timestamp(row.observed_at);
    if (!Number.isFinite(value) || published === null || observed === null
        || published.ms > observed.ms) {
      throw new Error(`P1_RPC_ROW_${index}_EVIDENCE_INVALID`);
    }
    return {
      sourceAuthority: row.source_authority,
      datasetCode: row.dataset_code,
      instrumentCode: row.instrument_code,
      metricCode: row.metric_code,
      value,
      unit: row.unit as PositioningUnit,
      periodEnd: row.period_end,
      publishedAt: published.canonical,
      observedAt: observed.canonical,
      artifactId: row.artifact_id,
      revision: row.revision,
    };
  });
}

export function buildPersistedPositioningEvidence(
  rows: readonly PositioningEvidenceRpcRow[],
  requestedCutoff: string,
): PersistedPositioningEvidence {
  // Echoed below: a non-string cutoff is an invalid (empty) cutoff, never an unhashable value.
  const knowledgeCutoff: string = typeof requestedCutoff === 'string' ? requestedCutoff : '';
  const inputs = normalizePositioningEvidenceRows(rows);
  return {
    schemaVersion: POSITIONING_PERSISTENCE_SCHEMA_VERSION,
    algorithmVersion: POSITIONING_PERSISTENCE_ALGORITHM_VERSION,
    knowledgeCutoff,
    persistence: {
      relation: 'positioning_evidence_observations',
      readRpc: 'fn_positioning_evidence_as_of',
      historyCompleteness: 'COMPLETE_OR_ERROR',
      runtimeWiring: 'NOT_ACTIVATED',
      providerApproval: 'NONE',
    },
    evidence: buildPositioningEvidenceEnvelope(inputs, knowledgeCutoff),
  };
}
