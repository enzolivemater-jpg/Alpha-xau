#!/usr/bin/env node
/**
 * Launcher for the local OFFLINE terminal (scripts/serve_terminal_local.mjs).
 *
 *   node scripts/terminal_launch.mjs [--no-browser] [server options]
 *   node scripts/terminal_launch.mjs --status | --stop [--port N [--port-range N]]
 *   --captures-local = --captures ~/.local/share/xau-v2/evidence (the local capture logs)
 *
 * Server options are passed through unchanged (--port, --port-range, --input,
 * --archive, --archive-digest, --cutoff). The launcher:
 *   - checks the checkout first (dependencies present) and says what to do;
 *   - reuses a server already started from this checkout (found through
 *     /local/v2/health.json on the port range) instead of starting a second one;
 *   - starts the server, waits until the view answers over HTTP with a HOLD
 *     chain, and only then opens the browser at http://localhost:<port>/#chaine
 *     (Windows default browser from WSL, xdg-open elsewhere, or the program in
 *     XAU_TERMINAL_BROWSER); if nothing opens, it prints the URL;
 *   - follows the server's port fallback (the URL comes from the server);
 *   - stops the server on Ctrl+C, SIGTERM or SIGHUP and exits when it stops;
 *   - --stop stops the server of this checkout, --status reports it.
 * It never binds anything but loopback, writes no file and changes no system
 * setting. Exit: 0 ok, 1 server failure, 3 environment problem, 64 usage.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'serve_terminal_local.mjs');
const DEFAULT_PORT = 4173;
const DEFAULT_RANGE = 10;
const HEALTH = '/local/v2/health.json';
const VIEW = '/local/v2/terminal.json';
const READY_TIMEOUT_MS = 90_000;
const PASSTHROUGH = new Set(['--port', '--port-range', '--input', '--archive', '--archive-digest', '--cutoff',
  '--positioning-cot', '--cot-dataset', '--cot-published-at', '--cot-received-at', '--cot-report-date', '--captures', '--data-root', '--events']);

export const LOCAL_DATA_ROOT = path.join(homedir(), '.local', 'share', 'xau-v2');
export const LOCAL_CAPTURES = path.join(LOCAL_DATA_ROOT, 'evidence');

const say = (line) => process.stdout.write(`terminal XAU V2 : ${line}\n`);
const fail = (line) => process.stderr.write(`terminal XAU V2 : ${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Problems that prevent a start, each with the action that fixes it. */
export function preflight(root = ROOT) {
  const problems = [];
  if (!existsSync(path.join(root, 'scripts', 'serve_terminal_local.mjs'))) {
    problems.push(`checkout incomplet : ${root}/scripts/serve_terminal_local.mjs absent ; lancer depuis le dossier du dépôt XAU V2.`);
  }
  if (!existsSync(path.join(root, 'node_modules', 'typescript', 'package.json'))) {
    problems.push(`node_modules absent ou incomplet dans ${root} : lancer « npm ci » une fois dans ce dossier.`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) problems.push(`Node.js ${process.versions.node} trop ancien : la version 22 ou plus récente est requise.`);
  return problems;
}

export function parseArgs(argv) {
  const options = { mode: 'start', browser: true, server: [], port: DEFAULT_PORT, range: DEFAULT_RANGE };
  let explicitPort = false;
  let explicitRange = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--no-browser') options.browser = false;
    else if (flag === '--stop') options.mode = 'stop';
    else if (flag === '--status') options.mode = 'status';
    // The operator's capture logs, where the DATA-2 capture tooling keeps them (as validate_evidence_captures.mjs).
    else if (flag === '--captures-local') options.server.push('--captures', LOCAL_CAPTURES);
    // The operator's local data, selectable in the page (captures and declared CFTC files), none selected by default.
    // With local data, the macro summaries come from the official releases by default (aligned with every replay).
    else if (flag === '--local-data') options.server.push('--data-root', LOCAL_DATA_ROOT, '--events', 'official:repository');
    else if (PASSTHROUGH.has(flag) && argv[i + 1] !== undefined) {
      const value = argv[i += 1];
      options.server.push(flag, value);
      if (flag === '--port') { options.port = Number(value); explicitPort = true; }
      if (flag === '--port-range') { options.range = Number(value); explicitRange = true; }
    } else {
      return null;
    }
  }
  if (explicitPort && !explicitRange) options.range = 1;
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535
      || !Number.isInteger(options.range) || options.range < 1 || options.range > 50) return null;
  return options;
}

