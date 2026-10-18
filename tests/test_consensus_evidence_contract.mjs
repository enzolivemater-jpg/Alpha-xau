// P2 — consensus evidence contract C-0. A consensus figure is checked against
// the RESOLVED official adapter result it claims to forecast (same release,
// metric, period, unit; published strictly before the release; known at the
// cutoff); valid figures are kept and counted, yet consensus stays UNKNOWN and
// no surprise is computed: no source or methodology is approved. The official
// results come from the repository's official-release fixtures; every consensus
// figure below is invented by this test and says so in its source name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const c0 = await loadBackendModule('event_facts/consensus_evidence_contract.ts');
const cpiAdapter = await loadBackendModule('event_facts/bls_cpi_adapter.ts');
const dolAdapter = await loadBackendModule('event_facts/dol_ui_weekly_claims_adapter.ts');
const gt = await loadBackendModule('gold_transmission/deterministic_processor.ts');
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const cpi = cpiAdapter.mapBlsCpiReleaseToEventFacts(fixture('bls_cpi_table1_2026_08.json'));
const claims = dolAdapter.mapDolUiWeeklyClaimsReleaseToEventFacts(fixture('dol_ui_weekly_claims_2026_10_01.json'));
assert.equal(cpi.kind, 'RESOLVED');
assert.equal(claims.kind, 'RESOLVED');
assert.equal(c0.CONSENSUS_EVIDENCE_SCHEMA_VERSION, 'xau.consensus-evidence.v1');
assert.equal(c0.CONSENSUS_EVIDENCE_ALGORITHM_VERSION, 'consensus-evidence-normalizer-1.0.0');

const RELEASE = cpi.publishedAt; // 2026-09-11T12:30:00.000Z
const AFTER = '2026-09-11T13:00:00.000Z';
const figure = (over = {}) => ({
  sourceAuthority: 'synthetic_test_survey', datasetCode: 'invented_median', statistic: 'MEDIAN',
  releaseIdentityType: cpi.releaseIdentity.identityType, releaseIdentityValue: cpi.releaseIdentity.identityValue,
  metricCode: 'CPI_CORE_MOM', referencePeriod: { kind: 'MONTH', year: 2026, month: 8 }, unit: 'PERCENT_CHANGE_MOM',
  value: '0.3', publishedAt: '2026-09-10T20:00:00.000Z', observedAt: '2026-09-10T20:05:00.000Z',
  artifactId: `sha256:${'a'.repeat(64)}`, revision: null, ...over,
});

// --- Valid figures are kept and counted; consensus stays UNKNOWN; always abstains.
const ok = c0.buildConsensusEvidenceEnvelope(cpi, [figure(), figure({ metricCode: 'CPI_HEADLINE_YOY', unit: 'PERCENT_CHANGE_YOY', value: '2.9' })], AFTER);
assert.equal(ok.evidenceState, 'ABSTAIN');
assert.equal(ok.consensusState, 'UNKNOWN');
assert.deepEqual(ok.reasonCodes, ['CONSENSUS_SOURCE_NOT_APPROVED', 'CONSENSUS_METHODOLOGY_NOT_APPROVED']);
assert.equal(ok.evidence.length, 2);
assert.deepEqual(ok.refused, []);
assert.equal(ok.releasePublishedAt, RELEASE);
assert.deepEqual(ok.metrics.map((m) => [m.metricCode, m.validEvidenceCount]),
  cpi.canonicalEventState.facts.metrics.map((m) => [m.metric_code, ['CPI_CORE_MOM', 'CPI_HEADLINE_YOY'].includes(m.metric_code) ? 1 : 0]));
