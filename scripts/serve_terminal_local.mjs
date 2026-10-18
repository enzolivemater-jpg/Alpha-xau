#!/usr/bin/env node
/**
 * Local terminal server: serves frontend/ and the CHAIN-0 terminal view on
 * the loopback interface only.
 *
 *   node scripts/serve_terminal_local.mjs [--port 4173 [--port-range N]] [--input chain-input.json]
 *     [--archive market-evidence-archive.json [--archive-digest sha256:...] [--cutoff ISO]]
 *     [--captures DIR]   (DATA-2 capture logs DIR/<capture>/archive.json, merged in memory)
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
import { TERMINAL_SCENARIOS, findTerminalScenario } from './lib/terminal_scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');
export const GOLDEN_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json');
export const SYNTHETIC_ARCHIVE = path.join(ROOT, 'tests', 'fixtures', 'market_evidence_archive_synthetic.json');
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
/** Size bound of that list (a page bound, not a market rule): the latest instants are kept. */
export const MAX_ARCHIVE_CUTOFFS = 500;
/** Market fields of a DATA-1 archive, in MP-0 order. */
const ARCHIVE_FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];
const VIEW_URL_PLACEHOLDER = "V2_VIEW_URL: '',";
const SCENARIOS_URL_PLACEHOLDER = "V2_SCENARIOS_URL: '',";
const CUTOFFS_URL_PLACEHOLDER = "V2_ARCHIVE_CUTOFFS_URL: '',";
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
export function localIndexHtml() {
  const html = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  for (const placeholder of [VIEW_URL_PLACEHOLDER, SCENARIOS_URL_PLACEHOLDER, CUTOFFS_URL_PLACEHOLDER]) {
    if (html.split(placeholder).length !== 2) {
      throw new Error(`frontend/index.html must contain exactly one "${placeholder}"`);
    }
  }
  return html.replace(VIEW_URL_PLACEHOLDER, `V2_VIEW_URL: '${VIEW_PATH}',`)
    .replace(SCENARIOS_URL_PLACEHOLDER, `V2_SCENARIOS_URL: '${SCENARIOS_PATH}',`)
    .replace(CUTOFFS_URL_PLACEHOLDER, `V2_ARCHIVE_CUTOFFS_URL: '${ARCHIVE_CUTOFFS_PATH}',`);
}

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

