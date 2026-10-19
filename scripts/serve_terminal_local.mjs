#!/usr/bin/env node
/**
 * Local terminal server: serves frontend/ and the CHAIN-0 terminal view on
 * the loopback interface only.
 *
 *   node scripts/serve_terminal_local.mjs [--port 4173 [--port-range N]] [--input chain-input.json]
 *     [--archive market-evidence-archive.json [--archive-digest sha256:...] [--cutoff ISO]]
 *     [--captures DIR]   (DATA-2 capture logs DIR/<capture>/archive.json, merged in memory)
 *     [--data-root DIR]  (selectable local data: DIR/evidence/<capture>/archive.json, DIR/positioning/<cftc file> + declaration,
 *                         DIR/official/<release>.json)
 *     [--events ID]      (default macro events source: input, official:repository, official:local)
 *     [--positioning-cot cot.csv --cot-dataset futures-only|futures-and-options --cot-published-at ISO --cot-received-at ISO
 *      [--cot-report-date YYYY-MM-DD]]
 *
 * Port: without --port the server takes 4173, or the next free port among the
 * next 9 when it is busy (loopback only, whatever the port). An explicit --port
 * is strict (one port, a busy one is an error) unless --port-range N allows
 * the next N-1 ports too.
 *
 * With --archive, the chain's market snapshot comes from a DATA-1 replay of
 * that archive at --cutoff (default: the input document's cutoff); every
 * other input comes from the input document.
 *
 * GET /local/v2/terminal.json runs CHAIN-0 on the golden fixture (or on the
 * `{ knowledgeCutoff, input }` file given with --input) and returns the
 * read-only view. index.html is served with V2_VIEW_URL pointing at it; the
 * published page keeps V2_VIEW_URL empty and shows the V2 panels as
 * unavailable. No database, provider, broker or network call is made, and
 * the Supabase settings stay empty, so the V1 panels run in labelled demo
 * mode.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadBackendModule } from './lib/backend_module_loader.mjs';
import { codeIdentity, describeCode } from './lib/code_identity.mjs';
import { aggregateOfficialReleasesAt, officialReleaseFiles, readOfficialReleases } from './lib/official_events.mjs';
import { TERMINAL_SCENARIOS, findTerminalScenario } from './lib/terminal_scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');
export const GOLDEN_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json');
export const SYNTHETIC_ARCHIVE = path.join(ROOT, 'tests', 'fixtures', 'market_evidence_archive_synthetic.json');
/** The official release documents committed with the repository (parsed from BLS, BEA and DOL artifacts). */
export const REPOSITORY_OFFICIAL_RELEASES = ['bea_pce_2026_07.json', 'bea_pce_2026_08.json', 'bls_cpi_table1_2026_07.json',
  'bls_cpi_table1_2026_08.json', 'bls_employment_situation_2026_07.json', 'bls_employment_situation_2026_08.json',
  'dol_ui_weekly_claims_2026_10_01.json'].map((name) => path.join(ROOT, 'tests', 'fixtures', name));
export const DEFAULT_PORT = 4173;
export const DEFAULT_PORT_RANGE = 10;
export const MAX_PORT_RANGE = 50;
export const LOOPBACK_ADDRESS = '127.0.0.1';
export const VIEW_PATH = '/local/v2/terminal.json';
export const SCENARIOS_PATH = '/local/v2/scenarios.json';
/** Identifies this server and its checkout, so the launcher never starts a second instance. */
export const HEALTH_PATH = '/local/v2/health.json';
/** In --archive mode, the instants at which the archive received records: the cutoffs worth replaying. */
export const ARCHIVE_CUTOFFS_PATH = '/local/v2/archive-cutoffs.json';
/** The local data sources the page may choose and inspect (market archives, capture logs, CFTC files). */
export const CATALOG_PATH = '/local/v2/catalog.json';
/** Size bound of that list (a page bound, not a market rule): the latest instants are kept. */
export const MAX_ARCHIVE_CUTOFFS = 500;
/** Market fields of a DATA-1 archive, in MP-0 order. */
/** The market fields a replay reads (MP-1 order); a VERIFIED replay needs every one of them. */
export const ARCHIVE_FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];
const VIEW_URL_PLACEHOLDER = "V2_VIEW_URL: '',";
const SCENARIOS_URL_PLACEHOLDER = "V2_SCENARIOS_URL: '',";
const CUTOFFS_URL_PLACEHOLDER = "V2_ARCHIVE_CUTOFFS_URL: '',";
const CATALOG_URL_PLACEHOLDER = "V2_CATALOG_URL: '',";
const CODE_PLACEHOLDER = '<span id="code-version">—</span>';
/** A replay cutoff asked by the page: an explicit UTC instant, nothing else. */
const REQUEST_CUTOFF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** index.html with the local URLs; refuses to start if a hook moved. */
/**
 * `archiveCutoffs`: the server replays an archive (--archive or --captures); only then does the page
 * get the replay-cutoff URL, so the default page never asks a route that answers 404.
 */
