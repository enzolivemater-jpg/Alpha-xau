// DATA-1 market evidence archive and as-of replay
// (backend/market_engine/evidence_archive.ts) and its CHAIN-0 bridge
// (backend/decision_chain/market_evidence_chain.ts).
//   - every usable observation carries instrument, unit, type, source and its
//     own id, observed / published / ingested times, revision and digests;
//     unknown metadata stays null and is reported;
//   - a replay never uses what was not ingested by the cutoff, is
//     deterministic, and is reproducible only when the archive is valid and
//     declares complete coverage of the cutoff;
//   - unit, instrument, chronology, duplicate, revision, contradiction and
//     raw-payload defects reject the archive; HOLD / FORBIDDEN on every path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const ev = await loadBackendModule('market_engine/evidence_archive.ts');
const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const { sha256Text } = await loadBackendModule('shared/canonical_json.ts');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url), 'utf8'));
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const CUTOFF = '2026-10-01T14:15:00.000Z';
const DAY_AFTER = '2026-10-02T14:00:00.000Z';
const PARSERS = { fred: providers.parseFred, twelve_data: providers.parseTwelveData };
const clone = (v) => structuredClone(v);
const replay = (archive, cutoff = CUTOFF, options) => ev.replayMarketEvidence(archive, cutoff, options);
const withRecords = (mutate) => { const a = clone(fixture); mutate(a.records, a); return a; };
const recordOf = (a, id) => a.records.find((r) => r.evidenceId === id);
const holds = (r, name) => {
  assert.equal(r.decision, 'HOLD', name);
  assert.equal(r.execution, 'FORBIDDEN', name);
  assert.notEqual(r.nature, 'LIVE', name);
};

// --- 1. The synthetic fixture replays VERIFIED, labelled SIMULATION.
const base = await replay(fixture);
holds(base, 'fixture');
assert.equal(base.schemaVersion, 'xau.market-evidence-replay.v1');
assert.equal(base.algorithmVersion, 'market-evidence-replay-1.0.0');
assert.equal(base.status, 'VERIFIED');
assert.equal(base.reproducible, true);
assert.equal(base.nature, 'SIMULATION', 'a synthetic archive is never historical evidence');
assert.equal(base.archive.provenanceClass, 'SYNTHETIC_FIXTURE');
assert.match(base.archive.digest, /^sha256:[0-9a-f]{64}$/);
assert.match(base.digest, /^sha256:[0-9a-f]{64}$/);
assert.deepEqual(base.reasonCodes, ['PROVENANCE_INCOMPLETE']);
assert.equal(base.selection.state, 'DEGRADED');
assert.deepEqual(base.selection.reasonCodes, ['OPTIONAL_FIELD_UNAVAILABLE_AS_OF']);
const spot = base.observations.spot;
assert.deepEqual(spot, {
  field: 'spot', evidenceId: 'td-xau-20261001-1414', instrument: 'XAUUSD', unit: 'USD_PER_TROY_OUNCE',
  observationType: 'LAST', value: 3900, source: 'twelve_data', sourceRecordId: 'XAU/USD',
  observedAt: '2026-10-01T14:14:00.000Z', publishedAt: null, ingestedAt: '2026-10-01T14:14:03.000Z',
  revision: 'td-quote-2', supersedes: null, rawPayloadDigest: null,
  recordDigest: await sha256Text(chain.canonicalJson(recordOf(fixture, 'td-xau-20261001-1414'))),
  ageSecondsAtCutoff: 60, freshnessAtCutoff: 'LIVE', raw: 'RAW_UNKNOWN', unknown: ['publishedAt', 'rawPayloadDigest'],
});
assert.equal(base.observations.dxy, null, 'no DXY record: missing, not invented');
assert.deepEqual(base.marketSnapshot.dxy, { value: null, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null });
assert.equal(base.marketSnapshot.us10y.status, 'STALE', 'a FRED value 38 h old at the cutoff is stale');
assert.equal(base.marketSnapshot.capturedAt, base.marketSnapshot.spot.observedAt);
assert.equal(base.marketSnapshot.available, true);
assert.equal(base.marketSnapshot.reason, null);
console.log('PASS synthetic archive: VERIFIED replay, labelled SIMULATION, full provenance per observation');

