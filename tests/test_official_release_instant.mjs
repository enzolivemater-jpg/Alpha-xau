/**
 * B3: an event version built from an official release must not be known
 * before that release was published. The adapters carry the publication
 * instant (UTC) parsed from the release's own text; the admission check
 * refuses a knowledge cutoff earlier than it, exactly to the nanosecond.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const [instant, cpi, nfp, claims, pce] = await Promise.all([
  loadBackendModule('event_facts/official_release_instant.ts'),
  loadBackendModule('event_facts/bls_cpi_adapter.ts'),
  loadBackendModule('event_facts/bls_employment_situation_adapter.ts'),
  loadBackendModule('event_facts/dol_ui_weekly_claims_adapter.ts'),
  loadBackendModule('event_facts/bea_pce_adapter.ts'),
]);
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// --- Every committed official fixture: the adapter carries its UTC publication instant.
const OFFICIAL = [
  [cpi.mapBlsCpiReleaseToEventFacts, 'bls_cpi_table1_2026_07.json', '2026-08-12T12:30:00.000Z'],
  [cpi.mapBlsCpiReleaseToEventFacts, 'bls_cpi_table1_2026_08.json', '2026-09-11T12:30:00.000Z'],
  [nfp.mapBlsEmploymentReleaseToEventFacts, 'bls_employment_situation_2026_07.json', '2026-08-07T12:30:00.000Z'],
  [nfp.mapBlsEmploymentReleaseToEventFacts, 'bls_employment_situation_2026_08.json', '2026-09-04T12:30:00.000Z'],
  [claims.mapDolUiWeeklyClaimsReleaseToEventFacts, 'dol_ui_weekly_claims_2026_10_01.json', '2026-10-01T12:30:00.000Z'],
  [pce.mapBeaPceReleaseToEventFacts, 'bea_pce_2026_07.json', '2026-08-26T12:30:00.000Z'],
  [pce.mapBeaPceReleaseToEventFacts, 'bea_pce_2026_08.json', '2026-09-30T12:30:00.000Z'],
];
// July NFP stays UNAVAILABLE on purpose (July AHE month-over-month is fail-closed): its text still parses.
const UNAVAILABLE_BY_DESIGN = new Set(['bls_employment_situation_2026_07.json']);
for (const [map, file, expected] of OFFICIAL) {
  const document = fixture(file);
  const result = map(document);
  assert.equal(instant.parseOfficialReleaseInstant(document.release.publicReleaseAtRaw), expected, file);
  if (UNAVAILABLE_BY_DESIGN.has(file)) {
    assert.equal(result.kind, 'UNAVAILABLE', file);
    assert.equal('publishedAt' in result, false, `${file}: only a RESOLVED result carries an instant`);
    continue;
  }
  assert.equal(result.kind, 'RESOLVED', file);
  assert.equal(result.publishedAt, expected, `${file}: ${document.release.publicReleaseAtRaw}`);
}
console.log(`PASS the ${OFFICIAL.length} official fixture texts parse to UTC; the ${OFFICIAL.length - UNAVAILABLE_BY_DESIGN.size} resolved ones carry it`);

// --- Parsing: US Eastern time with daylight saving, weekday and zone checked, anything else null.
const PARSED = [
  ['8:30 a.m. (ET) Friday, January 9, 2026', '2026-01-09T13:30:00.000Z'],
  ['8:30 a.m. (ET) Friday, March 6, 2026', '2026-03-06T13:30:00.000Z'], // before DST (8 March 2026)
  ['8:30 a.m. (ET) Thursday, March 12, 2026', '2026-03-12T12:30:00.000Z'],
  ['8:30 a.m. (ET) Friday, October 30, 2026', '2026-10-30T12:30:00.000Z'], // DST ends 1 November 2026
  ['8:30 a.m. (ET) Friday, November 6, 2026', '2026-11-06T13:30:00.000Z'],
  ['8:30 A.M. (Eastern) Thursday, December 31, 2026', '2026-12-31T13:30:00.000Z'],
  ['EMBARGOED UNTIL RELEASE AT 8:30 a.m. EST, Friday, January 30, 2026', '2026-01-30T13:30:00.000Z'],
  ['10:00 a.m. (ET) Wednesday, September 30, 2026', '2026-09-30T14:00:00.000Z'],
  ['12:00 p.m. (ET) Wednesday, September 30, 2026', '2026-09-30T16:00:00.000Z'],
  ['12:15 a.m. (ET) Wednesday, September 30, 2026', '2026-09-30T04:15:00.000Z'],
  ['1:59 a.m. (ET) Sunday, March 8, 2026', '2026-03-08T06:59:00.000Z'], // last EST minute
  ['3:00 a.m. (ET) Sunday, March 8, 2026', '2026-03-08T07:00:00.000Z'], // first EDT hour
  ['12:59 a.m. (ET) Sunday, November 1, 2026', '2026-11-01T04:59:00.000Z'], // still EDT
  ['2:00 a.m. (ET) Sunday, November 1, 2026', '2026-11-01T07:00:00.000Z'], // EST again
  ['11:30 p.m. (ET) Thursday, December 31, 2026', '2027-01-01T04:30:00.000Z'], // UTC day rolls over
  ['8:30 a.m. (ET) Tuesday, February 29, 2028', '2028-02-29T13:30:00.000Z'],
];
for (const [raw, expected] of PARSED) assert.equal(instant.parseOfficialReleaseInstant(raw), expected, raw);
const REFUSED = [
  'EMBARGOED UNTIL RELEASE AT 8:30 a.m. EST, Wednesday, September 30, 2026', // EST in summer
  'EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Friday, January 30, 2026', // EDT in winter
  '8:30 a.m. (ET) Thursday, September 11, 2026', // 11 September 2026 is a Friday
  '8:30 a.m. (ET) Monday, February 30, 2026',
  '8:30 a.m. (ET) Sunday, February 29, 2026', // 2026 is not a leap year
  '2:30 a.m. (ET) Sunday, March 8, 2026', // does not exist (spring forward)
  '1:30 a.m. (ET) Sunday, November 1, 2026', // ambiguous (fall back)
  '8:30 a.m. (ET) Friday, September 8, 2006', // before the 2007 daylight-saving rule
  '13:30 a.m. (ET) Friday, September 11, 2026',
  '0:30 a.m. (ET) Friday, September 11, 2026',
  '8:60 a.m. (ET) Friday, September 11, 2026',
  '8:30 a.m. (PT) Friday, September 11, 2026',
  '8:30 a.m. Friday, September 11, 2026',
  ' 8:30 a.m. (ET) Friday, September 11, 2026',
  '8:30 a.m. (ET) Friday, September 11, 2026 ',
  '8:30 a.m. (ET) Friday, Sept 11, 2026',
  '8:30 a.m. (ET) Friday, September 11, 0000',
  '8:30 a.m. (ET) Friday, September 011, 2026',
  '', '2026-09-11T12:30:00Z', null, undefined, 0, {}, [], 'x'.repeat(100_000),
];
for (const raw of REFUSED) assert.equal(instant.parseOfficialReleaseInstant(raw), null, String(raw).slice(0, 80));
console.log(`PASS ${PARSED.length} release texts parse to UTC; ${REFUSED.length} malformed or contradictory ones are null`);

// --- Admission: a CPI published on 11 September is not knowable on 1 September.
const cpiResult = cpi.mapBlsCpiReleaseToEventFacts(fixture('bls_cpi_table1_2026_08.json'));
const admit = (cutoff, result = cpiResult) => instant.admitEventVersionAtOfficialRelease(result, cutoff);
const refused = admit('2026-09-01T00:00:00.000Z');
assert.deepEqual(refused, { kind: 'REFUSED', reason: 'KNOWN_BEFORE_OFFICIAL_RELEASE', publishedAt: '2026-09-11T12:30:00.000Z' });
assert.equal(admit('2026-09-11T12:29:59.999999999Z').kind, 'REFUSED', '1 ns before the release');
assert.equal(admit('2026-09-11T08:29:59.999-04:00').kind, 'REFUSED', 'offset form, 1 ms before');
assert.deepEqual(admit('2026-09-11T12:30:00Z'), { kind: 'ADMITTED', reason: null, publishedAt: '2026-09-11T12:30:00.000Z' });
assert.equal(admit('2026-09-11T08:30:00-04:00').kind, 'ADMITTED', 'same instant in local offset');
assert.equal(admit('2026-10-01T14:15:00.000Z').kind, 'ADMITTED');
for (const cutoff of ['2026-09-31T12:30:00Z', '2026-09-12', 'x', '', null, 1789000000000, {}]) {
  assert.deepEqual(admit(cutoff), { kind: 'REFUSED', reason: 'INVALID_KNOWLEDGE_CUTOFF', publishedAt: '2026-09-11T12:30:00.000Z' }, String(cutoff));
}
// A release whose instant is unknown, or a result that did not resolve, is never admitted.
assert.deepEqual(admit('2026-10-01T14:15:00.000Z', { ...cpiResult, publishedAt: null }),
  { kind: 'REFUSED', reason: 'RELEASE_INSTANT_UNKNOWN', publishedAt: null });
assert.deepEqual(admit('2026-10-01T14:15:00.000Z', { ...cpiResult, publishedAt: '2026-09-11' }),
  { kind: 'REFUSED', reason: 'RELEASE_INSTANT_UNKNOWN', publishedAt: null });
const malformed = fixture('bls_cpi_table1_2026_08.json');
malformed.release.releaseId = '';
const notResolved = cpi.mapBlsCpiReleaseToEventFacts(malformed);
assert.notEqual(notResolved.kind, 'RESOLVED');
assert.deepEqual(admit('2026-10-01T14:15:00.000Z', notResolved), { kind: 'REFUSED', reason: 'ADAPTER_NOT_RESOLVED', publishedAt: null });
for (const hostile of [null, undefined, 'RESOLVED', [], {}, { kind: 'RESOLVED' }]) {
  assert.equal(instant.admitEventVersionAtOfficialRelease(hostile, '2026-10-01T14:15:00.000Z').kind, 'REFUSED', String(hostile));
}
const before = JSON.stringify(cpiResult);
assert.deepEqual(admit('2026-09-01T00:00:00.000Z'), refused, 'deterministic');
assert.equal(JSON.stringify(cpiResult), before, 'admission does not mutate the adapter result');
console.log('PASS a CPI published on 11 September is refused at a 1 September cutoff, and up to 1 ns before its release');

// --- An unparseable release text keeps the adapter result RESOLVED (no contract change) but unknown in time.
const odd = fixture('bls_cpi_table1_2026_08.json');
odd.release.publicReleaseAtRaw = 'Friday morning';
const oddResult = cpi.mapBlsCpiReleaseToEventFacts(odd);
assert.equal(oddResult.kind, 'RESOLVED');
assert.equal(oddResult.publishedAt, null);
assert.equal(admit('2026-10-01T14:15:00.000Z', oddResult).reason, 'RELEASE_INSTANT_UNKNOWN');
const { publishedAt: _omit, ...rest } = oddResult;
const { publishedAt: _omit2, ...official } = cpiResult;
assert.deepEqual(rest.canonicalEventState, official.canonicalEventState, 'the canonical event state is unchanged');
console.log('PASS an unparseable release text stays RESOLVED with an unknown instant, so it is never admitted');

// --- The four adapters carry a byte-identical copy of the reference block, and agree with it.
const blockOf = (file) => {
  const source = readFileSync(new URL(`../backend/event_facts/${file}`, import.meta.url), 'utf8');
  const begin = source.indexOf('// BEGIN official-release-instant (B3)');
  const end = source.indexOf('// END official-release-instant (B3)');
  assert.ok(begin >= 0 && end > begin, `${file}: block markers`);
  assert.equal(source.indexOf('// BEGIN official-release-instant (B3)', begin + 1), -1, `${file}: one block`);
  return source.slice(begin, end);
};
const reference = blockOf('official_release_instant.ts');
for (const file of ['bls_cpi_adapter.ts', 'bls_employment_situation_adapter.ts', 'dol_ui_weekly_claims_adapter.ts', 'bea_pce_adapter.ts']) {
  assert.equal(blockOf(file), reference, `${file}: copy drifted from official_release_instant.ts`);
}
const corpus = [...PARSED.map(([raw]) => raw), ...REFUSED.filter((raw) => typeof raw === 'string'),
  ...OFFICIAL.map(([, file]) => fixture(file).release.publicReleaseAtRaw)];
let resolvedCompared = 0;
for (const [map, file] of OFFICIAL.filter(([, file]) => !UNAVAILABLE_BY_DESIGN.has(file))) {
  for (const raw of corpus) {
    const document = fixture(file);
    document.release.publicReleaseAtRaw = raw;
    const result = map(document);
    if (result.kind !== 'RESOLVED') continue; // some adapters already refuse texts outside their own format
    assert.equal(result.publishedAt, instant.parseOfficialReleaseInstant(raw), `${file}: ${raw}`);
    resolvedCompared += 1;
  }
}
assert.ok(resolvedCompared >= 100, `parity exercised on ${resolvedCompared} resolved results`);
const throwing = new Proxy({}, { get() { throw new Error('hostile'); } });
assert.deepEqual(instant.admitEventVersionAtOfficialRelease(throwing, '2026-10-01T14:15:00.000Z'),
  { kind: 'REFUSED', reason: 'ADAPTER_NOT_RESOLVED', publishedAt: null });
console.log(`PASS the 4 adapters carry the reference block byte for byte and agree with it on ${resolvedCompared} resolved results`);
