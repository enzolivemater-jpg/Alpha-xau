/**
 * DATA-1 — Market evidence archive and deterministic as-of replay.
 *
 * An archive is an append-only list of market observations, each carrying
 * the full proof needed to use it: instrument, unit, observation type,
 * value, source and the source's own record identifier, observation,
 * publication and ingestion times, revision lineage and the digest of the
 * raw provider payload. Metadata a record does not have stays `null` and is
 * reported as unknown; nothing is inferred.
 *
 * The replay validates the archive, selects through the existing MP-1
 * selector (no look-ahead: a record is usable only if it was observed AND
 * ingested by the cutoff), and returns a CHAIN-0 `MarketSnapshot` plus a
 * verifiable manifest. A replay is called reproducible only when the archive
 * is valid, declares complete coverage of the cutoff, and matches a pinned
 * digest when one is given. It never upgrades MP-0, never reads a clock, a
 * network, a database or a provider, and always reports HOLD with execution
 * forbidden.
 *
 * Raw payload verification is optional and injected: when an archive keeps a
 * provider body, the caller's parser (the runtime FRED / Twelve Data parsers)
 * must re-derive the recorded value and observation time from those bytes.
 */

import {
  MARKET_PRICING_AS_OF_FIELDS,
  selectMarketPricingAsOf,
  type MarketPricingAsOfCandidate,
  type MarketPricingAsOfFieldName,
  type MarketPricingAsOfSelection,
} from './as_of_snapshot.js';
import type { Freshness, MarketField, MarketSnapshot, MarketSymbol, RawDataPoint } from './types.js';
import { SYMBOL_RULES, classifyFreshness } from './validate.js';
import { canonicalJson, sha256Canonical, sha256Text } from '../shared/canonical_json.js';
import { isStrictlyAfter, parseStrictTimestamp } from '../shared/strict_timestamp.js';

/** Input format of an archive (not an output contract version). */
export const MARKET_EVIDENCE_ARCHIVE_FORMAT = 'xau.market-evidence-archive.v1' as const;
export const MARKET_EVIDENCE_REPLAY_SCHEMA_VERSION = 'xau.market-evidence-replay.v1' as const;
export const MARKET_EVIDENCE_REPLAY_ALGORITHM_VERSION = 'market-evidence-replay-1.0.0' as const;

export type EvidenceInstrument = 'XAUUSD' | 'DXY' | 'US10Y' | 'US10YR' | 'VIX' | 'WTI';
export type EvidenceUnit = 'USD_PER_TROY_OUNCE' | 'INDEX_POINTS' | 'PERCENT' | 'USD_PER_BARREL';
export type EvidenceObservationType = 'LAST' | 'MID' | 'CLOSE' | 'BID' | 'ASK' | 'DAILY_VALUE';

/**
 * The only instrument, unit and observation types each field accepts. A
 * different unit is rejected, never converted.
 */
export const MARKET_EVIDENCE_FIELD_SPEC: Readonly<Record<MarketPricingAsOfFieldName, {
  readonly instrument: EvidenceInstrument;
  readonly unit: EvidenceUnit;
  readonly observationTypes: readonly EvidenceObservationType[];
  /** Freshness rule; null when no existing rule covers the instrument. */
  readonly freshnessSymbol: MarketSymbol | null;
}>> = {
  spot: { instrument: 'XAUUSD', unit: 'USD_PER_TROY_OUNCE', observationTypes: ['LAST', 'MID', 'CLOSE'], freshnessSymbol: 'XAUUSD' },
  bid: { instrument: 'XAUUSD', unit: 'USD_PER_TROY_OUNCE', observationTypes: ['BID'], freshnessSymbol: 'XAUUSD' },
  ask: { instrument: 'XAUUSD', unit: 'USD_PER_TROY_OUNCE', observationTypes: ['ASK'], freshnessSymbol: 'XAUUSD' },
  dxy: { instrument: 'DXY', unit: 'INDEX_POINTS', observationTypes: ['LAST', 'CLOSE', 'DAILY_VALUE'], freshnessSymbol: null },
  us10y: { instrument: 'US10Y', unit: 'PERCENT', observationTypes: ['DAILY_VALUE', 'CLOSE', 'LAST'], freshnessSymbol: 'US10Y' },
  realYield: { instrument: 'US10YR', unit: 'PERCENT', observationTypes: ['DAILY_VALUE', 'CLOSE', 'LAST'], freshnessSymbol: 'US10YR' },
  vix: { instrument: 'VIX', unit: 'INDEX_POINTS', observationTypes: ['DAILY_VALUE', 'CLOSE', 'LAST'], freshnessSymbol: 'VIX' },
  wti: { instrument: 'WTI', unit: 'USD_PER_BARREL', observationTypes: ['DAILY_VALUE', 'CLOSE', 'LAST'], freshnessSymbol: 'WTI' },
};