// --- 2. Determinism.
const again = await replay(clone(fixture));
assert.equal(again.digest, base.digest, 'same archive and cutoff: same replay digest');
assert.deepEqual(again, base);
const shuffled = clone(fixture);
shuffled.records.reverse();
const reordered = await replay(shuffled);
assert.deepEqual(reordered.observations, base.observations, 'record order does not change the selection');
assert.deepEqual(reordered.marketSnapshot, base.marketSnapshot);
assert.notEqual(reordered.archive.digest, base.archive.digest, 'the archive digest names its exact content');
// Host time zone and locale cannot change it either (no clock, no locale API).
const { spawnSync } = await import('node:child_process');
const script = `
  import { readFileSync } from 'node:fs';
  import { loadBackendModule } from ${JSON.stringify(new URL('../scripts/lib/backend_module_loader.mjs', import.meta.url).href)};
  const ev = await loadBackendModule('market_engine/evidence_archive.ts');
  const a = JSON.parse(readFileSync(${JSON.stringify(new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url).pathname)}, 'utf8'));
  process.stdout.write((await ev.replayMarketEvidence(a, '${CUTOFF}')).digest);`;
for (const [TZ, locale] of [['Pacific/Kiritimati', 'da_DK.UTF-8'], ['America/St_Johns', 'tr_TR.UTF-8']]) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', env: { ...process.env, TZ, LC_ALL: locale, LANG: locale } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, base.digest, `${TZ} ${locale}`);
}
console.log('PASS replay is deterministic: same digest across runs, record order, time zones and locales');

// --- 3. No temporal leakage: records ingested after the cutoff have no effect at all.
assert.equal(base.audit.recordsIngestedAfterCutoff, 2);
assert.ok(!Object.values(base.observations).some((o) => o && o.evidenceId === 'td-xau-20261001-1416'), 'later spot unused');
for (const cutoff of ['2026-10-01T06:00:00.000Z', '2026-10-01T14:10:03.000Z', '2026-10-01T14:10:04.000Z', CUTOFF,
  '2026-10-01T14:16:02.999Z', '2026-10-01T14:16:03.000Z', '2026-10-02T05:59:59.999Z', '2026-10-02T06:00:00.000Z', DAY_AFTER]) {
  const full = await replay(fixture, cutoff);
  const known = clone(fixture);
  known.records = known.records.filter((r) => Date.parse(r.ingestedAt) <= Date.parse(cutoff));
  const past = await replay(known, cutoff);
  assert.deepEqual(full.observations, past.observations, `${cutoff}: future records changed the selection`);
  assert.deepEqual(full.marketSnapshot, past.marketSnapshot, cutoff);
  for (const o of Object.values(full.observations)) {
    if (!o) continue;
    assert.ok(Date.parse(o.ingestedAt) <= Date.parse(cutoff) && Date.parse(o.observedAt) <= Date.parse(cutoff), `${cutoff} ${o.evidenceId}`);
    if (o.publishedAt !== null) assert.ok(Date.parse(o.publishedAt) <= Date.parse(cutoff));
  }
}
// A record is known from its ingestion instant, not before.
assert.equal((await replay(fixture, '2026-10-01T14:10:03.999Z')).observations.spot, null);
assert.equal((await replay(fixture, '2026-10-01T14:10:04.000Z')).observations.spot.evidenceId, 'td-xau-20261001-1410');
console.log('PASS no look-ahead: at every cutoff, removing post-cutoff records changes nothing');

