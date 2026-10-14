// Local terminal: the loopback server (scripts/serve_terminal_local.mjs) and
// the V2 panels of frontend/js/dashboard.js rendered in jsdom.
//   - the server binds 127.0.0.1, serves frontend/ read-only and the CHAIN-0
//     view, and injects V2_VIEW_URL only into the page it serves;
//   - the terminal renders HOLD, provenance and the capability matrix, and
//     refuses a view that claims anything but HOLD with execution forbidden;
//   - demo mode never shows a setup, a verdict or a LIVE price.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createTerminalServer, localIndexHtml, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(options) {
  const server = await createTerminalServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}
const close = (server) => new Promise((resolve) => server.close(resolve));

// --- Published page keeps the hook empty; only the served page points at the view.
assert.equal(html.split("V2_VIEW_URL: '',").length, 2, 'index.html carries exactly one empty V2_VIEW_URL');
assert.ok(localIndexHtml().includes(`V2_VIEW_URL: '${VIEW_PATH}',`));
assert.ok(!localIndexHtml().includes("V2_VIEW_URL: '',"));
assert.ok(localIndexHtml().includes("SUPABASE_URL: '',"), 'local page keeps Supabase empty (V1 demo mode)');

// --- Server.
const { server, base } = await listen();
let response = await fetch(`${base}/`);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type'), /text\/html/);
assert.equal(response.headers.get('cache-control'), 'no-store');
const served = await response.text();
assert.ok(served.includes(`V2_VIEW_URL: '${VIEW_PATH}',`));

response = await fetch(`${base}${VIEW_PATH}`);
assert.equal(response.status, 200);
const view = await response.json();
assert.equal(view.schemaVersion, 'xau.terminal-local-view.v1');
assert.equal(view.chain.chainState, 'HOLD');
assert.equal(view.chain.execution, 'FORBIDDEN');
assert.equal(view.chain.integrity, 'CONSISTENT');
assert.equal(view.chain.digest, 'sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7', 'golden digest');
assert.equal(view.origin.kind, 'GOLDEN_FIXTURE');
assert.ok(Number.isFinite(Date.parse(view.generatedAt)));

for (const [pathname, status] of [['/js/dashboard.js', 200], ['/css/style.css', 200], ['/index.html', 200],
  ['/../package.json', 404], ['/%2e%2e/package.json', 404], ['/js/../../scripts/serve_terminal_local.mjs', 404],
  ['/js', 404], ['/missing.js', 404], ['/js/dashboard.js%00.html', 404], ['/%E0%A4%A', 400]]) {
  response = await fetch(`${base}${pathname}`);
  assert.equal(response.status, status, pathname);
  await response.arrayBuffer();
}
for (const method of ['POST', 'PUT', 'DELETE']) {
  response = await fetch(`${base}${VIEW_PATH}`, { method });
  assert.equal(response.status, 405, method);
  await response.arrayBuffer();
}
response = await fetch(`${base}${VIEW_PATH}`, { method: 'HEAD' });
assert.equal(response.status, 200);
assert.equal(await response.text(), '');
await close(server);
console.log('PASS loopback server: view, static files, traversal refused, read-only methods');

// --- Local input file: bad documents still yield a HOLD view.
const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'terminal-local-'));
try {
  for (const [name, body, failed] of [
    ['malformed.json', '{not json', true],
    ['wrong-shape.json', JSON.stringify({ knowledgeCutoff: golden.knowledgeCutoff, input: { ...golden.input, extra: 1 } }), true],
    ['stale.json', JSON.stringify({ knowledgeCutoff: '2026-10-08T14:15:00.000Z', input: golden.input }), false],
  ]) {
    writeFileSync(path.join(dir, name), body);
    const local = await listen({ inputFile: path.join(dir, name) });
    const v = await (await fetch(`${local.base}${VIEW_PATH}`)).json();
    await close(local.server);
    assert.equal(v.origin.kind, 'LOCAL_INPUT_FILE', name);
    assert.equal(v.origin.label, name);
    assert.equal(v.chain.chainState, 'HOLD', name);
    assert.equal(v.chain.execution, 'FORBIDDEN', name);
    assert.equal(v.chain.outcome, failed ? 'REJECTED' : 'COMPLETED', name);
    if (!failed) {
      // A week after the fixture, every market field is downgraded at the cutoff.
      assert.ok(v.chain.inputFindings.length > 0, name);
      assert.equal(v.stages[0].state, 'ABSTAIN', name);
      assert.ok(v.market.fields.every((f) => f.statusAtCutoff !== 'LIVE'), name);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('PASS local input files: malformed, mis-shaped and stale inputs all stay HOLD');

// --- Terminal rendering.
function boot(config, fetchImpl) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom.window.fetch = fetchImpl;
  dom.window.ALPHA_XAU_CONFIG = config;
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  return dom;
}
const LOCAL = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
const serveView = (body, status = 200) => (url) => (String(url) === VIEW_PATH
  ? Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(structuredClone(body)) })
  : Promise.reject(new Error(`unexpected fetch ${url}`)));
