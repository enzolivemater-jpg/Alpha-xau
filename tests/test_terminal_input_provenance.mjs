// B4: in --archive mode the terminal must not attribute to the market archive
// the inputs that come from a synthetic fixture. Every chain input carries its
// own provenance: market, positioning, Event Impact, Gold Transmission,
// evidence graph and authorizations.
//   - backend: TerminalView.inputProvenance, built by buildTerminalView;
//   - frontend: the PROVENANCE DES ENTRÉES panel, and a refusal of any view
//     whose per-input provenance contradicts itself or the market manifest.
// The "captured" archive below is the synthetic fixture relabelled CAPTURED in
// a temporary file: a logic test of the label, not recorded market data.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { buildLocalView, GOLDEN_FIXTURE, SYNTHETIC_ARCHIVE, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const tv = await loadBackendModule('decision_chain/terminal_view.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const golden = JSON.parse(readFileSync(GOLDEN_FIXTURE, 'utf8'));
const NOW = () => new Date('2026-10-18T00:00:00.000Z');
const INPUTS = ['MARKET', 'POSITIONING', 'EVENT_IMPACT', 'GOLD_TRANSMISSION', 'EVIDENCE_GRAPH', 'AUTHORIZATIONS'];
const NON_MARKET = INPUTS.slice(1);
const sources = (view) => Object.fromEntries(view.inputProvenance.map((entry) => [entry.input, entry.source]));
const assertShape = (view, label) => {
  assert.ok(Array.isArray(view.inputProvenance), `${label}: per-input provenance present`);
  assert.deepEqual(view.inputProvenance.map((entry) => entry.input), INPUTS, `${label}: the six inputs, in order`);
  for (const entry of view.inputProvenance) {
    assert.ok(['CAPTURED_ARCHIVE', 'SYNTHETIC_FIXTURE', 'LOCAL_INPUT_UNVERIFIED', 'UNAVAILABLE', 'UNKNOWN'].includes(entry.source), `${label}: ${entry.source}`);
    assert.equal(typeof entry.detail, 'string', label);
    assert.doesNotMatch(entry.detail, /\b(observée?s?|officiellement|validée?s?|certifiée?s?|live|en direct)\b/i, `${label}: ${entry.detail}`);
  }
  for (const input of NON_MARKET) assert.notEqual(sources(view)[input], 'CAPTURED_ARCHIVE', `${label}: ${input} never from an archive`);
  assert.equal(view.chain.chainState, 'HOLD', label);
  assert.equal(view.chain.execution, 'FORBIDDEN', label);
};

