// Terminal OFFLINE finalisation.
//   A. Interface: the demo never turns synthetic noise into a gold impact; the
//      macro note is a general principle; a rejected input explains its HOLD;
//      no freshness legend without market fields.
//   B. Launcher (scripts/terminal_launch.mjs, scripts/terminal/xau-terminal.sh,
//      scripts/terminal/xau-terminal.cmd): one instance per checkout, browser
//      opened only once the view answers over HTTP, port fallback, clean stop,
//      readable diagnostics, Node found without a pinned version path.
// Windows itself is not available here: the .cmd is checked statically only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { codeIdentity, describeCode } from '../scripts/lib/code_identity.mjs';
import { buildLocalView, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
const js = readFileSync(path.join(ROOT, 'frontend', 'js', 'dashboard.js'), 'utf8');
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SCRATCH = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'terminal-final-'));

function boot(config, fetchImpl, random = null) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom.window.fetch = fetchImpl;
  dom.window.ALPHA_XAU_CONFIG = config;
  if (random) dom.window.Math.random = random;
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  return dom;
}
const LOCAL = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
const serve = (body) => (url) => (String(url) === VIEW_PATH
  ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) })
  : Promise.reject(new Error(`unexpected fetch ${url}`)));
const NOW = () => new Date('2026-10-18T00:00:00.000Z');