const text = (d, id) => d.getElementById(id).textContent;

let dom = boot(LOCAL, serveView(view));
await settle();
let d = dom.window.document;
assert.equal(text(d, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'hold');
assert.equal(text(d, 'v2-origin'), 'SIMULÉ — FIXTURE');
assert.equal(text(d, 'v2-chain-state'), 'HOLD');
assert.equal(text(d, 'v2-execution'), 'INTERDITE');
assert.equal(text(d, 'v2-integrity'), 'CONSISTENT');
assert.equal(text(d, 'v2-cutoff'), '2026-10-01T14:15:00.000Z');
assert.equal(d.getElementById('v2-digest').getAttribute('title'), view.chain.digest);
const stageRows = [...d.querySelectorAll('#v2-stages tr')];
assert.equal(stageRows.length, 12);
assert.equal(stageRows[0].cells[0].textContent, 'MARKET PRICING');
assert.equal(stageRows[0].cells[1].textContent, 'DEGRADED');
assert.equal(stageRows[0].cells[2].textContent, 'SIMULÉ');
assert.equal(stageRows[8].cells[0].textContent, 'ACTION');
assert.equal(stageRows[8].getAttribute('data-capability'), 'BLOCKED');
assert.match(stageRows[8].cells[3].textContent, /EXECUTION_NOT_AUTHORIZED/);
const marketRows = [...d.querySelectorAll('#v2-market tr')];
assert.equal(marketRows.length, 8);
assert.deepEqual([...marketRows[0].cells].map((c) => c.textContent), ['SPOT', '3900', 'LIVE', '60s', 'twelve_data']);
assert.deepEqual([...marketRows[3].cells].map((c) => c.textContent), ['DXY', 'N/A', 'UNAVAILABLE', 'N/A', 'N/A']);
const capRows = [...d.querySelectorAll('#v2-capabilities tr')];
assert.equal(capRows.length, view.capabilities.length);
const execRow = capRows.find((r) => r.cells[0].textContent === 'EXECUTION');
assert.equal(execRow.cells[1].textContent, 'BLOQUÉ');
assert.match(execRow.cells[2].textContent, /AUTORISATION/);
assert.match(text(d, 'v2-capability-count'), /OPÉRATIONNEL LOCAL 3 · SIMULÉ \d+ · BLOQUÉ \d+ · NON VALIDÉ 1/);
// Local V1 panels: demo, honest.
assert.equal(text(d, 'price-freshness'), 'DÉMO');
assert.equal(text(d, 'execution-status'), 'AUCUNE ANALYSE');
assert.equal(text(d, 'risk-verdict'), 'N/A');
assert.equal(d.querySelectorAll('#scenario-tree .scen').length, 0);
assert.ok(!/SETUP VALIDE|APPROUVÉ/.test(d.querySelector('main').textContent + d.querySelector('footer').textContent),
  'no positive V1 decision in demo');
assert.ok([...d.querySelectorAll('#news-stream .stream__title')].every((n) => n.textContent.startsWith('[DÉMO] ')));
dom.window.close();
console.log('PASS terminal renders the HOLD chain, provenance per field and the capability matrix');

// --- Refusals: a view claiming anything but HOLD / forbidden is not displayed at all.
const mutations = [
  ['execution allowed', (v) => { v.chain.execution = 'ALLOWED'; }],
  ['chain GO', (v) => { v.chain.chainState = 'GO'; }],
  ['not simulated', (v) => { v.simulated = false; }],
  ['unknown version', (v) => { v.schemaVersion = 'xau.terminal-local-view.v2'; }],
  ['unknown origin', (v) => { v.origin.kind = 'PRODUCTION'; }],
  ['unknown capability status', (v) => { v.capabilities[0].status = 'LIVE'; }],
  ['unknown stage capability', (v) => { v.stages[8].capability = 'EXECUTABLE'; }],
  ['stages missing', (v) => { delete v.stages; }],
  ['null view', () => null],
];
for (const [name, mutate] of mutations) {
  const body = structuredClone(view);
  const replaced = mutate(body);
  dom = boot(LOCAL, serveView(replaced === null ? null : body));
  await settle();
  d = dom.window.document;
  assert.equal(text(d, 'v2-state'), 'VUE V2 REFUSÉE', name);
  assert.equal(d.querySelectorAll('#v2-stages tr').length, 1, name);
  assert.equal(text(d, 'v2-chain-state'), '—', name);
  assert.equal(text(d, 'v2-capabilities').trim(), 'Matrice indisponible sans vue V2.', name);
  dom.window.close();
}
console.log(`PASS ${mutations.length} non-conforming views are refused whole`);

// --- Untrusted strings stay text.
const hostile = structuredClone(view);
hostile.stages[0].reasons[0].code = '<img src=x onerror="window.__pwned=1">';
hostile.capabilities[0].detail = '<script>window.__pwned=1</script>';
dom = boot(LOCAL, serveView(hostile));
await settle();
d = dom.window.document;
assert.equal(dom.window.__pwned, undefined);
assert.equal(d.querySelectorAll('#v2-stages img, #v2-capabilities script').length, 0);
assert.match(d.querySelector('#v2-stages tr').cells[3].textContent, /<img src=x/);
dom.window.close();
console.log('PASS view strings are rendered as text only');

// --- Degraded: no URL, HTTP error, network error, rejected chain, violated integrity.
dom = boot({ ...LOCAL, V2_VIEW_URL: '' }, () => Promise.reject(new Error('no fetch expected')));
await settle();
d = dom.window.document;
assert.equal(text(d, 'v2-state'), 'INDISPONIBLE');
assert.equal(text(d, 'v2-origin'), 'AUCUN RUNTIME');
assert.match(text(d, 'v2-detail'), /Aucun runtime V2 déployé/);
dom.window.close();

for (const [name, impl] of [['HTTP 500', serveView({}, 500)], ['network', () => Promise.reject(new Error('ECONNREFUSED'))],
  ['bad JSON', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) })]]) {
  dom = boot(LOCAL, impl);
  await settle();
  d = dom.window.document;
  assert.equal(text(d, 'v2-state'), 'VUE V2 INJOIGNABLE', name);
  assert.match(text(d, 'v2-detail'), /HOLD conservé/, name);
  assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'error', name);
  dom.window.close();
}

