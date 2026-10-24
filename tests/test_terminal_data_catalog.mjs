// DATA-TO-TERMINAL — the operator's local data becomes selectable and
// inspectable in the terminal. --data-root DIR registers DIR/evidence/<log>/
// archive.json (each capture log, and their merge) and DIR/positioning/<file>
// with <name>.declaration.json (CFTC COT files); nothing is selected by
// default. The page lists them (catalog ids only, never paths), shows each
// source's period, provenance, validation state and reasons, and replays the
// chosen market with the chosen positioning. Every view stays HOLD /
// FORBIDDEN; CFTC stays NOT_APPROVED; unknown formats are named. All data here
// is synthetic, written by this test.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import {
  ARCHIVE_CUTOFFS_PATH, CATALOG_PATH, SCENARIOS_PATH, VIEW_PATH,
  buildLocalView, createTerminalServer, listenOnLoopback, parseArgs, readPositioningDir, startNoteText,
} from '../scripts/serve_terminal_local.mjs';
import { LOCAL_DATA_ROOT, parseArgs as launcherArgs } from '../scripts/terminal_launch.mjs';

const cap = await loadBackendModule('market_engine/evidence_capture.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const PARSERS = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
const fredBody = (vintage, rows) => JSON.stringify({
  realtime_start: vintage, realtime_end: vintage, observation_start: rows[0][0], units: 'lin', file_type: 'json',
  observations: rows.map(([date, value]) => ({ realtime_start: vintage, realtime_end: vintage, date, value })),
});
const tdBody = (close, at) => JSON.stringify({ symbol: 'XAU/USD', close: String(close), last_quote_at: Date.parse(at) / 1000, is_market_open: true });
const logOf = async (id, captures) => {
  let a = cap.createEvidenceArchive({ archiveId: id, provenanceClass: 'SYNTHETIC_FIXTURE', createdAt: captures[0].ingestedAt,
    fields: [...new Set(captures.map((c) => cap.CAPTURE_SERIES.find((s) => s.sourceRecordId === c.sourceRecordId).field))],
    statement: 'journal de test synthétique' });
  for (const c of captures) {
    const r = await cap.appendProviderCapture(a, c, PARSERS);
    assert.equal(r.outcome, 'APPENDED', r.rejection);
    a = r.archive;
  }
  return a;
};

// ---- A local data root, as the operator would keep it.
const ROOT = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-data-root-'));
const put = (rel, body) => { mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true }); writeFileSync(path.join(ROOT, rel), body); };
put('evidence/fred-log/archive.json', JSON.stringify(await logOf('fred-log', [{ provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10',
  body: fredBody('2026-10-01', [['2026-09-29', '4.12'], ['2026-09-30', '4.10']]), ingestedAt: '2026-10-01T06:00:00Z' }])));
put('evidence/spot-log/archive.json', JSON.stringify(await logOf('spot-log', [{ provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD',
  body: tdBody(3900, '2026-10-01T14:14:00Z'), ingestedAt: '2026-10-01T14:14:03Z' }])));