export function localIndexHtml({ archiveCutoffs: withArchive = false, code = null } = {}) {
  const html = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  for (const placeholder of [VIEW_URL_PLACEHOLDER, SCENARIOS_URL_PLACEHOLDER, CUTOFFS_URL_PLACEHOLDER, CATALOG_URL_PLACEHOLDER, CODE_PLACEHOLDER]) {
    if (html.split(placeholder).length !== 2) {
      throw new Error(`frontend/index.html must contain exactly one "${placeholder}"`);
    }
  }
  return html.replace(VIEW_URL_PLACEHOLDER, `V2_VIEW_URL: '${VIEW_PATH}',`)
    .replace(SCENARIOS_URL_PLACEHOLDER, `V2_SCENARIOS_URL: '${SCENARIOS_PATH}',`)
    .replace(CUTOFFS_URL_PLACEHOLDER, withArchive ? `V2_ARCHIVE_CUTOFFS_URL: '${ARCHIVE_CUTOFFS_PATH}',` : CUTOFFS_URL_PLACEHOLDER)
    .replace(CATALOG_URL_PLACEHOLDER, `V2_CATALOG_URL: '${CATALOG_PATH}',`)
    // The footer names the code this server runs (commit, branch), so an outdated checkout is visible.
    .replace(CODE_PLACEHOLDER, `<span id="code-version" title="${escapeHtml(describeCode(code))}">${escapeHtml(describeCode(code))}</span>`);
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The replay cutoffs of an --archive: every distinct reception instant
 * (`ingestedAt`) of its records, in time order, at most MAX_ARCHIVE_CUTOFFS
 * (the latest). At such an instant the record just received is known. The
 * archive is only read; a malformed one gives no instant (its replay is
 * rejected by DATA-1 anyway). `defaultCutoff` is the cutoff used without one.
 */
export function archiveCutoffs(archiveFile, defaultCutoff) {
  let archive = null;
  try {
    archive = JSON.parse(readFileSync(archiveFile, 'utf8'));
  } catch { /* no instant */ }
  return archiveCutoffsOf(archive, defaultCutoff);
}

/**
 * Adds to a cutoff list the instant a CFTC positioning source becomes known:
 * the latest publishedAt / observedAt of its extracted evidence (P-0 drops a
 * value published or observed after the cutoff). Listed in `knownAt` and
 * merged into `cutoffs` (time order). No source, no extraction: unchanged.
 */
export function withPositioningKnownAt(list, source) {
  const evidence = source?.kind === 'CFTC_FILE' && source.conversion?.status === 'EXTRACTED' ? source.conversion.evidence : [];
  const ms = evidence.flatMap((e) => [e.publishedAt, e.observedAt]).filter((at) => typeof at === 'string' && REQUEST_CUTOFF.test(at))
    .map((at) => Date.parse(at)).filter(Number.isFinite);
  if (ms.length === 0 || ms.length !== evidence.length * 2) return list;
  const at = new Date(Math.max(...ms)).toISOString();
  const cutoffs = [...new Set([...list.cutoffs, at])].sort((a, b) => Date.parse(a) - Date.parse(b));
  return { ...list, cutoffs, knownAt: [{ at, input: 'POSITIONING', source: source.id, reportDate: source.conversion.reportDate ?? null }] };
}

/** archiveCutoffs of an archive already in memory (a --captures merge). */
export function archiveCutoffsOf(archive, defaultCutoff, capturedFields = null) {
  const records = archive && Array.isArray(archive.records) ? archive.records : [];
  const instants = new Map();
  const fields = new Map(ARCHIVE_FIELDS.map((field) => [field, { field, records: 0, sources: new Set(), observed: [], ingested: [] }]));
  for (const record of records) {
    const entry = record && fields.get(record.field);
    if (entry) {
      entry.records += 1;
      if (typeof record.source === 'string' && /^[a-z0-9_]{1,32}$/.test(record.source)) entry.sources.add(record.source);
      for (const [key, list] of [['observedAt', entry.observed], ['ingestedAt', entry.ingested]]) {
        const at = record[key];
        if (typeof at === 'string' && REQUEST_CUTOFF.test(at) && Number.isFinite(Date.parse(at))) list.push(Date.parse(at));
      }
    }
    const at = record && record.ingestedAt;
    if (typeof at !== 'string' || !REQUEST_CUTOFF.test(at)) continue;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) continue;
    if (!instants.has(ms)) instants.set(ms, { at: new Date(ms).toISOString(), fields: new Set() });
    if (ARCHIVE_FIELDS.includes(record.field)) instants.get(ms).fields.add(record.field);
  }
  const receptions = [...instants.entries()].sort(([a], [b]) => a - b)
    .map(([, { at, fields: received }]) => ({ at, fields: ARCHIVE_FIELDS.filter((field) => received.has(field)) }));
  const cutoffs = receptions.map(({ at }) => at);
  return {
    schemaVersion: 'xau.terminal-archive-cutoffs.v1',
    defaultCutoff: typeof defaultCutoff === 'string' ? defaultCutoff : null,
    truncated: cutoffs.length > MAX_ARCHIVE_CUTOFFS,
    cutoffs: cutoffs.slice(-MAX_ARCHIVE_CUTOFFS),
    // The market fields whose records arrived at each instant, in the same order as cutoffs.
    receptions: receptions.slice(-MAX_ARCHIVE_CUTOFFS),
    // What the archive holds per field, whatever the cutoff: counts and ranges, no judgement.
    fields: [...fields.values()].map(({ field, records: count, sources, observed, ingested }) => {
      const iso = (list, pickLast) => (list.length ? new Date(pickLast ? Math.max(...list) : Math.min(...list)).toISOString() : null);
      return {
        field, records: count, sources: [...sources].sort(),
        // Whether the DATA-2 capture tooling defines a series for the field (null: not known here).
        captureSeries: capturedFields === null ? null : capturedFields.has(field),
        firstObservedAt: iso(observed, false), lastObservedAt: iso(observed, true),
        firstIngestedAt: iso(ingested, false), lastIngestedAt: iso(ingested, true),
      };
    }),
  };
}

/** Reads a chain input document; errors are reported, never thrown. */
export function readChainDocument(file) {
  try {
    const document = JSON.parse(readFileSync(file, 'utf8'));
    if (document === null || typeof document !== 'object') return { ok: false, error: 'document is not an object' };
    return { ok: true, knowledgeCutoff: document.knowledgeCutoff, input: document.input };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * P2: a local CFTC Commitments of Traders file converted to positioning
 * evidence (one report of COMEX gold). Bytes are hashed here; the adapter is
 * pure. Instants are the operator's declarations, never the file's dates.
 */
export async function readPositioningCot({ file, publishedAt, receivedAt, reportDate = null, dataset = null }) {
  const adapter = await loadBackendModule('positioning_engine/cftc_cot_offline_adapter.ts');
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return { label: path.basename(file), conversion: { status: 'REJECTED', reasonCodes: ['INVALID_REQUEST'], detail: `illisible : ${error.code ?? error.message}`, reportDate: null, evidence: [] } };
  }
  const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const conversion = adapter.convertCftcCotReport({ text: bytes.toString('utf8'), artifactId, publishedAt, receivedAt, reportDate, dataset });
  return { label: path.basename(file), conversion };
}

/**
 * --captures DIR: every DIR/<capture>/archive.json (DATA-2 capture logs, only
 * read), merged in memory by reception time with the DATA-3 merge, which
 * re-reads every body and refuses ambiguity. Nothing is written. A failed merge
 * gives no archive: the replay then rejects it (HOLD), and `problems` says why.
 */
export async function readCaptures(capturesDir) {
  const cap = await loadBackendModule('market_engine/evidence_capture.ts');
  const providers = await loadBackendModule('market_engine/providers.ts');
  const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
  let files = [];
  try {
    files = readdirSync(capturesDir, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => path.join(capturesDir, d.name, 'archive.json')).filter((f) => existsSync(f)).sort();
  } catch (error) {
    return { archive: null, sources: 0, problems: [`CAPTURES_DIR_UNREADABLE:${error.code ?? 'ERROR'}`] };
  }
  if (files.length === 0) return { archive: null, sources: 0, problems: ['NO_CAPTURE_ARCHIVE'] };
  const sources = [];
  for (const file of files) {
    try {
      sources.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return { archive: null, sources: files.length, problems: [`SOURCE_UNREADABLE:${path.basename(path.dirname(file))}`] };
    }
  }
  const merge = await cap.mergeCaptureArchives(sources, { archiveId: 'local-captures', parsers });
  return merge.outcome === 'MERGED'
    ? { archive: merge.archive, sources: files.length, problems: [] }
    : { archive: null, sources: files.length, problems: merge.problems.length ? merge.problems : ['MERGE_REJECTED'] };
}

/** Catalog notes in plain words for the start line (the page has its own wording). */
const START_NOTES = {
  EVIDENCE_DIR_ABSENT: 'pas de dossier evidence/ (journaux de capture)',
  POSITIONING_DIR_ABSENT: 'pas de dossier positioning/ (fichiers CFTC : déposer le fichier puis node scripts/cot_declare.mjs)',
};

/** A source identifier the page may send: never a path, only what the catalog lists. */
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// artifactId and sourceUrl (optional, additive): the bytes declared and where the operator says they came from.
const COT_DECLARATION_KEYS = ['artifactId', 'contractMarketCode', 'dataset', 'publicationBasis', 'publishedAt', 'receivedAt', 'reportDate', 'schemaVersion', 'sourceUrl'];
/**
 * DATA-REAL-4 (optional, additive): what the declared publication instant rests on. EXPLICIT_OFFICIAL_MAPPING:
 * an official document pairs this report with its publication date; OFFICIAL_SCHEDULE_INFERRED: deduced from
 * the CFTC's tentative release schedule and its "usually the previous Tuesday" rule (not proved per report).
 */
const PUBLICATION_BASIS_KINDS = ['EXPLICIT_OFFICIAL_MAPPING', 'OFFICIAL_SCHEDULE_INFERRED'];
const validPublicationBasis = (b) => b && typeof b === 'object' && !Array.isArray(b)
  && Object.keys(b).sort().join() === 'kind,reference' && PUBLICATION_BASIS_KINDS.includes(b.kind)
  && typeof b.reference === 'string' && /^https:\/\/(www\.)?cftc\.gov\/[A-Za-z0-9._~%\/-]*$/.test(b.reference);
const SOURCE_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%\/-]*)?$/;

