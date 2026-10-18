/**
 * Official US macro releases as a local source of the terminal's Event
 * Impact and Gold Transmission summaries (OFFLINE).
 *
 * Each file is an adapter input document (the shape of tests/fixtures/
 * bls_cpi_table1_*.json and siblings), dispatched by `source.sourceCode` to
 * the existing Event Facts adapter. A RESOLVED release becomes one event
 * version whose knowledge cutoff is the adapter's official `publishedAt`
 * (B3), then one Event Impact and one Gold Transmission plan (the existing
 * deterministic processors). At a chain cutoff the plans are aggregated by
 * EIA-0 v2 with the same instants as release evidence, so a release
 * published after the cutoff is excluded and the summaries carry the chain's
 * own cutoff (no UPSTREAM_CUTOFF_MISMATCH). Identifiers are derived from the
 * bytes (no runtime, no database). Nothing is approved: the processors still
 * give INSUFFICIENT_EVIDENCE and HOLD / FORBIDDEN is unchanged.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { loadBackendModule } from './backend_module_loader.mjs';

const ADAPTERS = {
  bls_cpi_release: ['event_facts/bls_cpi_adapter.ts', 'mapBlsCpiReleaseToEventFacts'],
  bls_employment_situation_release: ['event_facts/bls_employment_situation_adapter.ts', 'mapBlsEmploymentReleaseToEventFacts'],
  dol_ui_weekly_claims_release: ['event_facts/dol_ui_weekly_claims_adapter.ts', 'mapDolUiWeeklyClaimsReleaseToEventFacts'],
  bea_personal_income_outlays_release: ['event_facts/bea_pce_adapter.ts', 'mapBeaPceReleaseToEventFacts'],
};
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** A UUID-shaped identifier derived from bytes (version 4 and variant bits set; never random). */
const uuidOf = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

function periodOf(state) {
  const metric = state?.facts?.metrics?.[0];
  const period = metric?.reference_period;
  if (!period) return null;
  if (period.kind === 'MONTH') return `${period.year}-${String(period.month).padStart(2, '0')}`;
  if (period.kind === 'WEEK_ENDING') return `semaine au ${period.date}`;
  return null;
}

/**
 * Reads release documents (absolute paths). Each entry: name, family,
 * period, publishedAt, status (RESOLVED or REJECTED with its reason), and,
 * when resolved, the event version and both plans. Never throws.
 */
export async function readOfficialReleases(files) {
  const ei = await loadBackendModule('event_impact/deterministic_processor.ts');
  const gt = await loadBackendModule('gold_transmission/deterministic_processor.ts');
  const instant = await loadBackendModule('event_facts/official_release_instant.ts');
  const entries = [];
  for (const file of [...files].sort()) {
    const name = path.basename(file);
    let bytes;
    let document;
    try {
      bytes = readFileSync(file);
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      entries.push({ name, status: 'REJECTED', reason: 'DOCUMENT_UNREADABLE', family: null, period: null, publishedAt: null });
      continue;
    }
    const adapter = ADAPTERS[document?.source?.sourceCode];
    if (!adapter) {
      entries.push({ name, status: 'REJECTED', reason: 'UNSUPPORTED_RELEASE_SOURCE', family: null, period: null, publishedAt: null });
      continue;
    }
    const mapped = (await loadBackendModule(adapter[0]))[adapter[1]](document);
    if (mapped?.kind !== 'RESOLVED') {
      entries.push({ name, status: 'REJECTED', reason: `ADAPTER_${mapped?.kind ?? 'FAILED'}${typeof mapped?.reason === 'string' ? `:${mapped.reason}` : ''}`,
        family: document?.release?.releaseFamily ?? null,
        period: null, publishedAt: null });
      continue;
    }
    // A version is known at its official release; one the adapter cannot date is refused (B3).
    const admitted = instant.admitEventVersionAtOfficialRelease(mapped, mapped.publishedAt);
    if (admitted.kind !== 'ADMITTED') {
      entries.push({ name, status: 'REJECTED', reason: admitted.reason, family: document.release?.releaseFamily ?? null, period: null, publishedAt: null });
      continue;
    }
    const fileHash = sha256(bytes);
    const eventVersion = {
      id: uuidOf(fileHash),
      clusterId: uuidOf(sha256(mapped.releaseIdentity.identityValue)),
      versionNumber: 1, transitionType: 'NOVELTY', knowledgeCutoff: admitted.publishedAt,
      effectiveTime: null, effectiveTimePrecision: null,
      canonicalEventStateSchemaVersion: mapped.canonicalEventStateSchemaVersion,
      canonicalEventState: mapped.canonicalEventState,
      officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
      supersedesVersionId: null, stateFingerprint: sha256(JSON.stringify(mapped.canonicalEventState)),
    };
    entries.push({
      name, status: 'RESOLVED', reason: null, family: mapped.canonicalEventState.facts.release_family,
      period: periodOf(mapped.canonicalEventState), publishedAt: admitted.publishedAt, artifactId: `sha256:${fileHash}`,
      eventVersion,
      impactPlan: ei.planDeterministicEventImpact({ eventVersion }),
      transmissionPlan: gt.planDeterministicGoldTransmission({ eventVersion }),
    });
  }
  return entries;
}

/** The release documents of a directory (`*.json`, safe names only). */
export function officialReleaseFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && SAFE_NAME.test(d.name)).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * EIA-0 v2 at one cutoff: the Event Impact and Gold Transmission summaries
 * (the chain's input shape) and which releases were known then.
 */
export async function aggregateOfficialReleasesAt(entries, knowledgeCutoff) {
  const eia2 = await loadBackendModule('event_aggregation/release_gate_contract.ts');
  const resolved = entries.filter((e) => e.status === 'RESOLVED');
  const evidence = resolved.map((e) => ({ eventVersionId: e.eventVersion.id, publishedAt: e.publishedAt }));
  const impact = eia2.aggregateEventPlansWithOfficialRelease('EVENT_IMPACT', resolved.map((e) => e.impactPlan), evidence, knowledgeCutoff);
  const transmission = eia2.aggregateEventPlansWithOfficialRelease('GOLD_TRANSMISSION', resolved.map((e) => e.transmissionPlan), evidence, knowledgeCutoff);
  const known = new Set(impact.eventVersionIds);
  const brief = (e) => ({ name: e.name, family: e.family, period: e.period, publishedAt: e.publishedAt });
  return {
    impact, transmission,
    known: resolved.filter((e) => known.has(e.eventVersion.id)).map(brief),
    notYetPublished: resolved.filter((e) => !known.has(e.eventVersion.id)).map(brief),
    rejected: entries.filter((e) => e.status !== 'RESOLVED').map((e) => ({ name: e.name, reason: e.reason })),
  };
}
