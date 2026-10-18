// P2 — the local terminal reads its positioning evidence from a CFTC
// Commitments of Traders file on disk (--positioning-cot) with the operator's
// declared publication and reception instants. The evidence is labelled
// LOCAL_INPUT_UNVERIFIED (source not approved), only the server's own input
// uses it (never a scenario), a rejected file supplies nothing, and every view
// stays HOLD / FORBIDDEN with positioning UNAVAILABLE.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { SYNTHETIC_ARCHIVE, VIEW_PATH, buildLocalView, parseArgs } from '../scripts/serve_terminal_local.mjs';
import { parseArgs as launcherArgs } from '../scripts/terminal_launch.mjs';

const FILE = new URL('./fixtures/cftc_cot_disaggregated_synthetic.csv', import.meta.url).pathname;
const declared = { file: FILE, publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z', reportDate: '2026-09-22',
  dataset: 'FUTURES_ONLY' };
const prov = (view, input) => view.inputProvenance.find((e) => e.input === input);

const view = await buildLocalView({ positioningCot: declared });
const own = await view();
assert.equal(own.chain.chainState, 'HOLD');
assert.equal(own.chain.execution, 'FORBIDDEN');
assert.equal(own.positioning.evidenceCount, 14);
assert.deepEqual(own.positioning.sourceAuthorities, ['cftc']);
assert.equal(own.positioning.positioningState, 'UNAVAILABLE');
assert.equal(own.positioning.evidenceState, 'ABSTAIN');
assert.equal(own.positioning.freshness.status, 'NOT_EVALUATED');
assert.equal(prov(own, 'POSITIONING').source, 'LOCAL_INPUT_UNVERIFIED');
assert.match(prov(own, 'POSITIONING').detail, /cftc_cot_disaggregated_synthetic\.csv.*2026-09-22, futures seuls \(déclaré\).*déclarées par l'opérateur.*non approuvée/);
assert.equal(prov(own, 'EVENT_IMPACT').source, 'SYNTHETIC_FIXTURE');
assert.equal(view.positioning.status, 'EXTRACTED');
// A scenario is a simulation of its own: it never takes the file's evidence.
const scenario = await view('golden');
assert.deepEqual(scenario.positioning.sourceAuthorities, ['authority_test']);
assert.equal(prov(scenario, 'POSITIONING').source, 'SYNTHETIC_FIXTURE');
console.log('PASS --positioning-cot: 14 CFTC tuples, LOCAL_INPUT_UNVERIFIED, HOLD; scenarios keep their own evidence');

// With --archive: market from the archive, positioning from the file, other inputs from the document.
const both = await (await buildLocalView({ archiveFile: SYNTHETIC_ARCHIVE, positioningCot: declared }))();
assert.equal(prov(both, 'MARKET').source, 'SYNTHETIC_FIXTURE');
assert.equal(prov(both, 'POSITIONING').source, 'LOCAL_INPUT_UNVERIFIED');
assert.equal(both.positioning.evidenceCount, 14);
assert.equal(both.chain.chainState, 'HOLD');
// Published after the cutoff: P-0 rejects it, the terminal says so (4.3.0).
const late = await (await buildLocalView({ positioningCot: { ...declared, reportDate: '2026-09-29',
  publishedAt: '2026-10-02T19:30:00.000Z', receivedAt: '2026-10-02T19:45:00.000Z' } }))();
assert.equal(late.positioning.freshness.status, 'AFTER_KNOWLEDGE_CUTOFF');
assert.equal(late.chain.chainState, 'HOLD');
// Rejected file: nothing retained, said in the provenance.
const rejected = await buildLocalView({ positioningCot: { ...declared, reportDate: null } });
const r = await rejected();
assert.equal(rejected.positioning.status, 'REJECTED');
assert.equal(r.positioning.evidenceCount, 0);
assert.equal(prov(r, 'POSITIONING').source, 'UNAVAILABLE');
assert.match(prov(r, 'POSITIONING').detail, /MULTIPLE_REPORT_DATES/);
const missing = await (await buildLocalView({ positioningCot: { ...declared, file: '/nonexistent/cot.csv' } }))();
assert.equal(prov(missing, 'POSITIONING').source, 'UNAVAILABLE');
assert.equal(missing.chain.chainState, 'HOLD');
console.log('PASS with --archive, after the cutoff, rejected or missing: always HOLD, never more than LOCAL_INPUT_UNVERIFIED');

// --- Arguments: a file needs both declared instants; instants need a file; the launcher passes them through.
const args = ['--positioning-cot', 'cot.csv', '--cot-published-at', declared.publishedAt, '--cot-received-at', declared.receivedAt,
  '--cot-dataset', 'futures-only'];
assert.equal(parseArgs(args).positioningCot.reportDate, null);
assert.equal(parseArgs(args).positioningCot.dataset, 'FUTURES_ONLY');
assert.equal(parseArgs([...args.slice(0, 6), '--cot-dataset', 'futures-and-options']).positioningCot.dataset, 'FUTURES_AND_OPTIONS_COMBINED');
assert.equal(parseArgs([...args, '--cot-report-date', '2026-09-22']).positioningCot.reportDate, '2026-09-22');
assert.equal(parseArgs(args.slice(0, 4)), null);
assert.equal(parseArgs(args.slice(2)), null);
assert.equal(parseArgs(args.slice(0, 6)), null, 'the dataset must be declared');
assert.equal(parseArgs([...args.slice(0, 6), '--cot-dataset', 'legacy']), null);
assert.deepEqual(launcherArgs(args).server, args);
console.log('PASS arguments: --positioning-cot requires --cot-dataset, --cot-published-at and --cot-received-at; the launcher passes them on');

// --- Page: the provenance panel names the file; the view is drawn, not refused.
const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
dom.window.fetch = (url) => (String(url) === VIEW_PATH
  ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(own)) })
  : Promise.reject(new Error(`unexpected fetch ${url}`)));
dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
const script = dom.window.document.createElement('script');
script.textContent = js;
dom.window.document.body.appendChild(script);
await new Promise((resolve) => setTimeout(resolve, 200));
const d = dom.window.document;
assert.notEqual(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
const item = d.querySelector('#v2-prov [data-input="POSITIONING"]');
assert.equal(item.getAttribute('data-source'), 'LOCAL_INPUT_UNVERIFIED');
assert.match(item.textContent, /fichier CFTC COT local/);
assert.match(d.getElementById('v2-positioning').textContent, /ABSTAIN · 14 preuve\(s\) · signal UNAVAILABLE/);
assert.equal(d.getElementById('v2-positioning-sources').textContent, 'cftc');
// 4.6.0: the raw values themselves, grouped by report, flagged when after the cutoff; nothing derived.
assert.equal(own.positioning.evidence.length, 14);
assert.equal(own.positioning.evidenceTruncated, false);
const mm = own.positioning.evidence.find((e) => e.metricCode === 'managed_money_long');
assert.deepEqual([mm.value, mm.unit, mm.periodEnd, mm.sourceAuthority, mm.afterCutoff], [200000, 'CONTRACTS', '2026-09-22', 'cftc', false]);
assert.ok(late.positioning.evidence.every((e) => e.afterCutoff === true), 'published after the cutoff: every row flagged');
const groups = d.querySelectorAll('#v2-positioning-evidence .v2__pos-group');
assert.equal(groups.length, 1);
assert.match(groups[0].textContent, /^CFTC · cot_disaggregated_futures_only · CFTC:088691 · rapport du 2026-09-22 · publié 2026-09-25 19:30:00Z · reçu 2026-09-25 19:45:00Z/);
assert.match(groups[0].textContent, /MANAGED MONEY LONG200\u202f000 contrats/);
assert.equal(d.querySelectorAll('#v2-positioning-evidence .v2__pos-list li').length, 14);
assert.doesNotMatch(d.getElementById('v2-positioning-evidence').textContent, /\bnet\b|ratio|percentile|haussier|baissier|BULL|BEAR/i, 'nothing derived');
dom.window.close();
// A view whose rows disagree with the kept count is refused (no silent partial display).
{
  const bad = structuredClone(own);
  bad.positioning.evidence.pop();
  const dom2 = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom2.window.fetch = (url) => (String(url) === VIEW_PATH ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(bad)) })
    : Promise.reject(new Error(`unexpected fetch ${url}`)));
  dom2.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const sc = dom2.window.document.createElement('script');
  sc.textContent = js;
  dom2.window.document.body.appendChild(sc);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(dom2.window.document.getElementById('v2-status').getAttribute('data-state'), 'rejected');
  dom2.window.close();
}
console.log('PASS the terminal names the CFTC file in PROVENANCE DES ENTRÉES and shows 14 kept, abstaining tuples');