async function getJson(port, pathname, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** XAU terminals answering on the port range, with the checkout they serve. */
export async function probeInstances(port = DEFAULT_PORT, range = DEFAULT_RANGE) {
  const ports = Array.from({ length: range }, (_, i) => port + i).filter((p) => p <= 65535);
  const found = await Promise.all(ports.map(async (p) => {
    const health = await getJson(p, HEALTH, 800);
    return health && health.app === 'xau-v2-terminal-local' && typeof health.root === 'string' && Number.isSafeInteger(health.pid)
      ? { port: p, root: health.root, pid: health.pid, args: Array.isArray(health.args) ? health.args.map(String) : null } : null;
  }));
  return found.filter(Boolean);
}

const pageUrl = (port) => `http://localhost:${port}/#chaine`;

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Opens the URL in a browser without a shell; false when nothing could be started. */
async function openBrowser(url) {
  const candidates = process.env.XAU_TERMINAL_BROWSER ? [[process.env.XAU_TERMINAL_BROWSER, [url]]]
    : isWsl() ? [['explorer.exe', [url]], ['cmd.exe', ['/c', 'start', '', url]], ['wslview', [url]]]
      : process.platform === 'darwin' ? [['open', [url]]] : [['xdg-open', [url]]];
  for (const [command, args] of candidates) {
    const started = await new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'ignore', detached: false });
      child.once('error', () => resolve(false)); // not installed
      child.once('spawn', () => resolve(child));
    });
    if (started) {
      // explorer.exe reports exit code 1 even when it opened the page: only a spawn failure counts.
      await new Promise((resolve) => { started.once('exit', resolve); setTimeout(resolve, 5000); });
      return true;
    }
  }
  return false;
}

async function showBrowser(url, wanted) {
  if (wanted && await openBrowser(url)) say(`navigateur ouvert sur ${url}`);
  else say(`ouvrez ${url} dans le navigateur (Brave, Chrome, Edge ou Firefox).`);
}

/**
 * Whether two server option lists show the same data: the same options and values, port options
 * aside, in any order (the server reads each option once whatever its position).
 */
export function sameDataOptions(a, b) {
  const key = (args) => {
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) if (!['--port', '--port-range'].includes(args[i])) pairs.push(`${args[i]}\u0000${args[i + 1]}`);
    return JSON.stringify(pairs.sort());
  };
  return key(a) === key(b);
}

/** The instance of this checkout among the probed ones, if any. */
const mine = (instances) => instances.find((instance) => instance.root === ROOT) ?? null;

function serverProcessOk(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('serve_terminal_local.mjs');
  } catch {
    return process.platform !== 'linux'; // no /proc: rely on the health answer
  }
}

async function status(options) {
  const instance = mine(await probeInstances(options.port, options.range));
  if (!instance) {
    say(`aucun terminal lancé depuis ${ROOT} sur les ports ${options.port}–${options.port + options.range - 1}.`);
    return 1;
  }
  say(`lancé : http://localhost:${instance.port}/ (processus ${instance.pid}, ${ROOT})`);
  return 0;
}

async function stop(options) {
  const instance = mine(await probeInstances(options.port, options.range));
  if (!instance) {
    say(`aucun terminal lancé depuis ${ROOT} : rien à arrêter.`);
    return 0;
  }
  if (!serverProcessOk(instance.pid)) {
    fail(`le processus ${instance.pid} n'est pas le serveur du terminal : arrêt refusé.`);
    return 1;
  }
  process.kill(instance.pid, 'SIGINT');
  for (let i = 0; i < 100; i += 1) {
    if (!await getJson(instance.port, HEALTH, 300)) {
      say(`terminal arrêté (port ${instance.port} libéré).`);
      return 0;
    }
    await sleep(100);
  }
  fail(`le terminal du port ${instance.port} ne s'est pas arrêté en 10 s.`);
  return 1;
}