try {
  // --- A1. Demo macro matrix: synthetic moves never become a gold impact (they did after the second tick).
  const golden = await (await buildLocalView({ now: NOW }))();
  let dom = boot(LOCAL, serve(golden), () => 0.99); // every demo tick moves every driver up
  await settle(4600); // at least two demo ticks (2 s period)
  let d = dom.window.document;
  const impacts = [...d.querySelectorAll('#macro-rows [data-field="impact"]')];
  assert.equal(impacts.length, 5);
  assert.ok([...d.querySelectorAll('#macro-rows [data-field="change"]')].some((c) => c.textContent !== '—'), 'the demo did move');
  for (const cell of impacts) {
    assert.equal(cell.textContent, 'N/A — DÉMO', cell.closest('tr').getAttribute('data-driver'));
    assert.equal(cell.getAttribute('data-impact'), 'unavailable');
  }
  assert.doesNotMatch(d.getElementById('macro-rows').textContent, /Soutien|Pression|Demande refuge|Appétit risque|Canal inflation|Désinflation|Stable/);
  // A2. The note under the matrix is a general principle, not a reading of the values shown.
  assert.match(d.querySelector('.matrix__note').textContent.trim(), /^Principe général, pas une lecture des valeurs affichées :/);
  dom.window.close();
  console.log('PASS demo macro matrix: no gold impact from synthetic moves; the note is a general principle');

  // --- A3/A4. Rejected input: POURQUOI HOLD explains; no freshness legend without market fields.
  const rejected = await (await buildLocalView({ now: NOW }))('invalid-input');
  assert.equal(rejected.chain.outcome, 'REJECTED');
  dom = boot(LOCAL, serve(rejected));
  await settle(300);
  d = dom.window.document;
  assert.equal(d.getElementById('v2-why').hidden, false, 'POURQUOI HOLD is not an empty heading');
  assert.match(d.getElementById('v2-why-lead').textContent, /^Entrée rejetée avant la chaîne : aucun étage n'a été évalué\./);
  assert.equal(d.getElementById('v2-market-legend').hidden, true, 'no freshness legend without fields');
  assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
  dom.window.close();
  dom = boot(LOCAL, serve(golden));
  await settle(300);
  d = dom.window.document;
  assert.equal(d.getElementById('v2-market-legend').hidden, false, 'legend kept when fields exist');
  assert.match(d.getElementById('v2-why-lead').textContent, /^La chaîne s'arrête à /);
  dom.window.close();
  console.log('PASS rejected input: POURQUOI HOLD explains the rejection; no market legend without fields');

  // --- B. Launcher.
  const launcher = await import('../scripts/terminal_launch.mjs');
  const LAUNCH = path.join(ROOT, 'scripts', 'terminal_launch.mjs');
  const opened = path.join(SCRATCH, 'opened.log');
  // The "browser" records the URL and whether the view already answered when it was asked to open.
  const browser = path.join(SCRATCH, 'browser.mjs');
  writeFileSync(browser, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const url = process.argv[2];
const view = new URL('${VIEW_PATH}', url).href.replace('localhost', '127.0.0.1');
let answered = false;
try { const r = await fetch(view, { headers: { host: new URL(view).host } }); answered = r.ok && (await r.json()).chain.chainState === 'HOLD'; } catch {}
appendFileSync(${JSON.stringify(opened)}, JSON.stringify({ url, answered }) + '\\n');
`);
  chmodSync(browser, 0o755);
  const ENV = { ...process.env, XAU_TERMINAL_BROWSER: browser };
  const openedLines = () => { try { return readFileSync(opened, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const start = (args, env = ENV) => {
    const child = spawn(process.execPath, [LAUNCH, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const until = async (re, ms = 60000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(out + err)) return true;
        if (child.exitCode !== null) return re.test(out + err);
        await settle(50);
      }
      return false;
    };
    return { child, exited, until, text: () => out + err };
  };
  const portOpen = (port) => new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
  const PORTS = ['--port', '4573', '--port-range', '3'];

  // B1. The health endpoint names the checkout and the process.
  const first = start(PORTS);
  assert.ok(await first.until(/navigateur ouvert sur http:\/\/localhost:4573\/#chaine/), first.text());
  assert.ok(first.text().indexOf('prêt :') < first.text().indexOf('navigateur ouvert'), 'ready before the browser');
  const health = await (await fetch('http://127.0.0.1:4573/local/v2/health.json')).json();
  // args (auto-session): the server's options, so a launch asking for other data never reuses it.
  assert.deepEqual(Object.keys(health).sort(), ['app', 'args', 'code', 'pid', 'root', 'schemaVersion']);
  assert.deepEqual(health.args, PORTS);
  assert.equal(health.app, 'xau-v2-terminal-local');
  assert.equal(health.schemaVersion, 'xau.terminal-local-health.v2');
  assert.equal(health.root, ROOT);
  // code (v2): the commit the server runs, also in the page footer and in the launcher's lines.
  const runningCode = codeIdentity(ROOT);
  assert.deepEqual(health.code, runningCode);
  assert.match(runningCode.commit ?? '', /^[0-9a-f]{40}$/, 'this checkout is a git repository');
  const page = await (await fetch('http://127.0.0.1:4573/')).text();
  const footer = new JSDOM(page).window.document.getElementById('code-version');
  assert.equal(footer.textContent, describeCode(runningCode));
  assert.equal(footer.parentElement.textContent.trim(), `CODE ${describeCode(runningCode)}`);
  assert.ok(first.text().includes(`code ${describeCode(runningCode)}`), 'the launcher says which code it starts');
  // fetch() drops a Host override; node:http sends it.
  const foreign = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 4573, path: '/local/v2/health.json', headers: { Host: 'evil.example:4573' } },
      (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreign, 403, 'the health endpoint is behind the loopback Host guard');
  // B2. Browser opened once, after the view answered over HTTP.
  assert.deepEqual(openedLines(), [{ url: 'http://localhost:4573/#chaine', answered: true }]);
  assert.match(first.text(), /HOLD/);
  console.log('PASS launcher: starts the server, waits for the view over HTTP, then opens http://localhost:4573/#chaine');

  // B3. A second launch from the same checkout reuses the running instance: no second server.
  const second = start(PORTS);
  const again = await second.exited;
  assert.equal(again.code, 0, second.text());
  assert.match(second.text(), /déjà lancé/);
  assert.equal(await portOpen(4574), false, 'no second server on the next port');
  assert.equal(openedLines().length, 2, 'the browser is pointed at the running instance');
  assert.equal(openedLines()[1].url, 'http://localhost:4573/#chaine');
  // B3b. A launch asking for other data (here an archive) is refused, never pointed at this instance.
  const other = start([...PORTS, '--archive', 'tests/fixtures/market_evidence_archive_synthetic.json']);
  const otherExit = await other.exited;
  assert.equal(otherExit.code, 1, other.text());
  assert.match(other.text(), /tourne déjà sur le port 4573 avec d'autres options \(--port 4573 --port-range 3\)/);
  assert.match(other.text(), /--stop/);
  assert.equal(openedLines().length, 2, 'no browser opened on the wrong data');
  assert.equal(await portOpen(4574), false, 'no second server either');
  // Same options in another order (and other port options) are the same data: reused, no refusal.
  assert.ok(launcher.sameDataOptions(['--captures', 'd', '--cutoff', 'c', '--port', '1'], ['--cutoff', 'c', '--captures', 'd']));
  assert.ok(!launcher.sameDataOptions(['--captures', 'd'], ['--captures', 'e']));
  assert.ok(!launcher.sameDataOptions(['--captures', 'd'], ['--captures', 'd', '--cutoff', 'c']));
  assert.ok(!launcher.sameDataOptions([], ['--archive', 'a.json']));
  const reordered = start(['--port-range', '3', '--port', '4573']);
  assert.equal((await reordered.exited).code, 0, reordered.text());
  assert.match(reordered.text(), /déjà lancé/);
  // B4. --status and --stop find this checkout's instance and stop it cleanly.
  const status = spawnSync(process.execPath, [LAUNCH, '--status', ...PORTS], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /lancé : http:\/\/localhost:4573\//);
  const stop = spawnSync(process.execPath, [LAUNCH, '--stop', ...PORTS], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.match(stop.stdout, /arrêté/);
  const firstExit = await first.exited;
  assert.equal(firstExit.code, 0, 'the launcher exits cleanly when its server stops');
  assert.equal(await portOpen(4573), false, 'port released');
  const none = spawnSync(process.execPath, [LAUNCH, '--status', ...PORTS], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /aucun terminal/);
  console.log('PASS launcher: one instance per checkout; --status and --stop; the port is released');

  // B4b. A server of this checkout left on other code (the checkout moved since, or a version without
  // the code field) is never reused: the launcher refuses and says to stop it.
  for (const [code, shown] of [[{ commit: '0'.repeat(40), branch: 'old', dirty: false }, '0000000 (old)'], [undefined, 'inconnu']]) {
    const stale = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ app: 'xau-v2-terminal-local', schemaVersion: 'xau.terminal-local-health.v1', root: ROOT, pid: 1,
        args: PORTS, ...(code ? { code } : {}) }));
    });
    await new Promise((resolve) => stale.listen(4573, '127.0.0.1', resolve));
    const opened = openedLines().length;
    const refused = start(PORTS);
    assert.equal((await refused.exited).code, 1, refused.text());
    assert.ok(refused.text().includes(`exécute le code ${shown}, le dossier est à ${describeCode(codeIdentity(ROOT))}`), refused.text());
    assert.match(refused.text(), /version périmée.*--stop/s);
    assert.equal(openedLines().length, opened, 'no browser on outdated code');
    assert.equal(await portOpen(4574), false, 'no second server either');
    await new Promise((resolve) => stale.close(resolve));
  }
  // codeIdentity: commit, branch, tracked changes; detached; nothing outside a repository.
  const repo = path.join(SCRATCH, 'code-repo');
  mkdirSync(repo);
  const g = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  g('init', '-q', '-b', 'work');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'a');
  const sha = g('rev-parse', 'HEAD').stdout.trim();
  assert.deepEqual(codeIdentity(repo), { commit: sha, branch: 'work', dirty: false });
  writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');
  assert.equal(codeIdentity(repo).dirty, false, 'untracked files (node_modules link) do not count');
  writeFileSync(path.join(repo, 'a.txt'), 'b\n');
  assert.equal(codeIdentity(repo).dirty, true);
  assert.equal(describeCode(codeIdentity(repo)), `${sha.slice(0, 7)} (work) + modifications non commitées`);
  g('checkout', '-q', '--detach');
  assert.equal(codeIdentity(repo).branch, null);
  assert.match(describeCode(codeIdentity(repo)), /\(détaché\)/);
  const notRepo = path.join(SCRATCH, 'not-a-repo');
  mkdirSync(notRepo);
  assert.deepEqual(codeIdentity(notRepo), { commit: null, branch: null, dirty: null });
  assert.equal(describeCode(null), 'inconnu');
  console.log('PASS launcher: a server of this checkout on other code is refused, never reused; the code is named everywhere');

  // B5. A busy port (another program): the server takes the next one and the browser follows it.
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(4573, '127.0.0.1', resolve));
  const fallback = start(PORTS);
  assert.ok(await fallback.until(/navigateur ouvert sur http:\/\/localhost:4574\/#chaine/), fallback.text());
  assert.equal(openedLines().at(-1).url, 'http://localhost:4574/#chaine');
  assert.equal(openedLines().at(-1).answered, true);
  // B6. Ctrl+C on the launcher stops its server.
  fallback.child.kill('SIGINT');
  const stopped = await fallback.exited;
  assert.equal(stopped.code, 0, fallback.text());
  assert.match(fallback.text(), /terminal arrêté/);
  assert.equal(await portOpen(4574), false);
  // B7. No free port: a readable diagnostic, non-zero exit, no browser.
  const before = openedLines().length;
  const full = start(['--port', '4573', '--port-range', '1']);
  const fullExit = await full.exited;
  assert.notEqual(fullExit.code, 0);
  assert.match(full.text(), /impossible de démarrer.*EADDRINUSE/s);
  assert.match(full.text(), /diagnostic :/);
  assert.equal(openedLines().length, before, 'no browser for a failed start');
  blocker.close();
  console.log('PASS launcher: busy port followed, Ctrl+C stops cleanly, no free port is a readable failure');

  // B8. No browser available: the URL is printed instead; --no-browser never opens one.
  const quiet = start([...PORTS, '--no-browser'], { ...process.env, XAU_TERMINAL_BROWSER: path.join(SCRATCH, 'missing-browser') });
  assert.ok(await quiet.until(/prêt : http:\/\/localhost:4573\/#chaine/), quiet.text());
  assert.match(quiet.text(), /ouvrez http:\/\/localhost:4573\/#chaine dans le navigateur/);
  quiet.child.kill('SIGTERM');
  assert.equal((await quiet.exited).code, 0);
  // B9. Preflight: a checkout without dependencies is diagnosed before anything starts.
  const bare = path.join(SCRATCH, 'bare');
  mkdirSync(path.join(bare, 'scripts'), { recursive: true });
  assert.match(launcher.preflight(bare).join('\n'), /node_modules absent.*npm ci/s);
  assert.deepEqual(launcher.preflight(ROOT), []);
  const usage = spawnSync(process.execPath, [LAUNCH, '--bogus'], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /usage/);
  console.log('PASS launcher: URL printed when no browser opens; missing dependencies and bad options are diagnosed');

  // B10. Node is found without a pinned version path: PATH, then nvm's newest version, else a clear message.
  const SH = path.join(ROOT, 'scripts', 'terminal', 'xau-terminal.sh');
  const fakeHome = path.join(SCRATCH, 'home');
  for (const version of ['v22.11.0', 'v24.21.0', 'v9.0.0']) {
    mkdirSync(path.join(fakeHome, '.nvm', 'versions', 'node', version, 'bin'), { recursive: true });
  }
  symlinkSync(process.execPath, path.join(fakeHome, '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'node'));
  symlinkSync(process.execPath, path.join(fakeHome, '.nvm', 'versions', 'node', 'v22.11.0', 'bin', 'node'));
  const which = (home, pathVar) => spawnSync('/bin/sh', [SH, '--which-node'], { cwd: ROOT, encoding: 'utf8', env: { HOME: home, PATH: pathVar } });
  // A PATH holding only the tools the script uses, so a system node elsewhere cannot leak in.
  const tools = path.join(SCRATCH, 'tools');
  mkdirSync(tools);
  for (const tool of ['ls', 'grep', 'sort', 'tail']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, path.join(tools, tool));
  }
  const noNodePath = tools;
  let found = which(fakeHome, noNodePath);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), path.join(fakeHome, '.nvm', 'versions', 'node', 'v24.21.0', 'bin', 'node'), 'newest nvm version, by version order');
  const pathDir = path.join(SCRATCH, 'bin');
  mkdirSync(pathDir);
  symlinkSync(process.execPath, path.join(pathDir, 'node'));
  found = which(fakeHome, `${pathDir}:${noNodePath}`);
  assert.equal(found.stdout.trim(), path.join(pathDir, 'node'), 'a node on PATH wins');
  const empty = path.join(SCRATCH, 'empty-home');
  mkdirSync(empty);
  found = which(empty, noNodePath);
  assert.equal(found.status, 3);
  assert.match(found.stderr, /Node\.js introuvable/);
  console.log('PASS xau-terminal.sh finds Node on PATH or the newest nvm version, else says so');

  // B11. The Windows launcher (static check: Windows is not available here).
  const cmd = readFileSync(path.join(ROOT, 'scripts', 'terminal', 'xau-terminal.cmd'), 'utf8');
  // --local-data: the operator's local data (captures, declared CFTC files) is offered in the page, none selected.
  assert.match(cmd, /wsl\.exe -d "%XAU_DISTRO%" --cd "%XAU_DIR%" -- sh scripts\/terminal\/xau-terminal\.sh --local-data %\*/);
  assert.match(cmd, /\\\\wsl\.localhost\\/i);
  assert.match(cmd, /\\\\wsl\$\\/i);
  assert.doesNotMatch(cmd, /v\d+\.\d+\.\d+/, 'no pinned Node version');
  assert.doesNotMatch(cmd, /--force|reg add|setx|netsh|Set-ExecutionPolicy/i, 'no system configuration change');
  assert.ok(cmd.includes('\r\n'), 'CRLF line endings for cmd.exe');
  assert.ok(cmd.split('\r\n').every((line, i, all) => i === all.length - 1 || !line.includes('\n')), 'no bare LF line');
  // B6 (Windows double-click from \\wsl.localhost\<distro>\…: UNC warning, then WSL_E_DISTRO_NOT_FOUND).
  // The launcher names what it read, keeps the configured name when only the case differs, and checks the
  // distribution with wsl.exe before launching; an unknown one is said, then the configured one is used.
  const lines = cmd.split('\r\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/^set "XAU_DEFAULT_DISTRO=xau-agent"$/) >= 0 && at(/^set "XAU_DISTRO=%XAU_DEFAULT_DISTRO%"$/) >= 0);
  assert.ok(at(/^set "XAU_HERE=%~dp0"$/) >= 0 && at(/^echo Lanceur : %XAU_HERE%$/) >= 0, 'the path read is shown');
  assert.ok(at(/^if \/i "%XAU_DISTRO%"=="%XAU_DEFAULT_DISTRO%" set "XAU_DISTRO=%XAU_DEFAULT_DISTRO%"$/) >= 0, 'case-only difference: configured name');
  const check = at(/^wsl\.exe -d "%XAU_DISTRO%" -- true >nul 2>&1$/);
  const launch = at(/^wsl\.exe -d "%XAU_DISTRO%" --cd "%XAU_DIR%" -- sh scripts\/terminal\/xau-terminal\.sh --local-data %\*$/);
  assert.ok(check > 0 && launch > check, 'the distribution is checked before the launch');
  assert.match(lines[check + 1], /^if errorlevel 1 \($/);
  assert.match(lines[check + 2], /^  echo Distribution "%XAU_DISTRO%" introuvable par wsl\.exe : essai de "%XAU_DEFAULT_DISTRO%"\.$/);
  assert.match(lines[check + 3], /^  set "XAU_DISTRO=%XAU_DEFAULT_DISTRO%"$/);
  assert.doesNotMatch(lines[launch], />nul/, 'launch errors stay visible');
  // The derivation, emulated with cmd's documented rules (FOR /F skips leading delimiters; IF /I ignores case).
  const derive = (here) => {
    let distro = 'xau-agent';
    let dir = '/home/xauagent/projects/Alpha-xau/.claude/worktrees/xau-terminal';
    const [a, b, ...rest] = here.split('\\').filter(Boolean);
    let tail = null;
    if (['wsl$', 'wsl.localhost'].includes(String(a).toLowerCase())) { distro = b; tail = `${rest.join('\\')}\\`; }
    if (tail) dir = `/${tail.replace(/\\/g, '/').replace('scripts/terminal/', '')}`.replace(/\/$/, '');
    if (distro.toLowerCase() === 'xau-agent') distro = 'xau-agent';
    return { distro, dir };
  };
  assert.deepEqual(derive('\\\\wsl.localhost\\xau-agent\\home\\xauagent\\projects\\Alpha-xau\\.claude\\worktrees\\xau-terminal\\scripts\\terminal\\'),
    { distro: 'xau-agent', dir: '/home/xauagent/projects/Alpha-xau/.claude/worktrees/xau-terminal' });
  assert.deepEqual(derive('\\\\WSL.LOCALHOST\\XAU-AGENT\\home\\xauagent\\x\\scripts\\terminal\\'), { distro: 'xau-agent', dir: '/home/xauagent/x' });
  assert.deepEqual(derive('\\\\wsl$\\Ubuntu\\home\\u\\repo\\scripts\\terminal\\'), { distro: 'Ubuntu', dir: '/home/u/repo' });
  assert.deepEqual(derive('C:\\Users\\Enzo\\Desktop\\'), { distro: 'xau-agent', dir: '/home/xauagent/projects/Alpha-xau/.claude/worktrees/xau-terminal' });
  console.log('PASS xau-terminal.cmd: derives distro and checkout from its location, no pinned version, no system change');
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
