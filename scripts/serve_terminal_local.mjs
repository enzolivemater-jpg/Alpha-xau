#!/usr/bin/env node
/**
 * Local terminal server: serves frontend/ and the CHAIN-0 terminal view on
 * the loopback interface only.
 *
 *   node scripts/serve_terminal_local.mjs [--port 4173 [--port-range N]] [--input chain-input.json]
 *     [--archive market-evidence-archive.json [--archive-digest sha256:...] [--cutoff ISO]]
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
import { readFileSync, statSync } from 'node:fs';
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
const VIEW_URL_PLACEHOLDER = "V2_VIEW_URL: '',";
const SCENARIOS_URL_PLACEHOLDER = "V2_SCENARIOS_URL: '',";

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
  for (const placeholder of [VIEW_URL_PLACEHOLDER, SCENARIOS_URL_PLACEHOLDER]) {
    if (html.split(placeholder).length !== 2) {
      throw new Error(`frontend/index.html must contain exactly one "${placeholder}"`);
    }
  }
  return html.replace(VIEW_URL_PLACEHOLDER, `V2_VIEW_URL: '${VIEW_PATH}',`)
    .replace(SCENARIOS_URL_PLACEHOLDER, `V2_SCENARIOS_URL: '${SCENARIOS_PATH}',`);
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

export async function buildLocalView({
  inputFile = GOLDEN_FIXTURE, archiveFile = null, archiveDigest = undefined, cutoff = null, now = () => new Date(),
} = {}) {
  const chain = await loadBackendModule('decision_chain/dry_run.ts');
  const obs = await loadBackendModule('observability/offline_receipt.ts');
  const view = await loadBackendModule('decision_chain/terminal_view.ts');
  const evidence = await loadBackendModule('market_engine/evidence_archive.ts');
  const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
  const providers = await loadBackendModule('market_engine/providers.ts');
  // Raw payloads are checked with the runtime parsers themselves.
  const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
  const origin = archiveFile !== null ? { kind: 'LOCAL_MARKET_ARCHIVE', label: path.basename(archiveFile) }
    : inputFile === GOLDEN_FIXTURE
      ? { kind: 'GOLDEN_FIXTURE', label: path.relative(ROOT, GOLDEN_FIXTURE) }
      : { kind: 'LOCAL_INPUT_FILE', label: path.basename(inputFile) };
  // B4: in --archive mode only the market comes from the archive; every other input from this document.
  const inputDocument = inputFile === GOLDEN_FIXTURE
    ? { kind: 'GOLDEN_FIXTURE', label: path.relative(ROOT, GOLDEN_FIXTURE) }
    : { kind: 'LOCAL_INPUT_FILE', label: path.basename(inputFile) };
  const golden = JSON.parse(readFileSync(GOLDEN_FIXTURE, 'utf8'));
  /** Replays an archive, then runs CHAIN-0 on its snapshot. */
  const fromArchive = async (archive, knowledgeCutoff, baseInput, viewOrigin, pinned, document = undefined) => {
    const replay = await evidence.replayMarketEvidence(archive, knowledgeCutoff,
      // A pin that was asked for is always applied: an empty or malformed one must fail the
      // replay (digest mismatch), never silently turn the pin off.
      { parsers, ...(pinned !== undefined ? { pinnedArchiveDigest: pinned } : {}) });
    const outcome = bridge.evaluateDecisionChainOnMarketEvidence(baseInput, replay);
    const receipt = outcome.kind === 'COMPLETED'
      ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
    const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
      ? receipt.fingerprint : null;
    return view.buildTerminalView(outcome, digest, viewOrigin, now().toISOString(), replay, document);
  };
  /** Without a scenario, the server's input; with one, that simulation. */
  return async (scenarioId = null) => {
    let document;
    let viewOrigin = origin;
    if (scenarioId === null) {
      document = readChainDocument(inputFile);
      if (archiveFile !== null) {
        let archive;
        try {
          archive = JSON.parse(readFileSync(archiveFile, 'utf8'));
        } catch {
          archive = null; // replayed as ARCHIVE_SHAPE_INVALID, never thrown
        }
        const knowledgeCutoff = cutoff ?? (document.ok ? document.knowledgeCutoff : null);
        return fromArchive(archive, knowledgeCutoff, document.ok ? document.input : undefined, origin, archiveDigest, inputDocument);
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
    const outcome = document.ok
      ? chain.evaluateDecisionChain(document.input, document.knowledgeCutoff)
      : chain.evaluateDecisionChain(undefined, undefined);
    const receipt = outcome.kind === 'COMPLETED'
      ? await obs.buildOfflineAuditReceipt(outcome.result) : null;
    const digest = receipt?.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED'
      ? receipt.fingerprint : null;
    return view.buildTerminalView(outcome, digest, viewOrigin, now().toISOString());
  };
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
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(url.pathname);
      scenarioId = url.searchParams.get('scenario') || null;
    } catch {
      send(response, 400, 'text/plain; charset=utf-8', 'bad request', method);
      return;
    }
    if (pathname === SCENARIOS_PATH) {
      const list = TERMINAL_SCENARIOS.map(({ id, label }) => ({ id, label }));
      send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(list), method);
      return;
    }
    if (pathname === VIEW_PATH) {
      try {
        const body = await view(scenarioId);
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
  return server;
}

export function parseArgs(argv) {
  const options = { port: null, portRange: null, inputFile: GOLDEN_FIXTURE, archiveFile: null, archiveDigest: undefined, cutoff: null };
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
    } else {
      return null;
    }
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
      + ' [--archive archive.json [--archive-digest sha256:...] [--cutoff ISO]]\n');
    process.exitCode = 1;
  } else {
    const { port: requested, portRange, ...serverOptions } = options;
    const server = await createTerminalServer(serverOptions);
    // A busy or forbidden port is the usual first-run problem (the demo is
    // often restarted): say so in one line instead of an unhandled 'error'
    // event with a raw stack trace.
    try {
      const { port } = await listenOnLoopback(server, { port: requested, range: portRange });
      if (port !== requested) {
        process.stdout.write(`terminal local : le port ${requested} est occupé ; le port libre ${port} est utilisé (loopback uniquement)\n`);
      }
      process.stdout.write(`terminal local : http://127.0.0.1:${port}/ (CHAIN-0 DRY RUN, HOLD, exécution interdite) — Ctrl+C pour arrêter\n`);
      process.stdout.write(`terminal local : scénarios de simulation dans l'onglet CHAÎNE V2 (http://127.0.0.1:${port}/#chaine), sélecteur « SCÉNARIO DE SIMULATION » en haut du panneau\n`);
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