const rejectedView = structuredClone(view);
Object.assign(rejectedView, { stages: [], market: { state: null, observedThrough: null, replay: null, fields: [] } });
Object.assign(rejectedView.chain, { outcome: 'REJECTED', integrity: null, digest: null, knowledgeCutoff: null,
  rejection: { failedAt: 'INPUT', inputErrors: ['extra: UNKNOWN_KEY'], stageError: null } });
dom = boot(LOCAL, serveView(rejectedView));
await settle();
d = dom.window.document;
assert.equal(text(d, 'v2-state'), 'HOLD — ENTRÉE REJETÉE');
assert.match(text(d, 'v2-detail'), /INPUT : extra: UNKNOWN_KEY/);
assert.match(text(d, 'v2-stages'), /Aucun étage/);
dom.window.close();

const violatedView = structuredClone(view);
Object.assign(violatedView.chain, { integrity: 'VIOLATED', violations: [{ stage: 'REGIME', code: 'STAGE_STATE_FORBIDDEN' }] });
dom = boot(LOCAL, serveView(violatedView));
await settle();
d = dom.window.document;
assert.equal(text(d, 'v2-state'), 'HOLD — INTÉGRITÉ VIOLÉE');
assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
dom.window.close();
console.log('PASS degraded V2 states: unavailable, unreachable, rejected input, violated integrity');

// --- End to end: jsdom against the real server.
const live = await listen();
dom = boot(LOCAL, (url) => fetch(new URL(String(url), live.base)));
await settle(400);
d = dom.window.document;
assert.equal(text(d, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
assert.equal(d.querySelectorAll('#v2-stages tr').length, 12);
dom.window.close();
await close(live.server);
console.log('PASS terminal against the real local server renders the golden HOLD chain');
