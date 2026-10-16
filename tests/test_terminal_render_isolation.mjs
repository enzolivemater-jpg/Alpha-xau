/**
 * Terminal render isolation. The client guard (v2Problem) checks the structure it
 * relies on, but some fields are only read later, while the panels are drawn. A
 * view that passes the guard and then breaks the renderer must never leave a
 * half-drawn state on screen: either the whole view is drawn, or the terminal
 * falls back to its refused / error state with nothing of the view visible.
 * A marker is planted in sections drawn BEFORE the failing one to detect any leak.
 * Bounded on purpose (each jsdom instance retains ~90 MB). Loopback only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createTerminalServer, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const MARK = 'LEAKMARK';

const server = await createTerminalServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const fetchView = async (query = '') => (await fetch(`${base}${VIEW_PATH}${query}`)).json();
const golden = await fetchView();
const archive = await fetchView('?scenario=archive-synthetic');
await new Promise((resolve) => server.close(resolve));

function boot(view) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom.window.fetch = (url) => (String(url) === VIEW_PATH
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(view)) })
    : Promise.reject(new Error(`unexpected fetch ${url}`)));
  dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  return dom;
}

/**
 * Text a user can see once the V2 workspace is open. Tabs hide the whole
 * workspace by default, so only the hiding done by the V2 renderer itself (its
 * `v2…` sections) counts: those subtrees are skipped.
 */
function visibleText(root) {
  if (root.nodeType === 3) return root.textContent;
  if (root.nodeType !== 1) return '';
  if (root.hidden === true && String(root.id).startsWith('v2')) return '';
  return [...root.childNodes].map((child) => visibleText(child)).join(' ');
}

const mutations = [
  ['market.fields item is null', (v) => { v.market.fields = [null]; }],
  ['market.fields item has object-valued cells', (v) => { v.market.fields = [{ field: {}, value: {}, statusAtCutoff: {}, ageSecondsAtCutoff: {}, observedAt: {}, source: {} }]; }],
  ['stages[0].reasons item is null', (v) => { v.stages[0].reasons = [null]; }],
  ['stages[3].reasons item is a number', (v) => { v.stages[3].reasons = [7]; }],
  ['stages[0].blockers is not a list', (v) => { v.stages[0].blockers = 'x'; }],
  ['capabilities[0].detail is an object', (v) => { v.capabilities[0].detail = { a: 1 }; }],
  ['holdRationale.rootCauses[0].reasons item is null', (v) => { v.holdRationale.rootCauses[0].reasons = [null]; }],
  ['summary.blockingDependencies[0].stages is null', (v) => { v.summary.blockingDependencies[0].stages = null; }],
  ['summary.mainReasons[0] lacks fields', (v) => { v.summary.mainReasons[0] = { category: v.summary.mainReasons[0].category }; }],
  ['acceptance.evidence item is null', (v) => { v.acceptance.evidence = [null, ...v.acceptance.evidence]; }],
  ['positioning is null', (v) => { v.positioning = null; }],
  ['market.replay is a number', (v) => { v.market.replay = 5; }],
  ['chain.violations is a string', (v) => { v.chain.violations = 'x'; }],
  ['temporal.cutoffAgeSeconds is a string', (v) => { v.temporal.cutoffAgeSeconds = 'x'; }],
];
const archiveMutations = [
  ['marketEvidence.coverage is a number', (v) => { v.marketEvidence.coverage = 5; }],
  ['marketEvidence.observations[0] is minimal', (v) => { v.marketEvidence.observations = [{ raw: v.marketEvidence.observations[0].raw }]; }],
  ['marketEvidence.reasonCodes item is null', (v) => { v.marketEvidence.reasonCodes = [null]; }],
];

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { drawn: 0, fallback: 0 };

async function check(label, view) {
  const dom = boot(view);
  const pageErrors = [];
  dom.window.addEventListener('error', (event) => { pageErrors.push(String(event.message)); });
  await settle();
  const doc = dom.window.document;
  const state = doc.getElementById('v2-status').getAttribute('data-state');
  const workspace = visibleText(doc.getElementById('v2-status').closest('section, main, div[id]') ?? doc.body);
  const everything = visibleText(doc.body);
  if (pageErrors.length) note(label, `uncaught page error: ${pageErrors[0].slice(0, 100)}`);
  if (state === 'hold') {
    tally.drawn += 1;
    if (!everything.includes(MARK)) note(label, 'drawn without the planted marker (the marker section was not drawn)');
  } else if (state === 'rejected' || state === 'error') {
    tally.fallback += 1;
    if (everything.includes(MARK) || workspace.includes(MARK)) note(label, `fallback state '${state}' still shows part of the refused view`);
    for (const id of ['v2-chain-state', 'v2-execution', 'v2-integrity', 'v2-cutoff', 'v2-digest']) {
      if (doc.getElementById(id).textContent.trim() !== '—') note(label, `${id} not cleared in '${state}'`);
    }
  } else {
    note(label, `unexpected state ${state}`);
  }
  if (/\b(BUY|SELL|ACHAT|VENTE|ORDRE)\b/i.test(visibleText(doc.getElementById('v2-status').parentElement ?? doc.body)) && state === 'hold') {
    note(label, 'a positive trading word is visible');
  }
  dom.window.close();
}

const marked = (view) => {
  const copy = structuredClone(view);
  copy.summary.headline = `${MARK} ${copy.summary.headline}`;
  copy.origin.label = `${MARK}-origin`;
  return copy;
};
await check('<unmodified golden>', marked(golden));
for (const [name, mutate] of mutations) {
  const view = marked(golden);
  mutate(view);
  await check(name, view);
}
for (const [name, mutate] of archiveMutations) {
  const view = marked(archive);
  mutate(view);
  await check(name, view);
}

assert.deepEqual(failures, [], `RENDER ISOLATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.drawn >= 1, JSON.stringify(tally));
console.log(`PASS terminal render isolation: ${tally.drawn + tally.fallback} guard-passing hostile views, ${tally.drawn} drawn whole, `
  + `${tally.fallback} fell back with nothing of the view left visible`);