/**
 * The CFTC files of a positioning directory, each with its declaration
 * `<name>.declaration.json` (schema `xau.cftc-cot-declaration.v1`: dataset,
 * publishedAt, receivedAt, optional reportDate and contractMarketCode). Files
 * are only read. A file without a valid declaration is listed, never converted;
 * an unknown format is named by the adapter. Never throws.
 */
export async function readPositioningDir(dir) {
  const adapter = await loadBackendModule('positioning_engine/cftc_cot_offline_adapter.ts');
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch (error) {
    return { entries: [], problem: `POSITIONING_DIR_UNREADABLE:${error.code ?? 'ERROR'}` };
  }
  const entries = [];
  for (const name of names) {
    if (name.endsWith('.declaration.json')) continue;
    if (!SAFE_NAME.test(name)) {
      entries.push({ name: null, ignored: `nom de fichier non pris en charge (${JSON.stringify(name).slice(0, 40)})` });
      continue;
    }
    const file = path.join(dir, name);
    const declarationFile = path.join(dir, `${name.replace(/\.[^.]*$/, '')}.declaration.json`);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      entries.push({ name, conversion: null, declaration: null, problem: `FILE_UNREADABLE:${error.code ?? 'ERROR'}` });
      continue;
    }
    const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const formatProblem = adapter.cftcCotFormatProblem(bytes.toString('utf8'));
    let declaration = null;
    let problem = null;
    try {
      const raw = JSON.parse(readFileSync(declarationFile, 'utf8'));
      const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : null;
      if (keys === null || raw.schemaVersion !== 'xau.cftc-cot-declaration.v1'
          || keys.some((key) => !COT_DECLARATION_KEYS.includes(key))
          || (raw.sourceUrl !== undefined && (typeof raw.sourceUrl !== 'string' || !SOURCE_URL.test(raw.sourceUrl)))
          || (raw.publicationBasis !== undefined && !validPublicationBasis(raw.publicationBasis))) problem = 'DECLARATION_INVALID';
      // A declaration bound to other bytes says nothing about this file (changed after it was declared).
      else if (raw.artifactId !== undefined && raw.artifactId !== artifactId) problem = 'DECLARATION_DIGEST_MISMATCH';
      else declaration = raw;
    } catch (error) {
      problem = error.code === 'ENOENT' ? 'DECLARATION_MISSING' : 'DECLARATION_INVALID';
    }
    const conversion = declaration === null ? null : adapter.convertCftcCotReport({
      text: bytes.toString('utf8'), artifactId, publishedAt: declaration.publishedAt, receivedAt: declaration.receivedAt,
      reportDate: declaration.reportDate ?? null, dataset: declaration.dataset,
      ...(declaration.contractMarketCode !== undefined ? { contractMarketCode: declaration.contractMarketCode } : {}),
    });
    entries.push({ name, artifactId, declaration, problem, formatProblem, conversion,
      inspection: adapter.inspectCftcCotFile(bytes.toString('utf8')) });
  }
  return { entries, problem: null };
}

/** Sub-directories of a captures directory that hold no archive.json (safe names only; others are not listed). */
function captureDirsWithoutArchive(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_NAME.test(d.name)
      && !existsSync(path.join(dir, d.name, 'archive.json'))).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/** Each capture log of a directory, read on its own (no merge). */
function readCaptureLogs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_NAME.test(d.name))
      .map((d) => ({ name: d.name, file: path.join(dir, d.name, 'archive.json') })).filter((l) => existsSync(l.file))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(({ name, file }) => {
        try {
          return { name, archive: JSON.parse(readFileSync(file, 'utf8')), problem: null };
        } catch {
          return { name, archive: null, problem: 'SOURCE_UNREADABLE' };
        }
      });
  } catch {
    return [];
  }
}

