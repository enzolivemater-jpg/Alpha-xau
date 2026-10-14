#!/usr/bin/env node
/**
 * Local terminal server: serves frontend/ and the CHAIN-0 terminal view on
 * the loopback interface only.
 *
 *   node scripts/serve_terminal_local.mjs [--port 4173] [--input chain-input.json]
 *
 * GET /local/v2/terminal.json runs CHAIN-0 on the golden fixture (or on the
 * `{ knowledgeCutoff, input }` file given with --input) and returns the
 * read-only view. index.html is served with V2_VIEW_URL pointing at it; the
 * published page keeps V2_VIEW_URL empty and shows the V2 panels as
 * unavailable. No database, provider, broker or network call is made, and
 * the Supabase settings stay empty, so the V1 panels run in labelled demo
 * mode.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadBackendModule } from './lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');
export const GOLDEN_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json');
export const VIEW_PATH = '/local/v2/terminal.json';
const VIEW_URL_PLACEHOLDER = "V2_VIEW_URL: '',";

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** index.html with the local view URL; refuses to start if the hook moved. */
export function localIndexHtml() {
  const html = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  if (html.split(VIEW_URL_PLACEHOLDER).length !== 2) {
    throw new Error(`frontend/index.html must contain exactly one "${VIEW_URL_PLACEHOLDER}"`);
  }
  return html.replace(VIEW_URL_PLACEHOLDER, `V2_VIEW_URL: '${VIEW_PATH}',`);
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

export async function buildLocalView({ inputFile = GOLDEN_FIXTURE, now = () => new Date() } = {}) {
  const chain = await loadBackendModule('decision_chain/dry_run.ts');
  const view = await loadBackendModule('command_center/terminal_view.ts');
  const origin = inputFile === GOLDEN_FIXTURE
    ? { kind: 'GOLDEN_FIXTURE', label: path.relative(ROOT, GOLDEN_FIXTURE) }
    : { kind: 'LOCAL_INPUT_FILE', label: path.basename(inputFile) };
  return async () => {
    const document = readChainDocument(inputFile);
    // An unreadable document still yields a HOLD view, through CHAIN-0's own rejection.
    const outcome = document.ok
      ? chain.evaluateDecisionChain(document.input, document.knowledgeCutoff)
      : chain.evaluateDecisionChain(undefined, undefined);
    const digest = outcome.kind === 'COMPLETED' ? await chain.computeDecisionChainDigest(outcome.result) : null;
    return view.buildTerminalView(outcome, digest, origin, now().toISOString());
  };
}

function send(response, status, type, body, method) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(method === 'HEAD' ? undefined : body);
}

export async function createTerminalServer(options = {}) {
  const view = await buildLocalView(options);
  const index = localIndexHtml();
  return createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'method not allowed', method);
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      send(response, 400, 'text/plain; charset=utf-8', 'bad request', method);
      return;
    }
    if (pathname === VIEW_PATH) {
      try {
        send(response, 200, CONTENT_TYPES['.json'], JSON.stringify(await view()), method);
      } catch (error) {
        send(response, 500, 'text/plain; charset=utf-8', `view error: ${error.message}`, method);
      }
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      send(response, 200, CONTENT_TYPES['.html'], index, method);
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
}

function parseArgs(argv) {
  const options = { port: 4173, inputFile: GOLDEN_FIXTURE };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--port' && /^\d{1,5}$/.test(value ?? '') && Number(value) > 0 && Number(value) < 65536) {
      options.port = Number(value);
    } else if (flag === '--input' && value) {
      options.inputFile = path.resolve(value);
    } else {
      return null;
    }
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write('usage: node scripts/serve_terminal_local.mjs [--port 4173] [--input chain-input.json]\n');
    process.exitCode = 1;
  } else {
    const server = await createTerminalServer({ inputFile: options.inputFile });
    server.listen(options.port, '127.0.0.1', () => {
      process.stdout.write(`terminal local : http://127.0.0.1:${options.port}/ (CHAIN-0 DRY RUN, HOLD, exécution interdite)\n`);
    });
  }
}