// --- 4. Historical revision: the correction is used only once known.
assert.equal(base.observations.wti.value, 66.4);
assert.equal(base.observations.wti.revision, 'fred-vintage-2026-10-01');
assert.deepEqual(base.audit.correctedAfterCutoff, ['wti'], 'the later correction is reported, not used');
const corrected = await replay(fixture, DAY_AFTER);
assert.equal(corrected.observations.wti.value, 66.9);
assert.equal(corrected.observations.wti.supersedes, 'fred-dcoilwtico-20260930-v1');
assert.deepEqual(corrected.audit.correctedAfterCutoff, []);
assert.equal(corrected.status, 'VERIFIED');
console.log('PASS revisions: the original value before the correction is known, the correction after');

// --- 5. Archive defects reject the whole archive; the chain gets no value.
const invalidCases = [
  ['unit', (rs) => { recordOf({ records: rs }, 'fred-dgs10-20260930').unit = 'INDEX_POINTS'; }, 'UNIT_MISMATCH'],
  ['instrument', (rs) => { recordOf({ records: rs }, 'fred-vixcls-20260930').instrument = 'WTI'; }, 'INSTRUMENT_MISMATCH'],
  ['observation type', (rs) => { recordOf({ records: rs }, 'td-xau-bid-20261001-1414').observationType = 'ASK'; }, 'OBSERVATION_TYPE_MISMATCH'],
  ['value out of domain', (rs) => { recordOf({ records: rs }, 'td-xau-20261001-1414').value = 50; }, 'VALUE_OUT_OF_DOMAIN'],
  ['yield in basis points', (rs) => { recordOf({ records: rs }, 'fred-dgs10-20260930').value = 410; }, 'VALUE_OUT_OF_DOMAIN'],
  ['value as text', (rs) => { recordOf({ records: rs }, 'td-xau-20261001-1414').value = '3900'; }, 'RECORD_SHAPE_INVALID'],
  ['unknown key', (rs) => { rs[0].confidence = 1; }, 'RECORD_SHAPE_INVALID'],
  ['missing key', (rs) => { delete rs[0].publishedAt; }, 'RECORD_SHAPE_INVALID'],
  ['bad timestamp', (rs) => { rs[0].observedAt = '2026-02-30T00:00:00Z'; }, 'RECORD_SHAPE_INVALID'],
  ['observed after ingestion', (rs) => { recordOf({ records: rs }, 'td-xau-20261001-1414').ingestedAt = '2026-10-01T14:13:00.000Z'; }, 'CHRONOLOGY_INVALID'],
  ['published after ingestion', (rs) => { recordOf({ records: rs }, 'fred-dgs10-20260930').publishedAt = '2026-10-01T07:00:00.000Z'; }, 'CHRONOLOGY_INVALID'],
  ['published before observed', (rs) => { recordOf({ records: rs }, 'fred-dgs10-20260930').publishedAt = '2026-09-29T00:00:00.000Z'; }, 'CHRONOLOGY_INVALID'],
  ['evidence id reused', (rs) => { rs.push({ ...rs[1], value: 3901 }); }, 'EVIDENCE_ID_CONFLICT'],
  ['identity reused with another value', (rs) => { rs.push({ ...rs[1], evidenceId: 'td-dup', value: 3901 }); }, 'IDENTITY_REUSED_WITH_DIVERGENT_VALUE'],
  ['correction of an unknown record', (rs) => { recordOf({ records: rs }, 'fred-dcoilwtico-20260930-v2').supersedes = 'nope'; }, 'REVISION_CHAIN_INVALID'],
  ['correction ingested first', (rs) => { recordOf({ records: rs }, 'fred-dcoilwtico-20260930-v2').ingestedAt = '2026-10-01T05:00:00.000Z'; }, 'REVISION_CHAIN_INVALID'],
  ['correction of another observation', (rs) => {
    const v2 = recordOf({ records: rs }, 'fred-dcoilwtico-20260930-v2');
    v2.observedAt = '2026-09-29T00:00:00.000Z';
  }, 'REVISION_CHAIN_INVALID'],
  ['two corrections of one record', (rs) => {
    rs.push({ ...recordOf({ records: rs }, 'fred-dcoilwtico-20260930-v2'), evidenceId: 'wti-v3', revision: 'fred-vintage-x', value: 67.1, ingestedAt: '2026-10-02T07:00:00.000Z' });
  }, 'REVISION_CHAIN_INVALID'],
  ['unlinked revision', (rs) => { recordOf({ records: rs }, 'fred-dcoilwtico-20260930-v2').supersedes = null; }, 'UNLINKED_REVISION_CONFLICT'],
];
for (const [name, mutate, code] of invalidCases) {
  const r = await replay(withRecords(mutate));
  holds(r, name);
  assert.equal(r.status, 'INVALID', name);
  assert.equal(r.reproducible, false, name);
  assert.ok(r.reasonCodes.includes(code), `${name}: ${r.reasonCodes}`);
  assert.equal(r.selection, null, name);
  assert.equal(r.marketSnapshot.available, false, name);
  assert.ok(Object.values(r.marketSnapshot).filter((f) => f && typeof f === 'object').every((f) => f.value === null), `${name}: a value leaked`);
  assert.match(r.marketSnapshot.reason, new RegExp(`INVALID.*${code}`), name);
  assert.ok(r.findings.some((f) => f.code === code), name);
}
console.log(`PASS ${invalidCases.length} archive defects (units, instruments, values, chronology, duplicates, revisions) reject the archive`);

