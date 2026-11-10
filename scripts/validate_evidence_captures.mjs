#!/usr/bin/env node
/**
 * DATA-3 local validation of real capture logs (not run in CI: the captures
 * stay on the operator's machine and are never committed).
 *
 *   node scripts/validate_evidence_captures.mjs [--out DIR] ARCHIVE.json...
 *
 * With no archive argument, it reads the archive.json files under
 * ~/.local/share/xau-v2/evidence/*. Sources are only read. It:
 *  1. checks each source: shape, payload digests, values re-read from bytes;
 *  2. merges them by replaying every capture at its recorded reception time,
 *     in reception order, into a new log without declared coverage, and
 *     checks that this reproduces the sources' records;
 *  3. replays the merge just before and at every capture and later, and
 *     checks no look-ahead, determinism, freshness, missing fields and
 *     HOLD / FORBIDDEN (CHAIN-0 runs with the golden fixture's non-market
 *     inputs, which are synthetic);
 *  4. audits the continuity of each source's declared window and of the
 *     merge, per series (gaps, duplicates, order, freshness intervals; see
 *     lib/capture_continuity.mjs). The audit never attests continuity;
 *  5. audits each source against the raw-storage contract (kept bytes, digest,
 *     request, reception, append order; an optional attestation.json beside
 *     archive.json is read as a declaration, never as proof; see
 *     lib/capture_attestation.mjs);
 *  6. writes merged-archive.json and report.json to --out.
 * Exit 0 when every check passes, 1 otherwise, 2 when no source is found.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBackendModule } from './lib/backend_module_loader.mjs';
import { auditCaptureContinuity, continuityOptions, declaredFieldHoles } from './lib/capture_continuity.mjs';
import { attestationIntegrityProblems, auditCaptureAttestation } from './lib/capture_attestation.mjs';

export { continuityOptions };

const { parseStrictTimestampNanos } = await loadBackendModule('shared/strict_timestamp.ts');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_DIR = path.join(homedir(), '.local', 'share', 'xau-v2', 'evidence');

function defaultSources() {
  if (!existsSync(DEFAULT_DIR)) return [];
  return readdirSync(DEFAULT_DIR).map((d) => path.join(DEFAULT_DIR, d, 'archive.json')).filter(existsSync).sort();
}

/**
 * Latest reception time of a source, compared as instants. A lexical sort
 * mis-orders `…:00Z` against `…:00.500Z` ('.' sorts before 'Z'). Instants are
 * read strictly and to the nanosecond: Date.parse rolled an impossible date
 * over to a real one and tied `.0001Z` with `.0004Z`. A value that does not
 * parse never wins; the replay then reports the source INVALID.
 */
export function latestIngestedAt(records) {
  let best = null;
  let bestNs = null;
  for (const r of records) {
    const ns = parseStrictTimestampNanos(r.ingestedAt);
    if (ns !== null && (bestNs === null || ns > bestNs)) { best = r.ingestedAt; bestNs = ns; }
  }
  return best ?? records.map((r) => r.ingestedAt).sort().at(-1);
}

/**
 * A declared window is not continuous for a covered field the audit found
 * unavailable inside it; a VERIFIED replay of that source would overstate it.
 */
export function continuityClaimProblems(replay, audit) {
  const problems = [];
  if (audit.continuity !== 'NOT_ATTESTED') problems.push('CONTINUITY_ATTESTED_BY_AUDIT');
  const holes = declaredFieldHoles(audit);
  if (replay.status === 'VERIFIED' && holes.length) problems.push(`VERIFIED_OVER_DECLARED_WINDOW_WITH_HOLES:${[...new Set(holes.map((h) => h.field))].join(',')}`);
  return problems;
}

/**
 * What a replay's own labels must not overstate. VERIFIED only when every
 * MP-0 field is held at the cutoff (DATA-3 L1), reproducible exactly when
 * VERIFIED, HISTORICAL_VERIFIED only on a VERIFIED replay. Returns the problems.
 */
