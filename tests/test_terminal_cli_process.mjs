/**
 * Offline demo terminal, END TO END ON THE REAL PROCESS. The other terminal tests
 * run the server in memory; none starts `scripts/serve_terminal_local.mjs` the way
 * an operator does. This one spawns it, waits for its ready line, and checks what
 * a browser would load: the page and its security headers, the scenario list, and
 * for EVERY scenario the view (12 CHAIN-0 stages in order, HOLD / FORBIDDEN,
 * simulated, origin, cutoff, fingerprint rules). It then covers the error paths
 * (unknown scenario, wrong method, traversal, foreign Host, hostile files), the
 * command-line errors (bad port, unknown flag, missing value), a port already in
 * use, and a clean stop. Loopback only; no network, database or provider.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'serve_terminal_local.mjs');
const STAGES = ['MARKET_PRICING', 'POSITIONING', 'REGIME', 'HORIZON_SYNTHESIS', 'AI_COMMITTEE', 'PRE_PM',
  'PORTFOLIO_MANAGER', 'FINAL_ACTION_RISK', 'ACTION', 'COMMAND_CENTER', 'ALERT', 'ACCEPTANCE'];

const failures = [];
const note = (label, message) => { if (failures.length < 30) failures.push(`${label}: ${message}`); };

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/** Starts the real CLI; resolves once it prints its ready line, or reports how it ended. */
function start(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 20_000);
    const check = setInterval(() => {
      if (/terminal local : http:\/\/127\.0\.0\.1:\d+\//.test(stdout)) { clearInterval(check); clearTimeout(timer); resolve('ready'); }
    }, 25);
    exited.then(() => { clearInterval(check); clearTimeout(timer); resolve('exited'); });
  });
  return { child, ready, exited, out: () => ({ stdout, stderr }) };
}
const stop = async (server) => {
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGTERM');
  return Promise.race([server.exited, new Promise((resolve) => setTimeout(() => { server.child.kill('SIGKILL'); resolve('killed'); }, 5000))]);
};

