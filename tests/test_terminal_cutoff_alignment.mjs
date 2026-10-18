// P3 — an archive replay at another instant than the input document makes the
// horizon synthesis abstain with UPSTREAM_CUTOFF_MISMATCH: Event Impact and
// Gold Transmission are precomputed summaries at the document's cutoff, never
// recomputed. View 4.5.0 says which cutoffs differ (cutoffAlignment) and the
// page writes it under POURQUOI HOLD instead of a bare "incohérence interne".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { SYNTHETIC_ARCHIVE, VIEW_PATH, archiveCutoffs, buildLocalView } from '../scripts/serve_terminal_local.mjs';
import { TERMINAL_SCENARIO_IDS } from '../scripts/lib/terminal_scenarios.mjs';

const mismatch = (v) => v.stages.find((s) => s.stage === 'HORIZON_SYNTHESIS').reasons.some((r) => r.code === 'UPSTREAM_CUTOFF_MISMATCH');
const golden = await (await buildLocalView())();
assert.deepEqual(golden.cutoffAlignment, {
  chainCutoff: '2026-10-01T14:15:00.000Z',
  inputs: [{ input: 'EVENT_IMPACT', knowledgeCutoff: '2026-10-01T14:15:00.000Z' }, { input: 'GOLD_TRANSMISSION', knowledgeCutoff: '2026-10-01T14:15:00.000Z' }],
  aligned: true,
  plain: 'Impact des événements et transmission or sont au cutoff de la chaîne.',
});
const archive = await buildLocalView({ archiveFile: SYNTHETIC_ARCHIVE });
const at = archiveCutoffs(SYNTHETIC_ARCHIVE, null).cutoffs[0];
const replay = await archive(null, { cutoff: at });
assert.equal(replay.cutoffAlignment.aligned, false);
assert.equal(replay.cutoffAlignment.chainCutoff, at);
assert.match(replay.cutoffAlignment.plain, new RegExp(`Chaîne évaluée au ${at.replace(/\./g, '\\.')} ; impact des événements au 2026-10-01T14:15:00\\.000Z`));
assert.match(replay.cutoffAlignment.plain, /UPSTREAM_CUTOFF_MISMATCH/);
assert.equal(replay.chain.chainState, 'HOLD');
// The line agrees with CHAIN-0 everywhere: misaligned exactly when the horizon reports the mismatch.
const views = [golden, replay];
for (const id of TERMINAL_SCENARIO_IDS) views.push(await archive(id));
for (const cutoff of archiveCutoffs(SYNTHETIC_ARCHIVE, null).cutoffs) views.push(await archive(null, { cutoff }));
let checked = 0;
for (const v of views) {
  if (v.chain.outcome !== 'COMPLETED') {
    assert.equal(v.cutoffAlignment, null);
    continue;
  }
  assert.equal(v.cutoffAlignment.aligned, !mismatch(v), `${v.origin.label} ${v.chain.knowledgeCutoff}`);
  checked += 1;
}
assert.ok(checked >= 10);
console.log(`PASS cutoffAlignment names the differing cutoffs and agrees with CHAIN-0 on ${checked} views`);

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
let dom = await render(replay);
let line = dom.window.document.getElementById('v2-why-cutoffs');
assert.equal(line.hidden, false);
assert.equal(line.textContent, replay.cutoffAlignment.plain);
dom.window.close();
for (const body of [golden, { ...golden, cutoffAlignment: null }, { ...golden, cutoffAlignment: undefined }]) {
  dom = await render(body);
  line = dom.window.document.getElementById('v2-why-cutoffs');
  assert.equal(line.hidden, true);
  assert.notEqual(dom.window.document.getElementById('v2-status').getAttribute('data-state'), 'rejected');
  dom.window.close();
}
console.log('PASS POURQUOI HOLD shows the cutoff line only when the inputs are at another cutoff');