export function verifiedClaimProblems(r) {
  const problems = [];
  if (r.status === 'VERIFIED' && Object.values(r.observations).some((o) => o === null)) problems.push('VERIFIED_WITH_FIELD_NOT_HELD');
  // A selected value too old for its freshness rule is not in the snapshot: the field is not held either.
  if (r.status === 'VERIFIED' && Object.values(r.observations).some((o) => o !== null && o.freshnessAtCutoff === 'UNAVAILABLE')) problems.push('VERIFIED_WITH_FIELD_UNAVAILABLE');
  // Replay 1.2.0 states the proof; a 1.1.0 replay carries none and is judged by the line above alone.
  if (r.status === 'VERIFIED' && Object.values(r.observations).some((o) => o !== null && o.freshnessProof !== undefined && o.freshnessProof !== 'FRESH')) {
    problems.push('VERIFIED_WITHOUT_FRESHNESS_PROOF');
  }
  if (r.reproducible !== (r.status === 'VERIFIED')) problems.push('REPRODUCIBLE_STATUS_MISMATCH');
  if (r.nature === 'HISTORICAL_VERIFIED' && r.status !== 'VERIFIED') problems.push('HISTORICAL_VERIFIED_WITHOUT_VERIFIED');
  return problems;
}

export async function validate(files, outDir) {
  const ev = await loadBackendModule('market_engine/evidence_archive.ts');
  const cap = await loadBackendModule('market_engine/evidence_capture.ts');
  const continuity = continuityOptions(ev, await loadBackendModule('market_engine/validate.ts'), cap);
  const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
  const providers = await loadBackendModule('market_engine/providers.ts');
  const { sha256Text } = await loadBackendModule('shared/canonical_json.ts');
  const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
  const golden = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json'), 'utf8'));
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); };
  const replay = (a, cutoff) => ev.replayMarketEvidence(a, cutoff, { parsers });

  // 1. Sources.
  const sources = [];
  const audits = [];
  const attestations = [];
  for (const file of files) {
    const bytes = readFileSync(file, 'utf8');
    const archive = JSON.parse(bytes);
    sources.push(archive);
    const latest = latestIngestedAt(archive.records);
    const r = await replay(archive, latest);
    check(`source ${archive.archiveId}: valid`, r.status !== 'INVALID', r.reasonCodes.join(','));
    for (const [digest, payload] of Object.entries(archive.rawPayloads)) {
      check(`source ${archive.archiveId}: body ${digest.slice(7, 19)} hashes to its digest`, await sha256Text(payload.body) === digest);
    }
    check(`source ${archive.archiveId}: every selected value re-read from its bytes`,
      Object.values(r.observations).filter(Boolean).every((o) => o.raw === 'RAW_VERIFIED'));
    // This used to read `status !== 'VERIFIED' || reproducible`, which the replay makes true by construction.
    const claims = verifiedClaimProblems(r);
    check(`source ${archive.archiveId}: VERIFIED and reproducible only on data held for every field`, claims.length === 0, claims.join(','));
    const audit = auditCaptureContinuity(archive, continuity);
    audits.push(audit);
    const gaps = continuityClaimProblems(r, audit);
    check(`source ${archive.archiveId}: declared window never presented as continuous over a hole`, gaps.length === 0, gaps.join(','));
    const manifestFile = path.join(path.dirname(file), 'attestation.json');
    const manifest = existsSync(manifestFile) ? (() => { try { return JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { return 'UNREADABLE'; } })() : null;
    const attestation = auditCaptureAttestation(archive, { series: cap.CAPTURE_SERIES, manifest });
    attestations.push(attestation);
    const broken = attestationIntegrityProblems(attestation);
    check(`source ${archive.archiveId}: every capture keeps its exact bytes, of a known series, received at one instant, in order; attestation not proven`,
      broken.length === 0, broken.join(','));
  }

  // 2. Merge, twice and in reverse order: same archive.
  const archiveId = 'data3-validation';
  const merge = await cap.mergeCaptureArchives(sources, { archiveId, parsers });
  check('merge: captures replayed in reception order reproduce every source record', merge.outcome === 'MERGED', merge.problems.join(' '));
  if (merge.outcome !== 'MERGED') return { checks, merge };
  const mergedDigest = await sha256Text(JSON.stringify(merge.archive));
  const reversed = await cap.mergeCaptureArchives([...sources].reverse(), { archiveId, parsers });
  check('merge: independent of source order', reversed.outcome === 'MERGED' && await sha256Text(JSON.stringify(reversed.archive)) === mergedDigest);
  const times = merge.captures.map((c) => Date.parse(c.ingestedAt));
  check('merge: captures in non-decreasing reception time', times.every((t, i) => i === 0 || times[i - 1] <= t));
  check('merge: no coverage claimed', merge.archive.coverage === null);
  check('merge: CAPTURED only if every source is', merge.archive.provenanceClass === (sources.every((s) => s.provenanceClass === 'CAPTURED') ? 'CAPTURED' : 'SYNTHETIC_FIXTURE'));
  const revisions = merge.archive.records.filter((r) => r.supersedes !== null).length;

  // 3. Scenarios.
  const iso = (ms) => new Date(ms).toISOString();
  const last = Math.max(...times);
  const cutoffs = [...new Set([...times.flatMap((t) => [t - 1, t]), last + 86_400_000, last + 7 * 86_400_000])].sort((a, b) => a - b).map(iso);
  const scenarios = [];
  for (const cutoff of cutoffs) {
    const r = await replay(merge.archive, cutoff);
    const again = await replay(structuredClone(merge.archive), cutoff);
    const known = { ...merge.archive, records: merge.archive.records.filter((x) => Date.parse(x.ingestedAt) <= Date.parse(cutoff)) };
    const past = await replay(known, cutoff);
    const outcome = bridge.evaluateDecisionChainOnMarketEvidence(golden.input, r);
    const values = (s) => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'reason')));
    const selected = Object.values(r.observations).filter(Boolean);
    check(`${cutoff}: deterministic digest`, r.digest === again.digest);
    check(`${cutoff}: no look-ahead`, JSON.stringify(r.observations) === JSON.stringify(past.observations)
      && values(r.marketSnapshot) === values(past.marketSnapshot)
      && selected.every((o) => Date.parse(o.ingestedAt) <= Date.parse(cutoff) && Date.parse(o.observedAt) <= Date.parse(cutoff)));
    check(`${cutoff}: incomplete, never reproducible`, r.status === 'INCOMPLETE' && r.reproducible === false && r.reasonCodes.includes('COVERAGE_NOT_DECLARED'));
    check(`${cutoff}: never HISTORICAL_VERIFIED nor LIVE nature`, r.nature !== 'HISTORICAL_VERIFIED' && r.nature !== 'LIVE');
    check(`${cutoff}: DXY, bid, ask unavailable`, ['dxy', 'bid', 'ask'].every((f) => r.observations[f] === null && r.marketSnapshot[f].value === null));
    check(`${cutoff}: publication time kept unknown`, selected.every((o) => o.publishedAt === null && o.unknown.includes('publishedAt')));
    check(`${cutoff}: replay HOLD / FORBIDDEN`, r.decision === 'HOLD' && r.execution === 'FORBIDDEN');
    check(`${cutoff}: chain HOLD / FORBIDDEN`, outcome.kind === 'REJECTED'
      ? outcome.chainState === 'HOLD' && outcome.execution === 'FORBIDDEN'
      : outcome.result.chainState === 'HOLD' && outcome.result.execution === 'FORBIDDEN'
        && outcome.result.trace.find((t) => t.stage === 'ACTION').state === 'ABSTAIN');
    scenarios.push({
      cutoff, status: r.status, nature: r.nature, digest: r.digest, mp1: r.selection?.state ?? null,
      mp0: outcome.kind === 'COMPLETED' ? outcome.result.stages.marketPricing.state : 'REJECTED',
      available: r.marketSnapshot.available,
      fields: Object.fromEntries(Object.entries(r.observations).map(([f, o]) => [f, o
        ? { value: o.value, observedAt: o.observedAt, ingestedAt: o.ingestedAt, freshness: o.freshnessAtCutoff, ageSeconds: o.ageSecondsAtCutoff }
        : null])),
    });
  }

  const mergedAudit = auditCaptureContinuity(merge.archive, continuity);
  check('merge: continuity audit attests nothing', mergedAudit.continuity === 'NOT_ATTESTED' && mergedAudit.window?.basis === 'RECEPTION_SPAN');

  const report = {
    continuity: { sources: audits, merged: mergedAudit },
    attestation: attestations,
    sources: sources.map((s) => ({ archiveId: s.archiveId, provenanceClass: s.provenanceClass, records: s.records.length,
      coverage: s.coverage && { from: s.coverage.from, to: s.coverage.to, fields: s.coverage.fields } })),
    merged: { archiveId, records: merge.archive.records.length, captures: merge.captures, revisions, coverage: null },
    scenarios,
    checks,
  };
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'merged-archive.json'), `${JSON.stringify(merge.archive, null, 2)}\n`);
    writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return { checks, merge, report };
}

