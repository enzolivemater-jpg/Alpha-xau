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
import { createHash } from 'node:crypto';
import { contentSecurityPolicy, createTerminalServer, localIndexHtml, SCENARIOS_PATH, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';
import { TERMINAL_SCENARIO_IDS } from '../scripts/lib/terminal_scenarios.mjs';

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
assert.equal(html.split("V2_SCENARIOS_URL: '',").length, 2);
assert.ok(localIndexHtml().includes(`V2_SCENARIOS_URL: '${SCENARIOS_PATH}',`));

// --- Server.
const { server, base } = await listen();
let response = await fetch(`${base}/`);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type'), /text\/html/);
assert.equal(response.headers.get('cache-control'), 'no-store');
const served = await response.text();
assert.ok(served.includes(`V2_VIEW_URL: '${VIEW_PATH}',`));
// Strict CSP: only the configuration script, by its exact hash after injection.
const csp = response.headers.get('content-security-policy');
const inline = /<script>([\s\S]*?)<\/script>/.exec(served)[1];
const hash = createHash('sha256').update(inline, 'utf8').digest('base64');
const directives = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
assert.deepEqual(directives['script-src'], ["'self'", `'sha256-${hash}'`]);
assert.deepEqual(directives['default-src'], ["'none'"]);
assert.deepEqual(directives['connect-src'], ["'self'"]);
assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
assert.ok(!csp.includes("'unsafe-eval'"));
assert.equal(response.headers.get('x-frame-options'), 'DENY');
assert.equal(csp, contentSecurityPolicy(served));
assert.throws(() => contentSecurityPolicy(`${served}<script>alert(1)</script>`), /exactly one inline script/);
assert.notEqual(contentSecurityPolicy(served.replace("POLL_INTERVAL_MS: 5000", "POLL_INTERVAL_MS: 5001")), csp,
  'any change to the inline script changes its hash');

response = await fetch(`${base}${VIEW_PATH}`);
assert.equal(response.status, 200);
const view = await response.json();
assert.equal(view.schemaVersion, 'xau.terminal-local-view.v2');
assert.equal(view.temporal.classification, 'HISTORICAL', 'the golden fixture is in the past');
assert.equal(view.chain.chainState, 'HOLD');
assert.equal(view.chain.execution, 'FORBIDDEN');
assert.equal(view.chain.integrity, 'CONSISTENT');
assert.equal(view.chain.digest, 'sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7', 'golden digest');
assert.equal(view.origin.kind, 'GOLDEN_FIXTURE');
assert.ok(Number.isFinite(Date.parse(view.generatedAt)));

// --- Simulation scenarios: each one holds, for its own reason.
response = await fetch(`${base}${SCENARIOS_PATH}`);
const scenarioList = await response.json();
assert.deepEqual(scenarioList.map((item) => item.id), TERMINAL_SCENARIO_IDS);
assert.ok(scenarioList.every((item) => typeof item.label === 'string' && item.label.length > 0));
const scenarioView = async (id) => (await fetch(`${base}${VIEW_PATH}?scenario=${id}`)).json();
const stageOf = (v, name) => v.stages.find((st) => st.stage === name);
const reasonsOf = (v, name) => stageOf(v, name).reasons.map((r) => r.code);
for (const id of TERMINAL_SCENARIO_IDS) {
  const v = await scenarioView(id);
  assert.deepEqual(v.origin, { kind: 'LOCAL_SCENARIO', label: id }, id);
  assert.equal(v.simulated, true, id);
  assert.equal(v.chain.chainState, 'HOLD', id);
  assert.equal(v.chain.execution, 'FORBIDDEN', id);
  if (v.chain.outcome === 'COMPLETED') {
    assert.equal(v.chain.integrity, 'CONSISTENT', id);
    assert.equal(stageOf(v, 'ACTION').state, 'ABSTAIN', id);
  }
}
assert.equal((await scenarioView('golden')).chain.digest, view.chain.digest, 'golden scenario = golden fixture');
const granted = await scenarioView('everything-granted');
assert.ok(!reasonsOf(granted, 'ACTION').includes('EXECUTION_NOT_AUTHORIZED'));
assert.ok(reasonsOf(granted, 'ACTION').includes('ACTION_METHOD_NOT_APPROVED'), 'granting everything still holds');
// Only the authorizations no chain input can grant remain.
assert.deepEqual(granted.holdRationale.rootCauses.find((c) => c.category === 'AUTHORIZATION').codes,
  ['COMMAND_CENTER_RUNTIME_NOT_APPROVED', 'E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED']);
const later = await scenarioView('read-7-days-later');
assert.ok(later.chain.inputFindings.length > 0);
assert.equal(stageOf(later, 'MARKET_PRICING').state, 'ABSTAIN');
assert.equal(later.temporal.classification, 'HISTORICAL');
const down = await scenarioView('market-unavailable');
assert.ok(reasonsOf(down, 'MARKET_PRICING').includes('SOURCE_SNAPSHOT_UNAVAILABLE'));
const ahead = await scenarioView('lookahead');
assert.ok(reasonsOf(ahead, 'MARKET_PRICING').includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));
const invalid = await scenarioView('invalid-input');
assert.equal(invalid.chain.outcome, 'REJECTED');
assert.ok(invalid.chain.rejection.inputErrors.includes('unexpectedKey: UNKNOWN_KEY'));
for (const bad of ['nope', '..%2Fgolden', '', 'GOLDEN']) {
  response = await fetch(`${base}${VIEW_PATH}?scenario=${bad}`);
  assert.equal(response.status, bad === '' ? 200 : 404, bad);
  await response.arrayBuffer();
}
console.log(`PASS ${TERMINAL_SCENARIO_IDS.length} simulation scenarios all hold, each for its own reason; unknown ones are refused`);

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
assert.match(text(d, 'v2-detail'), /pas une analyse de marché réelle/);
assert.equal(text(d, 'v2-origin'), 'SIMULATION — FIXTURE');
assert.equal(text(d, 'v2-chain-state'), 'HOLD');
assert.equal(text(d, 'v2-execution'), 'INTERDITE');
assert.equal(text(d, 'v2-integrity'), 'CONSISTENT');
assert.equal(text(d, 'v2-cutoff'), '2026-10-01T14:15:00.000Z');
assert.equal(text(d, 'v2-digest'), view.chain.digest, 'full digest shown');
assert.match(text(d, 'v2-cutoff-age'), /^\d+ (s|min|h|j) — HISTORIQUE$/);
// Why HOLD: first blocking stage and root causes by category.
assert.equal(d.getElementById('v2-why').hidden, false);
assert.match(text(d, 'v2-why-lead'), /^Premier étage bloquant : HORIZON SYNTHESIS\. \d+ motif\(s\) hérité\(s\) de l'amont/);
const why = [...d.querySelectorAll('#v2-why-list .why')];
assert.deepEqual(why.map((w) => w.getAttribute('data-category')), view.holdRationale.rootCauses.map((c) => c.category));
const auth = why.find((w) => w.getAttribute('data-category') === 'AUTHORIZATION');
assert.match(auth.querySelector('.why__cat').textContent, /^AUTORISATION — autorisation explicite requise$/);
assert.match(auth.querySelector('.why__codes').textContent, /EXECUTION NOT AUTHORIZED/);
// Stage cards.
const stages = [...d.querySelectorAll('#v2-stages .stage')];
assert.equal(stages.length, 12);
const stage = (i, sel) => stages[i].querySelector(sel).textContent;
assert.equal(stage(0, '.stage__name'), 'MARKET PRICING');
assert.equal(stage(0, '.stage__state'), 'DEGRADED');
assert.equal(stage(0, '.stage__cap'), 'SIMULÉ');
assert.equal(stage(8, '.stage__name'), 'ACTION');
assert.equal(stages[8].getAttribute('data-capability'), 'BLOCKED');
const actionReasons = [...stages[8].querySelectorAll('.reason')].map((r) =>
  [r.getAttribute('data-category'), r.querySelector('.reason__cat').textContent, r.querySelector('.reason__code').textContent]);
assert.deepEqual(actionReasons, [
  ['UPSTREAM', 'AMONT', 'FINAL_RISK_NOT_READY'],
  ['AUTHORIZATION', 'AUTORISATION', 'EXECUTION_NOT_AUTHORIZED'],
  ['ENVIRONMENT', 'ENVIRONNEMENT', 'BROKER_NOT_CONNECTED'],
  ['BUSINESS_DECISION', 'DÉCISION MÉTIER', 'ACTION_METHOD_NOT_APPROVED'],
]);
assert.match(stage(8, '.stage__version'), /^xau\.action-abstention\.v1 · action-abstention-gate-1\.0\.0$/);
// Market at the cutoff: a LIVE field of a simulation is labelled as such.
const marketRows = [...d.querySelectorAll('#v2-market tr')];
assert.equal(marketRows.length, 8);
assert.deepEqual([...marketRows[0].cells].map((c) => c.textContent),
  ['SPOT', '3900', 'LIVE AU CUTOFF', '60 s', '2026-10-01 14:14:00Z', 'twelve_data']);
assert.deepEqual([...marketRows[3].cells].map((c) => c.textContent), ['DXY', 'N/A', 'UNAVAILABLE', 'N/A', 'N/A', 'N/A']);
assert.equal([...marketRows[4].cells][3].textContent, '14 h');
assert.ok(marketRows.every((r) => r.cells[2].textContent !== 'LIVE'), 'no bare LIVE in a simulation');
assert.equal(text(d, 'v2-market-state'), 'MP-0 DEGRADED');
assert.equal(text(d, 'v2-replay'), 'LATEST_ONLY — non reproductible (INGESTION_CUTOFF_NOT_AVAILABLE)');
assert.equal(text(d, 'v2-positioning'), 'EVIDENCE_READY · 1 preuve(s) · signal UNAVAILABLE');
assert.equal(text(d, 'v2-positioning-through'), '2026-09-30T19:31:00.000Z');
assert.equal(text(d, 'v2-positioning-sources'), 'authority_test');
// Capability list.
const caps = [...d.querySelectorAll('#v2-capabilities .cap')];
assert.equal(caps.length, view.capabilities.length);
const exec = caps.find((c) => c.querySelector('.cap__id').textContent === 'EXECUTION');
assert.equal(exec.querySelector('.cap__status').textContent, 'BLOQUÉ');
assert.match(exec.querySelector('.cap__blockers').textContent, /AUTORISATION/);
assert.match(text(d, 'v2-capability-count'), /OPÉRATIONNEL LOCAL 3 · SIMULÉ \d+ · BLOQUÉ \d+ · NON VALIDÉ 1/);
// Data nature, always visible: DEMO market, SIMULATION + HISTORICAL chain, HOLD decision.
assert.equal(d.getElementById('mode-v1').getAttribute('data-mode'), 'demo');
assert.equal(text(d, 'mode-v1-val'), 'DÉMO — VALEURS SYNTHÉTIQUES');
assert.equal(d.getElementById('mode-v2').getAttribute('data-mode'), 'historical');
assert.match(text(d, 'mode-v2-val'), /^SIMULATION — FIXTURE · HISTORIQUE \(cutoff il y a \d+ (s|min|h|j)\) · HOLD$/);
assert.equal(text(d, 'tab-chain-state'), 'HOLD');
assert.ok(!/\bLIVE\b/.test(text(d, 'mode-v1-val') + text(d, 'mode-v2-val')));
assert.equal(text(d, 'macro-meta'), 'DÉMO — VALEURS SYNTHÉTIQUES');
assert.equal(text(d, 'conviction-grade'), '', 'no duplicated N/A');
// Horizons, acceptance manifest, observability.
const horizons = [...d.querySelectorAll('#v2-horizons .horizon')];
assert.deepEqual(horizons.map((h) => h.querySelector('.horizon__id').textContent), ['H1', 'H2', 'H3', 'H4', 'H5']);
assert.ok(horizons.every((h) => h.querySelector('.horizon__status').textContent === 'ABSTAIN'
  && h.querySelector('.horizon__dir').textContent === 'aucune direction'));
const evidence = [...d.querySelectorAll('#v2-evidence .evidence__item')];
assert.equal(evidence.length, 11);
assert.ok(evidence.every((e) => e.querySelector('.evidence__mark').textContent === 'MANQUANTE'));
assert.equal(evidence[0].querySelector('.evidence__label').textContent, 'Point de restauration vérifié');
assert.equal(evidence[10].querySelector('.evidence__label').textContent, "Autorité d'exécution approuvée");
assert.equal(text(d, 'v2-acceptance-state'), 'NOT_ACCEPTED · 0/11 DÉCLARÉES');
assert.equal(text(d, 'v2-observability'), 'CONTRACT_ONLY · corrélation absente · déploiement absent');
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
  ['previous version', (v) => { v.schemaVersion = 'xau.terminal-local-view.v1'; }],
  ['unknown temporal class', (v) => { v.temporal.classification = 'LIVE'; }],
  ['rationale missing', (v) => { delete v.holdRationale; }],
  ['unknown root cause', (v) => { v.holdRationale.rootCauses[0].category = 'NONE'; }],
  ['horizon with a direction', (v) => { v.horizons[0].direction = 'BULLISH'; }],
  ['horizon not abstaining', (v) => { v.horizons[2].status = 'READY'; }],
  ['acceptance missing', (v) => { delete v.acceptance; }],
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
  assert.equal(d.querySelectorAll('#v2-stages .stage').length, 0, name);
  assert.equal(d.getElementById('v2-why').hidden, true, name);
  assert.equal(d.getElementById('mode-v2').getAttribute('data-mode'), 'refused', name);
  assert.equal(text(d, 'tab-chain-state'), 'REFUSÉE', name);
  assert.equal(text(d, 'v2-chain-state'), '—', name);
  assert.equal(text(d, 'v2-positioning'), '—', name);
  assert.equal(text(d, 'v2-capabilities').trim(), 'Matrice indisponible sans vue V2.', name);
  dom.window.close();
}
console.log(`PASS ${mutations.length} non-conforming views are refused whole`);