/** One archived observation. `null` means unknown, never "not applicable". */
export interface MarketEvidenceRecord {
  readonly evidenceId: string;
  readonly field: MarketPricingAsOfFieldName;
  readonly instrument: EvidenceInstrument;
  readonly unit: EvidenceUnit;
  readonly observationType: EvidenceObservationType;
  readonly value: number;
  readonly source: string;
  /** The provider's own identifier for this record (series id, quote id). */
  readonly sourceRecordId: string | null;
  /** Time the value describes, as published by the source. */
  readonly observedAt: string;
  /** Time the source made the value available, when the source states it. */
  readonly publishedAt: string | null;
  /** First time this system held the record. Governs availability. */
  readonly ingestedAt: string;
  /** Provider revision or retained-evidence identifier (MP-2 `evidence_revision`). */
  readonly revision: string;
  /** `evidenceId` of the revision this record corrects, or null. */
  readonly supersedes: string | null;
  /** `sha256:<hex>` of the raw provider payload the value came from. */
  readonly rawPayloadDigest: string | null;
}

export interface MarketEvidenceRawPayload {
  readonly parser: 'fred' | 'twelve_data';
  readonly symbol: MarketSymbol;
  /** Exact provider body, UTF-8. */
  readonly body: string;
}

/**
 * SYNTHETIC_FIXTURE: written by hand or by a test; never market data.
 * CAPTURED: recorded from a provider by an ingestion process.
 */
export type MarketEvidenceProvenanceClass = 'SYNTHETIC_FIXTURE' | 'CAPTURED';

export interface MarketEvidenceArchive {
  readonly schemaVersion: typeof MARKET_EVIDENCE_ARCHIVE_FORMAT;
  readonly archiveId: string;
  readonly provenanceClass: MarketEvidenceProvenanceClass;
  /**
   * The window over which the producer states the archive holds every record
   * it ingested, for the listed fields. null: no completeness claim.
   */
  readonly coverage: {
    readonly from: string;
    readonly to: string;
    readonly fields: readonly MarketPricingAsOfFieldName[];
    readonly statement: string;
  } | null;
  readonly records: readonly MarketEvidenceRecord[];
  /** Raw provider bodies keyed by their `sha256:` digest. */
  readonly rawPayloads: Readonly<Record<string, MarketEvidenceRawPayload>>;
}

export type MarketEvidenceReasonCode =
  // Blocking: the archive cannot be trusted as a whole.
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'ARCHIVE_SHAPE_INVALID'
  | 'ARCHIVE_DIGEST_MISMATCH'
  | 'RECORD_SHAPE_INVALID'
  | 'INSTRUMENT_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'OBSERVATION_TYPE_MISMATCH'
  | 'VALUE_OUT_OF_DOMAIN'
  | 'CHRONOLOGY_INVALID'
  | 'EVIDENCE_ID_CONFLICT'
  | 'IDENTITY_REUSED_WITH_DIVERGENT_VALUE'
  | 'REVISION_CHAIN_INVALID'
  | 'UNLINKED_REVISION_CONFLICT'
  | 'RAW_PAYLOAD_MISMATCH'
  // Not blocking: reported, the replay continues.
  | 'EXACT_DUPLICATE_IGNORED'
  | 'COVERAGE_NOT_DECLARED'
  | 'CUTOFF_OUTSIDE_COVERAGE'
  | 'FIELDS_NOT_COVERED'
  | 'PROVENANCE_INCOMPLETE'
  | 'FRESHNESS_RULE_UNAVAILABLE';