export async function buildLocalView({
  inputFile = GOLDEN_FIXTURE, archiveFile = null, archiveDigest = undefined, cutoff = null, now = () => new Date(),
  positioningCot = null, capturesDir = null, dataRoot = null, events: eventsDefault = null,
} = {}) {
  const chain = await loadBackendModule('decision_chain/dry_run.ts');
  const obs = await loadBackendModule('observability/offline_receipt.ts');
  const view = await loadBackendModule('decision_chain/terminal_view.ts');
  const evidence = await loadBackendModule('market_engine/evidence_archive.ts');
  const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
  const providers = await loadBackendModule('market_engine/providers.ts');
  // Raw payloads are checked with the runtime parsers themselves.
  const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
  const captures = capturesDir === null ? null : await readCaptures(capturesDir);
  const capturedFields = new Set((await loadBackendModule('market_engine/evidence_capture.ts')).CAPTURE_SERIES.map((series) => series.field));
  const inputDocument = inputFile === GOLDEN_FIXTURE
    ? { kind: 'GOLDEN_FIXTURE', label: path.relative(ROOT, GOLDEN_FIXTURE) }
    : { kind: 'LOCAL_INPUT_FILE', label: path.basename(inputFile) };
  const golden = JSON.parse(readFileSync(GOLDEN_FIXTURE, 'utf8'));
  const lastReceptionOf = (archive) => (archive === null ? null : (archiveCutoffsOf(archive, null).cutoffs.at(-1) ?? null));

  // ---- Market sources. Each: id, kind, label, load() (null for the input document), default cutoff rule.
  const market = new Map();
  market.set('input', { id: 'input', kind: 'INPUT_DOCUMENT', label: `document d'entrée (${inputDocument.label})`, load: null });
  if (archiveFile !== null) {
    market.set('archive', { id: 'archive', kind: 'ARCHIVE_FILE', label: path.basename(archiveFile), pinned: archiveDigest,
      load: () => { try { return JSON.parse(readFileSync(archiveFile, 'utf8')); } catch { return null; } },
      // --archive keeps the input document's cutoff (unchanged).
      lastReception: false });
  }
  const captureDirs = [];
  const dataNotes = [];
  if (capturesDir !== null) captureDirs.push({ dir: capturesDir, merged: captures });
  if (dataRoot !== null) {
    const evidenceDir = path.join(dataRoot, 'evidence');
    if (!existsSync(evidenceDir)) dataNotes.push('EVIDENCE_DIR_ABSENT');
    else if (!captureDirs.some((c) => path.resolve(c.dir) === path.resolve(evidenceDir))) {
      captureDirs.push({ dir: evidenceDir, merged: await readCaptures(evidenceDir) });
    }
  }
  for (const { dir, merged } of captureDirs) {
    const tag = SAFE_NAME.test(path.basename(dir)) ? path.basename(dir) : 'captures';
    // A capture directory without archive.json is left out of the merge and of the list: say so, never silently.
    for (const name of captureDirsWithoutArchive(dir)) dataNotes.push(`CAPTURE_LOG_WITHOUT_ARCHIVE:${tag}/${name}`);
    const mergedArchive = merged.archive;
    market.set(`merged:${tag}`, { id: `merged:${tag}`, kind: 'CAPTURES_MERGED',
      label: `captures ${tag} (${merged.sources} journal(aux) fusionné(s))`, load: () => (mergedArchive === null ? null : structuredClone(mergedArchive)),
      lastReception: true, problems: merged.problems, sources: merged.sources });
    for (const log of readCaptureLogs(dir)) {
      const archive = log.archive;
      market.set(`log:${tag}:${log.name}`, { id: `log:${tag}:${log.name}`, kind: 'CAPTURE_LOG', label: `journal ${log.name} (${tag})`,
        load: () => (archive === null ? null : structuredClone(archive)), lastReception: true,
        problems: log.problem ? [log.problem] : [] });
    }
  }
  const defaultMarket = archiveFile !== null ? 'archive' : capturesDir !== null ? [...market.keys()].find((k) => k.startsWith('merged:')) : 'input';

  // ---- Positioning sources: the document's own evidence, the --positioning-cot file, the declared CFTC files.
  const positioning = new Map();
  positioning.set('input', { id: 'input', kind: 'INPUT_DOCUMENT', label: `document d'entrée (${inputDocument.label})`, conversion: null });
  const cot = positioningCot === null ? null : await readPositioningCot(positioningCot);
  if (cot !== null) positioning.set('cli-cot', { id: 'cli-cot', kind: 'CFTC_FILE', label: cot.label, conversion: cot.conversion, declaredBy: 'OPTIONS' });
  const positioningDir = dataRoot === null ? null : path.join(dataRoot, 'positioning');
  const dirRead = positioningDir === null ? null : existsSync(positioningDir) ? await readPositioningDir(positioningDir) : { entries: [], problem: 'POSITIONING_DIR_ABSENT' };
  const ignoredFiles = [];
  for (const entry of dirRead?.entries ?? []) {
    if (entry.name === null) { ignoredFiles.push(entry.ignored); continue; }
    positioning.set(`cot:${entry.name}`, { id: `cot:${entry.name}`, kind: 'CFTC_FILE', label: entry.name, conversion: entry.conversion,
      declaredBy: 'DECLARATION_FILE', declaration: entry.declaration, problem: entry.problem ?? null, formatProblem: entry.formatProblem ?? null,
      artifactId: entry.artifactId ?? null, inspection: entry.inspection ?? null });
  }
  const defaultPositioning = cot !== null ? 'cli-cot' : 'input';

  // ---- Macro event sources: the document's own summaries, or official release documents aggregated at the cutoff.
  const events = new Map();
  events.set('input', { id: 'input', kind: 'INPUT_DOCUMENT', label: `document d'entrée (${inputDocument.label})`, entries: null });
  events.set('official:repository', { id: 'official:repository', kind: 'OFFICIAL_RELEASES',
    label: 'publications officielles du dépôt (BLS CPI, NFP ; BEA PCE ; DOL claims)', entries: await readOfficialReleases(REPOSITORY_OFFICIAL_RELEASES) });
  if (dataRoot !== null) {
    const officialFiles = officialReleaseFiles(path.join(dataRoot, 'official'));
    if (officialFiles.length) {
      events.set('official:local', { id: 'official:local', kind: 'OFFICIAL_RELEASES', label: 'publications officielles locales (official/)',
        entries: await readOfficialReleases(officialFiles) });
    }
  }
  // --events: the default events source (a catalog id); an unknown id falls back to the document, said in the notes.
  const defaultEvents = eventsDefault !== null && events.has(eventsDefault) ? eventsDefault : 'input';
  if (eventsDefault !== null && !events.has(eventsDefault)) dataNotes.push(`EVENTS_SOURCE_UNKNOWN:${eventsDefault}`);
  /** The chain input with the chosen macro summaries recomputed at `cutoff`, and the facts behind them. */
  const withEventsAt = async (source, input, cutoff) => {
    if (source.entries === null || typeof input !== 'object' || input === null || Array.isArray(input)) return { input, officialEvents: null };
    const agg = await aggregateOfficialReleasesAt(source.entries, cutoff);
    return {
      input: { ...input, eventImpact: agg.impact.summary, goldTransmission: agg.transmission.summary },
      officialEvents: { label: source.label, known: agg.known, notYetPublished: agg.notYetPublished, rejected: agg.rejected,
        impactStatus: agg.impact.summary.status, transmissionStatus: agg.transmission.summary.status,
        reasonCodes: [...new Set([...agg.impact.reasonCodes, ...agg.transmission.reasonCodes])] },
    };
  };
  const positioningFileOf = (source) => (source.kind !== 'CFTC_FILE' ? null : {
    label: source.label,
    status: source.conversion?.status ?? 'REJECTED',
    reportDate: source.conversion?.reportDate ?? null,
    dataset: source.conversion?.dataset ?? null,
    reason: source.conversion === null ? `${source.problem ?? 'NON_CONVERTI'} — déclaration requise (${source.label.replace(/\.[^.]*$/, '')}.declaration.json)`
      : source.conversion.status === 'EXTRACTED' ? null : `${source.conversion.reasonCodes.join(', ')} — ${source.conversion.detail}`,
  });
  const withPositioningOf = (source) => (input) => (source.kind !== 'CFTC_FILE' || typeof input !== 'object' || input === null || Array.isArray(input)
    ? input : { ...input, positioningEvidence: source.conversion?.status === 'EXTRACTED' ? source.conversion.evidence : [] });

  const defaultCutoffOf = (source, document) => cutoff
    ?? (source.lastReception ? lastReceptionOf(source.load()) : null)
    ?? (document.ok ? document.knowledgeCutoff : null);
  /** 4.5.0: cutoffs of the input's precomputed summaries, for the view's alignment line. */
  const inputCutoffsOf = (input) => view.terminalInputCutoffs(input);
  /** Replays an archive, then runs CHAIN-0 on its snapshot. */
  const fromArchive = async (archive, knowledgeCutoff, baseInput, viewOrigin, pinned, document = undefined, positioningFile = null, eventsSource = null) => {
    const replay = await evidence.replayMarketEvidence(archive, knowledgeCutoff,
      // A pin that was asked for is always applied: an empty or malformed one must fail the
      // replay (digest mismatch), never silently turn the pin off.
      { parsers, ...(pinned !== undefined ? { pinnedArchiveDigest: pinned } : {}) });
    // The macro summaries, when computed from official releases, are computed at the replay's own cutoff.
    const withEvents = eventsSource === null ? { input: baseInput, officialEvents: null } : await withEventsAt(eventsSource, baseInput, replay.knowledgeCutoff);
    baseInput = withEvents.input;
    const outcome = bridge.evaluateDecisionChainOnMarketEvidence(baseInput, replay);
    const receipt = outcome.kind === 'COMPLETED'
      ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
    const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
      ? receipt.fingerprint : null;
    return view.buildTerminalView(outcome, digest, viewOrigin, now().toISOString(), replay, document, positioningFile,
      inputCutoffsOf(baseInput), withEvents.officialEvents);
  };
  /**
   * Without a scenario, the server's input with the selected market and
   * positioning sources (catalog ids; defaults: what the options chose); with
   * one, that simulation and nothing else. A request cutoff replays an archive
   * source at that instant. null for anything not in the catalog or not allowed.
   */
  const render = async (scenarioId = null, { cutoff: requestCutoff = null, market: marketId = null, positioning: positioningId = null,
    events: eventsId = null } = {}) => {
    if (scenarioId !== null && (requestCutoff !== null || marketId !== null || positioningId !== null || eventsId !== null)) return null;
    if (scenarioId === null) {
      const marketSource = market.get(marketId ?? defaultMarket);
      const positioningSource = positioning.get(positioningId ?? defaultPositioning);
      const eventsSource = events.get(eventsId ?? defaultEvents);
      if (!marketSource || !positioningSource || !eventsSource) return null;
      if (requestCutoff !== null && (marketSource.load === null || !REQUEST_CUTOFF.test(requestCutoff))) return null;
      const document = readChainDocument(inputFile);
      const withPositioning = withPositioningOf(positioningSource);
      const positioningFile = positioningFileOf(positioningSource);
      if (marketSource.load !== null) {
        const knowledgeCutoff = requestCutoff ?? defaultCutoffOf(marketSource, document);
        return fromArchive(marketSource.load(), knowledgeCutoff, document.ok ? withPositioning(document.input) : undefined,
          { kind: 'LOCAL_MARKET_ARCHIVE', label: marketSource.label }, marketSource.pinned, inputDocument, positioningFile,
          eventsSource.entries === null ? null : eventsSource);
      }
      const withEvents = document.ok ? await withEventsAt(eventsSource, withPositioning(document.input), document.knowledgeCutoff)
        : { input: undefined, officialEvents: null };
      // An unreadable document still yields a HOLD view, through CHAIN-0's own rejection.
      const outcome = document.ok
        ? chain.evaluateDecisionChain(withEvents.input, document.knowledgeCutoff)
        : chain.evaluateDecisionChain(undefined, undefined);
      const receipt = outcome.kind === 'COMPLETED' ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
      const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED' ? receipt.fingerprint : null;
      return view.buildTerminalView(outcome, digest, inputDocument, now().toISOString(), null, undefined, positioningFile,
        document.ok ? inputCutoffsOf(withEvents.input) : null, withEvents.officialEvents);
    }
    const scenario = findTerminalScenario(scenarioId);
    if (!scenario) return null;
    if (scenario.archive) {
      const built = scenario.archive(JSON.parse(readFileSync(SYNTHETIC_ARCHIVE, 'utf8')));
      return fromArchive(built.archive, built.knowledgeCutoff, golden.input, { kind: 'LOCAL_SCENARIO', label: scenario.id });
    }
    const built = scenario.build(golden);
    const outcome = chain.evaluateDecisionChain(built.input, built.knowledgeCutoff);
    const receipt = outcome.kind === 'COMPLETED' ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
    const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED' ? receipt.fingerprint : null;
    return view.buildTerminalView(outcome, digest, { kind: 'LOCAL_SCENARIO', label: scenario.id }, now().toISOString(), null, undefined, null,
      inputCutoffsOf(built.input));
  };
  render.captures = captures === null ? null : { sources: captures.sources, merged: captures.archive !== null,
    records: captures.archive?.records.length ?? 0, problems: captures.problems };
  render.positioning = cot === null ? null : { label: cot.label, ...cot.conversion, evidence: undefined, evidenceCount: cot.conversion.evidence.length };
  /**
   * Replay cutoffs of an archive source (default: the selected one); null when it is not an archive,
   * undefined when the positioning id is unknown. With a CFTC positioning source, the instant from
   * which its report is known is offered too (P-0's rule: published and received at or before the
   * cutoff), so the replay can reach it; nothing about the market changes.
   */
  render.archiveCutoffs = (marketId = null, positioningId = null) => {
    const source = market.get(marketId ?? defaultMarket);
    if (!source || source.load === null) return null;
    // Without an id: the server's own positioning source (e.g. --positioning-cot), as the view does.
    const pos = positioning.get(positioningId ?? defaultPositioning);
    if (pos === undefined) return undefined;
    const document = readChainDocument(inputFile);
    const list = withPositioningKnownAt(archiveCutoffsOf(source.load(), defaultCutoffOf(source, document), capturedFields), pos);
    // A captures merge: whether it succeeded and why not, so the page can say it (the replay only says "rejected").
    return source.kind === 'CAPTURES_MERGED' ? { ...list, captures: { sources: source.sources, merged: source.problems.length === 0,
      problems: [...source.problems] } } : list;
  };
  /**
   * What the operator can choose and inspect: every market and positioning
   * source, its period, provenance, validation state and reasons. Computed from
   * what was read at start; nothing is judged beyond the existing contracts.
   */
  const catalogEntries = [];
  for (const source of market.values()) {
    if (source.load === null) {
      catalogEntries.push({ id: source.id, kind: source.kind, label: source.label, replayable: false, provenanceClass: null, archiveId: null,
        records: null, coverage: null, observed: null, received: null, fields: [], validation: null, problems: [] });
      continue;
    }
    const archive = source.load();
    const list = archiveCutoffsOf(archive, null, capturedFields);
    const at = list.cutoffs.at(-1) ?? null;
    const check = at === null ? null : await evidence.replayMarketEvidence(archive, at, { parsers,
      ...(source.pinned !== undefined ? { pinnedArchiveDigest: source.pinned } : {}) });
    const span = (key1, key2) => {
      const values = list.fields.flatMap((f) => [f[key1], f[key2]]).filter((x) => typeof x === 'string').sort();
      return values.length ? { first: values[0], last: values.at(-1) } : null;
    };
    catalogEntries.push({
      id: source.id, kind: source.kind, label: source.label, replayable: true,
      provenanceClass: archive && typeof archive.provenanceClass === 'string' ? archive.provenanceClass : null,
      archiveId: archive && typeof archive.archiveId === 'string' ? archive.archiveId : null,
      records: archive && Array.isArray(archive.records) ? archive.records.length : 0,
      coverage: archive && archive.coverage && typeof archive.coverage === 'object'
        ? { from: archive.coverage.from ?? null, to: archive.coverage.to ?? null } : null,
      observed: span('firstObservedAt', 'lastObservedAt'),
      received: span('firstIngestedAt', 'lastIngestedAt'),
      fields: list.fields.filter((f) => f.records > 0).map((f) => f.field),
      // Replayed after its last reception: the state DATA-1 gives this archive with everything it received.
      validation: check === null ? { at: null, status: 'INVALID', nature: null, reasonCodes: ['NO_RECEPTION_INSTANT'] }
        : { at, status: check.status, nature: check.nature, reasonCodes: [...check.reasonCodes] },
      problems: [...(source.problems ?? [])],
    });
  }
  const positioningEntries = [...positioning.values()].map((source) => (source.kind === 'INPUT_DOCUMENT'
    ? { id: source.id, kind: source.kind, label: source.label, status: 'DOCUMENT', sourceApproval: null, dataset: null, reportDate: null,
      publishedAt: null, receivedAt: null, metrics: null, artifactId: null, reasonCodes: [], detail: null, declaredBy: null,
      dateColumn: null, fileDatasetMarker: null, sourceUrl: null, publicationBasis: null, fileReports: null, boundToBytes: null }
    : {
      id: source.id, kind: source.kind, label: source.label,
      status: source.conversion?.status ?? 'REJECTED',
      sourceApproval: 'NOT_APPROVED',
      dataset: source.conversion?.dataset ?? source.declaration?.dataset ?? null,
      reportDate: source.conversion?.reportDate ?? null,
      publishedAt: source.conversion?.evidence?.[0]?.publishedAt ?? source.declaration?.publishedAt ?? null,
      receivedAt: source.conversion?.evidence?.[0]?.observedAt ?? source.declaration?.receivedAt ?? null,
      metrics: source.conversion?.evidence?.length ?? 0,
      artifactId: source.conversion?.artifactId ?? source.artifactId ?? null,
      reasonCodes: source.conversion ? [...source.conversion.reasonCodes] : [source.problem ?? 'NOT_CONVERTED'],
      detail: source.conversion ? source.conversion.detail
        : source.problem === 'DECLARATION_DIGEST_MISMATCH'
          ? `le fichier a changé depuis sa déclaration (empreinte différente) : la déclarer à nouveau après vérification`
          : `${source.problem === 'DECLARATION_MISSING' ? 'déclaration absente' : 'déclaration invalide'} : ${source.label.replace(/\.[^.]*$/, '')}.declaration.json requis`
          + `${source.formatProblem ? ` ; ${source.formatProblem}` : ''}`,
      declaredBy: source.declaredBy,
      // 1.3.0 facts of the file itself, verbatim; the declaration is shown beside, never overridden.
      dateColumn: source.conversion?.dateColumn ?? null,
      fileDatasetMarker: source.conversion?.fileDatasetMarker ?? (source.inspection?.datasetMarkers?.length === 1 ? source.inspection.datasetMarkers[0] : null),
      sourceUrl: source.declaration?.sourceUrl ?? null,
      publicationBasis: source.declaration?.publicationBasis ? { ...source.declaration.publicationBasis } : null,
      // The reports of the market the file holds (from its header and rows), whatever is declared.
      fileReports: source.inspection && Array.isArray(source.inspection.reportDates) && source.inspection.reportDates.length
        ? { count: source.inspection.reportDates.length, first: source.inspection.reportDates[0], last: source.inspection.reportDates.at(-1) } : null,
      boundToBytes: source.declaration ? typeof source.declaration.artifactId === 'string' : null,
    }));
  const eventsEntries = [...events.values()].map((source) => ({
    id: source.id, kind: source.kind, label: source.label,
    releases: source.entries === null ? [] : source.entries.map((e) => ({ name: e.name, status: e.status, family: e.family,
      period: e.period, publishedAt: e.publishedAt, reason: e.reason, artifactId: e.artifactId ?? null })),
  }));
  render.catalog = () => ({
    schemaVersion: 'xau.terminal-data-catalog.v1',
    defaults: { market: defaultMarket, positioning: defaultPositioning, events: defaultEvents },
    events: structuredClone(eventsEntries),
    market: structuredClone(catalogEntries),
    positioning: structuredClone(positioningEntries),
    notes: [...dataNotes, ...(dirRead?.problem ? [dirRead.problem] : []), ...ignoredFiles],
  });
  return render;
}

