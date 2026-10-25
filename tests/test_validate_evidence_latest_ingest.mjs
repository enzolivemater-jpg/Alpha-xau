import assert from 'node:assert/strict';

import { latestIngestedAt, verifiedClaimProblems } from '../scripts/validate_evidence_captures.mjs';

const rec = (ingestedAt) => ({ ingestedAt });

// '.' sorts before 'Z', so a lexical sort picks the earlier instant.
assert.equal(latestIngestedAt([rec('2026-01-01T10:00:00.500Z'), rec('2026-01-01T10:00:00Z')]), '2026-01-01T10:00:00.500Z');
assert.equal(latestIngestedAt([rec('2026-01-01T10:00:00Z'), rec('2026-01-01T10:00:00.500Z')]), '2026-01-01T10:00:00.500Z');
// Offsets are compared as instants.
assert.equal(latestIngestedAt([rec('2026-01-01T10:00:00Z'), rec('2026-01-01T10:30:00+01:00')]), '2026-01-01T10:00:00Z');
// A value that does not parse never wins over one that does.
assert.equal(latestIngestedAt([rec('zzz'), rec('2026-01-01T10:00:00Z')]), '2026-01-01T10:00:00Z');
// Nothing parses: deterministic fallback, no throw.
assert.equal(latestIngestedAt([rec('b'), rec('a')]), 'b');
assert.equal(latestIngestedAt([]), undefined);

console.log('PASS validate_evidence_captures: latest reception time compared as instants, not as text');

// verifiedClaimProblems: the source check can fail (its former form, `status !== 'VERIFIED' || reproducible`, never could).
const FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];
const replayOf = (status, held, extra = {}) => ({ status, reproducible: status === 'VERIFIED', nature: 'SIMULATION',
  observations: Object.fromEntries(FIELDS.map((f) => [f, held.includes(f) ? { field: f } : null])), ...extra });
assert.deepEqual(verifiedClaimProblems(replayOf('VERIFIED', FIELDS)), []);
assert.deepEqual(verifiedClaimProblems(replayOf('INCOMPLETE', ['spot'])), [], 'an INCOMPLETE replay may lack fields');
assert.deepEqual(verifiedClaimProblems(replayOf('VERIFIED', FIELDS.filter((f) => f !== 'dxy'))), ['VERIFIED_WITH_FIELD_NOT_HELD']);
assert.deepEqual(verifiedClaimProblems(replayOf('INCOMPLETE', FIELDS, { reproducible: true })), ['REPRODUCIBLE_STATUS_MISMATCH']);
assert.deepEqual(verifiedClaimProblems(replayOf('VERIFIED', FIELDS, { reproducible: false })), ['REPRODUCIBLE_STATUS_MISMATCH']);
assert.deepEqual(verifiedClaimProblems(replayOf('INCOMPLETE', FIELDS, { nature: 'HISTORICAL_VERIFIED' })), ['HISTORICAL_VERIFIED_WITHOUT_VERIFIED']);
const tooOld = replayOf('VERIFIED', FIELDS);
tooOld.observations.wti = { field: 'wti', freshnessAtCutoff: 'UNAVAILABLE' };
assert.deepEqual(verifiedClaimProblems(tooOld), ['VERIFIED_WITH_FIELD_UNAVAILABLE'], 'a selected value too old to be held');
assert.deepEqual(verifiedClaimProblems({ ...tooOld, status: 'INCOMPLETE', reproducible: false }), []);
// Replay 1.2.0 proof: a VERIFIED claim on a value whose freshness is not proved FRESH; a 1.1.0 replay has no proof field.
const unproved = replayOf('VERIFIED', FIELDS);
unproved.observations.dxy = { field: 'dxy', freshnessAtCutoff: 'LIVE', freshnessProof: 'NOT_EVALUATED' };
assert.deepEqual(verifiedClaimProblems(unproved), ['VERIFIED_WITHOUT_FRESHNESS_PROOF']);
unproved.observations.dxy.freshnessProof = 'FRESH';
assert.deepEqual(verifiedClaimProblems(unproved), []);
// The former expression accepted the first defect: it is the one that matters for DATA-3 L1.
const former = (r) => r.status !== 'VERIFIED' || r.reproducible;
assert.equal(former(replayOf('VERIFIED', FIELDS.filter((f) => f !== 'dxy'))), true, 'the former check passed a VERIFIED replay without DXY');

console.log('PASS validate_evidence_captures: a VERIFIED, reproducible or HISTORICAL_VERIFIED label is checked against the data held');