const BLOCKING: readonly MarketEvidenceReasonCode[] = [
  'INVALID_KNOWLEDGE_CUTOFF', 'ARCHIVE_SHAPE_INVALID', 'ARCHIVE_DIGEST_MISMATCH', 'RECORD_SHAPE_INVALID',
  'INSTRUMENT_MISMATCH', 'UNIT_MISMATCH', 'OBSERVATION_TYPE_MISMATCH', 'VALUE_OUT_OF_DOMAIN',
  'CHRONOLOGY_INVALID', 'EVIDENCE_ID_CONFLICT', 'IDENTITY_REUSED_WITH_DIVERGENT_VALUE',
  'REVISION_CHAIN_INVALID', 'UNLINKED_REVISION_CONFLICT', 'RAW_PAYLOAD_MISMATCH',
];
const REASON_ORDER: readonly MarketEvidenceReasonCode[] = [
  ...BLOCKING, 'EXACT_DUPLICATE_IGNORED', 'COVERAGE_NOT_DECLARED', 'CUTOFF_OUTSIDE_COVERAGE',
  'FIELDS_NOT_COVERED', 'PROVENANCE_INCOMPLETE', 'FRESHNESS_RULE_UNAVAILABLE',
];

export interface MarketEvidenceFinding {
  readonly code: MarketEvidenceReasonCode;
  /** Record index in the archive, or null for an archive-level finding. */
  readonly index: number | null;
  readonly evidenceId: string | null;
}

/** RAW_VERIFIED: the injected parser re-derived value and time from the kept bytes. */
export type RawEvidenceState = 'RAW_VERIFIED' | 'RAW_DIGEST_ONLY' | 'RAW_UNKNOWN';

export interface ReplayedObservation {
  readonly field: MarketPricingAsOfFieldName;
  readonly evidenceId: string;
  readonly instrument: EvidenceInstrument;
  readonly unit: EvidenceUnit;
  readonly observationType: EvidenceObservationType;
  readonly value: number;
  readonly source: string;
  readonly sourceRecordId: string | null;
  readonly observedAt: string;
  readonly publishedAt: string | null;
  readonly ingestedAt: string;
  readonly revision: string;
  readonly supersedes: string | null;
  readonly rawPayloadDigest: string | null;
  readonly recordDigest: string;
  readonly ageSecondsAtCutoff: number;
  readonly freshnessAtCutoff: Freshness;
  readonly raw: RawEvidenceState;
  /** Names of the provenance fields this record leaves unknown. */
  readonly unknown: readonly ('sourceRecordId' | 'publishedAt' | 'rawPayloadDigest')[];
}

/**
 * VERIFIED: valid archive, complete declared coverage of the cutoff, pinned
 * digest matched when given. INCOMPLETE: valid but completeness not
 * established. INVALID: a blocking finding; nothing from it is usable.
 */
export type MarketEvidenceReplayStatus = 'VERIFIED' | 'INCOMPLETE' | 'INVALID';

/**
 * SIMULATION: synthetic archive. HISTORICAL_VERIFIED: captured archive,
 * VERIFIED replay, every selected value re-derived from its raw bytes.
 * HISTORICAL_UNVERIFIED: captured, but at least one of those does not hold.
 * Never LIVE: a replay describes the past.
 */
export type MarketEvidenceNature = 'SIMULATION' | 'HISTORICAL_VERIFIED' | 'HISTORICAL_UNVERIFIED';

export interface MarketEvidenceReplay {
  readonly schemaVersion: typeof MARKET_EVIDENCE_REPLAY_SCHEMA_VERSION;
  readonly algorithmVersion: typeof MARKET_EVIDENCE_REPLAY_ALGORITHM_VERSION;
  readonly knowledgeCutoff: string;
  readonly decision: 'HOLD';
  readonly execution: 'FORBIDDEN';
  readonly status: MarketEvidenceReplayStatus;
  readonly nature: MarketEvidenceNature;
  readonly reproducible: boolean;
  readonly archive: {
    readonly archiveId: string | null;
    readonly provenanceClass: MarketEvidenceProvenanceClass | null;
    /** Digest of the canonical archive as read, or null when it is not JSON-canonical. */
    readonly digest: string | null;
    readonly pinnedDigest: string | null;
    readonly recordCount: number;
    readonly coverage: MarketEvidenceArchive['coverage'];
  };
  readonly reasonCodes: readonly MarketEvidenceReasonCode[];
  readonly findings: readonly MarketEvidenceFinding[];
  /** MP-1 selection over the archive, unchanged; null when the archive is invalid. */
  readonly selection: MarketPricingAsOfSelection | null;
  readonly observations: Readonly<Record<MarketPricingAsOfFieldName, ReplayedObservation | null>>;
  /** Records ingested after the cutoff: counted for audit, never used. */
  readonly audit: {
    readonly recordsIngestedAfterCutoff: number;
    /** Fields whose selected value a later revision corrected after the cutoff. */
    readonly correctedAfterCutoff: readonly MarketPricingAsOfFieldName[];
  };
  /** CHAIN-0 input, at the cutoff. Fails closed: invalid or abstaining means unavailable. */
  readonly marketSnapshot: MarketSnapshot;
  /** `sha256:` of this replay without this field. */
  readonly digest: string;
}