// --- Only the latest requested view is shown, whatever the arrival order.
{
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const rejectedBody = structuredClone(view);
  Object.assign(rejectedBody.chain, { outcome: 'REJECTED', integrity: null, digest: null, knowledgeCutoff: null,
    rejection: { failedAt: 'INPUT', inputErrors: ['x: MISSING'], stageError: null } });
  Object.assign(rejectedBody, { stages: [] });
  const scenarios = [{ id: 'golden', label: 'g' }, { id: 'invalid-input', label: 'i' }];
  const order = (url) => {
    const u = String(url);
    if (u === '/s.json') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(scenarios) });
    // The first (default) request answers late with a stale view.
    if (u === VIEW_PATH) return slow.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(view)) }));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(rejectedBody)) });
  };
  dom = boot({ ...LOCAL, V2_SCENARIOS_URL: '/s.json' }, order);
  await settle(100);
  d = dom.window.document;
  d.getElementById('v2-scenario').value = 'invalid-input';
  d.getElementById('v2-scenario').dispatchEvent(new dom.window.Event('change'));
  await settle(100);
  release();
  await settle(100);
  assert.equal(text(d, 'v2-state'), 'HOLD — ENTRÉE REJETÉE', 'late default view did not overwrite the chosen scenario');
  dom.window.close();
}
console.log('PASS a late response never overwrites the scenario chosen after it');