async function start(options) {
  const problems = preflight();
  if (problems.length) {
    for (const problem of problems) fail(`diagnostic : ${problem}`);
    return 3;
  }
  const running = await probeInstances(options.port, options.range);
  const own = mine(running);
  if (own && (own.args === null || !sameDataOptions(own.args, options.server))) {
    fail(`diagnostic : un terminal de ce dossier tourne déjà sur le port ${own.port} avec d'autres options`
      + ` (${own.args === null ? 'inconnues' : own.args.join(' ') || 'aucune'}) : il montrerait d'autres données.`
      + ' « --stop » l\'arrête ; relancer ensuite avec les options voulues.');
    return 1;
  }
  if (own) {
    say(`déjà lancé depuis ce dossier sur le port ${own.port} : pas de second serveur.`);
    await showBrowser(pageUrl(own.port), options.browser);
    return 0;
  }
  for (const other of running) say(`un autre terminal XAU (${other.root}) occupe le port ${other.port} : un port libre suivant sera pris.`);

  say(`démarrage depuis ${ROOT} (Node ${process.versions.node})…`);
  const child = spawn(process.execPath, [SERVER, ...options.server], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { err += chunk; process.stderr.write(chunk); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
    });
  }

  // The port comes from the server itself (it may have fallen back to the next free one).
  let port = null;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (port === null && child.exitCode === null && Date.now() < deadline) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
    if (match) port = Number(match[1]);
    else await sleep(50);
  }
  let ready = false;
  while (port !== null && !ready && child.exitCode === null && Date.now() < deadline && !stopping) {
    const view = await getJson(port, VIEW, 5000);
    ready = view !== null && view.chain?.chainState === 'HOLD' && view.chain?.execution === 'FORBIDDEN';
    if (!ready) await sleep(200);
  }
  if (!ready) {
    if (child.exitCode === null) child.kill('SIGINT');
    const { code } = await exited;
    if (stopping) {
      say('terminal arrêté.');
      return 0;
    }
    fail(`diagnostic : le serveur n'a pas répondu (code ${code ?? 'signal'}). ${err.trim() ? 'Voir le message ci-dessus.' : ''}`
      + (/EADDRINUSE/.test(err) ? ' Un terminal tourne peut-être déjà : « --status » le dit, « --stop » l\'arrête.' : '')
      + (port === null && !err.trim() ? ' Aucun port annoncé : vérifier que le dossier est un checkout XAU V2 complet.' : ''));
    return 1;
  }
  say(`prêt : ${pageUrl(port)} — HOLD, exécution interdite. Fermer cette fenêtre ou Ctrl+C pour arrêter.`);
  await showBrowser(pageUrl(port), options.browser);
  const { code, signal } = await exited;
  if (stopping || signal === 'SIGINT' || code === 0) {
    say('terminal arrêté.');
    return 0;
  }
  fail(`diagnostic : le serveur s'est arrêté de lui-même (code ${code}, signal ${signal ?? 'aucun'}).`);
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write('usage: node scripts/terminal_launch.mjs [--no-browser] [--port N [--port-range N]]'
      + ' [--input file] [--archive file [--archive-digest sha256:…] | --captures DIR | --captures-local] [--cutoff ISO]'
      + ' [--positioning-cot file --cot-dataset futures-only|futures-and-options --cot-published-at ISO --cot-received-at ISO'
      + ' [--cot-report-date YYYY-MM-DD]]\n'
      + '       node scripts/terminal_launch.mjs --status | --stop [--port N [--port-range N]]\n');
    return 64;
  }
  if (options.mode === 'status') return status(options);
  if (options.mode === 'stop') return stop(options);
  return start(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