// --- 6. Provider contradictions (MP-1) also reject; agreement does not.
const contradicted = await replay(withRecords((rs) => {
  rs.push({ ...recordOf({ records: rs }, 'td-xau-20261001-1414'), evidenceId: 'other-1414', source: 'other_feed', value: 3905 });
}));
assert.equal(contradicted.status, 'INVALID');
assert.deepEqual(contradicted.selection.reasonCodes.slice(0, 1), ['AMBIGUOUS_TOP_OBSERVATION']);
assert.equal(contradicted.marketSnapshot.available, false);
assert.equal(contradicted.marketSnapshot.spot.value, null);
const agreeing = await replay(withRecords((rs) => {
  rs.push({ ...recordOf({ records: rs }, 'td-xau-20261001-1414'), evidenceId: 'other-1414', source: 'other_feed' });
}));
assert.equal(agreeing.status, 'VERIFIED');
assert.equal(agreeing.marketSnapshot.spot.value, 3900);
const exactDuplicate = await replay(withRecords((rs) => { rs.push(clone(rs[1])); }));
assert.equal(exactDuplicate.status, 'VERIFIED');
assert.ok(exactDuplicate.reasonCodes.includes('EXACT_DUPLICATE_IGNORED'));
const inverted = await replay(withRecords((rs) => { recordOf({ records: rs }, 'td-xau-ask-20261001-1414').value = 3899; }));
// An inverted book is consistent evidence of an unusable market: the replay
// is still verifiable, MP-1 abstains and nothing reaches the chain.
assert.equal(inverted.status, 'VERIFIED');
assert.equal(inverted.selection.state, 'ABSTAIN');
assert.ok(inverted.selection.reasonCodes.includes('BOOK_INVERTED'));
assert.equal(inverted.marketSnapshot.available, false);
assert.equal(inverted.marketSnapshot.bid.value, null);
assert.match(inverted.marketSnapshot.reason, /MP-1 ABSTAIN: .*BOOK_INVERTED/);
console.log('PASS contradictions: disagreeing providers reject, an inverted book abstains; agreement and exact duplicates pass');

// --- 7. Missing and stale data.
const noSpot = await replay(withRecords((rs) => { for (let i = rs.length - 1; i >= 0; i--) if (rs[i].field === 'spot') rs.splice(i, 1); }));
assert.equal(noSpot.status, 'VERIFIED', 'a complete archive without spot reproducibly abstains');
assert.equal(noSpot.selection.state, 'ABSTAIN');
assert.equal(noSpot.marketSnapshot.available, false);
assert.ok(Object.values(noSpot.marketSnapshot).filter((f) => f && typeof f === 'object').every((f) => f.value === null),
  'an abstaining selection passes no value on');