// --- Untrusted strings stay text.
const hostile = structuredClone(view);
hostile.stages[0].reasons[0].code = '<img src=x onerror="window.__pwned=1">';
hostile.capabilities[0].detail = '<script>window.__pwned=1</script>';
hostile.holdRationale.rootCauses[0].codes[0] = '<img src=y onerror="window.__pwned=2">';
hostile.market.fields[0].source = '<b>twelve</b>';
dom = boot(LOCAL, serveView(hostile));
await settle();
d = dom.window.document;
assert.equal(dom.window.__pwned, undefined);
assert.equal(d.querySelectorAll('#ws-chain img, #ws-chain script, #ws-chain b').length, 0);
assert.match(d.querySelector('#v2-why-list .why__codes').textContent, /<img src=y/);
assert.match(d.querySelector('#v2-stages .reason__code').textContent, /<img src=x/);
dom.window.close();
console.log('PASS view strings are rendered as text only');

// --- Workspaces: accessible tabs, hash and remembered choice; HOLD visible from both.
const tabState = (d) => [d.getElementById('ws-market').hidden, d.getElementById('ws-chain').hidden,
  d.getElementById('tab-market').getAttribute('aria-selected'), d.getElementById('tab-chain').getAttribute('aria-selected')];
dom = boot(LOCAL, serveView(view));
await settle();
d = dom.window.document;
assert.deepEqual(tabState(d), [false, true, 'true', 'false'], 'market workspace by default');
assert.match(d.querySelector('.workbar').textContent, /HOLD — EXÉCUTION INTERDITE/, 'decision visible from the market tab');
d.getElementById('tab-chain').click();
assert.deepEqual(tabState(d), [true, false, 'false', 'true']);
assert.equal(d.getElementById('tab-chain').tabIndex, 0);
assert.equal(d.getElementById('tab-market').tabIndex, -1);
assert.equal(dom.window.localStorage.getItem('alpha-xau.workspace'), 'chain');
d.getElementById('tab-chain').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
assert.deepEqual(tabState(d), [false, true, 'true', 'false']);
assert.equal(d.activeElement.id, 'tab-market');
d.getElementById('tab-market').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
assert.deepEqual(tabState(d), [true, false, 'false', 'true']);
dom.window.close();
const bootAt = (hash, stored) => {
  const dom2 = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `http://127.0.0.1:4173/${hash}` });
  if (stored) dom2.window.localStorage.setItem('alpha-xau.workspace', stored);
  dom2.window.fetch = serveView(view);
  dom2.window.ALPHA_XAU_CONFIG = LOCAL;
  const script = dom2.window.document.createElement('script');
  script.textContent = js;
  dom2.window.document.body.appendChild(script);
  return dom2;
};
for (const [hash, stored, chainShown] of [['#chaine', null, true], ['', 'chain', true], ['#marche', 'chain', false], ['', 'bogus', false]]) {
  const dom2 = bootAt(hash, stored);
  await settle(50);
  assert.equal(dom2.window.document.getElementById('ws-chain').hidden, !chainShown, `${hash} ${stored}`);
  dom2.window.close();
}
console.log('PASS workspaces: keyboard tabs, #chaine/#marche, remembered choice, HOLD visible from both');

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