put('evidence/broken-log/archive.json', '{not json');
mkdirSync(path.join(ROOT, 'evidence', 'empty-dir'));
const declare = (name, over = {}) => put(`positioning/${name}.declaration.json`, JSON.stringify({ schemaVersion: 'xau.cftc-cot-declaration.v1',
  dataset: 'FUTURES_ONLY', publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z', reportDate: '2026-09-22', ...over }));
const COT = new URL('./fixtures/cftc_cot_disaggregated_synthetic.csv', import.meta.url);
mkdirSync(path.join(ROOT, 'positioning'), { recursive: true });
copyFileSync(COT, path.join(ROOT, 'positioning', 'gold.csv'));
declare('gold');
copyFileSync(COT, path.join(ROOT, 'positioning', 'undeclared.csv'));
put('positioning/f_disagg.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
declare('f_disagg');
put('positioning/legacy.txt', 'Market_and_Exchange_Names,As_of_Date_In_Form_YYMMDD,Report_Date_as_YYYY-MM-DD,CFTC_Contract_Market_Code,'
  + 'Open_Interest_All,NonComm_Positions_Long_All\r\nX,260922,2026-09-22,088691,1,2\r\n');
declare('legacy');
copyFileSync(COT, path.join(ROOT, 'positioning', 'bad-declaration.csv'));
put('positioning/bad-declaration.declaration.json', JSON.stringify({ schemaVersion: 'xau.cftc-cot-declaration.v1', dataset: 'FUTURES_ONLY',
  publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z', approved: true }));
copyFileSync(COT, path.join(ROOT, 'positioning', 'odd name.csv'));
// contractMarketCode: a declared null is no market at all, never "gold by default"; a declared code selects that market.
copyFileSync(COT, path.join(ROOT, 'positioning', 'null-market.csv'));
declare('null-market', { contractMarketCode: null });
copyFileSync(COT, path.join(ROOT, 'positioning', 'silver.csv'));
declare('silver', { contractMarketCode: '084691', reportDate: '2026-09-29', publishedAt: '2026-10-02T19:30:00.000Z', receivedAt: '2026-10-02T19:45:00.000Z' });

// ---- Catalog: every source with its period, provenance, validation and reasons; nothing selected by default.
const view = await buildLocalView({ dataRoot: ROOT });
const catalog = view.catalog();
assert.equal(catalog.schemaVersion, 'xau.terminal-data-catalog.v1');
assert.deepEqual(catalog.defaults, { market: 'input', positioning: 'input', events: 'input' });
assert.deepEqual(catalog.market.map((m) => m.id), ['input', 'merged:evidence', 'log:evidence:broken-log', 'log:evidence:fred-log', 'log:evidence:spot-log']);
const m = Object.fromEntries(catalog.market.map((x) => [x.id, x]));
assert.equal(m.input.replayable, false);
assert.equal(m['merged:evidence'].kind, 'CAPTURES_MERGED');
assert.match(m['merged:evidence'].problems.join(), /SOURCE_UNREADABLE:broken-log/, 'the merge refuses an unreadable log');
assert.equal(m['merged:evidence'].validation.status, 'INVALID');
const fred = m['log:evidence:fred-log'];
assert.deepEqual([fred.kind, fred.provenanceClass, fred.archiveId, fred.records, fred.coverage, fred.fields],
  ['CAPTURE_LOG', 'SYNTHETIC_FIXTURE', 'fred-log', 2, fred.coverage, ['us10y']]);
assert.deepEqual(fred.observed, { first: '2026-09-29T00:00:00.000Z', last: '2026-09-30T00:00:00.000Z' });
assert.deepEqual(fred.received, { first: '2026-10-01T06:00:00.000Z', last: '2026-10-01T06:00:00.000Z' });
assert.deepEqual([fred.validation.at, fred.validation.nature], ['2026-10-01T06:00:00.000Z', 'SIMULATION']);
assert.ok(['VERIFIED', 'INCOMPLETE'].includes(fred.validation.status) && Array.isArray(fred.validation.reasonCodes));
assert.deepEqual([m['log:evidence:broken-log'].validation.status, m['log:evidence:broken-log'].problems], ['INVALID', ['SOURCE_UNREADABLE']]);
const p = Object.fromEntries(catalog.positioning.map((x) => [x.id, x]));
assert.deepEqual(Object.keys(p), ['input', 'cot:bad-declaration.csv', 'cot:f_disagg.zip', 'cot:gold.csv', 'cot:legacy.txt', 'cot:null-market.csv', 'cot:silver.csv', 'cot:undeclared.csv']);
assert.deepEqual([p['cot:null-market.csv'].status, p['cot:null-market.csv'].reasonCodes], ['REJECTED', ['DECLARATION_INVALID']], 'null market code is not gold');
assert.equal(p['cot:silver.csv'].status, 'EXTRACTED');
assert.match((await readPositioningDir(path.join(ROOT, 'positioning'))).entries.find((e) => e.name === 'silver.csv').conversion.marketName, /SILVER/);
assert.deepEqual([p['cot:gold.csv'].status, p['cot:gold.csv'].metrics, p['cot:gold.csv'].dataset, p['cot:gold.csv'].reportDate, p['cot:gold.csv'].sourceApproval],
  ['EXTRACTED', 14, 'FUTURES_ONLY', '2026-09-22', 'NOT_APPROVED']);
assert.deepEqual(p['cot:undeclared.csv'].reasonCodes, ['DECLARATION_MISSING']);
assert.deepEqual(p['cot:gold.csv'].fileReports, { count: 2, first: '2026-09-22', last: '2026-09-29' }, 'the file holds two reports, one is declared');
assert.deepEqual(p['cot:undeclared.csv'].fileReports, { count: 2, first: '2026-09-22', last: '2026-09-29' }, 'known even before a declaration');
assert.equal(p['cot:f_disagg.zip'].fileReports, null);
assert.deepEqual(p['cot:bad-declaration.csv'].reasonCodes, ['DECLARATION_INVALID'], 'an unknown key (approved) is refused');
assert.deepEqual(p['cot:f_disagg.zip'].reasonCodes, ['UNSUPPORTED_FORMAT']);
assert.match(p['cot:f_disagg.zip'].detail, /archive ZIP/);
assert.deepEqual(p['cot:legacy.txt'].reasonCodes, ['UNSUPPORTED_LAYOUT']);
assert.match(catalog.notes.join(), /nom de fichier non pris en charge \("odd name\.csv"\)/);
assert.ok(catalog.notes.includes('CAPTURE_LOG_WITHOUT_ARCHIVE:evidence/empty-dir'), 'a capture directory without archive.json is named');
assert.equal(startNoteText('CAPTURE_LOG_WITHOUT_ARCHIVE:evidence/empty-dir'),
  'dossier de capture sans archive.json (evidence/empty-dir) : ignoré, ses données manquent à la fusion');
assert.equal(startNoteText('EVIDENCE_DIR_ABSENT'), 'pas de dossier evidence/ (journaux de capture)');
assert.equal(startNoteText('SOMETHING_NEW'), 'SOMETHING_NEW');
assert.ok(!JSON.stringify(catalog).includes(ROOT), 'no path reaches the page');
const dirOnly = await readPositioningDir(path.join(ROOT, 'missing'));
assert.match(dirOnly.problem, /POSITIONING_DIR_UNREADABLE/);
console.log('PASS the catalog lists each capture log, their merge and each CFTC file with period, provenance, validation and reasons');

// ---- Views: the chosen market and positioning; HOLD / FORBIDDEN; refusals.
const prov = (v, input) => v.inputProvenance.find((e) => e.input === input);
const chosen = await view(null, { market: 'log:evidence:spot-log', positioning: 'cot:gold.csv' });
assert.equal(chosen.origin.label, 'journal spot-log (evidence)');
assert.equal(chosen.chain.knowledgeCutoff, '2026-10-01T14:14:03.000Z', 'a capture log replays after its last reception');
assert.equal(chosen.market.fields.find((f) => f.field === 'spot').value, 3900);
assert.equal(chosen.positioning.evidenceCount, 14);
assert.equal(prov(chosen, 'POSITIONING').source, 'LOCAL_INPUT_UNVERIFIED');
assert.equal(prov(chosen, 'MARKET').source, 'SYNTHETIC_FIXTURE');
for (const v of [chosen, await view(), await view(null, { market: 'merged:evidence' }), await view(null, { positioning: 'cot:legacy.txt' })]) {
  assert.equal(v.chain.chainState, 'HOLD');
  assert.equal(v.chain.execution, 'FORBIDDEN');
  assert.equal(v.positioning.positioningState ?? 'UNAVAILABLE', 'UNAVAILABLE');
}
const legacy = await view(null, { positioning: 'cot:legacy.txt' });
assert.equal(legacy.positioning.evidenceCount, 0, 'a rejected file supplies nothing');
assert.match(prov(legacy, 'POSITIONING').detail, /UNSUPPORTED_LAYOUT/);
const undeclared = await view(null, { positioning: 'cot:undeclared.csv' });
assert.equal(prov(undeclared, 'POSITIONING').source, 'UNAVAILABLE');
assert.match(prov(undeclared, 'POSITIONING').detail, /DECLARATION_MISSING/);
assert.equal((await view(null, { market: 'log:evidence:fred-log', cutoff: '2026-10-01T06:00:00.000Z' })).chain.knowledgeCutoff, '2026-10-01T06:00:00.000Z');
for (const [name, args] of [['unknown market', [null, { market: 'log:evidence:nope' }]], ['unknown positioning', [null, { positioning: 'cot:../../etc/passwd' }]],
  ['scenario with data', ['golden', { market: 'input' }]], ['cutoff without archive', [null, { cutoff: '2026-10-01T06:00:00.000Z' }]]]) {
  assert.equal(await view(...args), null, name);
}
assert.deepEqual(view.archiveCutoffs('log:evidence:fred-log').cutoffs, ['2026-10-01T06:00:00.000Z']);
assert.equal(view.archiveCutoffs('input'), null);
// The options keep their meaning: --captures and --positioning-cot are the default selection.
const withOptions = await buildLocalView({ dataRoot: ROOT, capturesDir: path.join(ROOT, 'evidence'),
  positioningCot: { file: path.join(ROOT, 'positioning', 'gold.csv'), publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z',
    reportDate: '2026-09-22', dataset: 'FUTURES_ONLY' } });
assert.deepEqual(withOptions.catalog().defaults, { market: 'merged:evidence', positioning: 'cli-cot', events: 'input' });
assert.equal(withOptions.catalog().market.filter((x) => x.kind === 'CAPTURES_MERGED').length, 1, 'the same directory is listed once');
// The server's own positioning (--positioning-cot) also gives its knowledge instant when the page sends no id.
assert.deepEqual(withOptions.archiveCutoffs().knownAt, [{ at: '2026-09-25T19:45:00.000Z', input: 'POSITIONING', source: 'cli-cot', reportDate: '2026-09-22' }]);
assert.ok(withOptions.archiveCutoffs().cutoffs.includes('2026-09-25T19:45:00.000Z'));
assert.equal(view.archiveCutoffs('log:evidence:fred-log').knownAt, undefined, 'the document positioning (input) adds nothing');
console.log('PASS the chosen sources drive the view (HOLD / FORBIDDEN); unknown ids, paths, or a scenario with data are refused');

// ---- HTTP.
const get = (port, pathname, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  }).on('error', reject);
});
const server = await createTerminalServer({ dataRoot: ROOT });
const { port } = await listenOnLoopback(server, { port: 4621, range: 5 });
try {
  assert.deepEqual(JSON.parse((await get(port, CATALOG_PATH)).body), catalog);
  assert.equal((await get(port, CATALOG_PATH, 'evil.example:80')).status, 403);
  const page = (await get(port, '/')).body;
  assert.match(page, new RegExp(`V2_CATALOG_URL: '${CATALOG_PATH}'`));
  assert.match(page, new RegExp(`V2_ARCHIVE_CUTOFFS_URL: '${ARCHIVE_CUTOFFS_PATH}'`), 'some source is replayable');
  const q = (o) => `${VIEW_PATH}?${new URLSearchParams(o)}`;
  const ok = await get(port, q({ market: 'log:evidence:spot-log', positioning: 'cot:gold.csv' }));
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).positioning.evidenceCount, 14);
  assert.equal((await get(port, q({ market: '../evidence' }))).status, 400);
  assert.equal((await get(port, q({ market: 'log:evidence:nope' }))).status, 404);
  assert.equal((await get(port, q({ scenario: 'golden', positioning: 'cot:gold.csv' }))).status, 400);
  assert.equal((await get(port, q({ cutoff: '2026-10-01T06:00:00.000Z' }))).status, 400, 'the default source (input) is not an archive');
  assert.equal((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=log:evidence:fred-log`)).status, 200);
  assert.equal((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=input`)).status, 404);
  assert.equal((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=a/b`)).status, 400);
  // With a CFTC positioning source: the instant its report is known (published and received) is offered too.
  const withCot = JSON.parse((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=log:evidence:fred-log&positioning=cot:gold.csv`)).body);
  assert.deepEqual(withCot.cutoffs, ['2026-09-25T19:45:00.000Z', '2026-10-01T06:00:00.000Z']);
  assert.deepEqual(withCot.knownAt, [{ at: '2026-09-25T19:45:00.000Z', input: 'POSITIONING', source: 'cot:gold.csv', reportDate: '2026-09-22' }]);
  assert.deepEqual(withCot.receptions.map((r) => r.at), ['2026-10-01T06:00:00.000Z'], 'receptions stay the market ones');
  const noCot = JSON.parse((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=log:evidence:fred-log&positioning=cot:legacy.txt`)).body);
  assert.deepEqual([noCot.cutoffs, noCot.knownAt], [['2026-10-01T06:00:00.000Z'], undefined], 'a rejected file adds nothing');
  assert.equal((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=log:evidence:fred-log&positioning=cot:nope.csv`)).status, 404);
  assert.equal((await get(port, `${ARCHIVE_CUTOFFS_PATH}?market=log:evidence:fred-log&positioning=../x`)).status, 400);
  // At that instant the report is known: P-0 keeps its values (none flagged after the cutoff); one millisecond before, none.
  const at = JSON.parse((await get(port, q({ market: 'log:evidence:fred-log', positioning: 'cot:gold.csv', cutoff: '2026-09-25T19:45:00.000Z' }))).body);
  assert.ok(at.positioning.evidence.length === 14 && at.positioning.evidence.every((e) => e.afterCutoff === false));
  assert.equal(at.chain.chainState, 'HOLD');
  const before = JSON.parse((await get(port, q({ market: 'log:evidence:fred-log', positioning: 'cot:gold.csv', cutoff: '2026-09-25T19:44:59.999Z' }))).body);
  assert.ok(before.positioning.evidence.every((e) => e.afterCutoff === true));
  // D1 (view 4.8.0): a value not yet known at the cutoff is never served; the row keeps why it is set aside.
  assert.ok(before.positioning.evidence.every((e) => e.value === null), 'no value before its knowledge instant');
  assert.equal(before.positioning.evidence.length, 14, 'the rows stay, with metric, period and instants');
  for (const e of at.positioning.evidence) {
    assert.ok(!JSON.stringify(before).includes(`"value":${e.value}`), `value of ${e.metricCode} absent from the JSON before the cutoff`);
  }
  assert.ok(at.positioning.evidence.every((e) => Number.isInteger(e.value)), 'known at the cutoff: values served');
} finally {
  server.close();
}
const plain = await createTerminalServer({});
const plainPort = (await listenOnLoopback(plain, { port: 4626, range: 5 })).port;
try {
  assert.match((await get(plainPort, '/')).body, /V2_ARCHIVE_CUTOFFS_URL: '',/, 'nothing replayable, no cutoffs URL');
  assert.deepEqual(JSON.parse((await get(plainPort, CATALOG_PATH)).body).market.map((x) => x.id), ['input']);
} finally {
  plain.close();
}
// Arguments and launcher.
assert.equal(parseArgs(['--data-root', ROOT]).dataRoot, ROOT);
assert.deepEqual(launcherArgs(['--local-data']).server, ['--data-root', LOCAL_DATA_ROOT, '--events', 'official:repository']);
assert.deepEqual(launcherArgs(['--data-root', ROOT]).server, ['--data-root', ROOT]);
console.log('PASS HTTP: catalog behind the Host guard, catalog ids only (400 for a path), 404 for unknown sources; --local-data');

