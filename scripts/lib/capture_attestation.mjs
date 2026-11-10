/**
 * DATA-3 G3/G4 — what a capture log can prove about each capture, against
 * the raw-storage contract (docs/XAU_V2_DATA_3_RAW_STORAGE_CONTRACT.md).
 *
 * A capture is one kept provider body (`rawPayloads[digest]`) and the records
 * that name it. For each, this audit checks what the log itself can show:
 * the exact bytes are kept and hash to their key, the request names a known
 * capture series, every record of the capture was received at one instant,
 * and captures were appended in reception order. What the log cannot show —
 * who or what collected the bytes, under which licence and retention — comes
 * only from an optional attestation manifest, and is then DECLARED, never
 * proved: no signature scheme exists, so `attestation` is always NOT_PROVEN.
 *
 * Report only. It never changes a replay, a status or a decision, and it reads
 * no clock, file, network or provider.
 *
 * Instants are read with the repository's strict rule (shared/strict_timestamp.ts):
 * an impossible date (2026-09-31) or the `-00:00` offset is unreadable, never
 * rolled over to a real one as Date.parse does, and instants compare to the
 * nanosecond.
 */

import { createHash } from 'node:crypto';
import { loadBackendModule } from './backend_module_loader.mjs';

const { parseStrictTimestampNanos } = await loadBackendModule('shared/strict_timestamp.ts');

// 1.1.0: strict instants (an impossible date is unreadable; nanosecond comparison); a capture listed twice in a
// manifest refuses it (MANIFEST_CAPTURE_DUPLICATED).
// 1.2.0: receivedAt keeps the digits beyond the millisecond that the comparison uses (it used to drop them).
export const CAPTURE_ATTESTATION_REPORT_VERSION = 'capture-attestation-1.2.0';
export const ATTESTATION_MANIFEST_FORMAT = 'xau.capture-attestation-manifest.v1';

/** What a manifest may declare. Anything else is refused, not ignored. */
const MANIFEST_KEYS = ['archiveId', 'attestedBy', 'captures', 'collector', 'licence', 'schemaVersion'];
const ATTESTER_KINDS = ['OPERATOR', 'COLLECTOR'];
const REDISTRIBUTION = ['NOT_ALLOWED', 'ALLOWED', 'UNKNOWN'];
/** Words a manifest must not use about itself: nothing here can be proved by this audit. */
const OVERCLAIM = /\b(VERIFIED|CERTIFIED|SIGNED|PROVEN|AUTHENTICATED)\b/i;