const twoDays = await replay(fixture, '2026-10-02T23:00:00.000Z');
assert.equal(twoDays.marketSnapshot.spot.status, 'STALE');
const expiredCutoff = '2026-10-04T15:00:00.000Z';
const expired = await replay({ ...clone(fixture), coverage: { ...fixture.coverage, to: '2026-10-05T00:00:00.000Z' } }, expiredCutoff);
assert.equal(expired.observations.spot.freshnessAtCutoff, 'UNAVAILABLE', 'beyond 3 days the spot has expired');
assert.equal(expired.marketSnapshot.spot.value, null);
assert.equal(expired.marketSnapshot.available, false);
console.log('PASS missing and stale data: no spot abstains, an old spot is STALE, an expired one is unavailable');

// --- 8. Completeness: never reproducible without a declared complete coverage of the cutoff.
for (const [name, archive, cutoff, code] of [
  ['no coverage', { ...clone(fixture), coverage: null }, CUTOFF, 'COVERAGE_NOT_DECLARED'],
  ['cutoff after coverage', clone(fixture), '2026-10-03T00:00:00.001Z', 'CUTOFF_OUTSIDE_COVERAGE'],
  ['cutoff before coverage', clone(fixture), '2026-09-28T23:59:59.999Z', 'CUTOFF_OUTSIDE_COVERAGE'],
  ['field not covered', { ...clone(fixture), coverage: { ...fixture.coverage, fields: fixture.coverage.fields.filter((f) => f !== 'dxy') } },
    CUTOFF, 'FIELDS_NOT_COVERED'],
]) {
  const r = await replay(archive, cutoff);
  holds(r, name);
  assert.equal(r.status, 'INCOMPLETE', name);
  assert.equal(r.reproducible, false, name);
  assert.ok(r.reasonCodes.includes(code), name);
  assert.match(r.marketSnapshot.reason ?? '', new RegExp(`INCOMPLETE.*${code}`), `${name}: the snapshot says why`);
}
console.log('PASS completeness: no coverage, a cutoff outside it or an uncovered field make the replay INCOMPLETE');

// --- 9. Pinned digest.
assert.equal((await replay(fixture, CUTOFF, { pinnedArchiveDigest: base.archive.digest })).status, 'VERIFIED');
const tampered = withRecords((rs) => { recordOf({ records: rs }, 'fred-vixcls-20260930').value = 17.3; });
const pinnedTampered = await replay(tampered, CUTOFF, { pinnedArchiveDigest: base.archive.digest });
assert.equal(pinnedTampered.status, 'INVALID');
assert.ok(pinnedTampered.reasonCodes.includes('ARCHIVE_DIGEST_MISMATCH'));
for (const bad of [null, [], 'x', { ...clone(fixture), schemaVersion: 'v0' }, { ...clone(fixture), extra: 1 },
  { ...clone(fixture), provenanceClass: 'LIVE' }, { ...clone(fixture), records: {} }]) {
  const r = await replay(bad);
  holds(r, JSON.stringify(bad)?.slice(0, 30));
  assert.equal(r.status, 'INVALID');
  assert.ok(r.reasonCodes.includes('ARCHIVE_SHAPE_INVALID'));
  assert.equal(r.marketSnapshot.available, false);
}
assert.ok((await replay(fixture, 'yesterday')).reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));
console.log('PASS a pinned digest detects a modified archive; malformed archives and cutoffs are rejected');

