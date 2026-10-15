/**
 * DATA-2 — capture of raw provider responses into a DATA-1 evidence archive.
 *
 * A capture is the exact body a provider returned, the provider series or
 * symbol it was requested for, and the explicit time this system received
 * it. Capturing never requests anything: a caller (an authorized ingestion
 * run, or a person running the local CLI on files they downloaded) supplies
 * the bytes. The body is kept verbatim, keyed by its SHA-256, and every
 * observation it contains becomes an evidence record that names it.
 *
 * Append-only: existing records and payloads are never changed. A value the
 * archive already holds is not recorded again; a different value for the same
 * observation becomes a new revision superseding the latest one. Capture
 * times must not go backwards, and the declared coverage ends at the latest
 * capture. A capture is applied only if the resulting archive replays without
 * a blocking finding; otherwise the archive is returned unchanged.
 *
 * Parsers are injected (the runtime FRED / Twelve Data parsers), so this
 * module reads no network, clock, environment or provider.
 */

import {
  MARKET_EVIDENCE_ARCHIVE_FORMAT,
  MARKET_EVIDENCE_FIELD_SPEC,
  replayMarketEvidence,
  type MarketEvidenceArchive,
  type MarketEvidenceProvenanceClass,
  type MarketEvidenceReasonCode,
  type MarketEvidenceRecord,
} from './evidence_archive.js';
import type { MarketPricingAsOfFieldName } from './as_of_snapshot.js';
import type { MarketSymbol, RawDataPoint } from './types.js';
import { canonicalJson, sha256Text } from '../shared/canonical_json.js';
import { isStrictlyAfter, parseStrictTimestamp } from '../shared/strict_timestamp.js';

export interface CaptureParsers {
  /** Every observation of a FRED response (`parseFredObservations`). */
  readonly fred: (body: string, symbol: MarketSymbol) => readonly RawDataPoint[];
  /** The quote of a Twelve Data response (`parseTwelveData`). */
  readonly twelve_data: (body: string, symbol: MarketSymbol) => RawDataPoint;
}

/**
 * What each provider series feeds. FRED series ids equal the runtime
 * `FRED_SERIES`; Twelve Data serves only the XAUUSD spot (its quotes carry no
 * book, so no bid or ask is ever captured from them).
 */