/** Reads a raw body; a body holding several observations returns them all. */
export type RawPayloadParser = (body: string, symbol: MarketSymbol) => RawDataPoint | readonly RawDataPoint[];

export interface MarketEvidenceReplayOptions {
  /** When given, an archive whose digest differs is INVALID. */
  readonly pinnedArchiveDigest?: string;
  /** Parsers able to re-derive values from kept raw payloads. */
  readonly parsers?: Partial<Record<MarketEvidenceRawPayload['parser'], RawPayloadParser>>;
}

/* -------------------------------------------------------------------------- */

const FIELD_SET: ReadonlySet<string> = new Set(MARKET_PRICING_AS_OF_FIELDS);
const OBSERVATION_TYPES: ReadonlySet<string> = new Set(['LAST', 'MID', 'CLOSE', 'BID', 'ASK', 'DAILY_VALUE']);
const INSTRUMENTS: ReadonlySet<string> = new Set(['XAUUSD', 'DXY', 'US10Y', 'US10YR', 'VIX', 'WTI']);
const UNITS: ReadonlySet<string> = new Set(['USD_PER_TROY_OUNCE', 'INDEX_POINTS', 'PERCENT', 'USD_PER_BARREL']);
/** Same identifier grammar as MP-2 `evidence_revision`. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECORD_KEYS = [
  'evidenceId', 'field', 'ingestedAt', 'instrument', 'observationType', 'observedAt', 'publishedAt',
  'rawPayloadDigest', 'revision', 'source', 'sourceRecordId', 'supersedes', 'unit', 'value',
].sort();
const ARCHIVE_KEYS = ['archiveId', 'coverage', 'provenanceClass', 'rawPayloads', 'records', 'schemaVersion'].sort();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
};
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isTimestamp = (value: unknown): value is string => parseStrictTimestamp(value) !== null;
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value);
const canonicalTime = (value: string) => new Date(parseStrictTimestamp(value)!).toISOString();

function recordShapeValid(record: unknown): record is MarketEvidenceRecord {
  if (!isObject(record) || !hasExactKeys(record, RECORD_KEYS)) return false;
  return isIdentifier(record.evidenceId)
    && FIELD_SET.has(record.field as string)
    && INSTRUMENTS.has(record.instrument as string)
    && UNITS.has(record.unit as string)
    && OBSERVATION_TYPES.has(record.observationType as string)
    && typeof record.value === 'number' && Number.isFinite(record.value)
    && isIdentifier(record.source)
    && (record.sourceRecordId === null || isText(record.sourceRecordId))
    && isTimestamp(record.observedAt)
    && (record.publishedAt === null || isTimestamp(record.publishedAt))
    && isTimestamp(record.ingestedAt)
    && isIdentifier(record.revision)
    && (record.supersedes === null || isIdentifier(record.supersedes))
    && (record.rawPayloadDigest === null || (typeof record.rawPayloadDigest === 'string' && DIGEST.test(record.rawPayloadDigest)));
}

function archiveShapeValid(archive: unknown): archive is MarketEvidenceArchive {
  if (!isObject(archive) || !hasExactKeys(archive, ARCHIVE_KEYS)) return false;
  if (archive.schemaVersion !== MARKET_EVIDENCE_ARCHIVE_FORMAT || !isIdentifier(archive.archiveId)) return false;
  if (archive.provenanceClass !== 'SYNTHETIC_FIXTURE' && archive.provenanceClass !== 'CAPTURED') return false;
  if (!Array.isArray(archive.records) || !isObject(archive.rawPayloads)) return false;
  for (const [digest, payload] of Object.entries(archive.rawPayloads)) {
    if (!DIGEST.test(digest) || !isObject(payload) || !hasExactKeys(payload, ['body', 'parser', 'symbol'])
        || (payload.parser !== 'fred' && payload.parser !== 'twelve_data')
        || !Object.prototype.hasOwnProperty.call(SYMBOL_RULES, payload.symbol as string)
        || typeof payload.body !== 'string') return false;
  }
  const coverage = archive.coverage;
  if (coverage === null) return true;
  return isObject(coverage) && hasExactKeys(coverage, ['fields', 'from', 'statement', 'to'])
    && isTimestamp(coverage.from) && isTimestamp(coverage.to)
    && !isStrictlyAfter(coverage.from as string, coverage.to as string)
    && Array.isArray(coverage.fields) && coverage.fields.every((field) => FIELD_SET.has(field as string))
    && isText(coverage.statement);
}

/** Value domain: the existing plausibility rules, else the MP-2 SQL domain. */
function valueInDomain(record: MarketEvidenceRecord): boolean {
  const symbol = MARKET_EVIDENCE_FIELD_SPEC[record.field].freshnessSymbol;
  if (symbol === null) return record.value > 0;
  const rule = SYMBOL_RULES[symbol];
  return record.value >= rule.min && record.value <= rule.max && (record.value >= 0 || rule.allowNegative);
}

