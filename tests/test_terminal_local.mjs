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
import { createServer as createNetServer } from 'node:net';
import {
  contentSecurityPolicy, createTerminalServer, DEFAULT_PORT, DEFAULT_PORT_RANGE, listenOnLoopback, localIndexHtml,
  MAX_PORT_RANGE, parseArgs, SCENARIOS_PATH, VIEW_PATH,
} from '../scripts/serve_terminal_local.mjs';
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

// --- Port selection: a default range, an explicit strict port, an explicit bounded range.
{
  const defaults = parseArgs([]);
  assert.equal(defaults.port, DEFAULT_PORT);
  assert.equal(defaults.port, 4173);
  assert.equal(defaults.portRange, DEFAULT_PORT_RANGE);
  assert.deepEqual([parseArgs(['--port', '5000']).port, parseArgs(['--port', '5000']).portRange], [5000, 1], 'an explicit port is strict');
  assert.deepEqual([parseArgs(['--port', '5000', '--port-range', '4']).port, parseArgs(['--port', '5000', '--port-range', '4']).portRange], [5000, 4]);
  assert.equal(parseArgs(['--port-range', '4', '--port', '5000']).portRange, 4, 'flag order does not matter');
  for (const bad of [['--port-range', '4'], ['--port', '5000', '--port-range', '0'], ['--port', '5000', '--port-range', String(MAX_PORT_RANGE + 1)],
    ['--port', '5000', '--port-range', '-1'], ['--port', '5000', '--port-range', '1.5'], ['--port', '5000', '--port-range', ''],
    ['--host', '0.0.0.0'], ['--port', '5000', '--host', '0.0.0.0'], ['--address', '0.0.0.0']]) {
    assert.equal(parseArgs(bad), null, `refused: ${bad.join(' ')}`);
  }
  const source = readFileSync(new URL('../scripts/serve_terminal_local.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]), ['candidate, LOOPBACK_ADDRESS'],
    'the only listen call takes the fixed loopback address');
  assert.doesNotMatch(source, /0\.0\.0\.0|'::'|--host|--bind/, 'no way to listen beyond the loopback');

  // listenOnLoopback on real sockets.
  const holders = [];
  const hold = (p) => new Promise((resolve, reject) => {
    const holder = createNetServer();
    holder.once('error', reject);
    holder.listen(p, '127.0.0.1', () => { holders.push(holder); resolve(holder.address().port); });
  });
  let first = 0;
  for (let attempt = 0; attempt < 20 && first === 0; attempt += 1) {
    try {
      const p = await hold(0);
      await hold(p + 1);
      first = p;
    } catch { await Promise.all(holders.splice(0).map((h) => new Promise((r) => h.close(r)))); }
  }
  assert.notEqual(first, 0, 'two consecutive busy ports');
  const probe = await createTerminalServer();
  const taken = await listenOnLoopback(probe, { port: first, range: 5 });
  assert.ok(taken.port >= first + 2 && taken.port <= first + 4, `moved past the two busy ports (${taken.port})`);
  assert.equal(taken.requested, first);
  assert.equal(probe.address().address, '127.0.0.1', 'bound to the loopback only');
  await close(probe);
  const strictProbe = await createTerminalServer();
  await assert.rejects(listenOnLoopback(strictProbe, { port: first }), (error) => error.code === 'EADDRINUSE' && error.firstPort === first && error.lastPort === first);
  assert.equal(strictProbe.listening, false, 'a strict busy port leaves the server closed');
  const shortProbe = await createTerminalServer();
  await assert.rejects(listenOnLoopback(shortProbe, { port: first, range: 2 }), (error) => error.code === 'EADDRINUSE' && error.lastPort === first + 1);
  assert.equal(shortProbe.listening, false);
  // Only EADDRINUSE moves on: a malformed port is not retried.
  const badProbe = await createTerminalServer();
  await assert.rejects(listenOnLoopback(badProbe, { port: 70000, range: 5 }), (error) => error.code === 'ERR_SOCKET_BAD_PORT' || error instanceof RangeError);
  await Promise.all(holders.map((h) => new Promise((r) => h.close(r))));
}

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

// Network independence: nothing of the page, its policy or its stylesheet reaches a foreign origin.
for (const [directive, sources] of Object.entries(directives)) {
  for (const source of sources) {
    assert.match(source, /^('self'|'none'|'unsafe-inline'|'sha256-[A-Za-z0-9+/=]+'|data:)$/, `CSP ${directive} allows ${source}`);
  }
}
assert.doesNotMatch(csp, /https?:|\*/, 'CSP names no foreign origin');
assert.doesNotMatch(served, /<(link|script|img|iframe|source)\b[^>]*\b(href|src)\s*=\s*["']?(https?:)?\/\//i,
  'the served page loads nothing from a foreign origin');
assert.doesNotMatch(served, /preconnect|dns-prefetch|prefetch/i, 'the served page opens no early connection');
// A browser asks the server for /favicon.ico unless the page names an icon: that was a 404 in the
// console on every first load (seen in headless Chromium). An inline data: icon needs no request.
assert.match(served, /<link rel="icon" href="data:[^"]+">/, 'the page declares an inline icon, so no /favicon.ico request is made');
assert.ok(directives['img-src'].includes('data:'), 'the CSP allows the inline icon');
const stylesheet = await (await fetch(`${base}/css/style.css`)).text();
assert.doesNotMatch(stylesheet, /@import|url\(\s*["']?(https?:)?\/\//i, 'the stylesheet fetches nothing from a foreign origin');
assert.doesNotMatch(stylesheet, /@font-face/i, 'no web font is declared: system fonts only');
for (const family of ['--mono', '--sans']) {
  const stack = new RegExp(`${family}:\\s*([^;]+);`).exec(stylesheet)?.[1] ?? '';
  assert.match(stack, /(^|,)\s*(monospace|sans-serif)\s*$/, `${family} ends with a generic family`);
  assert.ok(stack.split(',').length >= 5, `${family} lists several local fallbacks`);
}

response = await fetch(`${base}${VIEW_PATH}`);
assert.equal(response.status, 200);
const view = await response.json();
assert.equal(view.schemaVersion, 'xau.terminal-local-view.v4');
assert.equal(view.temporal.classification, 'HISTORICAL', 'the golden fixture is in the past');
assert.equal(view.chain.chainState, 'HOLD');
assert.equal(view.chain.execution, 'FORBIDDEN');
assert.equal(view.chain.integrity, 'CONSISTENT');
assert.equal(view.chain.digest, 'sha256:919b602e2f1ad8df2dc8f3acbe2a4237d5914640210bb8b1f4102e8635ae149c', 'golden digest');
const serverSource = readFileSync(new URL('../scripts/serve_terminal_local.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(serverSource, /computeDecisionChainDigest/, 'terminal may not compute an unchecked chain digest');
assert.match(serverSource, /obs\.buildOfflineAuditReceipt\(outcome\.result\)/, 'terminal must use OBS-0 receipt');
assert.match(serverSource, /STRUCTURALLY_VALID_HOLD_UNVERIFIED/, 'terminal must admit only structurally accepted receipt');
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
// DATA-1 archive scenarios: the market snapshot comes from a replay, the manifest travels with the view.
const archiveView = await scenarioView('archive-synthetic');
// DATA-3 L1 (replay 1.1.0): the synthetic fixture declares dxy and holds no DXY value: INCOMPLETE, still usable.
assert.equal(archiveView.marketEvidence.status, 'INCOMPLETE');
assert.equal(archiveView.marketEvidence.reproducible, false);
assert.equal(archiveView.marketEvidence.nature, 'SIMULATION');
assert.equal(archiveView.market.fields.find((f) => f.field === 'wti').value, 66.4);
const afterCorrection = await scenarioView('archive-after-correction');
assert.equal(afterCorrection.market.fields.find((f) => f.field === 'wti').value, 66.9);
// Upstream summaries evaluated at another cutoff are reported, never mixed in silently.
assert.ok(reasonsOf(afterCorrection, 'HORIZON_SYNTHESIS').includes('UPSTREAM_CUTOFF_MISMATCH'));
assert.ok(afterCorrection.holdRationale.rootCauses.some((c) => c.category === 'INTEGRITY' && c.codes.includes('UPSTREAM_CUTOFF_MISMATCH')));
assert.ok(!reasonsOf(archiveView, 'HORIZON_SYNTHESIS').includes('UPSTREAM_CUTOFF_MISMATCH'), 'aligned cutoffs: no mismatch');
assert.equal((await scenarioView('archive-incomplete')).marketEvidence.reproducible, false);
for (const id of ['archive-unit-mismatch', 'archive-contradiction']) {
  const v = await scenarioView(id);
  assert.equal(v.marketEvidence.status, 'INVALID', id);
  assert.equal(stageOf(v, 'MARKET_PRICING').state, 'ABSTAIN', id);
  assert.ok(v.market.fields.every((f) => f.value === null), `${id}: no value from a rejected archive`);
}
assert.equal(view.marketEvidence, null, 'a chain input snapshot has no archive manifest');
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

// --- --archive: the server replays a local archive, optionally pinned to its digest.
let verifiedSimView = null;
let completeSimView = null;
{
  const archiveFile = new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url).pathname;
  const pinned = archiveView.marketEvidence.archiveDigest;
  const scratch = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'terminal-archive-'));
  try {
    writeFileSync(path.join(scratch, 'broken.json'), '{not json');
    for (const [name, options, status, mp0] of [
      ['pinned', { archiveFile, archiveDigest: pinned }, 'INCOMPLETE', 'DEGRADED'],
      ['unpinned', { archiveFile }, 'INCOMPLETE', 'DEGRADED'],
      ['wrong pin', { archiveFile, archiveDigest: `sha256:${'0'.repeat(64)}` }, 'INVALID', 'ABSTAIN'],
      ['broken file', { archiveFile: path.join(scratch, 'broken.json') }, 'INVALID', 'ABSTAIN'],
      // Four days on, the spot has expired: INCOMPLETE replay and MP-0 abstains.
      ['cutoff outside coverage', { archiveFile, cutoff: '2026-10-05T00:00:00.000Z' }, 'INCOMPLETE', 'ABSTAIN'],
    ]) {
      const local = await listen(options);
      const v = await (await fetch(`${local.base}${VIEW_PATH}`)).json();
      await close(local.server);
      assert.equal(v.origin.kind, 'LOCAL_MARKET_ARCHIVE', name);
      assert.equal(v.marketEvidence.status, status, name);
      assert.equal(v.marketEvidence.pinnedDigest, options.archiveDigest ?? null, name);
      assert.equal(v.chain.chainState, 'HOLD', name);
      assert.equal(v.chain.execution, 'FORBIDDEN', name);
      assert.equal(v.stages[0].state, mp0, name);
    }
    // The same synthetic archive completed with the DXY value it declares (fictitious, written here).
    // Replay 1.2.0 (DATA-3 L1b): DXY has no approved freshness rule, so it stays INCOMPLETE, never VERIFIED.
    const complete = JSON.parse(readFileSync(archiveFile, 'utf8'));
    complete.records.push({ evidenceId: 'test-dxy-20260930', field: 'dxy', instrument: 'DXY', unit: 'INDEX_POINTS',
      observationType: 'DAILY_VALUE', value: 98.4, source: 'synthetic_fixture', sourceRecordId: null,
      observedAt: '2026-09-30T00:00:00.000Z', publishedAt: null, ingestedAt: '2026-10-01T06:00:00.000Z',
      revision: 'test-1', supersedes: null, rawPayloadDigest: null });
    writeFileSync(path.join(scratch, 'complete.json'), JSON.stringify(complete));
    const local = await listen({ archiveFile: path.join(scratch, 'complete.json') });
    completeSimView = await (await fetch(`${local.base}${VIEW_PATH}`)).json();
    await close(local.server);
    const mev = completeSimView.marketEvidence;
    assert.deepEqual([mev.status, mev.reproducible, mev.nature, mev.provenanceClass], ['INCOMPLETE', false, 'SIMULATION', 'SYNTHETIC_FIXTURE']);
    assert.ok(mev.reasonCodes.includes('DECLARED_FIELD_FRESHNESS_NOT_EVALUATED'));
    assert.equal(mev.observations.find((o) => o.field === 'dxy').freshnessProof, 'NOT_EVALUATED');
    assert.ok(mev.observations.filter((o) => o.field !== 'dxy').every((o) => o.freshnessProof === 'FRESH'));
    assert.deepEqual([completeSimView.chain.chainState, completeSimView.chain.execution], ['HOLD', 'FORBIDDEN']);
    // A hypothetical VERIFIED view, as if an approved DXY freshness rule proved the value fresh: no archive reaches it today.
    verifiedSimView = structuredClone(completeSimView);
    Object.assign(verifiedSimView.marketEvidence, { status: 'VERIFIED', reproducible: true,
      reasonCodes: mev.reasonCodes.filter((c) => c !== 'DECLARED_FIELD_FRESHNESS_NOT_EVALUATED') });
    verifiedSimView.marketEvidence.observations.find((o) => o.field === 'dxy').freshnessProof = 'FRESH';
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log('PASS --archive: pinned, unpinned, wrong pin, broken file and out-of-coverage cutoff all stay HOLD');

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
// Decision summary: overall state, main reasons, missing data, blocking dependencies.
const sum = view.summary;
assert.equal(d.getElementById('v2-sec-summary').hidden, false);
assert.equal(d.getElementById('v2-sec-summary').getAttribute('data-status'), 'BLOCKED');
assert.equal(text(d, 'v2-summary-headline'), sum.headline);
const listText = (id) => [...d.querySelectorAll(`#${id} li`)].map((li) => li.textContent);
assert.deepEqual(listText('v2-summary-reasons'), [...sum.mainReasons.map((r) => `${r.count} — ${r.plain}`),
  '11/11 preuves de recette manquantes']);
assert.deepEqual(listText('v2-summary-missing'), ['DXY indisponible au cutoff.', "Le graphe de preuves n'a pas été fourni."]);
const deps = [...d.querySelectorAll('#v2-summary-deps .dep')];
assert.deepEqual(deps.map((g) => g.querySelector('.dep__head').textContent), ['BUSINESS_DECISION', 'AUTHORIZATION', 'ENVIRONMENT']
  .map((c) => `${{ BUSINESS_DECISION: 'APPROBATIONS MÉTIER', AUTHORIZATION: 'AUTORISATIONS', ENVIRONMENT: 'ENVIRONNEMENT' }[c]} (${
    sum.blockingDependencies.filter((x) => x.category === c).length})`));
assert.equal(d.querySelectorAll('#v2-summary-deps .dep__item').length, sum.blockingDependencies.length, 'every dependency reachable');
assert.match(d.querySelector('#v2-summary-deps [data-category="AUTHORIZATION"]').textContent,
  /Aucune exécution n'est autorisée\.EXECUTION_NOT_AUTHORIZED · ACTION/);
// Why HOLD: a plain summary first, technical codes one click away, nothing dropped.
assert.equal(d.getElementById('v2-why').hidden, false);
assert.match(text(d, 'v2-why-lead'), /^La chaîne s'arrête à POSITIONING, premier étage bloqué ; .*\(\d+ motif\(s\) hérité\(s\) de l'amont\)\.$/);
assert.match(text(d, 'v2-why-lift'), /^Pour lever le HOLD, il faudrait : fournir ou corriger 2 donnée\(s\) ; approuver \d+ méthode\(s\) ou politique\(s\) ; accorder \d+ autorisation\(s\) ; mettre en place \d+ élément\(s\) d'environnement/);
const why = [...d.querySelectorAll('#v2-why-list .why')];
assert.deepEqual(why.map((w) => w.getAttribute('data-category')), view.holdRationale.rootCauses.map((c) => c.category));
assert.ok(why.every((w) => w.tagName === 'DETAILS' && !w.open), 'causes start folded');
const auth = why.find((w) => w.getAttribute('data-category') === 'AUTHORIZATION');
assert.match(auth.querySelector('.why__cat').textContent, /^AUTORISATION — autorisation explicite requise$/);
assert.equal(auth.querySelector('.why__count').textContent, String(view.holdRationale.rootCauses.find((c) => c.category === 'AUTHORIZATION').codes.length));
assert.match(auth.querySelector('.why__codes').textContent, /EXECUTION NOT AUTHORIZED/);
assert.ok([...auth.querySelectorAll('.why__plain li')].some((li) => li.textContent === "Aucune exécution n'est autorisée."));
// Every reason code of every stage is still in the page, in plain text and as a code.
for (const st of view.stages) {
  for (const r of st.reasons) {
    assert.ok(d.getElementById('v2-stages').textContent.includes(r.code), r.code);
    if (r.category !== 'UPSTREAM') assert.ok(d.getElementById('v2-why-list').textContent.includes(r.plain), r.code);
  }
}
// Stage cards.
const stages = [...d.querySelectorAll('#v2-stages .stage')];
assert.equal(stages.length, 12);
assert.ok(stages.every((st) => !st.querySelector('details').open), 'stages start folded');
assert.equal(stages[8].querySelector('.stage__count').textContent, '4 motif(s)');
const stage = (i, sel) => stages[i].querySelector(sel).textContent;
assert.equal(stage(0, '.stage__name'), 'MARKET PRICING');
assert.equal(stage(0, '.stage__state'), 'DEGRADED');
assert.equal(stage(0, '.stage__cap'), 'SIMULÉ');
assert.equal(stage(8, '.stage__name'), 'ACTION');
assert.equal(stages[8].getAttribute('data-capability'), 'BLOCKED');
const actionReasons = [...stages[8].querySelectorAll('.reason')].map((r) =>
  [r.getAttribute('data-category'), r.querySelector('.reason__cat').textContent, r.querySelector('.reason__code').textContent,
    r.querySelector('.reason__plain').textContent]);
assert.deepEqual(actionReasons, [
  ['UPSTREAM', 'AMONT', 'FINAL_RISK_NOT_READY', "Le risque final n'est pas prêt en amont."],
  ['AUTHORIZATION', 'AUTORISATION', 'EXECUTION_NOT_AUTHORIZED', "Aucune exécution n'est autorisée."],
  ['ENVIRONMENT', 'ENVIRONNEMENT', 'BROKER_NOT_CONNECTED', "Aucun courtier n'est connecté."],
  ['BUSINESS_DECISION', 'DÉCISION MÉTIER', 'ACTION_METHOD_NOT_APPROVED', "La méthode de décision d'action n'est pas approuvée."],
]);
assert.match(stage(8, '.stage__version'), /^xau\.action-abstention\.v1 · action-abstention-gate-1\.0\.0$/);
// Market at the cutoff: a field fresh at a simulated cutoff is FRAIS AU CUTOFF, never LIVE.
const marketRows = [...d.querySelectorAll('#v2-market tr')];
assert.equal(marketRows.length, 8);
assert.deepEqual([...marketRows[0].cells].map((c) => c.textContent),
  ['SPOT', '3900', 'FRAIS AU CUTOFF', '60 s', '2026-10-01 14:14:00Z', 'twelve_data']);
// Provenance is never dropped for layout: six cells per field, SOURCE last, in the DOM at every width.
// Rows and cells carry explicit ARIA roles because the narrow layout turns the table into a CSS grid.
assert.ok(marketRows.every((row) => row.cells.length === 6 && row.getAttribute('role') === 'row'));
assert.ok(marketRows.every((row) => [...row.cells].every((cell) => cell.getAttribute('role') === 'cell')));
assert.equal(d.querySelector('.v2__table--market').getAttribute('role'), 'table');
assert.deepEqual([...d.querySelectorAll('.v2__table--market thead th')].map((th) => th.textContent),
  ['CHAMP', 'VALEUR', 'ÉTAT AU CUTOFF', 'ÂGE', 'OBSERVÉ (UTC)', 'SOURCE']);
assert.ok([...d.querySelectorAll('.v2__table--market thead th')].every((th) => th.getAttribute('role') === 'columnheader'));
{
  // Layout contract (verified in a real browser by scripts/check_terminal_layout.mjs, which now
  // fails on any content left behind a horizontal scroller): the market table may wrap and
  // restack, but may not hide SOURCE or OBSERVÉ with display:none or a fixed-width clip.
  const css = readFileSync(new URL('../frontend/css/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.v2__table--market td \{ white-space: normal;|\.v2__table--market th,\s*\.v2__table--market td \{ white-space: normal;/);
  assert.match(css, /@container market \(max-width: 440px\)/);
  assert.doesNotMatch(css, /v2__table--market[^{]*nth-child\([56]\)[^{]*\{[^}]*display:\s*none/, 'no provenance column is hidden');
  assert.match(css, /\.v2__facts--stack \{ grid-template-columns: minmax\(0, 1fr\);/, 'long digests wrap instead of widening the column');
  assert.match(css, /\.v2__table--market td:nth-child\(5\)::before \{ content: 'OBSERVÉ '/);
  assert.match(css, /\.v2__table--market td:nth-child\(6\)::before \{ content: 'SOURCE '/);
}
assert.match(text(d, 'v2-market-legend'), /^FRAIS AU CUTOFF : .*cutoff simulé\. Ce n'est pas un flux en direct\.$/);
// The word LIVE appears nowhere in the simulated workspace.
assert.doesNotMatch(d.getElementById('ws-chain').textContent, /\bLIVE\b/);
assert.deepEqual([...marketRows[3].cells].map((c) => c.textContent), ['DXY', 'N/A', 'UNAVAILABLE', 'N/A', 'N/A', 'N/A']);
assert.equal([...marketRows[4].cells][3].textContent, '14 h');
assert.ok(marketRows.every((r) => r.cells[2].textContent !== 'LIVE'), 'no bare LIVE in a simulation');
assert.equal(text(d, 'v2-market-state'), 'MP-0 DEGRADED');
assert.equal(text(d, 'v2-replay'), 'LATEST_ONLY — non reproductible (INGESTION_CUTOFF_NOT_AVAILABLE)');
// B5: never presented as ready; freshness is not evaluated without an approved threshold.
assert.equal(text(d, 'v2-positioning'), 'ABSTAIN · 1 preuve(s) · signal UNAVAILABLE');
assert.match(text(d, 'v2-positioning-freshness'), /^fraîcheur non évaluée — aucun seuil approuvé · publiée \d+ (s|min|h|j) avant le cutoff$/);
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
assert.equal(text(d, 'mode-v2-val'), 'SIMULATION · HISTORIQUE');
// Inside the workspace, the full nature stays visible while scrolling.
assert.equal(d.getElementById('v2-nav-nature').getAttribute('data-mode'), 'historical');
assert.match(text(d, 'v2-nav-nature'), /^SIMULATION — FIXTURE · HISTORIQUE — cutoff il y a \d+ (s|min|h|j) · PAS UNE ANALYSE RÉELLE$/);
// The legend defines every label, and LIVE only as a real feed.
const legend = Object.fromEntries([...d.querySelectorAll('#nature-legend dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
assert.deepEqual(Object.keys(legend), ['DÉMO', 'SIMULATION', 'HISTORIQUE', 'HISTORIQUE VÉRIFIÉ', 'FRAIS AU CUTOFF', 'LIVE', 'HOLD']);
assert.match(legend['HISTORIQUE VÉRIFIÉ'], /octets bruts.*jamais LIVE/);
assert.match(legend.LIVE, /flux de marché réel.*Jamais une simulation/);
assert.match(legend['FRAIS AU CUTOFF'], /Ce n'est pas un flux en direct/);
assert.match(legend.SIMULATION, /Jamais une analyse de marché réelle/);
assert.equal(text(d, 'tab-chain-state'), 'HOLD');
assert.ok(!/\bLIVE\b/.test(text(d, 'mode-v1-val') + text(d, 'mode-v2-val') + text(d, 'v2-nav-nature')));
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

const demoNews = [...d.querySelectorAll('#news-stream .stream__item')];
assert.equal(demoNews.length, 3, 'three purely illustrative rows');
for (const row of demoNews) {
  assert.equal(row.getAttribute('data-class'), 'demo', 'fictional events cannot claim CATALYST/MAJOR');
  assert.equal(row.querySelector('[data-field="classification"]').textContent, 'DÉMO');
  assert.equal(row.querySelector('[data-field="score"]').textContent, 'NON ÉVALUÉ');
  assert.equal(row.querySelector('[data-field="time"]').textContent, 'HEURE FICTIVE');
  const impact = row.querySelector('[data-field="impact"]');
  assert.equal(impact.textContent, 'OR — NON ÉVALUÉ (DÉMO)');
  assert.equal(impact.getAttribute('data-dir'), 'unavailable', 'no bullish/bearish demo cue');
  assert.doesNotMatch(row.textContent, /\b(HAUSSIER|BAISSIER|CATALYST|MAJOR)\b/);
}
const demoSource = js.slice(js.indexOf('function startDemo()'), js.indexOf('13. HORLOGE ET DÉMARRAGE'));
assert.doesNotMatch(demoSource, /gold_direction_impact:\s*'(bullish|bearish)'/);
assert.doesNotMatch(demoSource, /news_score:\s*[0-9]/);

dom.window.close();
console.log('PASS terminal renders the HOLD chain, provenance per field and the capability matrix');

// --- Provenance: a recent or unreadable cutoff is still a SIMULATION, never LIVE.
for (const [classification, age, label, mode] of [
  ['AT_GENERATION', 42, 'SIMULATION · CUTOFF À LA GÉNÉRATION', 'simulated'],
  ['UNKNOWN', null, 'SIMULATION · CUTOFF INCONNU', 'simulated'],
]) {
  const body = structuredClone(view);
  body.temporal = { classification, cutoffAgeSeconds: age, currentWindowSeconds: 360 };
  body.origin = { kind: 'LOCAL_INPUT_FILE', label: 'recent.json' };
  dom = boot(LOCAL, serveView(body));
  await settle();
  d = dom.window.document;
  assert.equal(text(d, 'mode-v2-val'), label, classification);
  assert.equal(d.getElementById('mode-v2').getAttribute('data-mode'), mode, classification);
  assert.equal(text(d, 'v2-nav-nature'), `SIMULATION — FICHIER LOCAL · ${label.split(' · ')[1]} · PAS UNE ANALYSE RÉELLE`);
  assert.doesNotMatch(text(d, 'v2-cutoff-age'), /HISTORIQUE/, classification);
  assert.doesNotMatch(d.getElementById('ws-chain').textContent + text(d, 'mode-v2-val'), /\bLIVE\b/, classification);
  dom.window.close();
}
console.log('PASS provenance: a recent or unreadable cutoff is labelled SIMULATION, never LIVE');

// --- DATA-1 market evidence in the terminal: provenance shown, nature never overstated.
dom = boot(LOCAL, serveView(archiveView));
await settle();
d = dom.window.document;
assert.equal(d.getElementById('v2-mev').hidden, false);
assert.equal(text(d, 'v2-mev-status'), 'REJEU INCOMPLET · ARCHIVE SYNTHÉTIQUE · non reproductible');
assert.equal(text(d, 'mode-v2-val'), 'ARCHIVE SYNTHÉTIQUE · DRY RUN');
assert.match(text(d, 'v2-nav-nature'), /^SIMULATION — SCÉNARIO ARCHIVE-SYNTHETIC · ARCHIVE SYNTHÉTIQUE · REJEU INCOMPLET · .* · PAS UNE ANALYSE RÉELLE$/);
assert.match(text(d, 'v2-mev-archive'), /^fixture-data1-2026-10-01 · SYNTHETIC_FIXTURE · 10 enregistrement\(s\)$/);
assert.match(text(d, 'v2-mev-digest'), /^sha256:[0-9a-f]{64} \(non épinglée\)$/);
assert.equal(text(d, 'v2-mev-replay'), archiveView.marketEvidence.replayDigest);
assert.equal(text(d, 'v2-mev-audit'), "2 enregistrement(s) ingéré(s) après le cutoff ; corrigé(s) plus tard : WTI");
const mevItems = [...d.querySelectorAll('#v2-mev-obs .mev__item')];
assert.equal(mevItems.length, archiveView.marketEvidence.observations.length);
const spotItem = Object.fromEntries([...mevItems[0].querySelectorAll('.mev__facts > div')]
  .map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));
assert.deepEqual(spotItem, {
  'INSTRUMENT · TYPE': 'XAUUSD · LAST', 'SOURCE · ID SOURCE': 'twelve_data · XAU/USD', 'OBSERVÉ': '2026-10-01 14:14:00Z',
  'PUBLIÉ': 'INCONNU', 'INGÉRÉ': '2026-10-01 14:14:03Z', 'RÉVISION': 'td-quote-2', 'FRAÎCHEUR AU CUTOFF': 'FRAIS AU CUTOFF · 60 s', 'PREUVE DE FRAÎCHEUR': 'FRAÎCHEUR PROUVÉE',
  'EMPREINTE': archiveView.marketEvidence.observations[0].recordDigest,
});
assert.equal(mevItems[0].querySelector('.mev__raw').textContent, 'BRUT INCONNU');
assert.doesNotMatch(d.getElementById('ws-chain').textContent, /\bLIVE\b/, 'a replayed snapshot is never LIVE');
dom.window.close();
dom = boot(LOCAL, serveView(view));
await settle();
assert.equal(dom.window.document.getElementById('v2-mev').hidden, true, 'no manifest, no section');
dom.window.close();
// A captured, fully re-read archive is HISTORIQUE VÉRIFIÉ, and still a dry run, still not LIVE.
const historical = structuredClone(archiveView);
// A hypothetical view: no archive reaches it today (DATA-3 L1), the page must still render it coherently.
Object.assign(historical.marketEvidence, { nature: 'HISTORICAL_VERIFIED', provenanceClass: 'CAPTURED', status: 'VERIFIED', reproducible: true });
// Coherent with VERIFIED: none of the replay's own incompleteness reasons left.
historical.marketEvidence.reasonCodes = historical.marketEvidence.reasonCodes.filter((c) => c !== 'DECLARED_FIELD_NOT_OBSERVED');
for (const o of historical.marketEvidence.observations) Object.assign(o, { raw: 'RAW_VERIFIED', freshnessProof: 'FRESH' });
// B4: a coherent captured view also names the archive as the market's source.
Object.assign(historical.inputProvenance[0], { source: 'CAPTURED_ARCHIVE', detail: 'archive capturée localement (test)' });
dom = boot(LOCAL, serveView(historical));
await settle();
d = dom.window.document;
assert.equal(text(d, 'mode-v2-val'), 'HISTORIQUE VÉRIFIÉ · DRY RUN');
assert.match(text(d, 'v2-nav-nature'), /HISTORIQUE VÉRIFIÉ · REJEU VÉRIFIÉ · .* · PAS UNE ANALYSE RÉELLE$/);
assert.doesNotMatch(d.getElementById('ws-chain').textContent + text(d, 'mode-v2-val'), /\bLIVE\b/);
dom.window.close();
// The complete synthetic archive, as replayed: REJEU INCOMPLET, DXY freshness shown as not evaluated, never as stale.
dom = boot(LOCAL, serveView(completeSimView));
await settle();
d = dom.window.document;
assert.match(text(d, 'v2-mev-status'), /^REJEU INCOMPLET · ARCHIVE SYNTHÉTIQUE/);
{
  const dxyItem = [...d.querySelectorAll('#v2-mev-obs li')].find((li) => li.querySelector('.mev__field').textContent === 'DXY');
  assert.match(dxyItem.textContent, /PREUVE DE FRAÎCHEUR\s*FRAÎCHEUR NON ÉVALUÉE/);
  assert.doesNotMatch(dxyItem.textContent, /PÉRIMÉE/);
}
assert.equal(text(d, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
dom.window.close();
// VERIFIED + SIMULATION: a reproducible replay of a synthetic archive is shown as a simulation, never as
// verified history nor as an analysis or a validation; the chain still holds.
dom = boot(LOCAL, serveView(verifiedSimView));
await settle();
d = dom.window.document;
assert.equal(text(d, 'v2-mev-status'), 'REJEU VÉRIFIÉ · ARCHIVE SYNTHÉTIQUE · reproductible');
assert.equal(text(d, 'mode-v2-val'), 'ARCHIVE SYNTHÉTIQUE · DRY RUN');
// « HISTORIQUE » alone is the temporal mode (past cutoff, see the legend), never « HISTORIQUE VÉRIFIÉ ».
assert.match(text(d, 'v2-nav-nature'), /^ARCHIVE DE MARCHÉ LOCALE · .*ARCHIVE SYNTHÉTIQUE · REJEU VÉRIFIÉ · .* · PAS UNE ANALYSE RÉELLE$/);
assert.doesNotMatch(text(d, 'v2-nav-nature') + text(d, 'mode-v2-val') + text(d, 'v2-mev-status'), /HISTORIQUE VÉRIFIÉ|\bLIVE\b|VALID/);
assert.equal(text(d, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
dom.window.close();
for (const [name, mutate] of [
  ['synthetic VERIFIED replay called verified history', (v) => { v.marketEvidence.nature = 'HISTORICAL_VERIFIED'; }],
  ['synthetic VERIFIED replay called verified history, bytes claimed re-read', (v) => {
    v.marketEvidence.nature = 'HISTORICAL_VERIFIED';
    for (const o of v.marketEvidence.observations) o.raw = 'RAW_VERIFIED';
  }],
  ['synthetic VERIFIED replay called captured history', (v) => { Object.assign(v.marketEvidence, { nature: 'HISTORICAL_VERIFIED', provenanceClass: 'CAPTURED' }); }],
]) {
  const body = structuredClone(verifiedSimView);
  mutate(body);
  dom = boot(LOCAL, serveView(body));
  await settle();
  d = dom.window.document;
  assert.equal(text(d, 'v2-state'), 'VUE V2 REFUSÉE', name);
  assert.equal(d.getElementById('v2-mev').hidden, true, name);
  dom.window.close();
}
// DATA-3 L1b: VERIFIED needs every value's freshness proved; a 4.9.0 manifest (no proof) is refused, not shown as before.
for (const [name, mutate] of [
  ['verified with a stale value', (v) => { v.marketEvidence.observations[0].freshnessProof = 'STALE'; }],
  ['verified with a freshness not evaluated', (v) => { v.marketEvidence.observations.find((o) => o.field === 'dxy').freshnessProof = 'NOT_EVALUATED'; }],
  ['verified manifest from before replay 1.2.0', (v) => { for (const o of v.marketEvidence.observations) delete o.freshnessProof; }],
  ['verified despite its own stale reason', (v) => { v.marketEvidence.reasonCodes.push('DECLARED_FIELD_STALE'); }],
  ['verified despite its own not-evaluated reason', (v) => { v.marketEvidence.reasonCodes.push('DECLARED_FIELD_FRESHNESS_NOT_EVALUATED'); }],
]) {
  const body = structuredClone(verifiedSimView);
  mutate(body);
  dom = boot(LOCAL, serveView(body));
  await settle();
  d = dom.window.document;
  assert.equal(text(d, 'v2-state'), 'VUE V2 REFUSÉE', name);
  assert.equal(d.getElementById('v2-mev').hidden, true, name);
  dom.window.close();
}
// Any overstated or inconsistent claim refuses the whole view.
for (const [name, mutate] of [
  // A VERIFIED status must not carry the replay's own reasons for incompleteness or rejection (DATA-3 L1).
  ['verified despite a covered field never observed', (v) => { Object.assign(v.marketEvidence, { status: 'VERIFIED', reproducible: true }); }],
  ['verified without declared coverage', (v) => {
    Object.assign(v.marketEvidence, { status: 'VERIFIED', reproducible: true, reasonCodes: ['COVERAGE_NOT_DECLARED'] });
  }],
  ['verified with a field not covered', (v) => {
    Object.assign(v.marketEvidence, { status: 'VERIFIED', reproducible: true, reasonCodes: ['FIELDS_NOT_COVERED'] });
  }],
  ['verified with a cutoff outside coverage', (v) => {
    Object.assign(v.marketEvidence, { status: 'VERIFIED', reproducible: true, reasonCodes: ['CUTOFF_OUTSIDE_COVERAGE'] });
  }],
  ['verified with a blocking finding', (v) => {
    Object.assign(v.marketEvidence, { status: 'VERIFIED', reproducible: true, reasonCodes: ['RAW_PAYLOAD_MISMATCH'] });
  }],
  ['verified history without re-read bytes', (v) => { Object.assign(v.marketEvidence, { nature: 'HISTORICAL_VERIFIED', provenanceClass: 'CAPTURED' }); }],
  ['verified history from an incomplete replay', (v) => {
    Object.assign(v.marketEvidence, { nature: 'HISTORICAL_VERIFIED', provenanceClass: 'CAPTURED', status: 'INCOMPLETE', reproducible: false });
    for (const o of v.marketEvidence.observations) o.raw = 'RAW_VERIFIED';
  }],
  ['incomplete but called reproducible', (v) => { v.marketEvidence.reproducible = true; }],
  ['synthetic archive called captured', (v) => { v.marketEvidence.provenanceClass = 'CAPTURED'; }],
  ['captured archive called simulation', (v) => { v.marketEvidence.nature = 'HISTORICAL_UNVERIFIED'; }],
  ['LIVE market nature', (v) => { v.marketEvidence.nature = 'LIVE'; }],
  ['unknown raw state', (v) => { v.marketEvidence.observations[0].raw = 'TRUSTED'; }],
  ['unknown freshness proof', (v) => { v.marketEvidence.observations[0].freshnessProof = 'PROBABLY_FRESH'; }],
  ['manifest missing', (v) => { delete v.marketEvidence; }],
]) {
  const body = structuredClone(archiveView);
  mutate(body);
  dom = boot(LOCAL, serveView(body));
  await settle();
  d = dom.window.document;
  assert.equal(text(d, 'v2-state'), 'VUE V2 REFUSÉE', name);
  assert.equal(d.getElementById('v2-mev').hidden, true, name);
  assert.equal(d.querySelectorAll('#v2-mev-obs li').length, 0, name);
  dom.window.close();
}
console.log('PASS market evidence: provenance per value, unknowns shown, HISTORIQUE VÉRIFIÉ only when proven, never LIVE');

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
  ['previous v2 view', (v) => { v.schemaVersion = 'xau.terminal-local-view.v2'; delete v.summary; }],
  ['summary missing', (v) => { delete v.summary; }],
  ['summary not HOLD', (v) => { v.summary.decision = 'BUY'; }],
  ['summary execution allowed', (v) => { v.summary.execution = 'ALLOWED'; }],
  ['unknown summary status', (v) => { v.summary.status = 'READY'; }],
  ['unknown main reason', (v) => { v.summary.mainReasons[0].category = 'NONE'; }],
  ['unknown missing-data kind', (v) => { v.summary.missingData[0].kind = 'GUESS'; }],
  ['dependency of another kind', (v) => { v.summary.blockingDependencies[0].category = 'DATA'; }],
  ['root cause without reasons', (v) => { delete v.holdRationale.rootCauses[0].reasons; }],
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
  assert.equal(d.getElementById('v2-sec-summary').hidden, true, name);
  assert.equal(text(d, 'v2-nav-nature'), 'VUE V2 REFUSÉE', name);
  assert.equal(d.getElementById('mode-v2').getAttribute('data-mode'), 'refused', name);
  assert.equal(text(d, 'tab-chain-state'), 'REFUSÉE', name);
  assert.equal(text(d, 'v2-chain-state'), '—', name);
  assert.equal(text(d, 'v2-positioning'), '—', name);
  assert.equal(text(d, 'v2-capabilities').trim(), 'Matrice indisponible sans vue V2.', name);
  dom.window.close();
}
// A refused view replaces a valid one entirely: nothing of the previous view stays on screen.
{
  let body = structuredClone(view);
  dom = boot({ ...LOCAL, V2_SCENARIOS_URL: '/s.json' }, (url) => (String(url) === '/s.json'
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ id: 'golden', label: 'g' }]) })
    : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) })));
  await settle();
  d = dom.window.document;
  assert.equal(d.getElementById('v2-sec-summary').hidden, false);
  body = structuredClone(view);
  body.summary.decision = 'BUY';
  d.getElementById('v2-scenario').value = 'golden';
  d.getElementById('v2-scenario').dispatchEvent(new dom.window.Event('change'));
  await settle();
  assert.equal(text(d, 'v2-state'), 'VUE V2 REFUSÉE');
  assert.equal(d.getElementById('v2-sec-summary').hidden, true, 'previous summary hidden');
  assert.equal(d.getElementById('v2-why').hidden, true, 'previous rationale hidden');
  assert.equal(d.querySelectorAll('#v2-stages .stage, #v2-market tr[data-status]').length, 0, 'previous stages and fields removed');
  dom.window.close();
}
console.log(`PASS ${mutations.length} non-conforming views are refused whole, including after a valid one`);

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
hostile.summary.headline = '<img src=z onerror="window.__pwned=3">';
hostile.summary.blockingDependencies[0].plain = '<script>window.__pwned=4</script>';
dom = boot(LOCAL, serveView(hostile));
await settle();
d = dom.window.document;
assert.equal(dom.window.__pwned, undefined);
assert.equal(d.querySelectorAll('#ws-chain img, #ws-chain script, #ws-chain b').length, 0);
assert.match(d.querySelector('#v2-why-list .why__codes').textContent, /<img src=y/);
assert.match(d.querySelector('#v2-stages .reason__code').textContent, /<img src=x/);
assert.match(text(d, 'v2-summary-headline'), /<img src=z/);
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
{
  // Easy to find: first thing in the CHAÎNE V2 panel body, named, explained, counted.
  const wrap = d.getElementById('v2-scenario-wrap');
  const body = d.querySelector('.panel--chain .panel__body');
  assert.equal(body.firstElementChild, wrap, 'the selector opens the panel body, above the status');
  // Only the local data panel and the archive replay selector may sit in between, both hidden without data.
  assert.equal(wrap.nextElementSibling.id, 'v2-data-wrap');
  assert.equal(wrap.nextElementSibling.hidden, true);
  assert.equal(wrap.nextElementSibling.nextElementSibling.id, 'v2-replay-cutoff-wrap');
  assert.equal(wrap.nextElementSibling.nextElementSibling.hidden, true);
  assert.equal(wrap.nextElementSibling.nextElementSibling.nextElementSibling.id, 'v2-status');
  const label = wrap.querySelector('label[for="v2-scenario"]');
  assert.ok(label, 'the select has a visible label bound to it');
  assert.match(label.textContent, /SCÉNARIO DE SIMULATION/);
  assert.ok(!d.querySelector('.panel--chain .panel__head #v2-scenario'), 'no longer hidden in the panel header');
  const hint = text(d, 'v2-scenario-hint');
  assert.match(hint, new RegExp(`${TERMINAL_SCENARIO_IDS.length} scénarios`), hint);
  assert.match(hint, /HOLD/);
  assert.match(hint, /exécution interdite/i);
  assert.doesNotMatch(hint, /\b(achat|vente|buy|sell|signal)\b/i);
  assert.equal(d.getElementById('v2-scenario').getAttribute('aria-describedby'), 'v2-scenario-hint');
}
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
assert.match(text(d, 'v2-nav-nature'), /^SIMULATION — SCÉNARIO EVERYTHING-GRANTED · HISTORIQUE/);
// Every evidence declared by the simulation, still not accepted.
assert.equal(text(d, 'v2-acceptance-state'), 'NOT_ACCEPTED · 11/11 DÉCLARÉES');
assert.equal(text(d, 'v2-observability'), 'CONTRACT_ONLY · corrélation corr-test-1 · déploiement deploy-test-1');
// Degraded scenarios: the summary names what is missing and where the chain stops.
select.value = 'market-unavailable';
select.dispatchEvent(new dom.window.Event('change'));
await settle(400);
assert.match(text(d, 'v2-summary-headline'), /le premier à MARKET PRICING\./);
assert.equal(d.querySelectorAll('#v2-summary-missing li').length, 10, 'eight fields, the snapshot and the evidence graph');
assert.ok(listText('v2-summary-missing').includes("Aucun instantané de marché n'a été fourni."));
assert.ok([...d.querySelectorAll('#v2-market tr')].every((r) => r.cells[2].textContent === 'UNAVAILABLE'));
select.value = 'lookahead';
select.dispatchEvent(new dom.window.Event('change'));
await settle(400);
assert.ok(listText('v2-summary-missing').includes('Une observation de marché est postérieure au cutoff (anticipation interdite).'));
select.value = 'invalid-input';
select.dispatchEvent(new dom.window.Event('change'));
await settle(400);
assert.equal(d.getElementById('v2-sec-summary').getAttribute('data-status'), 'INPUT_REJECTED');
assert.deepEqual(listText('v2-summary-missing'), ['Entrée invalide : unexpectedKey: UNKNOWN_KEY.']);
assert.equal(text(d, 'v2-summary-deps'), "Aucune dépendance : la chaîne n'a pas été évaluée.");
// The POURQUOI HOLD heading is never left empty: a rejected input says why nothing was evaluated.
assert.equal(d.getElementById('v2-why').hidden, false);
assert.match(text(d, 'v2-why-lead'), /^Entrée rejetée avant la chaîne : aucun étage n'a été évalué\./);
dom.window.close();
await close(live.server);
console.log('PASS terminal against the real local server: golden HOLD chain, degraded and rejected scenarios summarized');

// --- Navigation inside the chain workspace: no hash change, folded state kept across refreshes.
{
  let body = structuredClone(view);
  const list = [{ id: 'golden', label: 'g' }];
  const dom4 = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/#chaine' });
  dom4.window.fetch = (url) => {
    const u = String(url);
    if (u === '/s.json') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list) });
    if (u.startsWith(VIEW_PATH)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) });
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  dom4.window.ALPHA_XAU_CONFIG = { ...LOCAL, V2_SCENARIOS_URL: '/s.json' };
  const boot4 = dom4.window.document.createElement('script');
  boot4.textContent = js;
  dom4.window.document.body.appendChild(boot4);
  await settle(100);
  const d4 = dom4.window.document;
  const scrolled = [];
  dom4.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.id); };
  const targets = [...d4.querySelectorAll('.v2nav__link')].map((b) => b.getAttribute('data-target'));
  assert.deepEqual(targets, ['v2-sec-summary', 'v2-sec-why', 'v2-sec-stages', 'v2-sec-market', 'v2-sec-readiness', 'v2-sec-caps']);
  for (const id of targets) assert.ok(d4.getElementById(id), id);
  for (const b of d4.querySelectorAll('.v2nav__link')) b.click();
  assert.deepEqual(scrolled, targets);
  assert.equal(dom4.window.location.hash, '#chaine', 'section links leave the workspace address alone');
  assert.equal(d4.getElementById('ws-chain').hidden, false);
  // Fold / unfold all stages, and keep the reader's choice across a refresh.
  const toggle = d4.getElementById('v2-stages-toggle');
  toggle.click();
  assert.ok([...d4.querySelectorAll('#v2-stages details')].every((x) => x.open));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.textContent, 'TOUT REPLIER');
  toggle.click();
  assert.ok([...d4.querySelectorAll('#v2-stages details')].every((x) => !x.open));
  d4.querySelector('#v2-stages [data-stage="ACTION"] details').open = true;
  d4.querySelector('#v2-why-list [data-category="ENVIRONMENT"]').open = true;
  body = structuredClone(view);
  body.generatedAt = '2026-10-14T21:43:00.000Z';
  d4.getElementById('v2-scenario').value = 'golden';
  d4.getElementById('v2-scenario').dispatchEvent(new dom4.window.Event('change'));
  await settle(100);
  assert.equal(text(d4, 'v2-generated'), '21:43 UTC', 'the view was re-rendered');
  assert.deepEqual([...d4.querySelectorAll('#v2-stages details[open]')].map((x) => x.parentElement.getAttribute('data-stage')), ['ACTION']);
  assert.deepEqual([...d4.querySelectorAll('#v2-why-list details[open]')].map((x) => x.getAttribute('data-category')), ['ENVIRONMENT']);
  dom4.window.close();
}
console.log('PASS chain navigation: section links scroll without changing the address; folded state survives a refresh');

// A market value observed after the cutoff was not known then (view 4.11.0): the page shows « POSTÉRIEUR AU CUTOFF »
// without a value, and refuses any view (an older one included) that gives such a field a value.
{
  const cutoffMs = Date.parse(view.chain.knowledgeCutoff);
  const future = new Date(cutoffMs + 3_600_000).toISOString();
  const masked = structuredClone(view);
  Object.assign(masked.market.fields.find((f) => f.field === 'spot'),
    { value: null, statusAtCutoff: 'OBSERVED_AFTER_CUTOFF', observedAt: future, ageSecondsAtCutoff: null });
  let dm = boot(LOCAL, serveView(masked));
  await settle();
  let dd = dm.window.document;
  assert.equal(text(dd, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE');
  const row = [...dd.querySelectorAll('#v2-market tr')].find((tr) => /^SPOT/.test(tr.textContent));
  assert.match(row.textContent, /N\/A.*POSTÉRIEUR AU CUTOFF/);
  dm.window.close();
  const leaked = structuredClone(view);
  Object.assign(leaked.market.fields.find((f) => f.field === 'spot'), { observedAt: future });
  dm = boot(LOCAL, serveView(leaked));
  await settle();
  dd = dm.window.document;
  assert.equal(text(dd, 'v2-state'), 'VUE V2 REFUSÉE', 'a value observed after the cutoff is never displayed');
  dm.window.close();
  const atCutoff = structuredClone(view);
  Object.assign(atCutoff.market.fields.find((f) => f.field === 'spot'), { observedAt: view.chain.knowledgeCutoff });
  dm = boot(LOCAL, serveView(atCutoff));
  await settle();
  assert.equal(text(dm.window.document, 'v2-state'), 'HOLD — EXÉCUTION INTERDITE', 'observed exactly at the cutoff is known');
  dm.window.close();
}
console.log('PASS market values observed after the cutoff are never displayed');

// View 4.12.0: a market value whose observation time is unreadable is OBSERVATION_TIME_INVALID, shown « DATE
// ILLISIBLE » without a value. The page refuses any view (an older one or a forged one included) that gives a value
// to a field whose observedAt is not a readable instant at or before the cutoff, to the nanosecond: Date.parse read
// 2026-02-30 as 2 March and 0.4 ms after the cutoff as the cutoff itself.
{
  const cutoff = view.chain.knowledgeCutoff;
  const state = async (observedAt, patch = {}, chainPatch = {}) => {
    const v = structuredClone(view);
    Object.assign(v.market.fields.find((f) => f.field === 'spot'), { observedAt, ...patch });
    Object.assign(v.chain, chainPatch);
    const dm = boot(LOCAL, serveView(v));
    await settle();
    const row = [...dm.window.document.querySelectorAll('#v2-market tr')].find((tr) => /^SPOT/.test(tr.textContent));
    const out = [text(dm.window.document, 'v2-state'), row ? row.textContent : null];
    dm.window.close();
    return out;
  };
  const masked = await state('2026-02-30T00:00:00Z', { value: null, statusAtCutoff: 'OBSERVATION_TIME_INVALID', ageSecondsAtCutoff: null });
  assert.equal(masked[0], 'HOLD — EXÉCUTION INTERDITE');
  assert.match(masked[1], /N\/A.*DATE ILLISIBLE/);
  const base = cutoff.replace(/(\.\d{3})?Z$/, (m, f) => f ?? '.000');
  for (const observedAt of ['2026-02-30T00:00:00Z', cutoff.replace('Z', '-00:00'), `${base}4Z`, `${base}000001Z`, 'hier']) {
    assert.equal((await state(observedAt))[0], 'VUE V2 REFUSÉE', `a value observed at ${observedAt} is never displayed`);
  }
  assert.equal((await state(`${base}000000Z`))[0], 'HOLD — EXÉCUTION INTERDITE', 'observed exactly at the cutoff is known');
  assert.equal((await state(cutoff, {}, { knowledgeCutoff: '2026-02-30T00:00:00Z' }))[0], 'VUE V2 REFUSÉE',
    'no value is displayed against an unreadable cutoff');
}
console.log('PASS market values whose observation time is unreadable, or after the cutoff by less than a millisecond, are never displayed');