function raw(port, pathname, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------- command-line errors
for (const [label, args] of [
  ['non-numeric port', ['--port', 'abc']], ['port 0', ['--port', '0']], ['port 70000', ['--port', '70000']],
  ['negative port', ['--port', '-1']], ['unknown flag', ['--bogus', '1']], ['missing value', ['--port']],
  ['odd arguments', ['--port', '4173', '--input']], ['bad digest', ['--archive', 'x.json', '--archive-digest', 'nope']],
]) {
  const server = start(args);
  const state = await server.ready;
  const { stdout, stderr } = server.out();
  const result = await stop(server);
  if (state === 'ready') note(`cli ${label}`, 'started although the arguments are invalid');
  if (result.code !== 1) note(`cli ${label}`, `exit code ${JSON.stringify(result)} (expected 1)`);
  if (!/usage:/.test(stderr)) note(`cli ${label}`, `no usage message on stderr (${JSON.stringify(stderr.slice(0, 120))})`);
  if (stdout.includes('terminal local :')) note(`cli ${label}`, 'printed the ready line');
}

// ---------------------------------------------------------------- the demo itself
const port = await freePort();
const main = start(['--port', String(port)]);
assert.equal(await main.ready, 'ready', `the server starts: ${JSON.stringify(main.out())}`);
{
  const { stdout } = main.out();
  if (!stdout.includes(`http://127.0.0.1:${port}/`)) note('ready line', 'does not show the URL to open');
  if (!/HOLD/.test(stdout) || !/interdite/.test(stdout)) note('ready line', 'does not state HOLD and forbidden execution');
}

// The page a browser loads.
{
  const page = await raw(port, '/');
  if (page.status !== 200 || !/text\/html/.test(page.headers['content-type'])) note('page', `status ${page.status}`);
  const csp = page.headers['content-security-policy'] ?? '';
  for (const directive of ["default-src 'none'", "frame-ancestors 'none'", "connect-src 'self'", "base-uri 'none'"]) {
    if (!csp.includes(directive)) note('page', `CSP lacks ${directive}`);
  }
  if (page.headers['x-frame-options'] !== 'DENY') note('page', 'no X-Frame-Options DENY');
  if (page.headers['cache-control'] !== 'no-store') note('page', 'page is cacheable');
  if (!page.body.includes("V2_VIEW_URL: '/local/v2/terminal.json'")) note('page', 'view URL not injected');
  if (!page.body.includes("V2_SCENARIOS_URL: '/local/v2/scenarios.json'")) note('page', 'scenarios URL not injected');
  if (!/SUPABASE_URL: ''/.test(page.body)) note('page', 'Supabase URL is not empty (demo mode would call a database)');
  for (const asset of ['/js/dashboard.js', '/css/style.css']) {
    const response = await raw(port, asset);
    if (response.status !== 200) note(`asset ${asset}`, `status ${response.status}`);
  }
}

// Every scenario, through the real process.
const scenarios = JSON.parse((await raw(port, '/local/v2/scenarios.json')).body);
if (scenarios.length < 10) note('scenarios', `only ${scenarios.length} scenarios offered`);
if (!scenarios.every((s) => typeof s.id === 'string' && /^[a-z][a-z0-9-]*$/.test(s.id) && typeof s.label === 'string' && s.label.length > 10)) {
  note('scenarios', 'an id or a label is malformed or too short to be understood');
}
const views = new Map();
for (const { id } of [{ id: null }, ...scenarios]) {
  const query = id === null ? '' : `?scenario=${encodeURIComponent(id)}`;
  const response = await raw(port, `/local/v2/terminal.json${query}`);
  const label = id ?? '<default>';
  if (response.status !== 200 || !/application\/json/.test(response.headers['content-type'])) { note(`view ${label}`, `status ${response.status}`); continue; }
  const view = JSON.parse(response.body);
  views.set(label, view);
  if (view.simulated !== true) note(`view ${label}`, 'not labelled simulated');
  if (view.chain.chainState !== 'HOLD' || view.chain.execution !== 'FORBIDDEN') note(`view ${label}`, 'left HOLD / FORBIDDEN');
  if (view.summary.decision !== 'HOLD' || view.summary.execution !== 'FORBIDDEN') note(`view ${label}`, 'summary left HOLD / FORBIDDEN');
  if (!view.origin?.kind || !view.origin?.label) note(`view ${label}`, 'no origin (provenance) shown');
  if (!Number.isFinite(Date.parse(view.generatedAt))) note(`view ${label}`, 'no generation time');
  if (view.chain.outcome === 'COMPLETED') {
    if (view.stages.map((s) => s.stage).join() !== STAGES.join()) note(`view ${label}`, `stages are ${view.stages.map((s) => s.stage).join(',')}`);
    if (!Number.isFinite(Date.parse(view.chain.knowledgeCutoff))) note(`view ${label}`, 'no knowledge cutoff');
    if (!['HISTORICAL', 'CURRENT', 'FUTURE', 'UNKNOWN'].includes(view.temporal.classification)) note(`view ${label}`, `temporal class ${view.temporal.classification}`);
    if (view.stages.some((s) => !['SIMULATED', 'BLOCKED'].includes(s.capability))) note(`view ${label}`, 'a stage claims a capability beyond simulated / blocked');
    if (view.chain.digest !== null && !/^sha256:[0-9a-f]{64}$/.test(view.chain.digest)) note(`view ${label}`, 'malformed fingerprint');
    if (view.chain.integrity === 'VIOLATED' && view.chain.digest !== null) note(`view ${label}`, 'a violated chain shows a fingerprint');
  } else {
    if (view.stages.length !== 0) note(`view ${label}`, 'a rejected input still lists stages');
    if (view.chain.digest !== null) note(`view ${label}`, 'a rejected input shows a fingerprint');
    if (!view.chain.rejection) note(`view ${label}`, 'a rejected input gives no reason');
  }
  if (view.capabilities.some((c) => !['SIMULATED', 'BLOCKED', 'UNAVAILABLE', 'CONTRACT_ONLY'].includes(c.status) && c.status === 'LIVE')) {
    note(`view ${label}`, 'a capability is LIVE');
  }
  if (/\b(BUY|SELL|LONG|SHORT)\b/.test(response.body.replace(/"[a-zA-Z_]*(?:direction|Direction)[a-zA-Z_]*":"[A-Z_]+"/g, ''))) {
    note(`view ${label}`, 'a trading word appears in the view');
  }
}
// The default view is the golden fixture and equals the 'golden' scenario's chain.
if (views.get('<default>')?.origin.kind !== 'GOLDEN_FIXTURE') note('default view', 'is not the golden fixture');
if (views.get('golden') && views.get('<default>')?.chain.digest !== views.get('golden').chain.digest) note('golden', 'scenario digest differs from the default view');
// Archive scenarios carry their market-evidence manifest, labelled as simulation.
for (const [label, view] of views) {
  if (label.startsWith('archive-') && view.marketEvidence === null) note(`view ${label}`, 'no market evidence manifest');
  if (label.startsWith('archive-') && view.marketEvidence && view.marketEvidence.nature === 'LIVE') note(`view ${label}`, 'market evidence labelled LIVE');
}
// One scenario per documented failure reason.
const reason = (label) => (views.get(label)?.holdRationale.rootCauses ?? []).flatMap((c) => c.codes);
if (!reason('market-unavailable').includes('SOURCE_SNAPSHOT_UNAVAILABLE')) note('market-unavailable', 'does not explain the missing market data');
if (!reason('lookahead').includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF')) note('lookahead', 'does not flag the look-ahead');
if (views.get('invalid-input')?.chain.outcome !== 'REJECTED') note('invalid-input', 'is not rejected');
if (views.get('everything-granted')?.chain.digest !== null) note('everything-granted', 'shows a fingerprint although OBS-0 refuses its receipt');

// Error paths a user can hit.
const expectStatus = async (label, pathname, status, options) => {
  const response = await raw(port, pathname, options);
  if (response.status !== status) note(label, `status ${response.status} (expected ${status})`);
  if (/Error:|    at |node_modules|\/home\//.test(response.body)) note(label, 'the body leaks an internal path or stack');
};
await expectStatus('unknown scenario', '/local/v2/terminal.json?scenario=nope', 404);
await expectStatus('traversal scenario', '/local/v2/terminal.json?scenario=..%2F..%2Fetc%2Fpasswd', 404);
await expectStatus('traversal path', '/%2e%2e/package.json', 404);
await expectStatus('traversal in assets', '/js/../../scripts/serve_terminal_local.mjs', 404);
await expectStatus('unknown path', '/nothing-here', 404);
await expectStatus('unsupported extension', '/index.html.map', 404);
await expectStatus('post', '/local/v2/terminal.json', 405, { method: 'POST' });
await expectStatus('delete', '/', 405, { method: 'DELETE' });
await expectStatus('foreign host', '/local/v2/terminal.json', 403, { host: 'attacker.example' });
await expectStatus('foreign host on the page', '/', 403, { host: `127.0.0.1.attacker.example:${port}` });
{
  const head = await raw(port, '/local/v2/terminal.json', { method: 'HEAD' });
  if (head.status !== 200 || head.body !== '') note('head', `status ${head.status} body ${head.body.length}`);
}
{
  const lookalike = await raw(port, `/local/v2/terminal.json?scenario=golden&scenario=invalid-input`);
  if (lookalike.status !== 200) note('repeated scenario parameter', `status ${lookalike.status}`);
}

// A second server on the same port: a readable refusal, not a stack trace.
{
  const second = start(['--port', String(port)]);
  const state = await second.ready;
  const { stdout, stderr } = second.out();
  const result = await stop(second);
  if (state === 'ready') note('port in use', 'a second server claims to be ready on the same port');
  if (result.code === 0) note('port in use', 'exit code 0');
  if (/\n\s+at .*\(/.test(stderr)) note('port in use', `a raw stack trace is printed instead of a readable message: ${JSON.stringify(stderr.split('\n').slice(0, 4).join(' | ').slice(0, 220))}`);
  if (!/EADDRINUSE|already in use|déjà utilisé|occup/i.test(stderr + stdout)) note('port in use', 'the message does not say the port is in use');
}

// Clean stop.
{
  const started = Date.now();
  const result = await stop(main);
  if (result === 'killed') note('stop', 'did not exit on SIGTERM within 5 s');
  if (Date.now() - started > 4000) note('stop', 'slow to stop');
  const after = await raw(port, '/').then(() => 'still listening', () => 'closed');
  if (after !== 'closed') note('stop', 'the port is still open after SIGTERM');
}

// Hostile inputs given on the command line: the demo still opens, in HOLD.
for (const [label, extra, check] of [
  ['missing --input file', ['--input', '/nonexistent/chain.json'], (v) => v.chain.outcome === 'REJECTED'],
  ['missing --archive file', ['--archive', '/nonexistent/archive.json'], (v) => v.marketEvidence?.status === 'INVALID'],
]) {
  const p = await freePort();
  const server = start(['--port', String(p), ...extra]);
  const state = await server.ready;
  if (state !== 'ready') { note(label, `the server did not start: ${JSON.stringify(server.out().stderr.slice(0, 200))}`); await stop(server); continue; }
  const response = await raw(p, '/local/v2/terminal.json');
  const view = JSON.parse(response.body);
  if (response.status !== 200 || view.chain.chainState !== 'HOLD' || view.chain.execution !== 'FORBIDDEN') note(label, 'not a HOLD / FORBIDDEN view');
  else if (!check(view)) note(label, 'the failure is not shown in the view');
  await stop(server);
}

assert.deepEqual(failures, [], `TERMINAL PROCESS findings (${failures.length}):\n${failures.join('\n')}`);
console.log(`PASS terminal demo process: real CLI, ${scenarios.length} scenarios + default each HOLD / FORBIDDEN with 12 ordered stages or a stated rejection; `
  + 'error paths, bad arguments, port conflict and clean stop checked');