// --- DATA-3 continuity audit (scripts/lib/capture_continuity.mjs): reports holes, never attests continuity.
// Every record below is synthetic and minimal: only what the audit reads.
const { auditCaptureContinuity, declaredFieldHoles, uncoveredIntervals } = await import('../scripts/lib/capture_continuity.mjs');
const { continuityClaimProblems } = await import('../scripts/validate_evidence_captures.mjs');
const H = 3_600_000;
const D = 24 * H;
const RULES = { spot: { liveMaxAgeS: 360, staleMaxAgeS: 3 * 86_400 }, us10y: { liveMaxAgeS: 36 * 3600, staleMaxAgeS: 6 * 86_400 }, dxy: null };
const CADENCE = { spot: 'INTRADAY', us10y: 'DAILY' };
const OPTS = { rules: RULES, cadence: CADENCE };
let n = 0;
const r = (field, observedAt, ingestedAt, extra = {}) => ({
  evidenceId: `syn-${(n += 1)}`, field, value: 1, source: field === 'spot' ? 'twelve_data' : 'fred',
  sourceRecordId: field === 'spot' ? 'XAU/USD' : 'DGS10', observedAt, ingestedAt, supersedes: null, ...extra,
});
const log = (records, coverage = null) => ({ archiveId: 'syn-continuity', coverage, records });
const cover = (from, to, fields) => ({ from, to, fields, statement: 'synthétique' });
const codes = (rep) => rep.findings.map((f) => f.code);

// Interval arithmetic: closed intervals, touching ones merge, a single uncovered instant is reported.
assert.deepEqual(uncoveredIntervals([[0, 10], [10, 20]], 0, 20), []);
assert.deepEqual(uncoveredIntervals([[0, 10], [11, 20]], 0, 20), [[10, 11]]);
assert.deepEqual(uncoveredIntervals([], 5, 5), [[5, 5]], 'a one-instant window with nothing held is a hole');
assert.deepEqual(uncoveredIntervals([[5, 5]], 5, 5), []);
assert.deepEqual(uncoveredIntervals([[3, 4], [8, 30]], 0, 20), [[0, 3], [4, 8]]);
assert.deepEqual(uncoveredIntervals([[-5, 2]], 0, 20), [[2, 20]]);
assert.deepEqual(uncoveredIntervals([[-5, -2]], 0, 0), [[0, 0]], 'a record expired before the window does not cover its start');