const scratch = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'terminal-provenance-'));
try {
  const capturedArchive = path.join(scratch, 'captured.json');
  const relabelled = JSON.parse(readFileSync(SYNTHETIC_ARCHIVE, 'utf8'));
  relabelled.provenanceClass = 'CAPTURED';
  writeFileSync(capturedArchive, JSON.stringify(relabelled));
  const localInput = path.join(scratch, 'local-input.json');
  writeFileSync(localInput, JSON.stringify({ knowledgeCutoff: golden.knowledgeCutoff, input: golden.input }));
  const at = async (options, scenario = null) => (await buildLocalView({ now: NOW, ...options }))(scenario);

  // --- The defect: a captured market archive, every other input from the synthetic golden fixture.
  let view = await at({ archiveFile: capturedArchive });
  assert.equal(view.origin.kind, 'LOCAL_MARKET_ARCHIVE');
  assert.equal(view.marketEvidence.provenanceClass, 'CAPTURED');
  assertShape(view, 'captured archive + golden');
  assert.deepEqual(sources(view), {
    MARKET: 'CAPTURED_ARCHIVE', POSITIONING: 'SYNTHETIC_FIXTURE', EVENT_IMPACT: 'SYNTHETIC_FIXTURE',
    GOLD_TRANSMISSION: 'SYNTHETIC_FIXTURE', EVIDENCE_GRAPH: 'UNAVAILABLE', AUTHORIZATIONS: 'SYNTHETIC_FIXTURE',
  });
  const capturedView = view;
  // A synthetic archive is synthetic market data, never an archive capture.
  view = await at({ archiveFile: SYNTHETIC_ARCHIVE });
  assertShape(view, 'synthetic archive');
  assert.equal(sources(view).MARKET, 'SYNTHETIC_FIXTURE');
  // --input in archive mode: the other inputs are a local, unverified file.
  view = await at({ archiveFile: capturedArchive, inputFile: localInput });
  assertShape(view, 'captured archive + local input');
  assert.equal(sources(view).MARKET, 'CAPTURED_ARCHIVE');
  for (const input of ['POSITIONING', 'EVENT_IMPACT', 'GOLD_TRANSMISSION', 'AUTHORIZATIONS']) {
    assert.equal(sources(view)[input], 'LOCAL_INPUT_UNVERIFIED', input);
  }
  console.log('PASS --archive: only the market comes from the archive; every other input names its own source');

  // --- Without an archive: the golden fixture, a local file, a scenario.
  view = await at({});
  assertShape(view, 'golden');
  assert.deepEqual(new Set(Object.values(sources(view))), new Set(['SYNTHETIC_FIXTURE', 'UNAVAILABLE']));
  assert.equal(sources(view).MARKET, 'SYNTHETIC_FIXTURE');
  view = await at({ inputFile: localInput });
  assertShape(view, 'local input');
  assert.equal(sources(view).MARKET, 'LOCAL_INPUT_UNVERIFIED');
  view = await at({}, 'archive-synthetic');
  assertShape(view, 'archive scenario');
  assert.equal(sources(view).MARKET, 'SYNTHETIC_FIXTURE');
  console.log('PASS without an archive every input follows the input document: fixture, local file or scenario');

  // --- Missing inputs: a broken archive, an unreadable document, an empty positioning set.
  const broken = path.join(scratch, 'broken.json');
  writeFileSync(broken, '{');
  view = await at({ archiveFile: broken });
  assertShape(view, 'broken archive');
  assert.equal(sources(view).MARKET, 'UNAVAILABLE');
  assert.equal(sources(view).POSITIONING, 'SYNTHETIC_FIXTURE');
  view = await at({ inputFile: broken });
  assertShape(view, 'unreadable input');
  assert.equal(view.chain.outcome, 'REJECTED');
  assert.ok(Object.values(sources(view)).every((source) => source === 'UNAVAILABLE'), 'nothing evaluated, nothing attributed');
  const noPositioning = { ...structuredClone(golden.input), positioningEvidence: [] };
  view = tv.buildTerminalView(chain.evaluateDecisionChain(noPositioning, golden.knowledgeCutoff), null,
    { kind: 'GOLDEN_FIXTURE', label: 'x' }, NOW().toISOString());
  assertShape(view, 'no positioning');
  assert.equal(sources(view).POSITIONING, 'UNAVAILABLE');
  console.log('PASS missing inputs are UNAVAILABLE, never attributed to a source');

  // --- Contradictory or unknown sources fail closed to UNKNOWN; never to the archive.
  const outcome = chain.evaluateDecisionChain(golden.input, golden.knowledgeCutoff);
  view = tv.buildTerminalView(outcome, null, { kind: 'LOCAL_MARKET_ARCHIVE', label: 'x' }, NOW().toISOString());
  assertShape(view, 'archive origin without manifest');
  assert.deepEqual(new Set(Object.values(sources(view))), new Set(['UNKNOWN', 'UNAVAILABLE']), 'no replay, no input document: unknown');
  const evidence = await loadBackendModule('market_engine/evidence_archive.ts');
  const providers = await loadBackendModule('market_engine/providers.ts');
  const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
  const replayOf = async (archive) => evidence.replayMarketEvidence(archive, '2026-10-01T14:15:00.000Z', { parsers });
  const capturedReplay = await replayOf(relabelled);
  const shown = (origin, replayed, inputOrigin) => tv.buildTerminalView(outcome, null, origin, NOW().toISOString(), replayed, inputOrigin);
  const ARCHIVE = { kind: 'LOCAL_MARKET_ARCHIVE', label: 'captured.json' };
  const GOLDEN = { kind: 'GOLDEN_FIXTURE', label: 'golden' };
  assert.equal(sources(shown(ARCHIVE, capturedReplay, GOLDEN)).MARKET, 'CAPTURED_ARCHIVE');
  for (const [label, origin, replayed, inputOrigin, expected] of [
    ['manifest on a non-archive origin', GOLDEN, capturedReplay, GOLDEN, { MARKET: 'UNKNOWN' }],
    ['captured class with a simulation nature', ARCHIVE, { ...capturedReplay, nature: 'SIMULATION' }, GOLDEN, { MARKET: 'UNKNOWN' }],
    ['synthetic class with a historical nature', ARCHIVE, { ...capturedReplay, archive: { ...capturedReplay.archive, provenanceClass: 'SYNTHETIC_FIXTURE' } }, GOLDEN, { MARKET: 'UNKNOWN' }],
    ['unknown class', ARCHIVE, { ...capturedReplay, archive: { ...capturedReplay.archive, provenanceClass: 'TRUSTED' } }, GOLDEN, { MARKET: 'UNKNOWN' }],
    ['archive given as the input document', ARCHIVE, capturedReplay, ARCHIVE, { POSITIONING: 'UNKNOWN', AUTHORIZATIONS: 'UNKNOWN' }],
    ['malformed input document origin', ARCHIVE, capturedReplay, { kind: 'GOLDEN_FIXTURE' }, { POSITIONING: 'UNKNOWN' }],
    ['no input document origin', ARCHIVE, capturedReplay, undefined, { POSITIONING: 'UNKNOWN', EVENT_IMPACT: 'UNKNOWN' }],
  ]) {
    const v = shown(origin, replayed, inputOrigin);
    assertShape(v, label);
    for (const [input, source] of Object.entries(expected)) assert.equal(sources(v)[input], source, `${label}: ${input}`);
  }
  console.log('PASS contradictory or missing source claims fail closed to UNKNOWN, never to the archive');

  // --- Terminal rendering (jsdom): the panel, the header, and refusal of contradictions.
  const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
  const render = async (body) => {
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
    dom.window.fetch = (url) => (String(url) === VIEW_PATH
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) })
      : Promise.reject(new Error(`unexpected fetch ${url}`)));
    dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
    const script = dom.window.document.createElement('script');
    script.textContent = js;
    dom.window.document.body.appendChild(script);
    await settle();
    return dom;
  };
  let dom = await render(capturedView);
  let d = dom.window.document;
  const items = [...d.querySelectorAll('#v2-prov-list li')];
  assert.deepEqual(items.map((li) => li.getAttribute('data-input')), INPUTS);
  assert.deepEqual(Object.fromEntries(items.map((li) => [li.getAttribute('data-input'), li.getAttribute('data-source')])), sources(capturedView));
  const label = (input) => d.querySelector(`#v2-prov-list li[data-input="${input}"] .prov__source`).textContent;
  assert.equal(label('MARKET'), 'ARCHIVE CAPTURÉE — NON CERTIFIÉE');
  assert.equal(label('POSITIONING'), 'FIXTURE SYNTHÉTIQUE');
  assert.equal(label('EVIDENCE_GRAPH'), 'NON DISPONIBLE');
  assert.match(d.getElementById('v2-nav-nature').textContent, /AUTRES ENTRÉES : FIXTURE SYNTHÉTIQUE/);
  assert.doesNotMatch(d.getElementById('v2-prov').textContent, /OBSERVÉ|VALIDÉ|OFFICIEL|\bLIVE\b|EN DIRECT/i);
  assert.equal(d.getElementById('v2-status').getAttribute('data-state') ?? 'hold', 'hold');
  dom.window.close();
  // A view without per-input provenance (an older v4 producer) still renders, and says so.
  const older = structuredClone(capturedView);
  delete older.inputProvenance;
  dom = await render(older);
  d = dom.window.document;
  assert.equal(d.querySelectorAll('#v2-prov-list li').length, 0);
  assert.match(d.getElementById('v2-prov-status').textContent, /PROVENANCE PAR ENTRÉE NON FOURNIE/);
  assert.match(d.getElementById('v2-nav-nature').textContent, /PROVENANCE DES AUTRES ENTRÉES NON FOURNIE/);
  dom.window.close();
  // Contradictory provenance refuses the whole view.
  const entry = (v, input) => v.inputProvenance.find((x) => x.input === input);
  for (const [name, mutate] of [
    ['positioning claimed from the archive', (v) => { entry(v, 'POSITIONING').source = 'CAPTURED_ARCHIVE'; }],
    ['authorizations claimed from the archive', (v) => { entry(v, 'AUTHORIZATIONS').source = 'CAPTURED_ARCHIVE'; }],
    ['captured market over a synthetic manifest', (v) => { v.marketEvidence.provenanceClass = 'SYNTHETIC_FIXTURE'; v.marketEvidence.nature = 'SIMULATION'; }],
    ['captured market without a manifest', (v) => { v.marketEvidence = null; }],
    ['synthetic market over a captured manifest', (v) => { entry(v, 'MARKET').source = 'SYNTHETIC_FIXTURE'; }],
    ['unknown source', (v) => { entry(v, 'EVENT_IMPACT').source = 'OBSERVED'; }],
    ['missing input', (v) => { v.inputProvenance.pop(); }],
    ['inputs reordered', (v) => { v.inputProvenance.reverse(); }],
    ['not a list', (v) => { v.inputProvenance = {}; }],
  ]) {
    const body = structuredClone(capturedView);
    mutate(body);
    dom = await render(body);
    d = dom.window.document;
    assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'rejected', name);
    assert.match(d.getElementById('v2-status').textContent, /VUE V2 REFUSÉE/, name);
    assert.equal(d.querySelectorAll('#v2-prov-list li').length, 0, `${name}: nothing half-drawn`);
    dom.window.close();
  }
  console.log('PASS the terminal shows each input\'s source, says when it is not given, and refuses contradictions');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