const sha256 = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
/** Exact instant (nanoseconds, bigint) or null. */
const instant = (v) => parseStrictTimestampNanos(v);
/** UTC text of an exact instant: the digits beyond the millisecond are kept, never dropped. */
const iso = (ns) => {
  const rest = ((ns % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const text = new Date(Number((ns - rest) / 1_000_000n)).toISOString();
  return rest === 0n ? text : text.replace('Z', `${String(rest).padStart(6, '0').replace(/0+$/, '')}Z`);
};

/** Problems of a manifest's own shape, and the claims it makes beyond what can be checked. */
function manifestProblems(manifest, archiveId) {
  const problems = [];
  if (!isObject(manifest)) return ['MANIFEST_UNREADABLE'];
  const keys = Object.keys(manifest).sort();
  if (keys.some((k) => !MANIFEST_KEYS.includes(k))) problems.push('MANIFEST_UNKNOWN_KEY');
  if (manifest.schemaVersion !== ATTESTATION_MANIFEST_FORMAT) problems.push('MANIFEST_FORMAT_UNKNOWN');
  if (manifest.archiveId !== archiveId) problems.push('MANIFEST_ARCHIVE_MISMATCH');
  const by = manifest.attestedBy;
  if (!isObject(by) || !ATTESTER_KINDS.includes(by.kind) || !isText(by.name)) problems.push('MANIFEST_ATTESTER_INVALID');
  // A collector attestation would need a signature this repository cannot check.
  if (isObject(by) && (by.kind === 'COLLECTOR' || 'signature' in by)) problems.push('MANIFEST_CLAIM_EXCEEDS_PROOF');
  if (OVERCLAIM.test(JSON.stringify(manifest))) problems.push('MANIFEST_CLAIM_EXCEEDS_PROOF');
  const col = manifest.collector;
  if (col !== null && col !== undefined && (!isObject(col) || !isText(col.name) || !isText(col.version))) problems.push('MANIFEST_COLLECTOR_INVALID');
  const lic = manifest.licence;
  if (lic !== null && lic !== undefined && (!isObject(lic) || !isText(lic.termsReference) || !REDISTRIBUTION.includes(lic.redistribution)
      || !isText(lic.retention))) problems.push('MANIFEST_LICENCE_INVALID');
  if (!Array.isArray(manifest.captures) || manifest.captures.some((c) => !isObject(c) || !isText(c.rawPayloadDigest) || instant(c.receivedAt) === null)) {
    problems.push('MANIFEST_CAPTURES_INVALID');
  } else if (new Set(manifest.captures.map((c) => c.rawPayloadDigest)).size !== manifest.captures.length) {
    // One capture, one declaration: a second entry would silently replace the first.
    problems.push('MANIFEST_CAPTURE_DUPLICATED');
  }
  return [...new Set(problems)];
}

/**
 * @param archive  a capture log (DATA-1 archive format)
 * @param options.series  the configured capture series ({ provider, symbol, sourceRecordId, field }[])
 * @param options.manifest optional attestation manifest (xau.capture-attestation-manifest.v1)
 */
export function auditCaptureAttestation(archive, { series = [], manifest = null } = {}) {
  const base = { reportVersion: CAPTURE_ATTESTATION_REPORT_VERSION, attestation: 'NOT_PROVEN', upgradesReplay: false };
  if (!isObject(archive) || !Array.isArray(archive.records) || !isObject(archive.rawPayloads)) {
    return { ...base, archiveId: null, outcome: 'NOT_EVALUATED', reason: 'ARCHIVE_UNREADABLE', captures: [], findings: [], manifest: null };
  }
  const findings = [];
  const add = (code, extra = {}) => findings.push({ code, ...extra });
  const archiveId = typeof archive.archiveId === 'string' ? archive.archiveId : null;

  // Records by the bytes they name; a record naming no bytes, or bytes not kept, is a contract gap.
  const byDigest = new Map();
  for (const [index, r] of archive.records.entries()) {
    if (!isObject(r)) { add('RECORD_UNREADABLE', { index }); continue; }
    if (r.rawPayloadDigest === null || r.rawPayloadDigest === undefined) { add('RECORD_WITHOUT_RAW_PAYLOAD', { index, evidenceId: r.evidenceId ?? null }); continue; }
    if (!Object.hasOwn(archive.rawPayloads, r.rawPayloadDigest)) { add('RAW_PAYLOAD_MISSING', { index, rawPayloadDigest: r.rawPayloadDigest }); continue; }
    if (!byDigest.has(r.rawPayloadDigest)) byDigest.set(r.rawPayloadDigest, []);
    byDigest.get(r.rawPayloadDigest).push({ index, r });
  }

  const captures = [];
  for (const [digest, payload] of Object.entries(archive.rawPayloads)) {
    const recs = byDigest.get(digest) ?? [];
    if (recs.length === 0) add('ORPHAN_RAW_PAYLOAD', { rawPayloadDigest: digest });
    const bytesKept = isObject(payload) && typeof payload.body === 'string';
    const digestMatches = bytesKept && sha256(payload.body) === digest;
    if (!bytesKept) add('RAW_BYTES_MISSING', { rawPayloadDigest: digest });
    else if (!digestMatches) add('RAW_PAYLOAD_DIGEST_MISMATCH', { rawPayloadDigest: digest });
    const ids = [...new Set(recs.map(({ r }) => r.sourceRecordId))].sort();
    const known = recs.length > 0 && ids.length === 1 && series.some((s) => isObject(payload) && s.provider === payload.parser
      && s.symbol === payload.symbol && s.sourceRecordId === ids[0] && recs.every(({ r }) => r.field === s.field && r.source === s.provider));
    if (recs.length > 0 && ids.length > 1) add('PAYLOAD_SHARED_BY_SERIES', { rawPayloadDigest: digest, sourceRecordIds: ids });
    else if (recs.length > 0 && !known) add('UNKNOWN_SERIES', { rawPayloadDigest: digest });
    const received = [...new Set(recs.map(({ r }) => instant(r.ingestedAt)))];
    if (received.some((ms) => ms === null)) add('RECEPTION_INSTANT_UNREADABLE', { rawPayloadDigest: digest });
    else if (received.length > 1) add('CAPTURE_RECEPTION_NOT_SINGLE', { rawPayloadDigest: digest });
    captures.push({
      rawPayloadDigest: digest,
      provider: isObject(payload) ? payload.parser ?? null : null,
      symbol: isObject(payload) ? payload.symbol ?? null : null,
      sourceRecordIds: ids,
      records: recs.length,
      firstIndex: recs.length ? Math.min(...recs.map((x) => x.index)) : null,
      receivedAt: received.length === 1 && received[0] !== null ? iso(received[0]) : null,
      receivedNs: received.length === 1 ? received[0] : null,
      bytes: bytesKept ? 'KEPT' : 'MISSING',
      digest: !bytesKept ? 'NOT_CHECKED' : digestMatches ? 'MATCH' : 'MISMATCH',
      request: known ? 'KNOWN_SERIES' : 'NOT_ESTABLISHED',
    });
  }
  // Append order: captures appear in the log in reception order.
  const ordered = captures.filter((c) => c.firstIndex !== null && c.receivedNs !== null).sort((a, b) => a.firstIndex - b.firstIndex);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].receivedNs < ordered[i - 1].receivedNs) add('CAPTURES_OUT_OF_ORDER', { rawPayloadDigest: ordered[i].rawPayloadDigest });
  }

  // What only an attestation can say: who attested, which collector, under which licence.
  let manifestReport = null;
  const declared = archive.provenanceClass === 'CAPTURED' ? 'OPERATOR_DECLARED' : 'NOT_CAPTURED';
  let attestedBy = declared;
  let collector = 'NOT_RECORDED';
  let licence = 'NOT_RECORDED';
  if (manifest !== null) {
    const problems = manifestProblems(manifest, archiveId);
    for (const code of problems) add(code);
    const usable = problems.length === 0;
    if (usable) {
      // The manifest is a second declaration; it can contradict the log, never upgrade it.
      const listed = new Map(manifest.captures.map((c) => [c.rawPayloadDigest, c]));
      for (const c of captures) {
        const m = listed.get(c.rawPayloadDigest);
        if (!m) add('MANIFEST_CAPTURE_MISSING', { rawPayloadDigest: c.rawPayloadDigest });
        else if (c.receivedNs === null || instant(m.receivedAt) !== c.receivedNs) add('MANIFEST_RECEPTION_MISMATCH', { rawPayloadDigest: c.rawPayloadDigest });
      }
      for (const d of listed.keys()) if (!captures.some((c) => c.rawPayloadDigest === d)) add('MANIFEST_CAPTURE_UNKNOWN', { rawPayloadDigest: d });
      attestedBy = archive.provenanceClass === 'CAPTURED' ? `${manifest.attestedBy.kind}_DECLARED` : 'NOT_CAPTURED';
      collector = isObject(manifest.collector) ? 'DECLARED_UNVERIFIED' : 'NOT_RECORDED';
      licence = isObject(manifest.licence) ? 'DECLARED_UNVERIFIED' : 'NOT_RECORDED';
    }
    manifestReport = { usable, problems };
  }
  if (collector === 'NOT_RECORDED') add('COLLECTOR_IDENTITY_NOT_RECORDED');
  if (licence === 'NOT_RECORDED') add('LICENCE_NOT_RECORDED');

  const integrity = ['RAW_PAYLOAD_DIGEST_MISMATCH', 'RAW_BYTES_MISSING', 'RAW_PAYLOAD_MISSING', 'RECORD_WITHOUT_RAW_PAYLOAD', 'RECORD_UNREADABLE',
    'PAYLOAD_SHARED_BY_SERIES', 'UNKNOWN_SERIES', 'CAPTURE_RECEPTION_NOT_SINGLE', 'RECEPTION_INSTANT_UNREADABLE', 'CAPTURES_OUT_OF_ORDER', 'ORPHAN_RAW_PAYLOAD'];
  const broken = findings.some((f) => integrity.includes(f.code));
  return {
    ...base,
    archiveId,
    // BYTES_CONSISTENT: what the log can show holds; the rest stays declared at best.
    outcome: broken ? 'CONTRACT_BROKEN' : 'BYTES_CONSISTENT',
    reason: null,
    attestedBy,
    collector,
    licence,
    captures: captures.map(({ firstIndex, receivedNs, ...c }) => c),
    findings,
    manifest: manifestReport,
  };
}

/**
 * What must fail a validation: the log breaking the raw-storage contract, a
 * manifest that is malformed, contradicts the log or claims more than can be
 * checked, or a report that overstates itself. A collector or licence left
 * unrecorded is reported, not failed: no collector or licence register exists yet.
 */
export function attestationIntegrityProblems(report) {
  if (report.attestation !== 'NOT_PROVEN' || report.upgradesReplay !== false) return ['ATTESTATION_OVERSTATED'];
  return [...new Set(report.findings.map((f) => f.code))].filter((c) => !c.endsWith('_NOT_RECORDED'));
}
