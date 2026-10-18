// P1 — the local terminal shows DATA-2 capture logs directly: --captures DIR
// merges every DIR/<capture>/archive.json in memory with the DATA-3 merge (no
// file written) and replays the result like an --archive, by default after the
// last reception. A failed merge gives no market, never a partial one. The logs
// here are synthetic, written by this test in the providers' formats.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { buildLocalView, parseArgs, readCaptures } from '../scripts/serve_terminal_local.mjs';
import { parseArgs as launcherArgs } from '../scripts/terminal_launch.mjs';

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
    assert.equal(r.outcome, 'APPENDED', `${id}: ${r.rejection}`);
    a = r.archive;
  }
  return a;
};
const ROOT = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-captures-test-'));
const dirOf = (name, logs) => {
  const dir = path.join(ROOT, name);
  for (const [sub, log] of Object.entries(logs)) {
    mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, sub, 'archive.json'), typeof log === 'string' ? log : JSON.stringify(log));
  }
  mkdirSync(path.join(dir, 'not-a-capture'), { recursive: true }); // no archive.json: ignored
  return dir;
};
const fredLog = await logOf('log-fred', [{ provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10',
  body: fredBody('2026-10-01', [['2026-09-29', '4.12'], ['2026-09-30', '4.10']]), ingestedAt: '2026-10-01T06:00:00Z' }]);
const tdLog = await logOf('log-td', [{ provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD',
  body: tdBody(3900, '2026-10-01T14:14:00Z'), ingestedAt: '2026-10-01T14:14:03Z' }]);
const good = dirOf('good', { a: fredLog, b: tdLog });

const merged = await readCaptures(good);
assert.equal(merged.sources, 2);
assert.deepEqual(merged.problems, []);
assert.equal(merged.archive.archiveId, 'local-captures');
assert.equal(merged.archive.coverage, null);
const view = await buildLocalView({ capturesDir: good });
const v = await view();
assert.equal(v.origin.kind, 'LOCAL_MARKET_ARCHIVE');
assert.match(v.origin.label, /captures good \(2 journal\(aux\) fusionné\(s\)\)/);
assert.equal(v.chain.knowledgeCutoff, '2026-10-01T14:14:03.000Z', 'default: after the last reception');
assert.equal(v.chain.chainState, 'HOLD');
assert.equal(v.chain.execution, 'FORBIDDEN');
assert.equal(v.marketEvidence.archiveId, 'local-captures');
assert.equal(v.marketEvidence.reproducible, false);
assert.ok(v.marketEvidence.reasonCodes.includes('COVERAGE_NOT_DECLARED'));
assert.equal(v.market.fields.find((f) => f.field === 'spot').value, 3900);
assert.equal(v.inputProvenance[0].source, 'SYNTHETIC_FIXTURE', 'synthetic logs stay synthetic after the merge');
const list = view.archiveCutoffs();
assert.deepEqual(list.cutoffs, ['2026-10-01T06:00:00.000Z', '2026-10-01T14:14:03.000Z']);
assert.equal(list.defaultCutoff, '2026-10-01T14:14:03.000Z');
const early = await view(null, { cutoff: '2026-10-01T06:00:00.000Z' });
assert.equal(early.market.fields.find((f) => f.field === 'spot').value, null, 'the spot was received later');
assert.equal(early.chain.chainState, 'HOLD');
// An explicit --cutoff still wins.
assert.equal((await (await buildLocalView({ capturesDir: good, cutoff: '2026-10-01T07:00:00.000Z' }))()).chain.knowledgeCutoff, '2026-10-01T07:00:00.000Z');
assert.equal(readdirSync(good).sort().join(), 'a,b,not-a-capture', 'nothing written next to the captures');
console.log('PASS --captures merges the logs in memory, replays after the last reception, lists their instants; HOLD');

// Failures: no market at all, the reason said, still HOLD.
const edited = structuredClone(fredLog);
edited.records[0].value = 9.99; // no longer what its kept bytes say
for (const [name, dir, problem] of [
  ['empty', dirOf('empty', {}), /NO_CAPTURE_ARCHIVE/],
  ['missing', path.join(ROOT, 'nope'), /CAPTURES_DIR_UNREADABLE/],
  ['unreadable', dirOf('bad-json', { a: '{not json' }), /SOURCE_UNREADABLE:a/],
  ['edited value', dirOf('edited', { a: edited, b: tdLog }), /SOURCE_INVALID:log-fred/],
]) {
  const failed = await buildLocalView({ capturesDir: dir });
  assert.match(failed.captures.problems.join(), problem, name);
  assert.equal(failed.captures.merged, false, name);
  const fv = await failed();
  assert.equal(fv.chain.chainState, 'HOLD', name);
  assert.equal(fv.chain.execution, 'FORBIDDEN', name);
  assert.ok(fv.market === null || fv.market.fields.every((f) => f.value === null) || fv.marketEvidence?.status === 'INVALID', name);
  assert.equal(fv.inputProvenance[0].source === 'CAPTURED_ARCHIVE', false, name);
}
console.log('PASS a failed merge (empty, missing, unreadable, edited value) gives no market and says why; HOLD');

// Arguments: --captures excludes --archive; the launcher passes it on.
assert.equal(parseArgs(['--captures', good]).capturesDir, good);
assert.equal(parseArgs(['--captures', good, '--archive', 'x.json']), null);
assert.deepEqual(launcherArgs(['--captures', good]).server, ['--captures', good]);
// --captures-local: the capture tooling's own directory; the Windows wrapper calls the main launcher with it.
const { LOCAL_CAPTURES } = await import('../scripts/terminal_launch.mjs');
assert.equal(LOCAL_CAPTURES, path.join(homedir(), '.local', 'share', 'xau-v2', 'evidence'));
assert.deepEqual(launcherArgs(['--captures-local']).server, ['--captures', LOCAL_CAPTURES]);
const wrapper = readFileSync(new URL('../scripts/terminal/xau-terminal-captures.cmd', import.meta.url));
assert.ok(wrapper.every((b) => b < 0x80), 'ASCII only');
const lines = wrapper.toString('latin1').split('\r\n');
assert.equal(lines.at(-1), '', 'CRLF line ends');
assert.ok(lines.slice(0, -1).every((l) => !l.includes('\n')), 'no bare LF');
assert.ok(lines.includes('call "%~dp0xau-terminal.cmd" --captures-local %*'), 'calls the sibling launcher, no copy of its logic');
assert.doesNotMatch(wrapper.toString('latin1'), /reg |setx|netsh|powershell|v\d+\.\d+\.\d+/i, 'no system change, no pinned version');
console.log('PASS --captures and --archive are exclusive; the launcher passes --captures through');