export const CAPTURE_SERIES: readonly {
  readonly provider: 'fred' | 'twelve_data';
  readonly symbol: MarketSymbol;
  readonly sourceRecordId: string;
  readonly field: MarketPricingAsOfFieldName;
  readonly observationType: 'DAILY_VALUE' | 'LAST';
}[] = [
  { provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10', field: 'us10y', observationType: 'DAILY_VALUE' },
  { provider: 'fred', symbol: 'US10YR', sourceRecordId: 'DFII10', field: 'realYield', observationType: 'DAILY_VALUE' },
  { provider: 'fred', symbol: 'VIX', sourceRecordId: 'VIXCLS', field: 'vix', observationType: 'DAILY_VALUE' },
  { provider: 'fred', symbol: 'WTI', sourceRecordId: 'DCOILWTICO', field: 'wti', observationType: 'DAILY_VALUE' },
  { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', field: 'spot', observationType: 'LAST' },
];

export interface ProviderCapture {
  readonly provider: 'fred' | 'twelve_data';
  readonly symbol: MarketSymbol;
  /** FRED series id or Twelve Data symbol the request named. */
  readonly sourceRecordId: string;
  /** Exact response body. */
  readonly body: string;
  /** Time this system received the body. Never inferred. */
  readonly ingestedAt: string;
}

export type CaptureRejection =
  | 'ARCHIVE_INVALID'
  | 'INVALID_INGESTED_AT'
  | 'INGESTION_OUT_OF_ORDER'
  | 'UNKNOWN_SERIES'
  | 'NO_USABLE_OBSERVATION'
  | 'ARCHIVE_WOULD_BE_INVALID';

export interface CaptureResult {
  readonly outcome: 'APPENDED' | 'ALREADY_CAPTURED' | 'REJECTED';
  /** The new archive, or the input archive unchanged. */
  readonly archive: MarketEvidenceArchive;
  readonly rawPayloadDigest: string | null;
  readonly added: readonly string[];
  /** New records that supersede a different earlier value. */
  readonly revised: readonly string[];
  /** Observations the archive already held with the same value. */
  readonly unchanged: number;
  /** Observations not recorded, with why (a provider gap, a future time). */
  readonly skipped: readonly { readonly observedAt: string | null; readonly reason: string }[];
  readonly rejection: CaptureRejection | null;
  readonly replayReasons: readonly MarketEvidenceReasonCode[];
}

/** A new, empty archive whose declared coverage starts at `createdAt`. */
export function createEvidenceArchive(options: {
  readonly archiveId: string;
  readonly provenanceClass: MarketEvidenceProvenanceClass;
  readonly createdAt: string;
  readonly fields: readonly MarketPricingAsOfFieldName[];
  readonly statement: string;
}): MarketEvidenceArchive {
  const created = parseStrictTimestamp(options.createdAt);
  if (created === null) throw new Error('createdAt must be a strict timestamp');
  const at = new Date(created).toISOString();
  return {
    schemaVersion: MARKET_EVIDENCE_ARCHIVE_FORMAT,
    archiveId: options.archiveId,
    provenanceClass: options.provenanceClass,
    coverage: { from: at, to: at, fields: [...options.fields], statement: options.statement },
    records: [],
    rawPayloads: {},
  };
}

const canonical = (value: string) => new Date(parseStrictTimestamp(value)!).toISOString();

/** Latest revision of one observation: the record nothing supersedes. */
function latestRevision(records: readonly MarketEvidenceRecord[], field: string, source: string, observedAt: string) {
  const same = records.filter((r) => r.field === field && r.source === source && canonical(r.observedAt) === observedAt);
  const superseded = new Set(same.map((r) => r.supersedes).filter((id): id is string => id !== null));
  return same.find((r) => !superseded.has(r.evidenceId)) ?? null;
}

export async function appendProviderCapture(
  archive: MarketEvidenceArchive,
  capture: ProviderCapture,
  parsers: CaptureParsers,
): Promise<CaptureResult> {
  const result = (partial: Partial<CaptureResult> & Pick<CaptureResult, 'outcome'>): CaptureResult => ({
    archive, rawPayloadDigest: null, added: [], revised: [], unchanged: 0, skipped: [], rejection: null, replayReasons: [], ...partial,
  });
  const verifyParsers = { fred: parsers.fred, twelve_data: parsers.twelve_data };

  const ingestedMs = parseStrictTimestamp(capture.ingestedAt);
  if (ingestedMs === null) return result({ outcome: 'REJECTED', rejection: 'INVALID_INGESTED_AT' });
  const ingestedAt = new Date(ingestedMs).toISOString();
  // The log's last known instant: the end of its coverage or its latest
  // ingestion, whichever is later. An archive without coverage is still a log.
  const latestIngestion = archive.records.map((r) => r.ingestedAt)
    .reduce<string | null>((latest, t) => (latest === null || isStrictlyAfter(t, latest) ? t : latest), null);
  const floor = archive.coverage && (latestIngestion === null || isStrictlyAfter(archive.coverage.to, latestIngestion))
    ? archive.coverage.to : latestIngestion;
  const before = floor === null ? null : await replayMarketEvidence(archive, floor, { parsers: verifyParsers });
  if (before !== null && before.status === 'INVALID') {
    return result({ outcome: 'REJECTED', rejection: 'ARCHIVE_INVALID', replayReasons: before.reasonCodes });
  }
  if (floor !== null && isStrictlyAfter(floor, ingestedAt)) {
    return result({ outcome: 'REJECTED', rejection: 'INGESTION_OUT_OF_ORDER' });
  }
  const series = CAPTURE_SERIES.find((s) => s.provider === capture.provider && s.symbol === capture.symbol
    && s.sourceRecordId === capture.sourceRecordId);
  if (!series) return result({ outcome: 'REJECTED', rejection: 'UNKNOWN_SERIES' });

  const digest = await sha256Text(capture.body);
  if (Object.prototype.hasOwnProperty.call(archive.rawPayloads, digest)) {
    return result({ outcome: 'ALREADY_CAPTURED', rawPayloadDigest: digest });
  }

  const read = capture.provider === 'fred'
    ? parsers.fred(capture.body, capture.symbol)
    : [parsers.twelve_data(capture.body, capture.symbol)];
  const skipped: { observedAt: string | null; reason: string }[] = [];
  const usable: { value: number; observedAt: string }[] = [];
  for (const point of read) {
    if (point.value === null || point.observedAt === null) {
      skipped.push({ observedAt: point.observedAt, reason: point.unavailableReason ?? 'valeur ou horodatage absent' });
    } else if (isStrictlyAfter(point.observedAt, ingestedAt)) {
      // A source time after reception is a clock defect; it is not corrected.
      skipped.push({ observedAt: canonical(point.observedAt), reason: 'OBSERVED_AFTER_INGESTION' });
    } else {
      usable.push({ value: point.value, observedAt: canonical(point.observedAt) });
    }
  }
  if (usable.length === 0) return result({ outcome: 'REJECTED', rejection: 'NO_USABLE_OBSERVATION', rawPayloadDigest: digest, skipped });

  const revision = `cap-${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
  const spec = MARKET_EVIDENCE_FIELD_SPEC[series.field];
  const records: MarketEvidenceRecord[] = [];
  const added: string[] = [];
  const revised: string[] = [];
  let unchanged = 0;
  for (const { value, observedAt } of usable) {
    const prior = latestRevision(archive.records, series.field, capture.provider, observedAt);
    if (prior && Object.is(prior.value, value)) {
      unchanged += 1;
      continue;
    }
    const evidenceId = `${capture.provider}:${series.sourceRecordId}:${observedAt}:${revision}`;
    records.push({
      evidenceId,
      field: series.field,
      instrument: spec.instrument,
      unit: spec.unit,
      observationType: series.observationType,
      value,
      source: capture.provider,
      sourceRecordId: series.sourceRecordId,
      observedAt,
      // Neither provider states a publication time: unknown, not inferred.
      publishedAt: null,
      ingestedAt,
      revision,
      supersedes: prior ? prior.evidenceId : null,
      rawPayloadDigest: digest,
    });
    (prior ? revised : added).push(evidenceId);
  }

  const next: MarketEvidenceArchive = {
    ...archive,
    coverage: archive.coverage ? { ...archive.coverage, to: ingestedAt } : null,
    records: [...archive.records, ...records],
    rawPayloads: { ...archive.rawPayloads, [digest]: { parser: capture.provider, symbol: capture.symbol, body: capture.body } },
  };
  const after = await replayMarketEvidence(next, ingestedAt, { parsers: verifyParsers });
  if (after.status === 'INVALID') {
    return result({ outcome: 'REJECTED', rejection: 'ARCHIVE_WOULD_BE_INVALID', rawPayloadDigest: digest, skipped,
      replayReasons: after.reasonCodes });
  }
  return result({ outcome: 'APPENDED', archive: next, rawPayloadDigest: digest, added, revised, unchanged, skipped,
    replayReasons: after.reasonCodes });
}

export interface MergeResult {
  readonly outcome: 'MERGED' | 'REJECTED';
  readonly archive: MarketEvidenceArchive | null;
  /** Captures replayed into the merge, in reception order. */
  readonly captures: readonly {
    readonly rawPayloadDigest: string;
    readonly provider: 'fred' | 'twelve_data';
    readonly sourceRecordId: string;
    readonly ingestedAt: string;
    readonly fromArchive: string;
    readonly outcome: CaptureResult['outcome'];
  }[];
  readonly problems: readonly string[];
}

/**
 * Merges capture logs by replaying every kept capture (its exact bytes, at
 * its recorded reception time) into a new log, in reception order. The
 * sources are not modified. The merge declares no coverage: each source
 * declares its own window, and nothing establishes completeness between
 * them. It is CAPTURED only if every source is. It is rejected when a source
 * is invalid, when a capture's reception time is ambiguous, or when the
 * replayed captures do not reproduce the sources' records.
 */
export async function mergeCaptureArchives(
  sources: readonly MarketEvidenceArchive[],
  options: { readonly archiveId: string; readonly parsers: CaptureParsers },
): Promise<MergeResult> {
  const problems: string[] = [];
  const verifyParsers = { fred: options.parsers.fred, twelve_data: options.parsers.twelve_data };
  const pending: { digest: string; provider: 'fred' | 'twelve_data'; symbol: MarketSymbol; sourceRecordId: string;
    body: string; ingestedAt: string; fromArchive: string }[] = [];
  for (const source of sources) {
    const latest = source.records.map((r) => r.ingestedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    const check = latest ? await replayMarketEvidence(source, latest, { parsers: verifyParsers }) : null;
    if (check === null || check.status === 'INVALID') {
      problems.push(`SOURCE_INVALID:${String(source?.archiveId)}:${check?.reasonCodes.join(',') ?? 'EMPTY'}`);
      continue;
    }
    for (const [digest, payload] of Object.entries(source.rawPayloads)) {
      const named = source.records.filter((r) => r.rawPayloadDigest === digest);
      const times = [...new Set(named.map((r) => canonical(r.ingestedAt)))];
      const series = [...new Set(named.map((r) => `${r.source}|${r.sourceRecordId}`))];
      // A kept body no record names has no recorded reception time: not placed.
      if (times.length !== 1 || series.length !== 1) {
        problems.push(`CAPTURE_TIME_OR_SERIES_AMBIGUOUS:${source.archiveId}:${digest}`);
        continue;
      }
      pending.push({ digest, provider: payload.parser, symbol: payload.symbol, sourceRecordId: named[0].sourceRecordId ?? '',
        body: payload.body, ingestedAt: times[0], fromArchive: source.archiveId });
    }
  }
  if (problems.length > 0) return { outcome: 'REJECTED', archive: null, captures: [], problems };

  pending.sort((a, b) => Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt) || (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  let archive: MarketEvidenceArchive = {
    schemaVersion: MARKET_EVIDENCE_ARCHIVE_FORMAT,
    archiveId: options.archiveId,
    provenanceClass: sources.every((s) => s.provenanceClass === 'CAPTURED') ? 'CAPTURED' : 'SYNTHETIC_FIXTURE',
    coverage: null,
    records: [],
    rawPayloads: {},
  };
  const captures: MergeResult['captures'][number][] = [];
  for (const c of pending) {
    const r = await appendProviderCapture(archive, {
      provider: c.provider, symbol: c.symbol, sourceRecordId: c.sourceRecordId, body: c.body, ingestedAt: c.ingestedAt,
    }, options.parsers);
    captures.push({ rawPayloadDigest: c.digest, provider: c.provider, sourceRecordId: c.sourceRecordId,
      ingestedAt: c.ingestedAt, fromArchive: c.fromArchive, outcome: r.outcome });
    if (r.outcome === 'REJECTED') problems.push(`CAPTURE_REJECTED:${c.fromArchive}:${c.digest}:${r.rejection}`);
    archive = r.archive;
  }

  // Every source record must come back, except a value a strictly earlier
  // capture already holds unchanged (then the earlier record stands for it).
  const merged = new Map(archive.records.map((r) => [r.evidenceId, r]));
  for (const source of sources) {
    for (const r of source.records) {
      const same = merged.get(r.evidenceId);
      const heldEarlier = archive.records.some((m) => m.field === r.field && m.source === r.source
        && canonical(m.observedAt) === canonical(r.observedAt) && Object.is(m.value, r.value)
        && isStrictlyAfter(r.ingestedAt, m.ingestedAt));
      if (same ? canonicalJson(same) !== canonicalJson(normalizeRecord(r)) : !heldEarlier) {
        problems.push(`RECORD_NOT_REPRODUCED:${source.archiveId}:${r.evidenceId}`);
      }
    }
  }
  return problems.length > 0
    ? { outcome: 'REJECTED', archive: null, captures, problems }
    : { outcome: 'MERGED', archive, captures, problems };
}

/** A record in the key order and canonical times the capture writes. */
function normalizeRecord(r: MarketEvidenceRecord): MarketEvidenceRecord {
  return {
    evidenceId: r.evidenceId, field: r.field, instrument: r.instrument, unit: r.unit, observationType: r.observationType,
    value: r.value, source: r.source, sourceRecordId: r.sourceRecordId, observedAt: canonical(r.observedAt),
    publishedAt: r.publishedAt === null ? null : canonical(r.publishedAt), ingestedAt: canonical(r.ingestedAt),
    revision: r.revision, supersedes: r.supersedes, rawPayloadDigest: r.rawPayloadDigest,
  };
}