async function main() {
  const argv = process.argv.slice(2);
  let outDir = path.join(process.env.TMPDIR || tmpdir(), 'xau-data3-validation');
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
    else files.push(path.resolve(argv[i]));
  }
  const sources = files.length ? files : defaultSources();
  if (sources.length === 0) {
    process.stderr.write(`no capture archive found (looked in ${DEFAULT_DIR})\n`);
    return 2;
  }
  // Inside a source directory (or equal to it), by path segments: a sibling such
  // as `evidence/a-out` is not inside `evidence/a`.
  const insideSourceDir = (f) => {
    const relative = path.relative(path.dirname(f), outDir);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if (sources.some(insideSourceDir)) {
    process.stderr.write('--out must not be a source directory\n');
    return 1;
  }
  const { checks, report } = await validate(sources, outDir);
  const failed = checks.filter((c) => !c.ok);
  for (const c of failed) process.stdout.write(`FAIL ${c.name} ${c.detail}\n`);
  if (report) {
    for (const a of [...report.continuity.sources, report.continuity.merged]) {
      process.stdout.write(`continuity ${a.archiveId}: ${a.outcome}, continuity ${a.continuity} (window ${a.window ? `${a.window.from} → ${a.window.to}, ${a.window.basis}` : a.reason})\n`);
      for (const f of a.findings) {
        process.stdout.write(`  ${f.code} ${f.series ?? f.field ?? ''}${f.from ? ` ${f.from} → ${f.to} (${f.durationSeconds} s)` : f.at ? ` at ${f.at}` : ''}\n`);
      }
      for (const s of a.series) {
        for (const g of s.observationGaps) {
          process.stdout.write(`  gap ${s.series} ${g.from} → ${g.to} (${g.durationSeconds} s${g.missingDates ? `, ${g.missingWeekdays} weekday(s), ${g.missingSaturdaysSundays} Sat/Sun` : ''}; tolerance ${g.tolerance})\n`);
        }
      }
    }
    for (const a of report.attestation) {
      process.stdout.write(`attestation ${a.archiveId}: ${a.outcome}, ${a.captures.length} capture(s), attested by ${a.attestedBy}, collector ${a.collector}, licence ${a.licence}; attestation ${a.attestation}\n`);
    }
    for (const s of report.scenarios) {
      const f = Object.entries(s.fields).map(([k, v]) => `${k}=${v ? `${v.value}(${v.freshness})` : '—'}`).join(' ');
      process.stdout.write(`${s.cutoff} ${s.status} mp1=${s.mp1} mp0=${s.mp0} ${f}\n`);
    }
  }
  process.stdout.write(`${checks.length - failed.length}/${checks.length} checks passed; output in ${outDir}\n`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