// --- 10. Raw payloads: HISTORIQUE VÉRIFIÉ only when every selected value is read back from its bytes.
const fredBody = (date, value) => JSON.stringify({ observations: [{ date, value: String(value), realtime_start: '2026-10-01' }] });
const tdBody = JSON.stringify({ symbol: 'XAU/USD', close: '3900', last_quote_at: Date.parse('2026-10-01T14:14:00Z') / 1000 });
const bodies = {
  spot: ['twelve_data', 'XAUUSD', tdBody],
  us10y: ['fred', 'US10Y', fredBody('2026-09-30', 4.1)],
  realYield: ['fred', 'US10YR', fredBody('2026-09-30', 1.7)],
  vix: ['fred', 'VIX', fredBody('2026-09-30', 17.2)],
  wti: ['fred', 'WTI', fredBody('2026-09-30', 66.4)],
};
async function capturedArchive(mutateBody = (b) => b) {
  // Test-only archive shaped like a capture; its bodies are written here, not recorded.
  const a = clone(fixture);
  a.provenanceClass = 'CAPTURED';
  a.archiveId = 'test-captured-shape';
  // Twelve Data quotes carry no book: no bid/ask record can be verified, so none is kept.
  a.records = a.records.filter((r) => ['spot', 'us10y', 'realYield', 'vix'].includes(r.field)
    || r.evidenceId === 'fred-dcoilwtico-20260930-v1');
  a.rawPayloads = {};
  for (const r of a.records) {
    const [parser, symbol, body] = bodies[r.field];
    const kept = r.field === 'spot' && r.evidenceId !== 'td-xau-20261001-1414'
      ? JSON.stringify({ close: String(r.value), last_quote_at: Date.parse(r.observedAt) / 1000 }) : body;
    const digest = await sha256Text(kept);
    a.rawPayloads[digest] = { parser, symbol, body: mutateBody(kept, r) };
    r.rawPayloadDigest = digest;
    r.publishedAt = r.observedAt;
  }
  return a;
}
const captured = await capturedArchive();
const verified = await replay(captured, CUTOFF, { parsers: PARSERS });
assert.equal(verified.status, 'VERIFIED', verified.reasonCodes.join());
assert.equal(verified.nature, 'HISTORICAL_VERIFIED');
assert.ok(Object.values(verified.observations).filter(Boolean).every((o) => o.raw === 'RAW_VERIFIED'));
const noParser = await replay(captured, CUTOFF);
assert.equal(noParser.nature, 'HISTORICAL_UNVERIFIED', 'without re-reading the bytes, not verified');
assert.ok(Object.values(noParser.observations).filter(Boolean).every((o) => o.raw === 'RAW_DIGEST_ONLY'));
const incompleteCapture = await replay({ ...captured, coverage: null }, CUTOFF, { parsers: PARSERS });
assert.equal(incompleteCapture.nature, 'HISTORICAL_UNVERIFIED', 'an incomplete capture is not verified history');
const unknownRaw = clone(captured);
unknownRaw.records.find((r) => r.evidenceId === 'td-xau-20261001-1414').rawPayloadDigest = null;
assert.equal((await replay(unknownRaw, CUTOFF, { parsers: PARSERS })).nature, 'HISTORICAL_UNVERIFIED');
const edited = await replay(await capturedArchive((body, r) => (r.field === 'vix' ? body.replace('17.2', '17.9') : body)),
  CUTOFF, { parsers: PARSERS });
assert.equal(edited.status, 'INVALID', 'bytes that no longer match their digest');
assert.ok(edited.reasonCodes.includes('RAW_PAYLOAD_MISMATCH'));
// Bytes changed without changing the value read: only the digest notices.
const rewritten = await replay(await capturedArchive((body, r) => (r.field === 'vix' ? body.replace('2026-10-01', '2026-10-09') : body)),
  CUTOFF, { parsers: PARSERS });
assert.equal(rewritten.status, 'INVALID', 'kept bytes must be the exact bytes digested');
assert.ok(rewritten.reasonCodes.includes('RAW_PAYLOAD_MISMATCH'));
const misread = clone(captured);
misread.records.find((r) => r.field === 'vix').value = 17.9;
const misreadReplay = await replay(misread, CUTOFF, { parsers: PARSERS });
assert.equal(misreadReplay.status, 'INVALID', 'a recorded value its own bytes do not contain');
assert.ok(misreadReplay.reasonCodes.includes('RAW_PAYLOAD_MISMATCH'));
assert.equal(misreadReplay.nature, 'HISTORICAL_UNVERIFIED');
console.log('PASS raw payloads: HISTORICAL_VERIFIED requires re-read bytes, complete coverage and a valid archive');

