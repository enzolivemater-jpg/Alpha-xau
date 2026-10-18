// The DONNÉES LOCALES panel's "DONNÉES RÉELLES DISPONIBLES" button selects, by
// explicit rules and without judging quality: market = the captures merge if
// it succeeded, else the most recently received CAPTURED archive (never a
// synthetic one); positioning = the read CFTC file with the latest report;
// events = local official releases, else the repository's. Nothing approved:
// the view stays HOLD / FORBIDDEN. Catalogs below are described as data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { CATALOG_PATH, VIEW_PATH, buildLocalView } from '../scripts/serve_terminal_local.mjs';

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const golden = await (await buildLocalView())();
const market = (id, kind, extra = {}) => ({ id, kind, label: id, replayable: kind !== 'INPUT_DOCUMENT', provenanceClass: 'CAPTURED', archiveId: id,
  records: 3, coverage: null, observed: null, received: { first: '2026-10-01T00:00:00.000Z', last: '2026-10-01T00:00:00.000Z' }, fields: ['spot'],
  validation: { at: '2026-10-01T00:00:00.000Z', status: 'INCOMPLETE', nature: 'HISTORICAL_UNVERIFIED', reasonCodes: [] }, problems: [], ...extra });
const cot = (id, reportDate, status = 'EXTRACTED') => ({ id, kind: 'CFTC_FILE', label: id, status, reportDate, metrics: 14, reasonCodes: [] });
const catalogOf = (over) => ({
  schemaVersion: 'xau.terminal-data-catalog.v1', defaults: { market: 'input', positioning: 'input', events: 'input' }, notes: [],
  market: [{ id: 'input', kind: 'INPUT_DOCUMENT', label: 'doc', replayable: false, problems: [] }],
  positioning: [{ id: 'input', kind: 'INPUT_DOCUMENT', label: 'doc', status: 'DOCUMENT', reasonCodes: [] }],
  events: [{ id: 'input', kind: 'INPUT_DOCUMENT', label: 'doc', releases: [] },
    { id: 'official:repository', kind: 'OFFICIAL_RELEASES', label: 'repo', releases: [{ name: 'a.json', status: 'RESOLVED' }] }],
  ...over,
});
const run = async (catalog) => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/#chaine' });
  const asked = [];
  dom.window.fetch = async (url) => {
    asked.push(String(url));
    const json = (b) => ({ ok: b !== null, status: b ? 200 : 404, json: async () => structuredClone(b) });
    if (String(url) === CATALOG_PATH) return json(catalog);
    if (String(url).startsWith(VIEW_PATH)) return json(golden);
    return json(null);
  };
  dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH, V2_CATALOG_URL: CATALOG_PATH };
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { dom, d: dom.window.document, asked };
};
const click = async (dom, d) => { d.getElementById('v2-data-real').click(); await new Promise((resolve) => setTimeout(resolve, 300)); };

// Merge OK: chosen over logs; latest CFTC report; local official releases preferred.
let { dom, d, asked } = await run(catalogOf({
  market: [...catalogOf({}).market, market('merged:evidence', 'CAPTURES_MERGED'), market('log:evidence:new', 'CAPTURE_LOG',
    { received: { first: 'x', last: '2026-10-15T00:00:00.000Z' } })],
  positioning: [...catalogOf({}).positioning, cot('cot:old.csv', '2026-09-22'), cot('cot:new.csv', '2026-10-13'), cot('cot:bad.csv', '2026-10-20', 'REJECTED')],
  events: [...catalogOf({}).events, { id: 'official:local', kind: 'OFFICIAL_RELEASES', label: 'local', releases: [{ name: 'b.json', status: 'RESOLVED' }] }],
}));
assert.equal(d.getElementById('v2-data-real').hidden, false);
await click(dom, d);
assert.equal(d.getElementById('v2-data-market').value, 'merged:evidence');
assert.equal(d.getElementById('v2-data-positioning').value, 'cot:new.csv', 'latest read report, never a rejected file');
assert.equal(d.getElementById('v2-data-events').value, 'official:local');
assert.ok(asked.some((u) => u === `${VIEW_PATH}?market=merged%3Aevidence&positioning=cot%3Anew.csv&events=official%3Alocal`), asked.join());
assert.equal(dom.window.location.hash, '#chaine/donnees/merged:evidence/cot:new.csv/evenements/official:local');
dom.window.close();

// Failed merge and a synthetic archive: the most recent CAPTURED log is chosen; repository releases.
({ dom, d } = await run(catalogOf({
  market: [...catalogOf({}).market, market('merged:evidence', 'CAPTURES_MERGED', { problems: ['SOURCE_UNREADABLE:x'] }),
    market('log:evidence:old', 'CAPTURE_LOG'), market('log:evidence:new', 'CAPTURE_LOG', { received: { first: 'x', last: '2026-10-15T00:00:00.000Z' } }),
    market('archive', 'ARCHIVE_FILE', { provenanceClass: 'SYNTHETIC_FIXTURE', received: { first: 'x', last: '2026-12-31T00:00:00.000Z' } }),
    market('log:evidence:rejected', 'CAPTURE_LOG', { validation: { status: 'INVALID', reasonCodes: [] }, received: { first: 'x', last: '2027-01-01T00:00:00.000Z' } })],
})));
await click(dom, d);
assert.equal(d.getElementById('v2-data-market').value, 'log:evidence:new');
assert.equal(d.getElementById('v2-data-positioning').value, 'input', 'no read CFTC file: positioning unchanged');
assert.equal(d.getElementById('v2-data-events').value, 'official:repository');
dom.window.close();

// Nothing real: no button. A scenario disables it.
({ dom, d } = await run(catalogOf({ events: [catalogOf({}).events[0]] })));
assert.equal(d.getElementById('v2-data-real').hidden, true);
dom.window.close();
// A real (synthetic) catalog from the server: no CAPTURED market, so the market is left alone.
const synthetic = (await buildLocalView()).catalog();
({ dom, d } = await run(synthetic));
await click(dom, d);
assert.equal(d.getElementById('v2-data-market').value, 'input');
assert.equal(d.getElementById('v2-data-events').value, 'official:repository');
assert.notEqual(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
dom.window.close();
console.log('PASS DONNÉES RÉELLES DISPONIBLES: explicit rules (merge, latest CAPTURED log, latest read CFTC report, official releases), never synthetic');
