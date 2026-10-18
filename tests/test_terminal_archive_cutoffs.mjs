// P1 — replaying an archive at each of its reception instants from the
// terminal. In --archive mode the server lists the distinct `ingestedAt`
// instants of the archive and replays it at a cutoff the page asks for; the
// page offers them in a CUTOFF DE REJEU selector. The cutoff exists only in
// archive mode and never with a scenario; every replay stays HOLD / FORBIDDEN
// and knows only what the archive had received at that instant.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import {
  ARCHIVE_CUTOFFS_PATH, SCENARIOS_PATH, SYNTHETIC_ARCHIVE, VIEW_PATH,
  archiveCutoffs, buildLocalView, createTerminalServer, listenOnLoopback, localIndexHtml,
} from '../scripts/serve_terminal_local.mjs';

const archive = JSON.parse(readFileSync(SYNTHETIC_ARCHIVE, 'utf8'));
const expected = [...new Set(archive.records.map((r) => Date.parse(r.ingestedAt)))].sort((a, b) => a - b)
  .map((ms) => new Date(ms).toISOString());

// --- The list: distinct reception instants in time order, the server's default cutoff.
const list = archiveCutoffs(SYNTHETIC_ARCHIVE, '2026-10-01T14:15:00.000Z');
assert.equal(list.schemaVersion, 'xau.terminal-archive-cutoffs.v1');
assert.deepEqual(list.cutoffs, expected);
assert.equal(list.defaultCutoff, '2026-10-01T14:15:00.000Z');
assert.equal(list.truncated, false);
assert.deepEqual(archiveCutoffs('/nonexistent/archive.json', null).cutoffs, []);
// Availability per field: counts, sources and ranges straight from the records, every field listed.
assert.deepEqual(list.fields.map((f) => f.field), ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti']);
for (const f of list.fields) {
  const recs = archive.records.filter((r) => r.field === f.field);
  assert.equal(f.records, recs.length, f.field);
  assert.deepEqual(f.sources, [...new Set(recs.map((r) => r.source))].sort(), f.field);
  const iso = (ms) => new Date(ms).toISOString();
  const span = (key) => (recs.length ? [iso(Math.min(...recs.map((r) => Date.parse(r[key])))), iso(Math.max(...recs.map((r) => Date.parse(r[key]))))] : [null, null]);
  assert.deepEqual([f.firstObservedAt, f.lastObservedAt], span('observedAt'), f.field);
  assert.deepEqual([f.firstIngestedAt, f.lastIngestedAt], span('ingestedAt'), f.field);
}
assert.ok(list.fields.some((f) => f.records === 0), 'the synthetic archive has a field without records (dxy)');
console.log(`PASS the archive gives ${expected.length} replay cutoffs (its distinct reception instants, in order)`);

// --- Replays: the chain runs at the asked instant and knows only what was received by then.
const view = await buildLocalView({ archiveFile: SYNTHETIC_ARCHIVE });
for (const at of expected) {
  const body = await view(null, { cutoff: at });
  assert.equal(body.chain.chainState, 'HOLD', at);
  assert.equal(body.chain.execution, 'FORBIDDEN', at);
  assert.equal(body.chain.knowledgeCutoff, at, at);
  const later = archive.records.filter((r) => Date.parse(r.ingestedAt) > Date.parse(at)).length;
  assert.equal(body.marketEvidence.recordsIngestedAfterCutoff, later, at);
  for (const o of body.marketEvidence.observations ?? []) assert.ok(Date.parse(o.ingestedAt) <= Date.parse(at), at);
}
// Refused: a cutoff outside archive mode, with a scenario, or not an explicit UTC instant.
const golden = await buildLocalView();
assert.equal(await golden(null, { cutoff: expected[0] }), null);
assert.equal(golden.archiveCutoffs(), null);
assert.equal(await view('archive-correction', { cutoff: expected[0] }), null);
for (const bad of ['2026-10-01', '2026-10-01T14:15:00+02:00', 'now', '2026-10-01T14:15:00.000Z ']) {
  assert.equal(await view(null, { cutoff: bad }), null, bad);
}
console.log('PASS each replay is HOLD / FORBIDDEN at the asked instant and excludes later receptions; misuse is refused');

// --- HTTP: routes, refusals and the Host guard.
const get = (port, pathname, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  }).on('error', reject);
});
const archiveServer = await createTerminalServer({ archiveFile: SYNTHETIC_ARCHIVE });
const { port } = await listenOnLoopback(archiveServer, { port: 4593, range: 5 });
try {
  const cut = await get(port, ARCHIVE_CUTOFFS_PATH);
  assert.equal(cut.status, 200);
  assert.deepEqual(JSON.parse(cut.body).cutoffs, expected);
  const at = expected[2];
  const replay = await get(port, `${VIEW_PATH}?cutoff=${encodeURIComponent(at)}`);
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse(replay.body).chain.knowledgeCutoff, at);
  assert.equal((await get(port, `${VIEW_PATH}?cutoff=yesterday`)).status, 400);
  assert.equal((await get(port, `${VIEW_PATH}?scenario=archive-correction&cutoff=${encodeURIComponent(at)}`)).status, 400);
  assert.equal((await get(port, ARCHIVE_CUTOFFS_PATH, 'evil.example:80')).status, 403);
  assert.match(localIndexHtml(), new RegExp(`V2_ARCHIVE_CUTOFFS_URL: '${ARCHIVE_CUTOFFS_PATH}'`));
} finally {
  archiveServer.close();
}
const plainServer = await createTerminalServer({});
const plain = await listenOnLoopback(plainServer, { port: 4598, range: 5 });
try {
  assert.equal((await get(plain.port, ARCHIVE_CUTOFFS_PATH)).status, 404);
  assert.equal((await get(plain.port, `${VIEW_PATH}?cutoff=${encodeURIComponent(expected[0])}`)).status, 400);
} finally {
  plainServer.close();
}
console.log('PASS HTTP: cutoffs listed and replayed in archive mode only; bad cutoff or scenario + cutoff 400; foreign Host 403');