/**
 * Content-Security-Policy of the served page. The only inline script is the
 * configuration block, allowed by its exact SHA-256 after injection; any
 * other inline or foreign script is refused. Network access is limited to
 * this server: no web font, no foreign stylesheet (system fonts only).
 */
export function contentSecurityPolicy(html) {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => body);
  if (inline.length !== 1) throw new Error(`expected exactly one inline script, found ${inline.length}`);
  const hash = createHash('sha256').update(inline[0], 'utf8').digest('base64');
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function send(response, status, type, body, method, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  response.end(method === 'HEAD' ? undefined : body);
}

/**
 * DNS-rebinding guard: the socket is loopback-only, but a hostile page can
 * still reach it through a rebound hostname. Only this server's exact
 * loopback origin is served; the comparison is byte-exact on purpose.
 */
export function isLoopbackHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Listens on the loopback address only, on `port` or, when it is busy
 * (EADDRINUSE and nothing else), on the next ports up to `range` ports in total.
 * Any other error (EACCES, ...) ends the search at once. The address is never
 * a parameter: a fallback cannot widen the exposure.
 */
export function listenOnLoopback(server, { port, range = 1 }) {
  const last = Math.min(port + range - 1, 65535);
  return new Promise((resolve, reject) => {
    const attempt = (candidate) => {
      const onError = (error) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && candidate < last) attempt(candidate + 1);
        else reject(Object.assign(error, { firstPort: port, lastPort: candidate }));
      };
      const onListening = () => {
        server.off('error', onError);
        resolve({ port: server.address().port, requested: port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, LOOPBACK_ADDRESS);
    };
    attempt(port);
  });
}

