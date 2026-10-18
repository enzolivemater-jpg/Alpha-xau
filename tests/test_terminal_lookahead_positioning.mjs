// Positioning evidence published or observed after the knowledge cutoff is
// rejected by P-0 (EVIDENCE_AFTER_KNOWLEDGE_CUTOFF) but kept in its envelope.
// The terminal must not present it as known: before 4.3.0 it read
// "publiée -7 h avant le cutoff" and an observation date later than the cutoff
// without comment. The view now says the evidence is after the cutoff, gives
// no publication age, and the page refuses a view that hides it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const tv = await loadBackendModule('decision_chain/terminal_view.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const evidence = golden.input.positioningEvidence[0]; // published 2026-09-30T19:30, observed 19:31
const AT = '2026-10-18T00:00:00.000Z';
const viewAt = (cutoff, positioningEvidence = golden.input.positioningEvidence) => {
  const input = { ...structuredClone(golden.input), positioningEvidence: structuredClone(positioningEvidence) };
  for (const key of ['eventImpact', 'goldTransmission']) input[key].knowledgeCutoff = cutoff;
  return tv.buildTerminalView(chain.evaluateDecisionChain(input, cutoff), null, { kind: 'GOLDEN_FIXTURE', label: 'golden' }, AT);
};

assert.equal(tv.TERMINAL_VIEW_ALGORITHM_VERSION, 'terminal-local-view-4.4.0');
const AFTER = {
  status: 'AFTER_KNOWLEDGE_CUTOFF', reason: 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF',
  plain: 'preuve postérieure au cutoff — écartée, fraîcheur non évaluée',
  latestPublishedAt: evidence.publishedAt, publishedAgeSecondsAtCutoff: null,
};
// Published after the cutoff; then published before but observed (received) after it.
for (const cutoff of ['2026-09-30T12:00:00.000Z', '2026-09-30T19:30:30.000Z']) {
  const view = viewAt(cutoff);
  assert.equal(view.chain.chainState, 'HOLD');
  assert.equal(view.chain.execution, 'FORBIDDEN');
  assert.equal(view.positioning.evidenceState, 'ABSTAIN', cutoff);
  assert.deepEqual(view.positioning.freshness, AFTER, cutoff);
}
// One evidence known at the cutoff and one after it: still reported after the cutoff, never a negative age.
const mixed = viewAt('2026-09-30T19:40:00.000Z', [evidence,
  { ...evidence, metricCode: 'open_interest', publishedAt: '2026-09-30T20:00:00.000Z', observedAt: '2026-09-30T20:01:00.000Z' }]);
assert.equal(mixed.positioning.freshness.status, 'AFTER_KNOWLEDGE_CUTOFF');
assert.equal(mixed.positioning.freshness.publishedAgeSecondsAtCutoff, null);
// Exactly at the cutoff is known: unchanged NOT_EVALUATED with an age of 0.
const exact = viewAt(evidence.observedAt);
assert.equal(exact.positioning.freshness.status, 'NOT_EVALUATED');
assert.equal(exact.positioning.freshness.publishedAgeSecondsAtCutoff, 60);
console.log('PASS the view reports positioning evidence after the cutoff instead of a negative publication age');

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const render = async (body) => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom.window.fetch = (url) => (String(url) === VIEW_PATH
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) })
    : Promise.reject(new Error(`unexpected fetch ${url}`)));
  dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return dom;
};
const early = viewAt('2026-09-30T12:00:00.000Z');
let dom = await render(early);
let d = dom.window.document;
assert.notEqual(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
assert.equal(d.getElementById('v2-positioning-freshness').textContent, AFTER.plain);
assert.equal(d.getElementById('v2-positioning-through').textContent, '2026-09-30T19:31:00.000Z (après le cutoff)');
assert.doesNotMatch(d.body.textContent, /publiée -/);
dom.window.close();
for (const [name, mutate] of [
  ['after-cutoff evidence given an age', (v) => { v.positioning.freshness.publishedAgeSecondsAtCutoff = -27000; }],
  ['after-cutoff status without evidence', (v) => { v.positioning.evidenceCount = 0; }],
  ['negative age on known evidence', (v) => { Object.assign(v.positioning.freshness, { status: 'NOT_EVALUATED', reason: 'FRESHNESS_POLICY_NOT_APPROVED', publishedAgeSecondsAtCutoff: -1 }); }],
]) {
  const body = structuredClone(early);
  mutate(body);
  dom = await render(body);
  d = dom.window.document;
  assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'rejected', name);
  dom.window.close();
}
console.log('PASS the terminal says "preuve postérieure au cutoff" and refuses a view that gives it an age');
