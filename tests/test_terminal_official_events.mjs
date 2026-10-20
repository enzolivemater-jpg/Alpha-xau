// The terminal's Event Impact and Gold Transmission summaries can come from
// official release documents instead of the input document: each document
// goes through its Event Facts adapter, becomes an event version known at its
// official release instant (B3), then EI / GT plans, aggregated by EIA-0 v2
// at the chain's own cutoff. A replay at another instant then has aligned
// cutoffs (no UPSTREAM_CUTOFF_MISMATCH), releases published after the cutoff
// are excluded, and everything stays HOLD / FORBIDDEN with no interpretation.
// The release documents are the repository's committed fixtures.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { aggregateOfficialReleasesAt, readOfficialReleases } from '../scripts/lib/official_events.mjs';
import { CATALOG_PATH, REPOSITORY_OFFICIAL_RELEASES, SYNTHETIC_ARCHIVE, VIEW_PATH, archiveCutoffs, buildLocalView } from '../scripts/serve_terminal_local.mjs';

// --- The documents: six resolve, the July employment report is refused by its adapter (July AHE unavailable).
const entries = await readOfficialReleases(REPOSITORY_OFFICIAL_RELEASES);
assert.deepEqual(entries.map((e) => [e.name, e.status, e.family, e.period, e.publishedAt]), [
  ['bea_pce_2026_07.json', 'RESOLVED', 'US_PCE', '2026-07', '2026-08-26T12:30:00.000Z'],
  ['bea_pce_2026_08.json', 'RESOLVED', 'US_PCE', '2026-08', '2026-09-30T12:30:00.000Z'],
  ['bls_cpi_table1_2026_07.json', 'RESOLVED', 'US_CPI', '2026-07', '2026-08-12T12:30:00.000Z'],
  ['bls_cpi_table1_2026_08.json', 'RESOLVED', 'US_CPI', '2026-08', '2026-09-11T12:30:00.000Z'],
  ['bls_employment_situation_2026_07.json', 'REJECTED', 'US_NFP', null, null],
  ['bls_employment_situation_2026_08.json', 'RESOLVED', 'US_NFP', '2026-08', '2026-09-04T12:30:00.000Z'],
  ['dol_ui_weekly_claims_2026_10_01.json', 'RESOLVED', 'US_JOBLESS_CLAIMS', 'semaine au 2026-09-26', '2026-10-01T12:30:00.000Z'],
]);
assert.match(entries[4].reason, /^ADAPTER_/);
for (const e of entries.filter((x) => x.status === 'RESOLVED')) {
  assert.equal(e.eventVersion.knowledgeCutoff, e.publishedAt, `${e.name}: known at its release`);
  assert.equal(e.impactPlan.assessmentStatus, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(e.impactPlan.interpretations, []);
  assert.deepEqual(e.transmissionPlan.paths, []);
}
assert.deepEqual(await readOfficialReleases(REPOSITORY_OFFICIAL_RELEASES), entries, 'deterministic identifiers and plans');
// Aggregation at a cutoff: only what was published by then; the summaries carry that cutoff.
const at = async (cutoff) => aggregateOfficialReleasesAt(entries, cutoff);
let a = await at('2026-10-01T14:15:00.000Z');
assert.deepEqual([a.known.length, a.notYetPublished.length, a.impact.summary.knowledgeCutoff, a.impact.summary.status],
  [6, 0, '2026-10-01T14:15:00.000Z', 'INSUFFICIENT_EVIDENCE']);
a = await at('2026-09-05T00:00:00.000Z');
assert.deepEqual(a.known.map((e) => e.name).sort(), ['bea_pce_2026_07.json', 'bls_cpi_table1_2026_07.json', 'bls_employment_situation_2026_08.json']);
assert.equal(a.notYetPublished.length, 3);
a = await at('2026-09-04T12:29:59.999Z');
assert.ok(!a.known.some((e) => e.name === 'bls_employment_situation_2026_08.json'), 'one millisecond before its release, the NFP is not known');
a = await at('2026-08-01T00:00:00.000Z');
assert.deepEqual([a.known.length, a.impact.summary.status], [0, 'UNAVAILABLE']);
console.log('PASS official releases: adapters, release instants, EI/GT plans, EIA-0 v2 at the cutoff; later releases excluded');

// --- The terminal: the chosen events source drives the summaries at the chain cutoff.
const view = await buildLocalView({ archiveFile: SYNTHETIC_ARCHIVE });
assert.deepEqual(view.catalog().events.map((e) => e.id), ['input', 'official:repository']);
assert.equal(view.catalog().defaults.events, 'input');
const instant = archiveCutoffs(SYNTHETIC_ARCHIVE, null).cutoffs[0];
const before = await view(null, { cutoff: instant });
const after = await view(null, { cutoff: instant, events: 'official:repository' });
const mismatch = (v) => v.stages.find((s) => s.stage === 'HORIZON_SYNTHESIS').reasons.some((r) => r.code === 'UPSTREAM_CUTOFF_MISMATCH');
assert.equal(mismatch(before), true, 'the document summaries sit at another cutoff');
assert.equal(mismatch(after), false, 'recomputed at the replay cutoff');
assert.equal(after.cutoffAlignment.aligned, true);
assert.equal(after.chain.chainState, 'HOLD');
assert.equal(after.chain.execution, 'FORBIDDEN');
for (const input of ['EVENT_IMPACT', 'GOLD_TRANSMISSION']) {
  const p = after.inputProvenance.find((e) => e.input === input);
  assert.equal(p.source, 'LOCAL_INPUT_UNVERIFIED');
  assert.match(p.detail, /publications officielles locales .* : \d+ connue\(s\) au cutoff, \d+ pas encore publiée\(s\), agrégées par EIA-0 v2/);
}
assert.equal(after.officialEvents.rejected.length, 1);
assert.equal(before.officialEvents, null);
assert.equal(await view('golden', { events: 'official:repository' }), null, 'a scenario takes no data source');
assert.equal(await view(null, { events: 'official:nope' }), null);
// The golden document with official events: same cutoff, same HOLD; only the two summaries change.
const golden = await (await buildLocalView())(null, { events: 'official:repository' });
assert.equal(golden.officialEvents.known.length, 6);
assert.equal(golden.chain.chainState, 'HOLD');
// A data root's official/ directory: listed as its own source; unreadable or foreign documents rejected by name.
const ROOT = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-official-'));
mkdirSync(path.join(ROOT, 'official'));
copyFileSync(REPOSITORY_OFFICIAL_RELEASES[3], path.join(ROOT, 'official', 'cpi.json'));
writeFileSync(path.join(ROOT, 'official', 'broken.json'), '{nope');
writeFileSync(path.join(ROOT, 'official', 'other.json'), JSON.stringify({ source: { sourceCode: 'unknown_release' } }));
// A release whose official instant cannot be read is never admitted (B3), whatever its facts.
const undated = JSON.parse(readFileSync(REPOSITORY_OFFICIAL_RELEASES[3], 'utf8'));
undated.release.publicReleaseAtRaw = 'soon';
writeFileSync(path.join(ROOT, 'official', 'undated.json'), JSON.stringify(undated));
const undatedEntry = (await readOfficialReleases([path.join(ROOT, 'official', 'undated.json')]))[0];
assert.equal(undatedEntry.status, 'REJECTED');
assert.match(undatedEntry.reason, /RELEASE_INSTANT_UNKNOWN|ADAPTER_/);
const local = await buildLocalView({ dataRoot: ROOT });
const localEntry = local.catalog().events.find((e) => e.id === 'official:local');
assert.deepEqual(localEntry.releases.map((r) => [r.name, r.status, r.reason]),
  [['broken.json', 'REJECTED', 'DOCUMENT_UNREADABLE'], ['cpi.json', 'RESOLVED', null], ['other.json', 'REJECTED', 'UNSUPPORTED_RELEASE_SOURCE'],
    ['undated.json', 'REJECTED', undatedEntry.reason]]);
// --events sets the default events source (the launcher's --local-data passes official:repository); unknown ids fall back, noted.
{
  const { parseArgs } = await import('../scripts/serve_terminal_local.mjs');
  assert.equal(parseArgs(['--events', 'official:repository']).events, 'official:repository');
  assert.equal(parseArgs(['--events', '../x']), null);
  const byDefault = await buildLocalView({ events: 'official:repository' });
  assert.equal(byDefault.catalog().defaults.events, 'official:repository');
  const v = await byDefault();
  assert.equal(v.officialEvents.known.length, 6, 'the default view uses the official releases');
  assert.equal(v.inputProvenance.find((e) => e.input === 'EVENT_IMPACT').source, 'LOCAL_INPUT_UNVERIFIED');
  const unknown = await buildLocalView({ events: 'official:nowhere' });
  assert.equal(unknown.catalog().defaults.events, 'input');
  assert.ok(unknown.catalog().notes.includes('EVENTS_SOURCE_UNKNOWN:official:nowhere'));
}
console.log('PASS terminal: the events source recomputes the summaries at the replay cutoff (aligned), LOCAL_INPUT_UNVERIFIED, HOLD');

// --- Page: third selector, events card, the releases known or not at the cutoff.
const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const catalog = view.catalog();
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/#chaine' });
const asked = [];
dom.window.fetch = async (url) => {
  const u = String(url);
  asked.push(u);
  const json = (b) => ({ ok: b !== null, status: b === null ? 404 : 200, json: async () => structuredClone(b) });
  const qs = new URL(u, 'http://x').searchParams;
  if (u === CATALOG_PATH) return json(catalog);
  if (u.startsWith(VIEW_PATH)) return json(await view(null, { events: qs.get('events'), cutoff: qs.get('cutoff') }));
  return json(null);
};
dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH, V2_CATALOG_URL: CATALOG_PATH };
const script = dom.window.document.createElement('script');
script.textContent = js;
dom.window.document.body.appendChild(script);
await new Promise((resolve) => setTimeout(resolve, 400));
const d = dom.window.document;
assert.equal(d.getElementById('v2-data-wrap').hidden, false, 'two events sources: something to choose');
assert.equal(d.getElementById('v2-data-events').hidden, false);
assert.equal(d.getElementById('v2-official-events').hidden, true, 'document summaries: no official list');
const sel = d.getElementById('v2-data-events');
sel.value = 'official:repository';
sel.dispatchEvent(new dom.window.Event('change'));
await new Promise((resolve) => setTimeout(resolve, 400));
assert.ok(asked.includes(`${VIEW_PATH}?events=official%3Arepository`), asked.join());
assert.equal(dom.window.location.hash, '#chaine/donnees/archive/input/evenements/official:repository');
assert.equal(d.getElementById('v2-official-events').hidden, false);
const items = [...d.querySelectorAll('#v2-official-events-list li')];
assert.equal(items.filter((li) => li.getAttribute('data-state') === 'known').length, 6);
assert.equal(items.filter((li) => li.getAttribute('data-state') === 'rejected').length, 1);
assert.match(d.getElementById('v2-data-card-events').textContent, /US_CPI 2026-08 \(publiée 2026-09-11 12:30:00Z\)/);
assert.notEqual(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
assert.doesNotMatch(d.getElementById('v2-official-events').textContent, /BULL|BEAR|haussier|baissier|\bachat\b|\bvente\b/i);
dom.window.close();
// At an earlier cutoff, the releases published after it are listed as not yet published, and excluded.
{
  const early = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/#chaine' });
  early.window.fetch = async (url) => {
    const u = String(url);
    const json = (b) => ({ ok: b !== null, status: b === null ? 404 : 200, json: async () => structuredClone(b) });
    if (u === CATALOG_PATH) return json(catalog);
    if (u.startsWith(VIEW_PATH)) return json(await view(null, { events: 'official:repository', cutoff: '2026-09-20T00:00:00.000Z' }));
    return json(null);
  };
  early.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH, V2_CATALOG_URL: CATALOG_PATH };
  const s2 = early.window.document.createElement('script');
  s2.textContent = js;
  early.window.document.body.appendChild(s2);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const lis = [...early.window.document.querySelectorAll('#v2-official-events-list li')];
  const byState = (state) => lis.filter((li) => li.getAttribute('data-state') === state).map((li) => li.textContent);
  assert.equal(byState('known').length, 4);
  assert.deepEqual(byState('pending').map((t) => t.replace(/ · .*/, '')), ['US_PCE 2026-08', 'US_JOBLESS_CLAIMS semaine au 2026-09-26']);
  assert.ok(byState('pending').every((t) => /PAS ENCORE PUBLIÉE au cutoff : exclue/.test(t)), byState('pending').join(' | '));
  assert.match(byState('pending')[0], /publiée 2026-09-30 12:30:00Z/);
  early.window.close();
}
// A view that lists official releases while its provenance says otherwise is refused.
{
  const forged = structuredClone(after);
  forged.inputProvenance.find((e) => e.input === 'EVENT_IMPACT').source = 'SYNTHETIC_FIXTURE';
  const dom2 = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom2.window.fetch = (url) => (String(url) === VIEW_PATH ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(forged)) })
    : Promise.reject(new Error(`unexpected fetch ${url}`)));
  dom2.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const sc = dom2.window.document.createElement('script');
  sc.textContent = js;
  dom2.window.document.body.appendChild(sc);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(dom2.window.document.getElementById('v2-status').getAttribute('data-state'), 'rejected');
  assert.match(dom2.window.document.getElementById('v2-detail').textContent, /provenance des événements contradictoire/);
  dom2.window.close();
}
console.log('PASS page: Événements macro selector, card and list of official releases known at the cutoff; anchor kept');