export async function createTerminalServer(options = {}) {
  const view = await buildLocalView(options);
  // The replay-cutoff URL only when some market source is an archive (never a request answered 404).
  // Read once: the server keeps running the code it loaded even if the checkout moves afterwards.
  const code = codeIdentity(ROOT);
  const index = localIndexHtml({ archiveCutoffs: view.catalog().market.some((source) => source.replayable), code });
  const csp = contentSecurityPolicy(index);
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const address = server.address();
    if (address === null || typeof address === 'string' || !isLoopbackHost(request.headers.host, address.port)) {
      send(response, 403, 'text/plain; charset=utf-8', 'forbidden host', method);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'method not allowed', method);
      return;
    }
    let pathname;
    let scenarioId;
    let requestCutoff;
    let marketId;
    let positioningId;
    let eventsId;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(url.pathname);
      scenarioId = url.searchParams.get('scenario') || null;
      requestCutoff = url.searchParams.get('cutoff') || null;
      marketId = url.searchParams.get('market') || null;
      positioningId = url.searchParams.get('positioning') || null;
      eventsId = url.searchParams.get('events') || null;
    } catch {
      send(response, 400, 'text/plain; charset=utf-8', 'bad request', method);
      return;
    }
    if (pathname === HEALTH_PATH) {
      // args: the server's own command-line options, so the launcher never reuses an instance showing other data.
      // code: the commit it runs, so the launcher never reuses a server left on older code.
      const health = { app: 'xau-v2-terminal-local', schemaVersion: 'xau.terminal-local-health.v2', root: ROOT, pid: process.pid,
        args: Array.isArray(options.launchArgs) ? options.launchArgs : [], code };
      send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(health), method);
      return;
    }
    if (pathname === SCENARIOS_PATH) {
      const list = TERMINAL_SCENARIOS.map(({ id, label }) => ({ id, label }));
      send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(list), method);
      return;
    }
    if (pathname === CATALOG_PATH) {
      send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(view.catalog()), method);
      return;
    }
    if (pathname === ARCHIVE_CUTOFFS_PATH) {
      if ((marketId !== null && !SOURCE_ID.test(marketId)) || (positioningId !== null && !SOURCE_ID.test(positioningId))) {
        send(response, 400, 'text/plain; charset=utf-8', 'market / positioning: catalog ids only', method);
        return;
      }
      const list = view.archiveCutoffs(marketId, positioningId);
      if (list === null) send(response, 404, 'text/plain; charset=utf-8', 'no archive', method);
      else if (list === undefined) send(response, 404, 'text/plain; charset=utf-8', 'unknown positioning source', method);
      else send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(list), method);
      return;
    }
    if (pathname === VIEW_PATH) {
      if ((marketId !== null && !SOURCE_ID.test(marketId)) || (positioningId !== null && !SOURCE_ID.test(positioningId))
          || (eventsId !== null && !SOURCE_ID.test(eventsId))) {
        send(response, 400, 'text/plain; charset=utf-8', 'market / positioning: catalog ids only', method);
        return;
      }
      if (scenarioId !== null && (marketId !== null || positioningId !== null || eventsId !== null)) {
        send(response, 400, 'text/plain; charset=utf-8', 'a scenario takes no data source', method);
        return;
      }
      if (requestCutoff !== null && (scenarioId !== null || view.archiveCutoffs(marketId) === null || !REQUEST_CUTOFF.test(requestCutoff))) {
        send(response, 400, 'text/plain; charset=utf-8', 'cutoff: archive source only, no scenario, UTC instant', method);
        return;
      }
      try {
        const body = await view(scenarioId, { cutoff: requestCutoff, market: marketId, positioning: positioningId, events: eventsId });
        if (body === null) send(response, 404, 'text/plain; charset=utf-8', 'unknown scenario or data source', method);
        else send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(body), method);
      } catch (error) {
        send(response, 500, 'text/plain; charset=utf-8', `view error: ${error.message}`, method);
      }
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      send(response, 200, CONTENT_TYPES['.html'], index, method, {
        'content-security-policy': csp, 'x-frame-options': 'DENY',
      });
      return;
    }
    const file = path.resolve(FRONTEND, `.${pathname}`);
    const type = CONTENT_TYPES[path.extname(file)];
    if (!file.startsWith(`${FRONTEND}${path.sep}`) || pathname.includes('\0') || !type) {
      send(response, 404, 'text/plain; charset=utf-8', 'not found', method);
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      send(response, 200, type, readFileSync(file), method);
    } catch {
      send(response, 404, 'text/plain; charset=utf-8', 'not found', method);
    }
  });
  // The launcher-facing main prints what --captures and --positioning-cot gave.
  server.terminalView = view;
  return server;
}

