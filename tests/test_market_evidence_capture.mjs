// DATA-2 capture of raw provider responses into a DATA-1 evidence archive
// (backend/market_engine/evidence_capture.ts).
//   - the exact body is kept and digested; every observation it holds names it;
//   - nothing is inferred: publication time stays unknown, ingestion is explicit;
//   - append-only: a repeated body is a no-op, a changed value is a revision,
//     capture times never go backwards, an invalid result is refused;
//   - replays of captured archives never see a later capture.
// Every provider body below is written by this test in the provider's format:
// none is a recorded response, and the archives are labelled accordingly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const cap = await loadBackendModule('market_engine/evidence_capture.ts');
const ev = await loadBackendModule('market_engine/evidence_archive.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
const { sha256Text } = await loadBackendModule('shared/canonical_json.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));

const PARSERS = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
const ALL_FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];
const fredBody = (vintage, rows) => JSON.stringify({
  realtime_start: vintage, realtime_end: vintage, observation_start: rows[0][0], units: 'lin', file_type: 'json',
  observations: rows.map(([date, value]) => ({ realtime_start: vintage, realtime_end: vintage, date, value })),
});
const tdBody = (close, at) => JSON.stringify({ symbol: 'XAU/USD', close: String(close), last_quote_at: Date.parse(at) / 1000, is_market_open: true });
const fresh = (cls = 'SYNTHETIC_FIXTURE') => cap.createEvidenceArchive({
  archiveId: 'test-capture-log', provenanceClass: cls, createdAt: '2026-09-29T00:00:00Z', fields: ALL_FIELDS,
  statement: 'Journal de capture de test : toute réponse capturée est dans ce fichier.',
});
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const fred = (sourceRecordId, symbol, body, ingestedAt) => ({ provider: 'fred', symbol, sourceRecordId, body, ingestedAt });

// --- 1. Provider formats: the series map equals the runtime, the FRED reader agrees with parseFred.
assert.deepEqual(cap.CAPTURE_SERIES.filter((s) => s.provider === 'fred').map(({ symbol, sourceRecordId }) => ({ symbol, seriesId: sourceRecordId })),
  providers.FRED_SERIES.map(({ symbol, seriesId }) => ({ symbol, seriesId })));
for (const s of cap.CAPTURE_SERIES) assert.equal(ev.MARKET_EVIDENCE_FIELD_SPEC[s.field].freshnessSymbol, s.symbol, s.field);
const body1 = fredBody('2026-10-01', [['2026-09-24', '4.05'], ['2026-09-25', '4.07'], ['2026-09-26', '.'], ['2026-09-29', '4.12'], ['2026-09-30', '4.10']]);
const all = providers.parseFredObservations(body1, 'US10Y');
assert.deepEqual(all.map((p) => [p.observedAt, p.value]), [
  ['2026-09-24T00:00:00.000Z', 4.05], ['2026-09-25T00:00:00.000Z', 4.07], ['2026-09-29T00:00:00.000Z', 4.12], ['2026-09-30T00:00:00.000Z', 4.1]]);
assert.deepEqual(all.at(-1), providers.parseFred(body1, 'US10Y'), 'the runtime parser reads the same last observation');
for (const bad of ['', 'null', '[]', '{"observations":null}', '{"observations":[{"date":"2026-02-30","value":"4"}]}', '<html>']) {
  assert.deepEqual(providers.parseFredObservations(bad, 'US10Y'), [], bad);
}
console.log('PASS provider formats: FRED series equal the runtime map; all observations read with parseFred rules');

// --- 2. A FRED response becomes records that name its kept bytes.
const archive0 = deepFreeze(fresh());
const r1 = await cap.appendProviderCapture(archive0, fred('DGS10', 'US10Y', body1, '2026-10-01T06:00:00Z'), PARSERS);
assert.equal(r1.outcome, 'APPENDED', r1.rejection);
const digest1 = await sha256Text(body1);
assert.equal(r1.rawPayloadDigest, digest1);
assert.equal(r1.archive.rawPayloads[digest1].body, body1, 'body kept byte for byte');
assert.deepEqual(r1.archive.rawPayloads[digest1], { parser: 'fred', symbol: 'US10Y', body: body1 });
assert.equal(r1.added.length, 4);
assert.deepEqual(r1.skipped, [], 'FRED "." holidays are gaps, not observations');
assert.equal(r1.archive.records.length, 4);
const rec = r1.archive.records.at(-1);
const revision1 = `cap-${digest1.slice(7, 23)}`;
assert.deepEqual(rec, {
  evidenceId: `fred:DGS10:2026-09-30T00:00:00.000Z:${revision1}`, field: 'us10y', instrument: 'US10Y', unit: 'PERCENT',
  observationType: 'DAILY_VALUE', value: 4.1, source: 'fred', sourceRecordId: 'DGS10', observedAt: '2026-09-30T00:00:00.000Z',
  publishedAt: null, ingestedAt: '2026-10-01T06:00:00.000Z', revision: revision1, supersedes: null, rawPayloadDigest: digest1,
});
assert.equal(r1.archive.coverage.to, '2026-10-01T06:00:00.000Z');
assert.equal(archive0.records.length, 0, 'the input archive is not modified');
console.log('PASS a FRED response becomes evidence records naming its kept, digested bytes; unknowns stay null');

// --- 3. Idempotence, revisions and order.
const again = await cap.appendProviderCapture(r1.archive, fred('DGS10', 'US10Y', body1, '2026-10-01T07:00:00Z'), PARSERS);
assert.equal(again.outcome, 'ALREADY_CAPTURED');
assert.equal(again.archive, r1.archive, 'same bytes: nothing appended');
const body2 = fredBody('2026-10-02', [['2026-09-29', '4.12'], ['2026-09-30', '4.11'], ['2026-10-01', '4.15']]);
const r2 = await cap.appendProviderCapture(r1.archive, fred('DGS10', 'US10Y', body2, '2026-10-02T06:00:00Z'), PARSERS);
assert.equal(r2.outcome, 'APPENDED', r2.rejection);
assert.equal(r2.unchanged, 1, '09-29 unchanged: not recorded again');
assert.equal(r2.revised.length, 1);
assert.equal(r2.added.length, 1);
const correction = r2.archive.records.find((r) => r.evidenceId === r2.revised[0]);
assert.equal(correction.value, 4.11);
assert.equal(correction.supersedes, rec.evidenceId, 'the provider revision supersedes the earlier value');
assert.deepEqual(r2.archive.records.slice(0, 4), r1.archive.records, 'earlier records unchanged');
const late = await cap.appendProviderCapture(r2.archive, fred('DGS10', 'US10Y', fredBody('2026-10-01', [['2026-09-23', '4.00']]), '2026-10-01T23:00:00Z'), PARSERS);
assert.equal(late.outcome, 'REJECTED');
assert.equal(late.rejection, 'INGESTION_OUT_OF_ORDER');
assert.equal(late.archive, r2.archive);
const third = fredBody('2026-10-03', [['2026-09-30', '4.13']]);
const r3 = await cap.appendProviderCapture(r2.archive, fred('DGS10', 'US10Y', third, '2026-10-03T06:00:00Z'), PARSERS);
assert.equal(r3.archive.records.at(-1).supersedes, correction.evidenceId, 'a second revision supersedes the first one');
console.log('PASS append-only: repeated bytes are a no-op, a changed value is a linked revision, time never goes back');

// --- 4. Rejections leave the archive unchanged.
for (const [name, capture, rejection] of [
  ['series named for another symbol', fred('DGS10', 'VIX', body1, '2026-10-04T00:00:00Z'), 'UNKNOWN_SERIES'],
  ['unknown provider series', fred('DEXUSEU', 'US10Y', body1, '2026-10-04T00:00:00Z'), 'UNKNOWN_SERIES'],
  ['bad ingestion time', fred('DGS10', 'US10Y', body1, 'tomorrow'), 'INVALID_INGESTED_AT'],
  ['empty FRED window', fred('DGS10', 'US10Y', fredBody('2026-10-04', [['2026-10-03', '.']]), '2026-10-04T00:00:00Z'), 'NO_USABLE_OBSERVATION'],
  ['quota error', { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', body: '{"status":"error","code":429}', ingestedAt: '2026-10-04T00:00:00Z' }, 'NO_USABLE_OBSERVATION'],
  ['quote stamped after reception', { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD',
    body: tdBody(3900, '2026-10-04T00:05:00Z'), ingestedAt: '2026-10-04T00:00:00Z' }, 'NO_USABLE_OBSERVATION'],
  ['implausible quote', { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD',
    body: tdBody(50, '2026-10-03T23:59:00Z'), ingestedAt: '2026-10-04T00:00:00Z' }, 'ARCHIVE_WOULD_BE_INVALID'],
  ['yield in basis points', fred('DGS10', 'US10Y', fredBody('2026-10-04', [['2026-10-03', '413']]), '2026-10-04T00:00:00Z'), 'ARCHIVE_WOULD_BE_INVALID'],
]) {
  const r = await cap.appendProviderCapture(r3.archive, capture, PARSERS);
  assert.equal(r.outcome, 'REJECTED', name);
  assert.equal(r.rejection, rejection, name);
  assert.equal(r.archive, r3.archive, `${name}: archive unchanged`);
}
const broken = structuredClone(r3.archive);
broken.records[0].unit = 'INDEX_POINTS';
assert.equal((await cap.appendProviderCapture(broken, fred('DGS10', 'US10Y', fredBody('2026-10-04', [['2026-10-03', '4.2']]), '2026-10-04T00:00:00Z'), PARSERS)).rejection,
  'ARCHIVE_INVALID', 'nothing is appended to an archive that is already invalid');
console.log('PASS rejections: wrong series, bad time, empty or error body, future stamp, implausible value, invalid archive');

// --- 5. Replays of the capture log: as-of, verified bytes, no look-ahead.
const asOf = (a, cutoff) => ev.replayMarketEvidence(a, cutoff, { parsers: PARSERS });
const beforeRevision = await asOf(r3.archive, '2026-10-01T12:00:00Z');
assert.equal(beforeRevision.observations.us10y.value, 4.1, 'before the revision was received');
assert.equal(beforeRevision.observations.us10y.raw, 'RAW_VERIFIED', 'an older observation of a multi-observation body is re-read');
assert.deepEqual(beforeRevision.audit.correctedAfterCutoff, ['us10y']);
const afterRevision = await asOf(r3.archive, '2026-10-02T12:00:00Z');
assert.equal(afterRevision.observations.us10y.value, 4.15, 'the newest observation once known');
assert.equal((await asOf(r3.archive, '2026-10-03T06:00:00Z')).status, 'VERIFIED');
const sliced = await asOf(r1.archive, '2026-10-01T12:00:00Z');
assert.deepEqual(beforeRevision.observations, sliced.observations, 'later captures change nothing before they were received');
// Same values; only the reason differs (the shorter log's coverage ends before this cutoff).
assert.deepEqual({ ...beforeRevision.marketSnapshot, reason: null }, { ...sliced.marketSnapshot, reason: null });
assert.equal(sliced.status, 'INCOMPLETE');
assert.equal((await asOf(r3.archive, '2026-10-03T06:00:00.001Z')).status, 'INCOMPLETE', 'nothing is claimed after the last capture');
assert.equal(beforeRevision.nature, 'SIMULATION', 'test-written bodies in a synthetic log');
// The old single-observation reader cannot re-read older observations: rejected, not trusted.
assert.equal((await ev.replayMarketEvidence(r3.archive, '2026-10-01T12:00:00Z', { parsers: { fred: providers.parseFred } })).status, 'INVALID');
console.log('PASS capture-log replays: the value known at the cutoff, bytes re-read, nothing later, nothing beyond coverage');

// --- 6. A full log of every captured series, then CHAIN-0.
let log = fresh();
const step = async (capture) => {
  const r = await cap.appendProviderCapture(log, capture, PARSERS);
  assert.equal(r.outcome, 'APPENDED', `${capture.sourceRecordId}: ${r.rejection} ${r.replayReasons}`);
  log = r.archive;
};
await step(fred('DGS10', 'US10Y', fredBody('2026-10-01', [['2026-09-30', '4.10']]), '2026-10-01T06:00:00Z'));
await step(fred('DFII10', 'US10YR', fredBody('2026-10-01', [['2026-09-30', '1.70']]), '2026-10-01T06:00:01Z'));
await step(fred('VIXCLS', 'VIX', fredBody('2026-10-01', [['2026-09-30', '17.20']]), '2026-10-01T06:00:02Z'));
await step(fred('DCOILWTICO', 'WTI', fredBody('2026-10-01', [['2026-09-30', '66.40']]), '2026-10-01T06:00:03Z'));
await step({ provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', body: tdBody(3900, '2026-10-01T14:14:00Z'), ingestedAt: '2026-10-01T14:14:03Z' });
// Same quote time, another price: the provider corrected its quote.
await step({ provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', body: tdBody(3900.6, '2026-10-01T14:14:00Z'), ingestedAt: '2026-10-01T14:15:00Z' });
const replay = await asOf(log, '2026-10-01T14:15:00Z');
assert.equal(replay.status, 'VERIFIED');
assert.equal(replay.observations.spot.value, 3900.6);
assert.equal(replay.observations.spot.supersedes, `twelve_data:XAU/USD:2026-10-01T14:14:00.000Z:cap-${(await sha256Text(tdBody(3900, '2026-10-01T14:14:00Z'))).slice(7, 23)}`);
assert.equal(replay.observations.bid, null, 'Twelve Data quotes carry no book: no bid is invented');
assert.ok(Object.values(replay.observations).filter(Boolean).every((o) => o.raw === 'RAW_VERIFIED' && o.unknown.includes('publishedAt')));
const outcome = bridge.evaluateDecisionChainOnMarketEvidence(golden.input, replay);
assert.equal(outcome.result.chainState, 'HOLD');
assert.equal(outcome.result.execution, 'FORBIDDEN');
assert.equal(outcome.result.stages.marketPricing.fields.spot.value, 3900.6);
assert.equal(outcome.result.stages.marketPricing.fields.bid.status, 'UNAVAILABLE');
assert.equal(outcome.result.trace.find((t) => t.stage === 'ACTION').state, 'ABSTAIN');
console.log('PASS a full capture log replays VERIFIED and feeds CHAIN-0, which holds; no book is invented');

// --- 7. What a CAPTURED log would be called: logic only, with test-written bodies.
let captured = fresh('CAPTURED');
for (const c of [fred('DGS10', 'US10Y', fredBody('2026-10-01', [['2026-09-30', '4.10']]), '2026-10-01T06:00:00Z'),
  { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', body: tdBody(3900, '2026-10-01T14:14:00Z'), ingestedAt: '2026-10-01T14:14:03Z' }]) {
  captured = (await cap.appendProviderCapture(captured, c, PARSERS)).archive;
}
assert.equal((await asOf(captured, '2026-10-01T14:14:03Z')).nature, 'HISTORICAL_VERIFIED', 'at the last capture');
assert.equal((await asOf(captured, '2026-10-01T14:15:00Z')).nature, 'HISTORICAL_UNVERIFIED', 'after the last capture: incomplete');
assert.equal((await ev.replayMarketEvidence(captured, '2026-10-01T14:14:03Z')).nature, 'HISTORICAL_UNVERIFIED', 'without re-reading');
console.log('PASS a CAPTURED log is HISTORICAL_VERIFIED only when its bytes are re-read (logic test; no recorded data here)');

// --- 8. Purity.
const closure = listBackendImportClosure('market_engine/evidence_capture.ts');
assert.ok(!closure.includes('market_engine/providers.ts'), 'parsers are injected, not imported');
for (const file of closure) {
  assert.doesNotMatch(readFileSync(new URL(`../backend/${file}`, import.meta.url), 'utf8'), /\bfetch\(|process\.env|Math\.random\(|Date\.now\(/, file);
}
assert.doesNotMatch(readFileSync(new URL('../backend/market_engine/evidence_capture.ts', import.meta.url), 'utf8'), /new Date\(\)/);
console.log('PASS capture reads no network, clock, environment or provider');

// --- 9. Local CLI: init, append files already on disk, replay; no network, explicit times.
{
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync: write, readFileSync: read, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const cli = new URL('../scripts/market_evidence_capture.mjs', import.meta.url).pathname;
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'evidence-cli-'));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
  try {
    const log = path.join(dir, 'log.json');
    assert.equal(run('init', '--archive', log, '--id', 'cli-test', '--created-at', '2026-09-29T00:00:00Z',
      '--statement', 'test', '--class', 'CAPTURED').status, 1, 'CAPTURED needs an explicit attestation');
    assert.equal(existsSync(log), false);
    assert.equal(run('init', '--archive', log, '--id', 'cli-test', '--created-at', '2026-09-29T00:00:00Z', '--statement', 'test').status, 0);
    assert.equal(JSON.parse(read(log, 'utf8')).provenanceClass, 'SYNTHETIC_FIXTURE', 'synthetic unless attested');
    assert.equal(run('init', '--archive', log, '--id', 'x', '--created-at', '2026-09-29T00:00:00Z', '--statement', 't').status, 1,
      'never overwritten');
    write(path.join(dir, 'dgs10.json'), fredBody('2026-10-01', [['2026-09-30', '4.10']]));
    write(path.join(dir, 'quote.json'), tdBody(3900, '2026-10-01T14:14:00Z'));
    let r = run('append', '--archive', log, '--provider', 'fred', '--symbol', 'US10Y', '--series', 'DGS10',
      '--body', path.join(dir, 'dgs10.json'), '--ingested-at', '2026-10-01T06:00:00Z');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).outcome, 'APPENDED');
    const before = read(log, 'utf8');
    r = run('append', '--archive', log, '--provider', 'twelve_data', '--symbol', 'XAUUSD', '--series', 'XAU/USD',
      '--body', path.join(dir, 'quote.json'), '--ingested-at', '2026-10-01T05:00:00Z');
    assert.equal(r.status, 1, 'out of order');
    assert.equal(read(log, 'utf8'), before, 'a rejected append leaves the file byte for byte');
    r = run('append', '--archive', log, '--provider', 'twelve_data', '--symbol', 'XAUUSD', '--series', 'XAU/USD',
      '--body', path.join(dir, 'quote.json'), '--ingested-at', '2026-10-01T14:14:03Z');
    assert.equal(r.status, 0, r.stderr);
    r = run('replay', '--archive', log, '--cutoff', '2026-10-01T14:14:03Z');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.status, out.nature, out.decision, out.execution], ['VERIFIED', 'SIMULATION', 'HOLD', 'FORBIDDEN']);
    assert.equal(out.marketSnapshot.spot.value, 3900);
    r = run('replay', '--archive', log, '--cutoff', '2026-10-01T14:14:03Z', '--digest', `sha256:${'0'.repeat(64)}`);
    assert.equal(r.status, 1, 'a pinned digest that does not match');
    assert.equal(JSON.parse(r.stdout).status, 'INVALID');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const source = readFileSync(cli, 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|https?:\/\/|Date\.now\(|new Date\(\)|statSync|mtime/, 'no network, no clock, no file time');
}
console.log('PASS capture CLI: explicit attestation for CAPTURED, never overwrites, atomic append, pinned replay');