// ---- Page.
const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const scenarios = [{ id: 'golden', label: 'golden' }];
const render = async (hash = '', cat = catalog) => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `http://127.0.0.1:4173/${hash}` });
  const asked = [];
  dom.window.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const json = (b) => ({ ok: b !== null, status: b === null ? 404 : 200, json: async () => structuredClone(b) });
    const qs = new URL(u, 'http://x').searchParams;
    if (u === CATALOG_PATH) return json(cat);
    if (u === SCENARIOS_PATH) return json(scenarios);
    if (u.startsWith(ARCHIVE_CUTOFFS_PATH)) return json(view.archiveCutoffs(qs.get('market'), qs.get('positioning')) ?? null);
    if (u.startsWith(VIEW_PATH)) {
      return json(qs.get('scenario') ? await view(qs.get('scenario'))
        : await view(null, { market: qs.get('market'), positioning: qs.get('positioning'), cutoff: qs.get('cutoff') }));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH,
    V2_SCENARIOS_URL: SCENARIOS_PATH, V2_ARCHIVE_CUTOFFS_URL: ARCHIVE_CUTOFFS_PATH, V2_CATALOG_URL: CATALOG_PATH };
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { dom, d: dom.window.document, asked };
};
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
const change = (dom, el, value) => { el.value = value; el.dispatchEvent(new dom.window.Event('change')); };
let { dom, d, asked } = await render('#chaine');
assert.equal(d.getElementById('v2-data-wrap').hidden, false);
assert.deepEqual([...d.querySelectorAll('#v2-data-market option')].map((o) => o.value), catalog.market.map((x) => x.id));
assert.match(d.getElementById('v2-data-hint').textContent, /dossier de capture sans archive\.json \(evidence\/empty-dir\) : ignoré, ses données manquent à la fusion/);
assert.match(d.getElementById('v2-data-card-market').textContent, /document d'entrée/);
assert.ok(!asked.some((u) => u.startsWith(ARCHIVE_CUTOFFS_PATH)), 'the input document has no replay cutoffs to ask');
change(dom, d.getElementById('v2-data-market'), 'log:evidence:fred-log');
await settle();
assert.ok(asked.includes(`${VIEW_PATH}?market=log%3Aevidence%3Afred-log`), asked.join());
assert.ok(asked.includes(`${ARCHIVE_CUTOFFS_PATH}?market=log%3Aevidence%3Afred-log`));
const card = d.getElementById('v2-data-card-market').textContent;
for (const fact of ['journal de capture', 'SYNTHÉTIQUE · fred-log', '2 · champs : US10Y', 'Période observée2026-09-29 00:00:00Z → 2026-09-30 00:00:00Z',
  'Période reçue2026-10-01 06:00:00Z', 'Couverture déclarée', 'rejeu au 2026-10-01 06:00:00Z']) assert.ok(card.includes(fact), `${fact} in ${card}`);
assert.equal(d.getElementById('v2-replay-cutoff-wrap').hidden, false);
assert.equal(d.getElementById('v2-cutoff').textContent, '2026-10-01T06:00:00.000Z');
change(dom, d.getElementById('v2-data-positioning'), 'cot:f_disagg.zip');
await settle();
const pcard = d.getElementById('v2-data-card-positioning').textContent;
assert.match(pcard, /source NON APPROUVÉE/);
assert.match(pcard, /REJETÉ/);
assert.match(pcard, /UNSUPPORTED FORMAT — format non pris en charge : archive ZIP/);
assert.equal(d.querySelector('#v2-prov [data-input="POSITIONING"]').getAttribute('data-source'), 'UNAVAILABLE');
change(dom, d.getElementById('v2-data-positioning'), 'cot:gold.csv');
await settle();
assert.match(d.getElementById('v2-data-card-positioning').textContent, /LU — 14 mesures brutes, aucune méthode approuvée.*futures seuls.*2026-09-22/);
assert.match(d.getElementById('v2-data-card-positioning').textContent, /Rapports dans le fichier2 \(2026-09-22 → 2026-09-29\) · un seul est lu : celui déclaré/);
assert.match(d.getElementById('v2-data-card-positioning').textContent, /Base de la date de publicationnon indiquée \(déclaration de l'opérateur seule\)/);
// The replay cutoffs follow the positioning choice: the instant its report becomes known is offered and labelled.
assert.ok(asked.includes(`${ARCHIVE_CUTOFFS_PATH}?market=log%3Aevidence%3Afred-log&positioning=cot%3Agold.csv`), asked.join());
const cutoffOptions = () => [...d.querySelectorAll('#v2-replay-cutoff option')].map((o) => [o.value, o.textContent]);
assert.deepEqual(cutoffOptions().slice(1), [['2026-09-25T19:45:00.000Z', '2026-09-25 19:45:00.000Z — POSITIONNEMENT connu (rapport CFTC du 2026-09-22)'],
  ['2026-10-01T06:00:00.000Z', '2026-10-01 06:00:00.000Z — réception 1/1 · US10Y']]);
assert.match(d.getElementById('v2-replay-cutoff-hint').textContent, /^1 instant de réception de l'archive et 1 instant où le positionnement choisi devient connu/);
change(dom, d.getElementById('v2-replay-cutoff'), '2026-09-25T19:45:00.000Z');
await settle();
assert.equal(d.getElementById('v2-cutoff').textContent, '2026-09-25T19:45:00.000Z');
assert.doesNotMatch(d.getElementById('v2-positioning-evidence').textContent, /APRÈS LE CUTOFF/, 'the report is known at that instant');
assert.equal(d.getElementById('v2-state').textContent.includes('HOLD'), true);
// Before that instant the report is shown, set aside, with the instant from which it is known.
{
  const v = await view(null, { market: 'log:evidence:fred-log', positioning: 'cot:gold.csv', cutoff: '2026-09-25T19:44:59.999Z' });
  const early = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/#chaine' });
  early.window.fetch = async (url) => ({ ok: String(url).startsWith(VIEW_PATH), status: String(url).startsWith(VIEW_PATH) ? 200 : 404,
    json: async () => structuredClone(v) });
  early.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const sc = early.window.document.createElement('script');
  sc.textContent = js;
  early.window.document.body.appendChild(sc);
  await settle();
  const head = early.window.document.querySelector('#v2-positioning-evidence .v2__pos-group-head');
  assert.equal(head.getAttribute('data-after-cutoff'), 'true');
  assert.match(head.textContent, /reçu 2026-09-25 19:45:00Z · APRÈS LE CUTOFF : écartée \(connue à partir du 2026-09-25 19:45:00Z\)$/, head.textContent);
  const values = [...early.window.document.querySelectorAll('#v2-positioning-evidence .v2__pos-value')].map((x) => x.textContent);
  assert.equal(values.length, 14);
  assert.ok(values.every((x) => x === 'masquée (inconnue au cutoff)'), values.join(' | '));
  // A view that would still carry such a value is refused by the page, not shown.
  const leaking = structuredClone(v);
  leaking.positioning.evidence[0].value = 987654; // SYNTHETIC test value, not CFTC data
  const leak = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/#chaine' });
  leak.window.fetch = async (url) => ({ ok: String(url).startsWith(VIEW_PATH), status: 200, json: async () => structuredClone(leaking) });
  leak.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const sl = leak.window.document.createElement('script');
  sl.textContent = js;
  leak.window.document.body.appendChild(sl);
  await settle();
  assert.equal(leak.window.document.getElementById('v2-status').getAttribute('data-state'), 'rejected');
  assert.doesNotMatch(leak.window.document.body.textContent, /987\s?654/);
  leak.window.close();
  early.window.close();
}
// Back to the document's positioning: that instant is no longer offered, the server cutoff applies again.
change(dom, d.getElementById('v2-data-positioning'), 'input');
await settle();
assert.deepEqual(cutoffOptions().slice(1).map(([v]) => v), ['2026-10-01T06:00:00.000Z']);
assert.equal(d.getElementById('v2-replay-cutoff').value, '');
assert.equal(d.getElementById('v2-cutoff').textContent, '2026-10-01T06:00:00.000Z');
change(dom, d.getElementById('v2-data-positioning'), 'cot:gold.csv');
await settle();
assert.equal(dom.window.location.hash, '#chaine/donnees/log:evidence:fred-log/cot:gold.csv');
assert.notEqual(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
assert.doesNotMatch(d.getElementById('v2-status').closest('section').textContent, /\b(BUY|SELL|EVIDENCE_READY)\b/);
change(dom, d.getElementById('v2-scenario'), 'golden');
await settle();
assert.equal(d.getElementById('v2-data-market').disabled, true);
assert.equal(asked.at(-1), `${VIEW_PATH}?scenario=golden`);
dom.window.close();
// Reload with the anchor: the same sources (and replay instant) come back; unknown ids are ignored.
({ dom, d, asked } = await render('#chaine/donnees/log:evidence:fred-log/cot:gold.csv/rejeu/2026-10-01T06:00:00.000Z'));
await settle();
assert.equal(d.getElementById('v2-data-market').value, 'log:evidence:fred-log');
assert.equal(d.getElementById('v2-data-positioning').value, 'cot:gold.csv');
assert.ok(asked.some((u) => u.startsWith(VIEW_PATH) && u.includes('market=log%3Aevidence%3Afred-log') && u.includes('positioning=cot%3Agold.csv')
  && u.includes('cutoff=2026-10-01T06%3A00%3A00.000Z')), asked.join());
dom.window.close();
// An anchor on the instant the CFTC report becomes known comes back too (it is offered for that positioning).
({ dom, d, asked } = await render('#chaine/donnees/log:evidence:fred-log/cot:gold.csv/rejeu/2026-09-25T19:45:00.000Z'));
await settle();
assert.equal(d.getElementById('v2-replay-cutoff').value, '2026-09-25T19:45:00.000Z');
assert.equal(d.getElementById('v2-cutoff').textContent, '2026-09-25T19:45:00.000Z');
assert.doesNotMatch(d.getElementById('v2-positioning-evidence').textContent, /APRÈS LE CUTOFF/);
assert.equal(dom.window.location.hash, '#chaine/donnees/log:evidence:fred-log/cot:gold.csv/rejeu/2026-09-25T19:45:00.000Z');
dom.window.close();
({ dom, d, asked } = await render('#chaine/donnees/log:evidence:gone/cot:gold.csv'));
assert.equal(d.getElementById('v2-data-market').value, 'input');
assert.ok(asked.filter((u) => u.startsWith(VIEW_PATH)).every((u) => u === VIEW_PATH), asked.join());
dom.window.close();
// The publication basis is shown as declared: an inferred date is never presented as an official one.
for (const [kind, expected] of [
  ['OFFICIAL_SCHEDULE_INFERRED', /Base de la date de publicationDÉDUITE du calendrier officiel provisoire \(non prouvée pour ce rapport\) — https:\/\/www\.cftc\.gov\/x/],
  ['EXPLICIT_OFFICIAL_MAPPING', /Base de la date de publicationdocument officiel associant ce rapport à sa date — https:\/\/www\.cftc\.gov\/x/],
]) {
  const withBasis = { ...catalog, positioning: catalog.positioning.map((x) => (x.id === 'cot:gold.csv'
    ? { ...x, publicationBasis: { kind, reference: 'https://www.cftc.gov/x' } } : x)) };
  ({ dom, d } = await render('#chaine/donnees/log:evidence:fred-log/cot:gold.csv', withBasis));
  await settle();
  const text = d.getElementById('v2-data-card-positioning').textContent;
  assert.match(text, expected, text);
  if (kind === 'OFFICIAL_SCHEDULE_INFERRED') assert.doesNotMatch(text, /document officiel associant/);
  dom.window.close();
}
// Nothing to choose (input only): no panel.
({ dom, d } = await render('#chaine', { ...catalog, market: [catalog.market[0]], positioning: [catalog.positioning[0]], events: [catalog.events[0]], notes: [] }));
assert.equal(d.getElementById('v2-data-wrap').hidden, true);
dom.window.close();
// An empty data root: nothing to choose, but the panel says where the data goes (no useless selector).
{
  const empty = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-data-empty-'));
  const emptyView = await buildLocalView({ dataRoot: empty });
  const emptyCatalog = emptyView.catalog();
  assert.deepEqual(emptyCatalog.notes, ['EVIDENCE_DIR_ABSENT', 'POSITIONING_DIR_ABSENT']);
  ({ dom, d } = await render('#chaine', emptyCatalog));
  assert.equal(d.getElementById('v2-data-wrap').hidden, false);
  assert.equal(d.getElementById('v2-data-market').hidden, true);
  assert.equal(d.getElementById('v2-data-positioning').hidden, true);
  assert.match(d.getElementById('v2-data-hint').textContent, /evidence\/<journal>\/archive\.json.*scripts\/cot_declare\.mjs/);
  dom.window.close();
}
console.log('PASS the page lets the operator choose and inspect each source, keeps the choice in the anchor, and never upgrades it');