// --- Market data nature with a real (mocked) feed: LIVE only when fresh.
const SUPA = { SUPABASE_URL: 'https://t.supabase.co', SUPABASE_ANON_KEY: 'anon', POLL_INTERVAL_MS: 1e6,
  ANALYSIS_INTERVAL_MS: 1e6, STALE_THRESHOLD_S: 60, V2_VIEW_URL: '' };
const tick = (staleness) => [{ symbol: 'XAUUSD', bid: 3401, ask: 3402, spread: 1, close: 3401.5, dxy_value: 97.1,
  us10y_yield: null, real_yield: null, vix: null, wti: null, ts: '2026-10-14T10:00:00Z', staleness_seconds: staleness }];
const feed = (staleness) => (url) => Promise.resolve({ ok: true, status: 200,
  json: () => Promise.resolve(String(url).includes('v_market_latest') ? tick(staleness) : []) });
for (const [name, impl, mode, label] of [
  ['fresh', feed(12), 'live', 'LIVE 12s'],
  ['stale', feed(900), 'stale', 'PÉRIMÉ 900s'],
  ['down', () => Promise.reject(new Error('ECONNREFUSED')), 'offline', 'FLUX ROMPU'],
]) {
  // Two consecutive failures are needed before the feed is declared broken.
  dom = boot(name === 'down' ? { ...SUPA, POLL_INTERVAL_MS: 50 } : SUPA, impl);
  await settle(300);
  d = dom.window.document;
  assert.equal(d.getElementById('mode-v1').getAttribute('data-mode'), mode, name);
  assert.equal(text(d, 'mode-v1-val'), label, name);
  if (name !== 'down') assert.equal(text(d, 'macro-meta'), `TICK 10:00 UTC · ${name === 'fresh' ? 12 : 900}s`, name);
  assert.equal(text(d, 'mode-v2-val'), 'INDISPONIBLE', name);
  dom.window.close();
}
console.log('PASS market data nature: LIVE only when fresh, PÉRIMÉ beyond the threshold, FLUX ROMPU when down');