// --- 11. CHAIN-0 integration: only the market snapshot changes; HOLD everywhere.
const outcome = bridge.evaluateDecisionChainOnMarketEvidence(golden.input, base);
assert.equal(outcome.kind, 'COMPLETED');
const result = outcome.result;
assert.equal(result.knowledgeCutoff, CUTOFF);
assert.equal(result.chainState, 'HOLD');
assert.equal(result.execution, 'FORBIDDEN');
assert.equal(result.integrity, 'CONSISTENT');
const mp0 = result.stages.marketPricing;
assert.equal(mp0.fields.spot.value, 3900);
assert.equal(mp0.fields.wti.value, 66.4);
assert.equal(mp0.state, 'DEGRADED');
assert.ok(mp0.reasonCodes.includes('HISTORICAL_REPLAY_UNAVAILABLE'), 'MP-0 is not upgraded by DATA-1');
assert.deepEqual(mp0.replay, { mode: 'LATEST_ONLY', reproducible: false, reason: 'INGESTION_CUTOFF_NOT_AVAILABLE' });
assert.equal(result.trace.find((t) => t.stage === 'ACTION').state, 'ABSTAIN');
assert.equal(await chain.computeDecisionChainDigest(result),
  await chain.computeDecisionChainDigest(bridge.evaluateDecisionChainOnMarketEvidence(clone(golden.input), await replay(clone(fixture))).result),
  'chain digest reproducible from the same archive and cutoff');
for (const [name, r] of [['invalid', await replay(withRecords((rs) => { rs[0].unit = 'PERCENT'; }))],
  ['contradicted', contradicted], ['no spot', noSpot], ['shape', await replay(null)]]) {
  const o = bridge.evaluateDecisionChainOnMarketEvidence(golden.input, r);
  assert.equal(o.kind, 'COMPLETED', name);
  assert.equal(o.result.chainState, 'HOLD', name);
  assert.equal(o.result.execution, 'FORBIDDEN', name);
  assert.equal(o.result.stages.marketPricing.state, 'ABSTAIN', name);
  assert.ok(o.result.stages.marketPricing.reasonCodes.includes('SOURCE_SNAPSHOT_UNAVAILABLE'), name);
  assert.match(o.result.stages.marketPricing.sourceReason, /market evidence replay/, `${name}: precise reason carried`);
}
const incompleteChain = bridge.evaluateDecisionChainOnMarketEvidence(golden.input, await replay({ ...clone(fixture), coverage: null }));
assert.match(incompleteChain.result.stages.marketPricing.sourceReason, /INCOMPLETE .*: COVERAGE_NOT_DECLARED/);
assert.equal(bridge.evaluateDecisionChainOnMarketEvidence(undefined, base).kind, 'REJECTED');
assert.throws(() => bridge.evaluateDecisionChainOnMarketEvidence(golden.input, { ...base, execution: 'ALLOWED' }), /HOLD/);
console.log('PASS CHAIN-0 on replayed evidence: same contracts, MP-0 not upgraded, invalid evidence abstains, HOLD / FORBIDDEN');

// --- 12. Containment: the replay is pure and reaches no provider, network, clock or environment.
const closure = listBackendImportClosure('market_engine/evidence_archive.ts');
assert.deepEqual(closure, ['market_engine/as_of_snapshot.ts', 'market_engine/evidence_archive.ts', 'market_engine/validate.ts',
  'shared/canonical_json.ts', 'shared/strict_timestamp.ts']);
for (const file of [...closure, 'decision_chain/market_evidence_chain.ts']) {
  const text = readFileSync(new URL(`../backend/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\bfetch\(|process\.env|Math\.random\(|Date\.now\(|SUPABASE_|\benv\.[A-Z]/, file);
}
// The DATA-1 files never read the clock (validate.ts keeps a `now` default the replay does not call).
for (const file of ['market_engine/evidence_archive.ts', 'decision_chain/market_evidence_chain.ts']) {
  assert.doesNotMatch(readFileSync(new URL(`../backend/${file}`, import.meta.url), 'utf8'), /new Date\(\)|validatePoint/, file);
}
console.log('PASS the replay reaches no provider, network, clock, randomness or environment');