// 1. Intraday hole: start, end and duration per series; the replay's own freshness thresholds, no new one.
{
  const rep = auditCaptureContinuity(log([
    r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:02Z'),
    r('spot', '2026-10-01T10:05:00Z', '2026-10-01T10:05:02Z'),
    r('spot', '2026-10-01T16:00:00Z', '2026-10-01T16:00:02Z'),
  ], cover('2026-10-01T10:00:00Z', '2026-10-05T00:00:00Z', ['spot'])), OPTS);
  const s = rep.series[0];
  assert.equal(s.series, 'spot|twelve_data|XAU/USD');
  assert.deepEqual(s.observationGaps.map((g) => [g.from, g.to, g.durationSeconds, g.tolerance, g.marketClosure]), [
    ['2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z', 300, 'NOT_EVALUATED', 'NOT_EVALUATED'],
    ['2026-10-01T10:05:00.000Z', '2026-10-01T16:00:00.000Z', 21_300, 'NOT_EVALUATED', 'NOT_EVALUATED']]);
  // Held from reception (10:00:02), fresh while age <= 3 days; live while age <= 360 s.
  assert.deepEqual(s.unavailableIntervals, [
    { from: '2026-10-01T10:00:00.000Z', to: '2026-10-01T10:00:02.000Z', durationSeconds: 2 },
    { from: '2026-10-04T16:00:00.000Z', to: '2026-10-05T00:00:00.000Z', durationSeconds: 28_800 }]);
  assert.deepEqual(s.notLiveIntervals.map((i) => [i.from, i.to]), [
    ['2026-10-01T10:00:00.000Z', '2026-10-01T10:00:02.000Z'], ['2026-10-01T10:11:00.000Z', '2026-10-01T16:00:02.000Z'],
    ['2026-10-01T16:06:00.000Z', '2026-10-05T00:00:00.000Z']]);
  assert.equal(rep.outcome, 'GAPS_DETECTED');
  assert.equal(rep.continuity, 'NOT_ATTESTED');
  assert.deepEqual(declaredFieldHoles(rep).map((h) => [h.field, h.from, h.to]), [
    ['spot', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:02.000Z'], ['spot', '2026-10-04T16:00:00.000Z', '2026-10-05T00:00:00.000Z']]);
  // Exactly at the threshold the value is still STALE, not UNAVAILABLE (same edge as classifyFreshness).
  const edge = auditCaptureContinuity(log([r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')],
    cover('2026-10-01T10:00:00Z', '2026-10-04T10:00:00Z', ['spot'])), OPTS);
  assert.deepEqual(edge.series[0].unavailableIntervals, []);
  const past = auditCaptureContinuity(log([r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')],
    cover('2026-10-01T10:00:00Z', '2026-10-04T10:00:00.001Z', ['spot'])), OPTS);
  assert.deepEqual(past.series[0].unavailableIntervals.map((i) => i.durationSeconds), [0.001]);
}

// 2. Duplicates: a linked revision is not one; the same value twice and divergent unlinked values are.
{
  const a = r('us10y', '2026-09-30T00:00:00Z', '2026-10-01T06:00:00Z');
  const rev = r('us10y', '2026-09-30T00:00:00Z', '2026-10-02T06:00:00Z', { supersedes: a.evidenceId, value: 2 });
  assert.deepEqual(auditCaptureContinuity(log([a, rev]), OPTS).series[0].duplicates.map((d) => d.type), ['LINKED_REVISION']);
  assert.ok(!codes(auditCaptureContinuity(log([a, rev]), OPTS)).includes('DUPLICATE_OBSERVATION'));
  const twice = auditCaptureContinuity(log([a, r('us10y', '2026-09-30T00:00:00Z', '2026-10-02T06:00:00Z')]), OPTS);
  assert.deepEqual(twice.findings.filter((f) => f.code === 'DUPLICATE_OBSERVATION').map((f) => f.type), ['SAME_VALUE_RECORDED_TWICE']);
  const diverge = auditCaptureContinuity(log([a, r('us10y', '2026-09-30T00:00:00+00:00', '2026-10-02T06:00:00Z', { value: 3 })]), OPTS);
  assert.deepEqual(diverge.findings.filter((f) => f.code === 'DUPLICATE_OBSERVATION').map((f) => f.type), ['UNLINKED_DIVERGENT_VALUES'],
    'the same instant written with another offset is the same observation time');
}

// 3. Temporal order: an append before an earlier reception; an observation that arrives after a later one.
{
  const rep = auditCaptureContinuity(log([
    r('spot', '2026-10-01T10:05:00Z', '2026-10-01T10:05:02Z'),
    r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:02Z'),
  ]), OPTS);
  assert.deepEqual(codes(rep).filter((c) => c !== 'SERIES_UNAVAILABLE_IN_WINDOW'), ['INGESTION_ORDER_VIOLATION'],
    'received in order, so not late: only the append order is wrong');
  const late = auditCaptureContinuity(log([
    r('us10y', '2026-09-29T00:00:00Z', '2026-09-30T06:00:00Z'),
    r('us10y', '2026-09-30T00:00:00Z', '2026-10-01T06:00:00Z'),
    r('us10y', '2026-09-28T00:00:00Z', '2026-10-02T06:00:00Z'),
  ]), OPTS);
  assert.deepEqual(late.series[0].lateObservations, [{ observedAt: '2026-09-28T00:00:00.000Z', ingestedAt: '2026-10-02T06:00:00.000Z', afterObservedAt: '2026-09-30T00:00:00.000Z' }]);
  // A FRED response carries its history at once: older dates received together are not late.
  const batch = auditCaptureContinuity(log([
    r('us10y', '2026-09-30T00:00:00Z', '2026-10-01T06:00:00Z'), r('us10y', '2026-09-29T00:00:00Z', '2026-10-01T06:00:00Z')]), OPTS);
  assert.deepEqual(batch.series[0].lateObservations, []);
  assert.ok(!codes(batch).includes('INGESTION_ORDER_VIOLATION'));
}

// 4–5. Daily data: weekend and weekday holes are counted, never classified as closures (no approved calendar).
{
  const rep = auditCaptureContinuity(log([
    r('us10y', '2026-09-24T00:00:00Z', '2026-10-01T06:00:00Z'), // Thursday
    r('us10y', '2026-09-25T00:00:00Z', '2026-10-01T06:00:00Z'), // Friday
    r('us10y', '2026-09-28T00:00:00Z', '2026-10-01T06:00:00Z'), // Monday
    r('us10y', '2026-09-30T00:00:00Z', '2026-10-01T06:00:00Z'), // Wednesday
  ], cover('2026-10-01T06:00:00Z', '2026-10-01T06:00:00Z', ['us10y'])), OPTS);
  assert.deepEqual(rep.series[0].observationGaps.map((g) => [g.from.slice(0, 10), g.to.slice(0, 10), g.missingWeekdays, g.missingSaturdaysSundays,
    g.marketClosure, g.nonBusinessDay, g.tolerance]), [
    ['2026-09-25', '2026-09-28', 0, 2, 'NOT_EVALUATED', 'NOT_EVALUATED', 'NOT_EVALUATED'],
    ['2026-09-28', '2026-09-30', 1, 0, 'NOT_EVALUATED', 'NOT_EVALUATED', 'NOT_EVALUATED']], 'consecutive dates are no gap');
  assert.deepEqual(rep.series[0].unavailableIntervals, [], 'a day-old value is fresh under the 6-day rule');
  assert.deepEqual(declaredFieldHoles(rep), []);
  assert.equal(rep.outcome, 'GAPS_DETECTED', 'a missing date is reported even when the replay would still hold a value');
}

// 6. Cutoff: what was ingested later is never read; a later record does not fill an earlier hole.
{
  const records = [
    r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
    r('spot', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z'),
  ];
  const window = cover('2026-10-01T10:00:00Z', '2026-10-06T00:00:00Z', ['spot']);
  const cutoff = '2026-10-04T12:00:00Z';
  const at = auditCaptureContinuity(log(records, window), { ...OPTS, cutoff });
  const known = auditCaptureContinuity(log(records.filter((x) => Date.parse(x.ingestedAt) <= Date.parse(cutoff)), window), { ...OPTS, cutoff });
  assert.deepEqual(at, known, 'no look-ahead');
  assert.equal(at.window.to, '2026-10-04T12:00:00.000Z');
  assert.deepEqual(at.series[0].unavailableIntervals.map((i) => [i.from, i.to]), [['2026-10-04T10:00:00.000Z', '2026-10-04T12:00:00.000Z']]);
  assert.equal(auditCaptureContinuity(log(records, window), { ...OPTS, cutoff: '2026-09-30T00:00:00Z' }).outcome, 'NOT_EVALUATED');
  assert.equal(auditCaptureContinuity(log(records, window), { ...OPTS, cutoff: '2026-10-04T12:00:00' }).reason, 'CUTOFF_UNREADABLE', 'an implicit zone is refused');
  const full = auditCaptureContinuity(log(records, window), OPTS);
  assert.deepEqual(full.series[0].unavailableIntervals.map((i) => [i.from, i.to]), [['2026-10-04T10:00:00.000Z', '2026-10-05T10:00:00.000Z']]);
}

// 7. Fail closed: unreadable input is NOT_EVALUATED, a field without rule or without series is a hole, never continuity.
{
  assert.equal(auditCaptureContinuity(null, OPTS).outcome, 'NOT_EVALUATED');
  assert.equal(auditCaptureContinuity(log([r('spot', 'yesterday', '2026-10-01T10:00:00Z')]), OPTS).reason, 'RECORD_TIME_UNREADABLE');
  const rep = auditCaptureContinuity(log([r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
    r('dxy', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', { source: 'synthetic', sourceRecordId: 'DXY' })],
  cover('2026-10-01T10:00:00Z', '2026-10-01T10:01:00Z', ['spot', 'dxy', 'wti'])), OPTS);
  assert.deepEqual(rep.declaredFieldsWithoutSeries, ['wti']);
  assert.deepEqual(declaredFieldHoles(rep).map((h) => [h.field, h.basis]), [['dxy', 'FRESHNESS_RULE_UNAVAILABLE'], ['wti', 'NO_SERIES']], 'in declared order');
  assert.ok(codes(rep).includes('FRESHNESS_RULE_UNAVAILABLE') && codes(rep).includes('DECLARED_FIELD_WITHOUT_OBSERVATION'));
}

// 8. No hole found is not an attestation: the report still says NOT_ATTESTED, and the validator refuses any other value.
{
  const clean = auditCaptureContinuity(log([r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')],
    cover('2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z', ['spot'])), OPTS);
  assert.equal(clean.outcome, 'NO_GAP_DETECTED');
  assert.equal(clean.continuity, 'NOT_ATTESTED');
  assert.deepEqual(clean.continuityBasis, ['NO_APPROVED_SOURCE_CALENDAR', 'NO_APPROVED_GAP_TOLERANCE']);
  assert.ok(!JSON.stringify(clean).includes('CONTINUOUS'), 'no continuity wording in a clean report');
  const verified = { status: 'VERIFIED' };
  assert.deepEqual(continuityClaimProblems(verified, clean), []);
  assert.deepEqual(continuityClaimProblems(verified, { ...clean, continuity: 'CONTINUOUS' }), ['CONTINUITY_ATTESTED_BY_AUDIT']);
  const holed = auditCaptureContinuity(log([r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')],
    cover('2026-09-30T10:00:00Z', '2026-10-01T10:05:00Z', ['spot'])), OPTS);
  assert.deepEqual(continuityClaimProblems(verified, holed), ['VERIFIED_OVER_DECLARED_WINDOW_WITH_HOLES:spot']);
  assert.deepEqual(continuityClaimProblems({ status: 'INCOMPLETE' }, holed), [], 'an INCOMPLETE replay claims nothing');
  // Without declared coverage the window is the reception span: holes are reported, nothing is claimed.
  assert.deepEqual(declaredFieldHoles(auditCaptureContinuity(log([r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')]), OPTS)), []);
}

// L1b: replay 1.1.0 called VERIFIED a cutoff where a covered field is too old to be held; 1.2.0 says INCOMPLETE.
// The validator still refuses such a VERIFIED claim (forged, or from a 1.1.0 replay).
{
  const evr = await (await import('../scripts/lib/backend_module_loader.mjs')).loadBackendModule('market_engine/evidence_archive.ts');
  const { readFileSync } = await import('node:fs');
  const a = JSON.parse(readFileSync(new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url), 'utf8'));
  a.records.push({ ...a.records[5], evidenceId: 'syn-dxy-1', field: 'dxy', instrument: 'DXY', unit: 'INDEX_POINTS', value: 100, source: 'synthetic', sourceRecordId: 'DXY' });
  a.coverage = { ...a.coverage, to: '2026-10-07T00:00:00.000Z' };
  const late = await evr.replayMarketEvidence(a, '2026-10-07T00:00:00Z');
  assert.equal(late.status, 'INCOMPLETE');
  assert.ok(late.reasonCodes.includes('DECLARED_FIELD_STALE') && late.reasonCodes.includes('DECLARED_FIELD_FRESHNESS_NOT_EVALUATED'));
  assert.equal(late.marketSnapshot.available, false);
  assert.deepEqual(verifiedClaimProblems(late), []);
  const forged = { ...late, status: 'VERIFIED', reproducible: true };
  assert.deepEqual(verifiedClaimProblems(forged), ['VERIFIED_WITH_FIELD_UNAVAILABLE', 'VERIFIED_WITHOUT_FRESHNESS_PROOF']);
  const asIn110 = structuredClone(forged);
  for (const o of Object.values(asIn110.observations)) if (o) delete o.freshnessProof;
  assert.deepEqual(verifiedClaimProblems(asIn110), ['VERIFIED_WITH_FIELD_UNAVAILABLE'], 'a 1.1.0 replay is still judged');
  const audit = auditCaptureContinuity(a, { rules: { ...RULES, bid: RULES.spot, ask: RULES.spot, realYield: RULES.us10y, vix: RULES.us10y, wti: RULES.us10y }, cadence: CADENCE });
  assert.deepEqual([...new Set(declaredFieldHoles(audit).map((h) => h.field))].sort(), ['ask', 'bid', 'dxy', 'realYield', 'spot', 'us10y', 'vix', 'wti']);
  assert.ok(continuityClaimProblems(forged, audit)[0].startsWith('VERIFIED_OVER_DECLARED_WINDOW_WITH_HOLES:'));
  assert.deepEqual(continuityClaimProblems(late, audit), []);
}

// The summary shared by the catalog, terminal:check-data and the page: per field and per series, with a status.
{
  const { summarizeContinuity } = await import('../scripts/lib/capture_continuity.mjs');
  const rep = auditCaptureContinuity(log([
    r('spot', '2026-10-01T10:00:00Z', '2026-10-01T10:00:02Z'), r('spot', '2026-10-01T16:00:00Z', '2026-10-01T16:00:02Z'),
    r('us10y', '2026-09-25T00:00:00Z', '2026-10-01T06:00:00Z'), r('us10y', '2026-09-28T00:00:00Z', '2026-10-01T06:00:00Z'),
    r('dxy', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', { source: 'synthetic', sourceRecordId: 'DXY' }),
  ], cover('2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z', ['spot', 'dxy', 'us10y', 'wti'])), OPTS);
  const sum = summarizeContinuity(rep);
  assert.equal(sum.continuity, 'NOT_ATTESTED');
  assert.deepEqual(sum.fields.map((f) => [f.field, f.declared, f.status, f.holes && f.holes.map((h) => [h.from, h.to, h.basis])]), [
    ['spot', true, 'HOLES_DETECTED', [['2026-10-01T10:00:00.000Z', '2026-10-01T10:00:02.000Z', 'RUNTIME_FRESHNESS_RULE']]],
    ['dxy', true, 'NOT_EVALUATED', null],
    ['us10y', true, 'NO_HOLE_DETECTED', []],
    ['wti', true, 'NO_SERIES', [['2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', 'NO_SERIES']]]]);
  const us = sum.fields.find((f) => f.field === 'us10y');
  assert.deepEqual([us.observationGaps, us.largestGapSeconds, us.missingWeekdays, us.missingSaturdaysSundays, us.observed],
    [1, 259_200, 0, 2, { first: '2026-09-25T00:00:00.000Z', last: '2026-09-28T00:00:00.000Z' }]);
  assert.deepEqual(sum.series.map((x) => [x.series, x.status]), [
    ['dxy|synthetic|DXY', 'NOT_EVALUATED'], ['spot|twelve_data|XAU/USD', 'HOLES_DETECTED'], ['us10y|fred|DGS10', 'NO_HOLE_DETECTED']]);
  assert.equal(sum.findings.DECLARED_FIELD_WITHOUT_OBSERVATION, 1);
  assert.deepEqual(summarizeContinuity(auditCaptureContinuity(null, OPTS)), { reportVersion: 'capture-continuity-1.0.0', continuity: 'NOT_ATTESTED',
    continuityBasis: ['NO_APPROVED_SOURCE_CALENDAR', 'NO_APPROVED_GAP_TOLERANCE'], outcome: 'NOT_EVALUATED', reason: 'ARCHIVE_UNREADABLE',
    window: null, fields: [], series: [], findings: {} });
}

console.log('PASS DATA-3 continuity audit: per-series gaps, duplicates, order, freshness holes and cutoff; no hole found is never an attestation');

// --- DATA-3 G3/G4 raw-storage contract (scripts/lib/capture_attestation.mjs): what a log proves per capture; never an attestation.
// Synthetic capture log written in the providers' formats by this test.
{
  const { auditCaptureAttestation, attestationIntegrityProblems, ATTESTATION_MANIFEST_FORMAT } = await import('../scripts/lib/capture_attestation.mjs');
  const { loadBackendModule: load } = await import('../scripts/lib/backend_module_loader.mjs');
  const capm = await load('market_engine/evidence_capture.ts');
  const prov = await load('market_engine/providers.ts');
  const P = { fred: prov.parseFredObservations, twelve_data: prov.parseTwelveData };
  const fredBody = (rows) => JSON.stringify({ realtime_start: '2026-10-01', realtime_end: '2026-10-01', observation_start: rows[0][0], units: 'lin', file_type: 'json',
    observations: rows.map(([date, value]) => ({ realtime_start: '2026-10-01', realtime_end: '2026-10-01', date, value })) });
  const tdBody = (close, at) => JSON.stringify({ symbol: 'XAU/USD', close: String(close), last_quote_at: Date.parse(at) / 1000, is_market_open: true });
  let logA = capm.createEvidenceArchive({ archiveId: 'att-log', provenanceClass: 'CAPTURED', createdAt: '2026-10-01T06:00:00Z',
    fields: ['us10y', 'spot'], statement: 'journal synthétique de test' });
  for (const c of [
    { provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10', body: fredBody([['2026-09-29', '4.12'], ['2026-09-30', '4.10']]), ingestedAt: '2026-10-01T06:00:00Z' },
    { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', body: tdBody(3900, '2026-10-01T14:14:00Z'), ingestedAt: '2026-10-01T14:14:03Z' },
  ]) {
    const res = await capm.appendProviderCapture(logA, c, P);
    assert.equal(res.outcome, 'APPENDED', res.rejection);
    logA = res.archive;
  }
  const SERIES = capm.CAPTURE_SERIES;
  const audit = (a, manifest = null) => auditCaptureAttestation(a, { series: SERIES, manifest });
  const codesOf = (rep) => rep.findings.map((f) => f.code);

  // A log written by the capture code holds: bytes kept, digests match, known series, one instant, in order.
  const ok = audit(logA);
  assert.equal(ok.outcome, 'BYTES_CONSISTENT');
  assert.deepEqual(ok.captures.map((c) => [c.provider, c.sourceRecordIds, c.records, c.receivedAt, c.bytes, c.digest, c.request]), [
    ['fred', ['DGS10'], 2, '2026-10-01T06:00:00.000Z', 'KEPT', 'MATCH', 'KNOWN_SERIES'],
    ['twelve_data', ['XAU/USD'], 1, '2026-10-01T14:14:03.000Z', 'KEPT', 'MATCH', 'KNOWN_SERIES']]);
  // CAPTURED is the operator's word; collector and licence are not recorded anywhere: reported, never proved.
  assert.deepEqual([ok.attestation, ok.upgradesReplay, ok.attestedBy, ok.collector, ok.licence],
    ['NOT_PROVEN', false, 'OPERATOR_DECLARED', 'NOT_RECORDED', 'NOT_RECORDED']);
  assert.deepEqual(codesOf(ok), ['COLLECTOR_IDENTITY_NOT_RECORDED', 'LICENCE_NOT_RECORDED']);
  assert.deepEqual(attestationIntegrityProblems(ok), [], 'an operator-only attestation is incomplete, not broken');

  // Negative cases: each breaks the contract and fails the validator check.
  const digests = Object.keys(logA.rawPayloads);
  const broken = (name, mutate, code) => {
    const a = structuredClone(logA);
    mutate(a);
    const rep = audit(a);
    assert.equal(rep.outcome, 'CONTRACT_BROKEN', name);
    assert.ok(codesOf(rep).includes(code), `${name}: ${codesOf(rep)}`);
    assert.ok(attestationIntegrityProblems(rep).includes(code), name);
    assert.equal(rep.attestation, 'NOT_PROVEN', name);
  };
  broken('tampered bytes', (a) => { a.rawPayloads[digests[0]].body = a.rawPayloads[digests[0]].body.replace('4.10', '4.11'); }, 'RAW_PAYLOAD_DIGEST_MISMATCH');
  broken('bytes dropped', (a) => { delete a.rawPayloads[digests[1]].body; }, 'RAW_BYTES_MISSING');
  broken('record names no bytes', (a) => { a.records[0].rawPayloadDigest = null; }, 'RECORD_WITHOUT_RAW_PAYLOAD');
  broken('record names bytes not kept', (a) => { a.records[2].rawPayloadDigest = `sha256:${'0'.repeat(64)}`; }, 'RAW_PAYLOAD_MISSING');
  broken('kept bytes nobody names', (a) => { a.rawPayloads[`sha256:${'1'.repeat(64)}`] = { parser: 'fred', symbol: 'VIX', body: '{}' }; }, 'ORPHAN_RAW_PAYLOAD');
  broken('captures reordered', (a) => { a.records = [a.records[2], a.records[0], a.records[1]]; }, 'CAPTURES_OUT_OF_ORDER');
  broken('one capture received at two instants', (a) => { a.records[1].ingestedAt = '2026-10-01T06:00:01Z'; }, 'CAPTURE_RECEPTION_NOT_SINGLE');
  broken('duplicate payload for two series', (a) => { a.records[1].sourceRecordId = 'DFII10'; }, 'PAYLOAD_SHARED_BY_SERIES');
  broken('series no capture code knows', (a) => { for (const r of a.records.slice(0, 2)) r.sourceRecordId = 'T10YIE'; }, 'UNKNOWN_SERIES');
  broken('bytes relabelled to another provider', (a) => { a.rawPayloads[digests[1]].parser = 'fred'; }, 'UNKNOWN_SERIES');
  broken('bytes relabelled to another symbol', (a) => { a.rawPayloads[digests[1]].symbol = 'VIX'; }, 'UNKNOWN_SERIES');

  // An attestation manifest: a second declaration. It can name a collector and a licence, contradict the log, never upgrade it.
  const manifest = (over = {}) => ({ schemaVersion: ATTESTATION_MANIFEST_FORMAT, archiveId: 'att-log',
    attestedBy: { kind: 'OPERATOR', name: 'opérateur de test' },
    collector: { name: 'market_evidence_capture.mjs', version: 'test' },
    licence: { termsReference: 'conditions du fournisseur (à relire)', redistribution: 'UNKNOWN', retention: 'non définie' },
    captures: ok.captures.map((c) => ({ rawPayloadDigest: c.rawPayloadDigest, receivedAt: c.receivedAt })), ...over });
  const declared = audit(logA, manifest());
  assert.deepEqual([declared.outcome, declared.attestedBy, declared.collector, declared.licence, declared.attestation],
    ['BYTES_CONSISTENT', 'OPERATOR_DECLARED', 'DECLARED_UNVERIFIED', 'DECLARED_UNVERIFIED', 'NOT_PROVEN']);
  assert.deepEqual(codesOf(declared), []);
  for (const [name, m, code] of [
    ['collector attestation (needs a signature nothing checks)', manifest({ attestedBy: { kind: 'COLLECTOR', name: 'collecteur' } }), 'MANIFEST_CLAIM_EXCEEDS_PROOF'],
    ['signature field', manifest({ attestedBy: { kind: 'OPERATOR', name: 'x', signature: 'abc' } }), 'MANIFEST_CLAIM_EXCEEDS_PROOF'],
    ['self-described as verified', manifest({ licence: { termsReference: 'licence VERIFIED', redistribution: 'ALLOWED', retention: '1 an' } }), 'MANIFEST_CLAIM_EXCEEDS_PROOF'],
    ['another archive', manifest({ archiveId: 'other' }), 'MANIFEST_ARCHIVE_MISMATCH'],
    ['unknown key', manifest({ trusted: true }), 'MANIFEST_UNKNOWN_KEY'],
    ['wrong format', manifest({ schemaVersion: 'v0' }), 'MANIFEST_FORMAT_UNKNOWN'],
    ['licence without retention', manifest({ licence: { termsReference: 'x', redistribution: 'ALLOWED' } }), 'MANIFEST_LICENCE_INVALID'],
    ['a capture left out', manifest({ captures: [{ rawPayloadDigest: digests[0], receivedAt: '2026-10-01T06:00:00Z' }] }), 'MANIFEST_CAPTURE_MISSING'],
    ['another reception instant', manifest({ captures: ok.captures.map((c, i) => ({ rawPayloadDigest: c.rawPayloadDigest, receivedAt: i ? '2026-10-01T14:14:04Z' : c.receivedAt })) }), 'MANIFEST_RECEPTION_MISMATCH'],
    ['a capture the log does not hold', manifest({ captures: [...manifest().captures, { rawPayloadDigest: `sha256:${'2'.repeat(64)}`, receivedAt: '2026-10-01T06:00:00Z' }] }), 'MANIFEST_CAPTURE_UNKNOWN'],
    ['unreadable', 'UNREADABLE', 'MANIFEST_UNREADABLE'],
  ]) {
    const rep = audit(logA, m);
    assert.ok(codesOf(rep).includes(code), `${name}: ${codesOf(rep)}`);
    assert.ok(attestationIntegrityProblems(rep).includes(code), name);
    assert.equal(rep.attestation, 'NOT_PROVEN', name);
    assert.notEqual(rep.collector === 'DECLARED_UNVERIFIED' && !rep.manifest.usable, true, `${name}: a refused manifest declares nothing`);
  }
  // A synthetic log stays not captured, whatever a manifest says.
  assert.equal(audit({ ...logA, provenanceClass: 'SYNTHETIC_FIXTURE' }, manifest()).attestedBy, 'NOT_CAPTURED');
  // The report never overstates itself, and the validator refuses one that would.
  assert.deepEqual(attestationIntegrityProblems({ ...ok, attestation: 'PROVEN' }), ['ATTESTATION_OVERSTATED']);
  assert.deepEqual(attestationIntegrityProblems({ ...ok, upgradesReplay: true }), ['ATTESTATION_OVERSTATED']);
  assert.equal(auditCaptureAttestation(null).outcome, 'NOT_EVALUATED');
  // Report only: the replay of the same log is unchanged by the audit (same digest before and after).
  const ev2 = await load('market_engine/evidence_archive.ts');
  const before = await ev2.replayMarketEvidence(logA, '2026-10-01T14:14:03Z', { parsers: P });
  audit(logA, manifest());
  assert.equal((await ev2.replayMarketEvidence(logA, '2026-10-01T14:14:03Z', { parsers: P })).digest, before.digest);
  assert.notEqual(before.status, 'VERIFIED');
  // End to end: the validator reads attestation.json beside archive.json as a declaration; an overclaim fails it.
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const pathm = await import('node:path');
  const dir = mkdtempSync(pathm.join(process.env.TMPDIR || tmpdir(), 'att-'));
  const out = mkdtempSync(pathm.join(process.env.TMPDIR || tmpdir(), 'att-out-'));
  try {
    mkdirSync(pathm.join(dir, 'log'));
    const file = pathm.join(dir, 'log', 'archive.json');
    writeFileSync(file, JSON.stringify(logA));
    const cli = new URL('../scripts/validate_evidence_captures.mjs', import.meta.url).pathname;
    let run = spawnSync(process.execPath, [cli, '--out', out, file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /attestation att-log: BYTES_CONSISTENT, 2 capture\(s\), attested by OPERATOR_DECLARED, collector NOT_RECORDED, licence NOT_RECORDED; attestation NOT_PROVEN/);
    writeFileSync(pathm.join(dir, 'log', 'attestation.json'), JSON.stringify(manifest({ attestedBy: { kind: 'COLLECTOR', name: 'collecteur' } })));
    run = spawnSync(process.execPath, [cli, '--out', out, file], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL source att-log: every capture keeps its exact bytes.* MANIFEST_CLAIM_EXCEEDS_PROOF/);
    writeFileSync(pathm.join(dir, 'log', 'attestation.json'), JSON.stringify(manifest()));
    run = spawnSync(process.execPath, [cli, '--out', out, file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /collector DECLARED_UNVERIFIED, licence DECLARED_UNVERIFIED; attestation NOT_PROVEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}
console.log('PASS DATA-3 raw-storage contract: kept bytes, digest, series, reception and order checked per capture; manifests declare, never prove');