/** The value a record claims, as found in a raw provider payload. */
function rawValue(point: RawDataPoint, field: MarketPricingAsOfFieldName): number | null {
  if (field === 'bid') return point.bid ?? null;
  if (field === 'ask') return point.ask ?? null;
  return point.value;
}

function emptyField(): MarketField {
  return { value: null, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null };
}

/**
 * Validates an archive and replays it at `knowledgeCutoff`. Pure apart from
 * Web Crypto digests; same archive, cutoff and options give the same digest.
 */
export async function replayMarketEvidence(
  archive: unknown,
  knowledgeCutoff: string,
  options: MarketEvidenceReplayOptions = {},
): Promise<MarketEvidenceReplay> {
  // JavaScript callers can pass anything. The replay echoes both values into a
  // hashed envelope, so a non-string (NaN, an object...) must not reach it: a
  // non-string cutoff is an invalid (empty) cutoff, a non-string pin never matches.
  const requestedCutoff: unknown = knowledgeCutoff;
  knowledgeCutoff = typeof requestedCutoff === 'string' ? requestedCutoff : '';
  const requestedPin: unknown = options.pinnedArchiveDigest ?? null;
  const findings: MarketEvidenceFinding[] = [];
  const add = (code: MarketEvidenceReasonCode, index: number | null = null, evidenceId: string | null = null) => {
    if (!findings.some((f) => f.code === code && f.index === index)) findings.push({ code, index, evidenceId });
  };
  const cutoffMs = parseStrictTimestamp(knowledgeCutoff);
  if (cutoffMs === null) add('INVALID_KNOWLEDGE_CUTOFF');

  let archiveDigest: string | null = null;
  try {
    archiveDigest = await sha256Canonical(archive);
  } catch {
    add('ARCHIVE_SHAPE_INVALID');
  }
  const pinned = typeof requestedPin === 'string' ? requestedPin : null;
  if (requestedPin !== null && (pinned === null || archiveDigest !== pinned)) add('ARCHIVE_DIGEST_MISMATCH');

  const shapeOk = archiveShapeValid(archive);
  if (!shapeOk) add('ARCHIVE_SHAPE_INVALID');
  const valid: { record: MarketEvidenceRecord; index: number }[] = [];
  const recordDigests = new Map<string, string>();
  if (shapeOk) {
    const byId = new Map<string, { record: MarketEvidenceRecord; canonical: string }>();
    for (const [index, record] of (archive.records as readonly unknown[]).entries()) {
      if (!recordShapeValid(record)) {
        const id = isObject(record) && typeof record.evidenceId === 'string' ? record.evidenceId : null;
        add('RECORD_SHAPE_INVALID', index, id);
        continue;
      }
      const id = record.evidenceId;
      const canonical = canonicalJson(record);
      const prior = byId.get(id);
      if (prior) {
        add(prior.canonical === canonical ? 'EXACT_DUPLICATE_IGNORED' : 'EVIDENCE_ID_CONFLICT', index, id);
        continue;
      }
      byId.set(id, { record, canonical });
      const spec = MARKET_EVIDENCE_FIELD_SPEC[record.field];
      if (record.instrument !== spec.instrument) add('INSTRUMENT_MISMATCH', index, id);
      if (record.unit !== spec.unit) add('UNIT_MISMATCH', index, id);
      if (!spec.observationTypes.includes(record.observationType)) add('OBSERVATION_TYPE_MISMATCH', index, id);
      if (!valueInDomain(record)) add('VALUE_OUT_OF_DOMAIN', index, id);
      // A value is described, then published, then held by this system.
      if (isStrictlyAfter(record.observedAt, record.ingestedAt)
          || (record.publishedAt !== null && (isStrictlyAfter(record.observedAt, record.publishedAt)
            || isStrictlyAfter(record.publishedAt, record.ingestedAt)))) {
        add('CHRONOLOGY_INVALID', index, id);
      }
      if (record.sourceRecordId === null || record.publishedAt === null || record.rawPayloadDigest === null) {
        add('PROVENANCE_INCOMPLETE', index, id);
      }
      valid.push({ record, index });
      recordDigests.set(id, await sha256Text(canonical));
    }

    // MP-2 identity: (field, source, observedAt, revision) names one value.
    const identities = new Map<string, MarketEvidenceRecord>();
    for (const { record, index } of valid) {
      const key = [record.field, record.source, canonicalTime(record.observedAt), record.revision].join('|');
      const prior = identities.get(key);
      if (prior && !Object.is(prior.value, record.value)) add('IDENTITY_REUSED_WITH_DIVERGENT_VALUE', index, record.evidenceId);
      else if (!prior) identities.set(key, record);
    }

    // Revisions: a correction names the record it supersedes, for the same
    // field, source and observation time, ingested after it; no branching.
    const ids = new Map(valid.map(({ record }) => [record.evidenceId, record]));
    const superseded = new Set<string>();
    for (const { record, index } of valid) {
      if (record.supersedes === null) continue;
      const target = ids.get(record.supersedes);
      if (!target || target.field !== record.field || target.source !== record.source
          || canonicalTime(target.observedAt) !== canonicalTime(record.observedAt)
          || target.revision === record.revision
          || !isStrictlyAfter(record.ingestedAt, target.ingestedAt)
          || superseded.has(record.supersedes)) {
        add('REVISION_CHAIN_INVALID', index, record.evidenceId);
      }
      superseded.add(record.supersedes);
    }
    const lineage = (id: string): Set<string> => {
      const seen = new Set<string>();
      for (let cur: string | null = id; cur !== null && !seen.has(cur);) {
        seen.add(cur);
        cur = ids.get(cur)?.supersedes ?? null;
      }
      return seen;
    };
    // Two revisions of one observation with different values must be linked.
    for (const [i, { record: a }] of valid.entries()) {
      for (const { record: b, index } of valid.slice(i + 1)) {
        if (a.field === b.field && a.source === b.source && a.revision !== b.revision
            && canonicalTime(a.observedAt) === canonicalTime(b.observedAt) && !Object.is(a.value, b.value)
            && !lineage(a.evidenceId).has(b.evidenceId) && !lineage(b.evidenceId).has(a.evidenceId)) {
          add('UNLINKED_REVISION_CONFLICT', index, b.evidenceId);
        }
      }
    }

    // Raw payloads: the kept bytes must hash to the digest, and the runtime
    // parser must read the recorded value and time back from them.
    for (const { record, index } of valid) {
      if (record.rawPayloadDigest === null) continue;
      const payload = archive.rawPayloads[record.rawPayloadDigest];
      if (!payload) continue;
      const parser = options.parsers?.[payload.parser];
      if (await sha256Text(payload.body) !== record.rawPayloadDigest) {
        add('RAW_PAYLOAD_MISMATCH', index, record.evidenceId);
        continue;
      }
      if (!parser) continue;
      const read = parser(payload.body, payload.symbol);
      const points: readonly RawDataPoint[] = Array.isArray(read) ? read : [read as RawDataPoint];
      // The recorded observation must be one the bytes actually contain.
      const found = points.some((point) => {
        const value = rawValue(point, record.field);
        return point.symbol === MARKET_EVIDENCE_FIELD_SPEC[record.field].freshnessSymbol
          && point.source === record.source && value !== null && Object.is(value, record.value)
          && point.observedAt !== null && canonicalTime(point.observedAt) === canonicalTime(record.observedAt);
      });
      if (!found) add('RAW_PAYLOAD_MISMATCH', index, record.evidenceId);
    }

    const coverage = archive.coverage;
    if (coverage === null) add('COVERAGE_NOT_DECLARED');
    else if (cutoffMs !== null && (isStrictlyAfter(coverage.from, knowledgeCutoff)
      || isStrictlyAfter(knowledgeCutoff, coverage.to))) add('CUTOFF_OUTSIDE_COVERAGE');
    if (coverage !== null && MARKET_PRICING_AS_OF_FIELDS.some((field) => !coverage.fields.includes(field))) {
      add('FIELDS_NOT_COVERED');
    }
  }

  const codes = new Set(findings.map((f) => f.code));
  const invalid = BLOCKING.some((code) => codes.has(code));

  let selection: MarketPricingAsOfSelection | null = null;
  const observations = Object.fromEntries(MARKET_PRICING_AS_OF_FIELDS.map((f) => [f, null])) as
    Record<MarketPricingAsOfFieldName, ReplayedObservation | null>;
  let recordsIngestedAfterCutoff = 0;
  const correctedAfterCutoff: MarketPricingAsOfFieldName[] = [];
  if (!invalid && shapeOk && cutoffMs !== null) {
    const candidates: MarketPricingAsOfCandidate[] = valid.map(({ record }) => ({
      candidateId: record.evidenceId,
      field: record.field,
      value: record.value,
      source: record.source,
      observedAt: record.observedAt,
      ingestedAt: record.ingestedAt,
      evidenceRevision: record.revision,
    }));
    selection = selectMarketPricingAsOf(candidates, knowledgeCutoff);
    recordsIngestedAfterCutoff = valid.filter(({ record }) => isStrictlyAfter(record.ingestedAt, knowledgeCutoff)).length;
    const byId = new Map(valid.map(({ record }) => [record.evidenceId, record]));
    for (const field of MARKET_PRICING_AS_OF_FIELDS) {
      const chosen = selection.fields[field];
      if (!chosen) continue;
      const record = byId.get(chosen.candidateId)!;
      const spec = MARKET_EVIDENCE_FIELD_SPEC[field];
      const ageSecondsAtCutoff = chosen.ageSeconds;
      let freshnessAtCutoff: Freshness = 'UNAVAILABLE';
      if (spec.freshnessSymbol === null) add('FRESHNESS_RULE_UNAVAILABLE');
      else freshnessAtCutoff = classifyFreshness(ageSecondsAtCutoff, SYMBOL_RULES[spec.freshnessSymbol]);
      const payload = record.rawPayloadDigest === null ? undefined : archive.rawPayloads[record.rawPayloadDigest];
      const raw: RawEvidenceState = record.rawPayloadDigest === null ? 'RAW_UNKNOWN'
        : payload && options.parsers?.[payload.parser] ? 'RAW_VERIFIED' : 'RAW_DIGEST_ONLY';
      observations[field] = {
        field,
        evidenceId: record.evidenceId,
        instrument: record.instrument,
        unit: record.unit,
        observationType: record.observationType,
        value: record.value,
        source: record.source,
        sourceRecordId: record.sourceRecordId,
        observedAt: canonicalTime(record.observedAt),
        publishedAt: record.publishedAt === null ? null : canonicalTime(record.publishedAt),
        ingestedAt: canonicalTime(record.ingestedAt),
        revision: record.revision,
        supersedes: record.supersedes,
        rawPayloadDigest: record.rawPayloadDigest,
        recordDigest: recordDigests.get(record.evidenceId)!,
        ageSecondsAtCutoff,
        freshnessAtCutoff,
        raw,
        unknown: (['sourceRecordId', 'publishedAt', 'rawPayloadDigest'] as const).filter((key) => record[key] === null),
      };
      if (valid.some(({ record: later }) => later.supersedes !== null && lineageHas(byId, later.evidenceId, record.evidenceId)
          && isStrictlyAfter(later.ingestedAt, knowledgeCutoff))) {
        correctedAfterCutoff.push(field);
      }
    }
  }

  const finalCodes = new Set(findings.map((f) => f.code));
  const selectionInvalid = selection !== null && !selection.replay.reproducible;
  const status: MarketEvidenceReplayStatus = invalid || selectionInvalid || selection === null ? 'INVALID'
    : ['COVERAGE_NOT_DECLARED', 'CUTOFF_OUTSIDE_COVERAGE', 'FIELDS_NOT_COVERED']
      .some((code) => finalCodes.has(code as MarketEvidenceReasonCode)) ? 'INCOMPLETE' : 'VERIFIED';
  const captured = shapeOk && archive.provenanceClass === 'CAPTURED';
  const selected = Object.values(observations).filter((o): o is ReplayedObservation => o !== null);
  const nature: MarketEvidenceNature = !captured ? 'SIMULATION'
    : status === 'VERIFIED' && selected.length > 0 && selected.every((o) => o.raw === 'RAW_VERIFIED')
      ? 'HISTORICAL_VERIFIED' : 'HISTORICAL_UNVERIFIED';

  // CHAIN-0 input. Invalid or abstaining evidence yields no value at all.
  const usable = status !== 'INVALID' && selection !== null && selection.state !== 'ABSTAIN';
  const fields = Object.fromEntries(MARKET_PRICING_AS_OF_FIELDS.map((field) => {
    const o = observations[field];
    if (!usable || !o || o.freshnessAtCutoff === 'UNAVAILABLE') return [field, emptyField()];
    return [field, { value: o.value, status: o.freshnessAtCutoff, observedAt: o.observedAt, ageSeconds: o.ageSecondsAtCutoff, source: o.source }];
  })) as Record<MarketPricingAsOfFieldName, MarketField>;
  const reasonCodes = REASON_ORDER.filter((code) => finalCodes.has(code));
  const available = usable && fields.spot.value !== null;
  // An INCOMPLETE replay stays usable but always says why it is not reproducible.
  const snapshotReason = available && status === 'VERIFIED' ? null
    : `market evidence replay ${status}${selection ? ` / MP-1 ${selection.state}` : ''}: ${
      [...reasonCodes.filter((c) => c !== 'PROVENANCE_INCOMPLETE' && c !== 'EXACT_DUPLICATE_IGNORED'),
        ...(selection?.reasonCodes ?? [])].join(',') || 'SPOT_UNAVAILABLE'}`;
  const marketSnapshot: MarketSnapshot = {
    available,
    reason: snapshotReason,
    ...fields,
    capturedAt: fields.spot.observedAt,
  };

  const body: Omit<MarketEvidenceReplay, 'digest'> = {
    schemaVersion: MARKET_EVIDENCE_REPLAY_SCHEMA_VERSION,
    algorithmVersion: MARKET_EVIDENCE_REPLAY_ALGORITHM_VERSION,
    knowledgeCutoff,
    decision: 'HOLD',
    execution: 'FORBIDDEN',
    status,
    nature,
    reproducible: status === 'VERIFIED',
    archive: {
      archiveId: shapeOk ? archive.archiveId : null,
      provenanceClass: shapeOk ? archive.provenanceClass : null,
      digest: archiveDigest,
      pinnedDigest: pinned,
      recordCount: shapeOk ? archive.records.length : 0,
      coverage: shapeOk ? archive.coverage : null,
    },
    reasonCodes,
    findings: [...findings].sort((a, b) => REASON_ORDER.indexOf(a.code) - REASON_ORDER.indexOf(b.code)
      || (a.index ?? -1) - (b.index ?? -1)),
    selection,
    observations,
    audit: { recordsIngestedAfterCutoff, correctedAfterCutoff },
    marketSnapshot,
  };
  return { ...body, digest: await sha256Canonical(body) };
}

function lineageHas(byId: ReadonlyMap<string, MarketEvidenceRecord>, from: string, target: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null = byId.get(from)?.supersedes ?? null; cur !== null && !seen.has(cur);) {
    if (cur === target) return true;
    seen.add(cur);
    cur = byId.get(cur)?.supersedes ?? null;
  }
  return false;
}