// --- Page: the selector appears only with a list, asks ?cutoff=, and is disabled under a scenario.
const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const scenarios = [{ id: 'archive-correction', label: 'correction' }];
const render = async (config) => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  const asked = [];
  dom.window.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const json = (b) => ({ ok: true, status: 200, json: async () => structuredClone(b) });
    if (u === ARCHIVE_CUTOFFS_PATH) return json(list);
    if (u === SCENARIOS_PATH) return json(scenarios);
    if (u.startsWith(VIEW_PATH)) {
      const q = new URL(u, 'http://x').searchParams;
      return json(q.get('scenario') ? await view(q.get('scenario')) : await view(null, { cutoff: q.get('cutoff') }));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH, ...config };
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { dom, asked };
};
let { dom, asked } = await render({});
assert.equal(dom.window.document.getElementById('v2-replay-cutoff-wrap').hidden, true, 'no list configured: no selector');
assert.ok(!asked.includes(ARCHIVE_CUTOFFS_PATH));
dom.window.close();
({ dom, asked } = await render({ V2_ARCHIVE_CUTOFFS_URL: ARCHIVE_CUTOFFS_PATH, V2_SCENARIOS_URL: SCENARIOS_PATH }));
const d = dom.window.document;
const select = d.getElementById("v2-replay-cutoff");
assert.equal(d.getElementById('v2-replay-cutoff-wrap').hidden, false);
assert.equal(select.options.length, expected.length + 1);
assert.match(select.options[0].textContent, /Cutoff du serveur \(2026-10-01T14:15:00.000Z\)/);
assert.match(d.getElementById('v2-replay-cutoff-hint').textContent, /HOLD, exécution interdite/);
const avail = d.getElementById('v2-archive-avail');
assert.equal(avail.hidden, false);
const availItems = [...d.querySelectorAll('#v2-archive-avail-list li')];
assert.equal(availItems.length, 8);
assert.match(availItems[0].textContent, /^SPOT · \d+ enr\. · twelve_data · observé 2026-/);
assert.equal(d.querySelector('#v2-archive-avail-list li[data-records="0"]').textContent, 'DXY · aucun enregistrement');
select.value = expected[1];
select.dispatchEvent(new dom.window.Event('change'));
await new Promise((resolve) => setTimeout(resolve, 300));
assert.ok(asked.includes(`${VIEW_PATH}?cutoff=${encodeURIComponent(expected[1])}`));
assert.notEqual(d.getElementById('v2-status').getAttribute('data-state'), 'rejected');
assert.match(d.body.textContent, new RegExp(expected[1].replace(/[.]/g, '\\.')));
const scenario = d.getElementById('v2-scenario');
scenario.value = 'archive-correction';
scenario.dispatchEvent(new dom.window.Event('change'));
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(select.disabled, true, 'a scenario disables the archive cutoff');
assert.ok(asked.at(-1) === `${VIEW_PATH}?scenario=archive-correction`, asked.at(-1));
assert.doesNotMatch(d.getElementById("v2-status").closest("section").textContent, /\b(BUY|SELL|EVIDENCE_READY)\b/);
dom.window.close();
console.log('PASS the page lists the reception instants, replays the chosen one, and disables it under a scenario');