export function parseArgs(argv) {
  const options = { port: null, portRange: null, inputFile: GOLDEN_FIXTURE, archiveFile: null, archiveDigest: undefined, cutoff: null, positioningCot: null, capturesDir: null, dataRoot: null, events: null };
  const cot = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--port' && /^\d{1,5}$/.test(value ?? '') && Number(value) > 0 && Number(value) < 65536) {
      options.port = Number(value);
    } else if (flag === '--port-range' && /^\d{1,2}$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= MAX_PORT_RANGE) {
      options.portRange = Number(value);
    } else if (flag === '--input' && value) {
      options.inputFile = path.resolve(value);
    } else if (flag === '--archive' && value) {
      options.archiveFile = path.resolve(value);
    } else if (flag === '--archive-digest' && /^sha256:[0-9a-f]{64}$/.test(value ?? '')) {
      options.archiveDigest = value;
    } else if (flag === '--cutoff' && value) {
      options.cutoff = value;
    } else if (flag === '--events' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value ?? '')) {
      options.events = value;
    } else if (flag === '--data-root' && value) {
      options.dataRoot = path.resolve(value);
    } else if (flag === '--captures' && value) {
      options.capturesDir = path.resolve(value);
    } else if (flag === '--positioning-cot' && value) {
      cot.file = path.resolve(value);
    } else if (flag === '--cot-published-at' && value) {
      cot.publishedAt = value;
    } else if (flag === '--cot-received-at' && value) {
      cot.receivedAt = value;
    } else if (flag === '--cot-report-date' && value) {
      cot.reportDate = value;
    } else if (flag === '--cot-dataset' && (value === 'futures-only' || value === 'futures-and-options')) {
      cot.dataset = value === 'futures-only' ? 'FUTURES_ONLY' : 'FUTURES_AND_OPTIONS_COMBINED';
    } else {
      return null;
    }
  }
  // One market archive at most: a file or a captures directory.
  if (options.archiveFile !== null && options.capturesDir !== null) return null;
  // A CFTC file needs both declared instants; the instants mean nothing without a file.
  if (Object.keys(cot).length > 0) {
    if (!cot.file || !cot.publishedAt || !cot.receivedAt || !cot.dataset) return null;
    options.positioningCot = { reportDate: null, ...cot };
  }
  // --port-range only widens an explicit --port; without --port the default range applies.
  if (options.port === null) {
    if (options.portRange !== null) return null;
    options.port = DEFAULT_PORT;
    options.portRange = DEFAULT_PORT_RANGE;
  } else if (options.portRange === null) {
    options.portRange = 1;
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write('usage: node scripts/serve_terminal_local.mjs [--port 4173 [--port-range N]] [--input chain-input.json]'
      + ' [--archive archive.json [--archive-digest sha256:...] | --captures DIR] [--cutoff ISO] [--data-root DIR] [--events ID]'
      + ' [--positioning-cot cot.csv --cot-dataset futures-only|futures-and-options --cot-published-at ISO --cot-received-at ISO'
      + ' [--cot-report-date YYYY-MM-DD]]\n');
    process.exitCode = 1;
  } else {
    const { port: requested, portRange, ...serverOptions } = options;
    const server = await createTerminalServer({ ...serverOptions, launchArgs: process.argv.slice(2) });
    // A busy or forbidden port is the usual first-run problem (the demo is
    // often restarted): say so in one line instead of an unhandled 'error'
    // event with a raw stack trace.
    try {
      const { port } = await listenOnLoopback(server, { port: requested, range: portRange });
      // One write: a reader that sees the ready line also sees where the selector is (pipes may split writes).
      const lines = [];
      if (port !== requested) {
        lines.push(`le port ${requested} est occupé ; le port libre ${port} est utilisé (loopback uniquement)`);
      }
      lines.push(`http://127.0.0.1:${port}/ (CHAIN-0 DRY RUN, HOLD, exécution interdite) — Ctrl+C pour arrêter`);
      const c = server.terminalView.captures;
      if (c) {
        lines.push(c.merged
          ? `${c.sources} journal(aux) de captures fusionné(s) depuis ${serverOptions.capturesDir} (${c.records} enregistrements) ; historique non vérifié, HOLD`
          : `captures de ${serverOptions.capturesDir} non fusionnées (${c.problems.join(' ; ')}) ; marché indisponible, HOLD`);
      }
      const cot = server.terminalView.positioning;
      if (cot) {
        lines.push(cot.status === 'EXTRACTED'
          ? `positionnement lu dans ${cot.label} (CFTC COT, rapport du ${cot.reportDate}, ${cot.evidenceCount} mesures) ; source non approuvée, HOLD`
          : `fichier CFTC COT rejeté (${cot.reasonCodes.join(', ')} — ${cot.detail}) ; aucune preuve de positionnement retenue`);
      }
      if (serverOptions.dataRoot) {
        const catalog = server.terminalView.catalog();
        const read = catalog.positioning.filter((p) => p.kind === 'CFTC_FILE');
        lines.push(`données locales de ${serverOptions.dataRoot} : ${catalog.market.length - 1} source(s) de marché, `
          + `${read.length} fichier(s) CFTC (${read.filter((p) => p.status === 'EXTRACTED').length} lu(s)), à choisir dans « DONNÉES LOCALES »`
          + `${catalog.notes.length ? ` ; ${catalog.notes.map((note) => START_NOTES[note] ?? note).join(' ; ')}` : ''}`);
      }
      {
        const catalog = server.terminalView.catalog();
        const source = catalog.events.find((e) => e.id === catalog.defaults.events);
        if (source && source.kind === 'OFFICIAL_RELEASES') {
          lines.push(`événements macro : ${source.label} — ${source.releases.filter((r) => r.status === 'RESOLVED').length} publication(s) lue(s), `
            + 'agrégées au cutoff de chaque vue ; aucune interprétation (HOLD)');
        }
      }
      lines.push(`scénarios de simulation dans l'onglet CHAÎNE V2 (http://127.0.0.1:${port}/#chaine), sélecteur « SCÉNARIO DE SIMULATION » en haut du panneau`);
      process.stdout.write(lines.map((line) => `terminal local : ${line}\n`).join(''));
    } catch (error) {
      const busy = portRange > 1
        ? `aucun port libre entre ${error.firstPort} et ${error.lastPort} (EADDRINUSE) ; un autre terminal local tourne peut-être déjà. Arrêtez-le ou choisissez un autre port avec --port <numéro>.`
        : `le port ${requested} est déjà utilisé (EADDRINUSE) ; un autre terminal local tourne peut-être déjà. Choisissez un autre port avec --port <numéro> (ou --port-range <N> pour essayer les suivants).`;
      const reason = error.code === 'EADDRINUSE' ? busy
        : error.code === 'EACCES'
          ? `le port ${error.lastPort ?? requested} n'est pas autorisé (EACCES). Choisissez un port supérieur à 1024 avec --port <numéro>.`
          : `${error.code ?? 'erreur'} : ${error.message}`;
      process.stderr.write(`terminal local : impossible de démarrer, ${reason}\n`);
      process.exitCode = 1;
    }
  }
}