// --- End to end: jsdom against the real server, including the scenario selector.
const live = await listen();
dom = boot({ ...LOCAL, V2_SCENARIOS_URL: SCENARIOS_PATH }, (url) => fetch(new URL(String(url), live.base)));
await settle(400);
d = dom.window.document;
assert.equal(text(d, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
assert.equal(d.querySelectorAll('#v2-stages .stage').length, 12);
assert.equal(d.getElementById('v2-scenario-wrap').hidden, false);
const options = [...d.querySelectorAll('#v2-scenario option')].map((o) => o.value);
assert.deepEqual(options, ['', ...TERMINAL_SCENARIO_IDS]);
const select = d.getElementById('v2-scenario');
select.value = 'invalid-input';
select.dispatchEvent(new dom.window.Event('change'));
await settle(400);
assert.equal(text(d, 'v2-state'), 'HOLD — ENTRÉE REJETÉE');
assert.equal(text(d, 'v2-origin'), 'SIMULATION — SCÉNARIO INVALID-INPUT');
select.value = 'everything-granted';
select.dispatchEvent(new dom.window.Event('change'));
await settle(400);
assert.equal(text(d, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
assert.doesNotMatch(text(d, 'v2-why-list'), /EXECUTION NOT AUTHORIZED|PROVIDER NOT AUTHORIZED/);
assert.match(text(d, 'mode-v2-val'), /^SIMULATION — SCÉNARIO EVERYTHING-GRANTED · HISTORIQUE/);
// Every evidence declared by the simulation, still not accepted.
assert.equal(text(d, 'v2-acceptance-state'), 'NOT_ACCEPTED · 11/11 DÉCLARÉES');
assert.equal(text(d, 'v2-observability'), 'CONTRACT_ONLY · corrélation corr-test-1 · déploiement deploy-test-1');
dom.window.close();
await close(live.server);
console.log('PASS terminal against the real local server renders the golden HOLD chain');