export async function buildLocalView({
  inputFile = GOLDEN_FIXTURE, archiveFile = null, archiveDigest = undefined, cutoff = null, now = () => new Date(),
  positioningCot = null, capturesDir = null,
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
  const archiveMode = archiveFile !== null || captures !== null;
  /** The --archive file (read at each request) or the --captures merge; null when unreadable. */
  const loadArchive = () => {
    if (captures !== null) return captures.archive === null ? null : structuredClone(captures.archive);
    try {
      return JSON.parse(readFileSync(archiveFile, 'utf8'));
    } catch {
      return null; // replayed as ARCHIVE_SHAPE_INVALID, never thrown
    }
  };
  // --captures without --cutoff replays after the last reception, so the captures are seen at launch;
  // --archive keeps the input document's cutoff (unchanged).
  const lastReception = captures === null || captures.archive === null ? null
    : (archiveCutoffsOf(captures.archive, null).cutoffs.at(-1) ?? null);
  const defaultArchiveCutoff = (document) => cutoff ?? lastReception ?? (document.ok ? document.knowledgeCutoff : null);
  const origin = captures !== null
    ? { kind: 'LOCAL_MARKET_ARCHIVE', label: `captures ${path.basename(capturesDir)} (${captures.sources} journal(aux) fusionné(s))` }
    : archiveFile !== null ? { kind: 'LOCAL_MARKET_ARCHIVE', label: path.basename(archiveFile) }
    : inputFile === GOLDEN_FIXTURE
      ? { kind: 'GOLDEN_FIXTURE', label: path.relative(ROOT, GOLDEN_FIXTURE) }
      : { kind: 'LOCAL_INPUT_FILE', label: path.basename(inputFile) };
  // B4: in --archive mode only the market comes from the archive; every other input from this document.
  const inputDocument = inputFile === GOLDEN_FIXTURE
    ? { kind: 'GOLDEN_FIXTURE', label: path.relative(ROOT, GOLDEN_FIXTURE) }
    : { kind: 'LOCAL_INPUT_FILE', label: path.basename(inputFile) };
  const golden = JSON.parse(readFileSync(GOLDEN_FIXTURE, 'utf8'));
  // P2: with --positioning-cot the server's own input takes its positioning evidence from that file.
  const cot = positioningCot === null ? null : await readPositioningCot(positioningCot);
  const positioningFile = cot === null ? null : {
    label: cot.label, status: cot.conversion.status, reportDate: cot.conversion.reportDate, dataset: cot.conversion.dataset ?? null,
    reason: cot.conversion.status === 'EXTRACTED' ? null : `${cot.conversion.reasonCodes.join(', ')} — ${cot.conversion.detail}`,
  };
  const withPositioning = (input) => (cot === null || typeof input !== 'object' || input === null || Array.isArray(input)
    ? input : { ...input, positioningEvidence: cot.conversion.evidence });
  /** 4.5.0: cutoffs of the input's precomputed summaries, for the view's alignment line. */
  const inputCutoffsOf = (input) => view.terminalInputCutoffs(input);
  /** Replays an archive, then runs CHAIN-0 on its snapshot. */
  const fromArchive = async (archive, knowledgeCutoff, baseInput, viewOrigin, pinned, document = undefined, positioning = null) => {
    const replay = await evidence.replayMarketEvidence(archive, knowledgeCutoff,
      // A pin that was asked for is always applied: an empty or malformed one must fail the
      // replay (digest mismatch), never silently turn the pin off.
      { parsers, ...(pinned !== undefined ? { pinnedArchiveDigest: pinned } : {}) });
    const outcome = bridge.evaluateDecisionChainOnMarketEvidence(baseInput, replay);
    const receipt = outcome.kind === 'COMPLETED'
      ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
    const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
      ? receipt.fingerprint : null;
    return view.buildTerminalView(outcome, digest, viewOrigin, now().toISOString(), replay, document, positioning,
      inputCutoffsOf(baseInput));
  };
  /**
   * Without a scenario, the server's input; with one, that simulation. A
   * request cutoff replays the --archive at that instant; it exists only in
   * archive mode and without a scenario (null is returned otherwise).
   */
  const render = async (scenarioId = null, { cutoff: requestCutoff = null } = {}) => {
    if (requestCutoff !== null && (!archiveMode || scenarioId !== null || !REQUEST_CUTOFF.test(requestCutoff))) return null;
    let document;
    let viewOrigin = origin;
    if (scenarioId === null) {
      document = readChainDocument(inputFile);
      if (archiveMode) {
        const archive = loadArchive();
        const knowledgeCutoff = requestCutoff ?? defaultArchiveCutoff(document);
        return fromArchive(archive, knowledgeCutoff, document.ok ? withPositioning(document.input) : undefined, origin, archiveDigest,
          inputDocument, positioningFile);
      }
    } else {
      const scenario = findTerminalScenario(scenarioId);
      if (!scenario) return null;
      if (scenario.archive) {
        const built = scenario.archive(JSON.parse(readFileSync(SYNTHETIC_ARCHIVE, 'utf8')));
        return fromArchive(built.archive, built.knowledgeCutoff, golden.input, { kind: 'LOCAL_SCENARIO', label: scenario.id });
      }
      const built = scenario.build(golden);
      document = { ok: true, knowledgeCutoff: built.knowledgeCutoff, input: built.input };
      viewOrigin = { kind: 'LOCAL_SCENARIO', label: scenario.id };
    }
    // An unreadable document still yields a HOLD view, through CHAIN-0's own rejection.
    const own = scenarioId === null;
    const outcome = document.ok
      ? chain.evaluateDecisionChain(own ? withPositioning(document.input) : document.input, document.knowledgeCutoff)
      : chain.evaluateDecisionChain(undefined, undefined);
    const receipt = outcome.kind === 'COMPLETED'
      ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
    const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
      ? receipt.fingerprint : null;
    return view.buildTerminalView(outcome, digest, viewOrigin, now().toISOString(), null, undefined, own ? positioningFile : null,
      document.ok ? inputCutoffsOf(document.input) : null);
  };
  render.captures = captures === null ? null : { sources: captures.sources, merged: captures.archive !== null,
    records: captures.archive?.records.length ?? 0, problems: captures.problems };
  render.positioning = cot === null ? null : { label: cot.label, ...cot.conversion, evidence: undefined, evidenceCount: cot.conversion.evidence.length };
  render.archiveCutoffs = () => {
    if (!archiveMode) return null;
    const document = readChainDocument(inputFile);
    const list = archiveCutoffsOf(loadArchive(), defaultArchiveCutoff(document), capturedFields);
    // --captures: whether the merge succeeded and why not, so the page can say it (the replay only says "rejected").
    return captures === null ? list : { ...list, captures: { sources: captures.sources, merged: captures.archive !== null,
      problems: [...captures.problems] } };
  };
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
  const index = localIndexHtml();
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
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(url.pathname);
      scenarioId = url.searchParams.get('scenario') || null;
      requestCutoff = url.searchParams.get('cutoff') || null;
    } catch {
      send(response, 400, 'text/plain; charset=utf-8', 'bad request', method);
      return;
    }
    if (pathname === HEALTH_PATH) {
      // args: the server's own command-line options, so the launcher never reuses an instance showing other data.
      const health = { app: 'xau-v2-terminal-local', schemaVersion: 'xau.terminal-local-health.v1', root: ROOT, pid: process.pid,
        args: Array.isArray(options.launchArgs) ? options.launchArgs : [] };
      send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(health), method);
      return;
    }
    if (pathname === SCENARIOS_PATH) {
      const list = TERMINAL_SCENARIOS.map(({ id, label }) => ({ id, label }));
      send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(list), method);
      return;
    }
    if (pathname === ARCHIVE_CUTOFFS_PATH) {
      const list = view.archiveCutoffs();
      if (list === null) send(response, 404, 'text/plain; charset=utf-8', 'no archive', method);
      else send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(list), method);
      return;
    }
    if (pathname === VIEW_PATH) {
      if (requestCutoff !== null && (scenarioId !== null || view.archiveCutoffs() === null || !REQUEST_CUTOFF.test(requestCutoff))) {
        send(response, 400, 'text/plain; charset=utf-8', 'cutoff: archive mode only, no scenario, UTC instant', method);
        return;
      }
      try {
        const body = await view(scenarioId, { cutoff: requestCutoff });
        if (body === null) send(response, 404, 'text/plain; charset=utf-8', 'unknown scenario', method);
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
  const options = { port: null, portRange: null, inputFile: GOLDEN_FIXTURE, archiveFile: null, archiveDigest: undefined, cutoff: null, positioningCot: null, capturesDir: null };
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
      + ' [--archive archive.json [--archive-digest sha256:...] | --captures DIR] [--cutoff ISO]'
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