for (const m of ok.metrics) assert.deepEqual(m.consensus, { state: 'UNKNOWN', value: null });
assert.ok(!JSON.stringify(ok).match(/surprise|deviation|BULLISH|BEARISH/i), 'no surprise or direction anywhere');
// Weekly release: WEEK_ENDING periods match the claims adapter.
const week = claims.canonicalEventState.facts.metrics.find((m) => m.metric_code === 'INITIAL_CLAIMS');
const claimsOk = c0.buildConsensusEvidenceEnvelope(claims, [figure({
  releaseIdentityType: claims.releaseIdentity.identityType, releaseIdentityValue: claims.releaseIdentity.identityValue,
  metricCode: 'INITIAL_CLAIMS', referencePeriod: { ...week.reference_period }, unit: 'THOUSANDS_OF_PERSONS', value: '225',
  publishedAt: '2026-09-30T20:00:00.000Z', observedAt: '2026-09-30T20:00:00.000Z' })], '2026-10-02T00:00:00.000Z');
assert.deepEqual(claimsOk.refused, [], JSON.stringify(claimsOk.refused));
assert.equal(claimsOk.metrics.find((m) => m.metricCode === 'INITIAL_CLAIMS').validEvidenceCount, 1);
// Deterministic and order-independent.
const many = [figure(), figure({ sourceAuthority: 'synthetic_other', value: '0.2' }), figure({ statistic: 'MEAN', value: '0.25' })];
assert.deepEqual(c0.buildConsensusEvidenceEnvelope(cpi, many, AFTER), c0.buildConsensusEvidenceEnvelope(cpi, many, AFTER));
assert.deepEqual(c0.buildConsensusEvidenceEnvelope(cpi, many, AFTER).evidence, c0.buildConsensusEvidenceEnvelope(cpi, [...many].reverse(), AFTER).evidence);
console.log('PASS valid figures are matched to the official release and counted; consensus stays UNKNOWN, no surprise');

// --- Each defect refuses the figure with its own reason.
const cases = [
  ['figure published at the release instant', figure({ publishedAt: RELEASE, observedAt: RELEASE }), 'CONSENSUS_NOT_BEFORE_RELEASE'],
  ['figure published after the release', figure({ publishedAt: AFTER, observedAt: AFTER }), 'CONSENSUS_NOT_BEFORE_RELEASE'],
  ['retrieved after the cutoff', figure({ observedAt: '2026-09-11T13:30:00.000Z' }), 'EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'],
  ['other release', figure({ releaseIdentityValue: claims.releaseIdentity.identityValue }), 'RELEASE_IDENTITY_MISMATCH'],
  ['metric not in this release', figure({ metricCode: 'NFP_PAYROLL_CHANGE', unit: 'THOUSANDS_OF_PERSONS' }), 'METRIC_NOT_IN_RELEASE'],
  ['previous month', figure({ referencePeriod: { kind: 'MONTH', year: 2026, month: 7 } }), 'REFERENCE_PERIOD_MISMATCH'],
  ['week instead of month', figure({ referencePeriod: { kind: 'WEEK_ENDING', date: '2026-08-29' } }), 'REFERENCE_PERIOD_MISMATCH'],
  ['year-over-year unit on a MoM metric', figure({ unit: 'PERCENT_CHANGE_YOY' }), 'UNIT_MISMATCH'],
  ['retrieved before published', figure({ observedAt: '2026-09-10T19:00:00.000Z' }), 'INVALID_EVIDENCE_SHAPE'],
  ['number instead of decimal text', figure({ value: 0.3 }), 'INVALID_EVIDENCE_SHAPE'],
  ['comma decimal', figure({ value: '0,3' }), 'INVALID_EVIDENCE_SHAPE'],
  ['implicit-zone timestamp', figure({ publishedAt: '2026-09-10T20:00:00' }), 'INVALID_EVIDENCE_SHAPE'],
  ['extra key', { ...figure(), surprise: '0.1' }, 'INVALID_EVIDENCE_SHAPE'],
  ['missing revision key', (() => { const f = figure(); delete f.revision; return f; })(), 'INVALID_EVIDENCE_SHAPE'],
  ['impossible month', figure({ referencePeriod: { kind: 'MONTH', year: 2026, month: 13 } }), 'INVALID_EVIDENCE_SHAPE'],
  ['unknown statistic', figure({ statistic: 'MODE' }), 'INVALID_EVIDENCE_SHAPE'],
  ['bad artifact', figure({ artifactId: 'sha256:xyz' }), 'INVALID_EVIDENCE_SHAPE'],
];
for (const [name, bad, reason] of cases) {
  const out = c0.buildConsensusEvidenceEnvelope(cpi, [figure(), bad], AFTER);
  assert.deepEqual(out.refused, [{ index: 1, reason }], name);
  assert.ok(out.reasonCodes.includes(reason), name);
  assert.equal(out.evidence.length, 1, `${name}: the valid figure is kept`);
  assert.equal(out.consensusState, 'UNKNOWN');
}
const dup = c0.buildConsensusEvidenceEnvelope(cpi, [figure(), figure({ value: '0.4' })], AFTER);
assert.deepEqual(dup.refused, [{ index: 1, reason: 'DUPLICATE_EVIDENCE_KEY' }]);
const revised = c0.buildConsensusEvidenceEnvelope(cpi, [figure(), figure({ value: '0.4', revision: 'r2' })], AFTER);
assert.deepEqual(revised.refused, [], 'an explicit revision is a distinct figure');
console.log(`PASS ${cases.length + 1} defects each refuse the figure with their own reason; valid figures are kept`);

// --- Release side: no resolved release, bad cutoff, nothing supplied: refuse, never throw.
for (const [release, evidence, cutoff, reason] of [
  [{ kind: 'NOT_FOUND' }, [figure()], AFTER, 'RELEASE_NOT_RESOLVED'],
  [{ ...cpi, publishedAt: '2026-09-11' }, [figure()], AFTER, 'RELEASE_NOT_RESOLVED'],
  [null, [figure()], AFTER, 'RELEASE_NOT_RESOLVED'],
  [cpi, [figure()], '2026-09-11', 'INVALID_KNOWLEDGE_CUTOFF'],
  [cpi, [], AFTER, 'NO_CONSENSUS_EVIDENCE'],
  [cpi, 'not a list', AFTER, 'INVALID_EVIDENCE_SHAPE'],
]) {
  const out = c0.buildConsensusEvidenceEnvelope(release, evidence, cutoff);
  assert.ok(out.reasonCodes.includes(reason), `${reason}: ${out.reasonCodes}`);
  assert.equal(out.evidence.length, 0);
  assert.equal(out.evidenceState, 'ABSTAIN');
}
const hostile = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
assert.equal(c0.buildConsensusEvidenceEnvelope(hostile, [hostile], AFTER).evidenceState, 'ABSTAIN');
// Gold Transmission still refuses a known consensus: C-0 changes no consumer.
const metrics = cpi.canonicalEventState.facts.metrics.map((m) => ({ ...m, consensus: { state: 'KNOWN', value: '0.3' } }));
const plan = gt.planDeterministicGoldTransmission({ eventVersion: {
  id: '11111111-1111-4111-8111-111111111111', clusterId: '22222222-2222-4222-8222-222222222222', versionNumber: 1,
  transitionType: 'NOVELTY', knowledgeCutoff: '2026-09-22T00:00:00.123456Z', effectiveTime: null, effectiveTimePrecision: null,
  canonicalEventStateSchemaVersion: 2, canonicalEventState: { ...cpi.canonicalEventState, facts: { ...cpi.canonicalEventState.facts, metrics } },
  officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN' } });
assert.notEqual(plan.assessmentStatus, 'ASSESSED');
const source = readFileSync(new URL('../backend/event_facts/consensus_evidence_contract.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bfetch\(|Date\.now|new Date\(\)|process\.|import\(/);
console.log('PASS unresolved release, bad cutoff, empty or hostile input abstain; consumers still refuse a known consensus; pure');
