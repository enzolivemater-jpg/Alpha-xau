import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';

// Prime Node's type-stripping resolver for the .js specifiers used by TS sources.
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';
import { parseBlsCpiArtifacts } from '../backend/event_facts/bls_cpi_artifact_parser.ts';
import { resolveActiveReleaseIdentity } from '../backend/event_facts/release_identity_lookup.ts';
import {
  BLS_CPI_PRODUCER_PLANNER_VERSION,
  planBlsCpiProduction,
} from '../backend/event_facts/bls_cpi_producer_planner.ts';

const headerBytes = strToU8(`<!doctype html><body>
Transmission of material in this release is embargoed until
8:30 a.m. (ET) Friday, September 11, 2026 &nbsp; USDL-26-1496
<h1>CONSUMER PRICE INDEX - AUGUST 2026</h1></body>`);
const strings = [
  'Table 1. Consumer Price Index for All Urban Consumers (CPI-U): U.S. city average, by expenditure category, August 2026',
  'Aug. 2025-Aug. 2026', 'Jul. 2026-Aug. 2026', 'All items',
  'All items less food and energy', 'Unadjusted percent change',
  'Seasonally adjusted percent change',
];
const shared = `<?xml version="1.0"?><sst>${strings.map(value => `<si><t>${value}</t></si>`).join('')}</sst>`;
const sheet = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="B1" t="s"><v>0</v></c></row>
<row r="4"><c r="G4" t="s"><v>5</v></c><c r="K4" t="s"><v>6</v></c></row>
<row r="5"><c r="G5" t="s"><v>1</v></c><c r="K5" t="s"><v>2</v></c></row>
<row r="7"><c r="B7" t="s"><v>3</v></c><c r="G7"><v>3.4</v></c><c r="K7"><v>0.4</v></c></row>
<row r="27"><c r="B27" t="s"><v>4</v></c><c r="G27"><v>2.4</v></c><c r="K27"><v>0.3</v></c></row>
</sheetData></worksheet>`;
const input = {
  headerBytes,
  headerArchivePath: '/news.release/archives/cpi_09112026.htm',
  table1Bytes: zipSync({
    'xl/sharedStrings.xml': strToU8(shared),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  }),
  table1ArtifactPath: '/cpi/tables/supplemental-files/news-release-table1-202608.xlsx',
};

function db(rows, error = null) {
  return { calls: [], async request(method, path, body) {
    this.calls.push({ method, path, body });
    if (error) throw error;
    return structuredClone(rows);
  } };
}
const dependencies = database => ({
  parse: parseBlsCpiArtifacts,
  adapt: mapBlsCpiReleaseToEventFacts,
  lookupIdentity: proposal => resolveActiveReleaseIdentity(database, proposal),
});

assert.equal(BLS_CPI_PRODUCER_PLANNER_VERSION, 'bls-cpi-producer-planner-v1');
const identityValue = '{"authority":"us_bls","release_family":"US_CPI","release_id":"USDL-26-1496","release_stage":"SINGLE","strategy":"OFFICIAL_RELEASE_ID","strategy_version":"bls_cpi_v1"}';
const key = createHash('sha256').update([
  'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', identityValue,
].join('\u001f')).digest('hex');
const lookup = db([{
  cluster_id: '11111111-1111-4111-8111-111111111111',
  identity_claim_id: '22222222-2222-4222-8222-222222222222',
  strong_identity_key: key,
}]);
const ready = await planBlsCpiProduction(dependencies(lookup), input);
assert.equal(ready.kind, 'READY', JSON.stringify(ready));
assert.equal(ready.canonicalEventStateSchemaVersion, 2);
assert.deepEqual(ready.identity.candidateClusterIds, ['11111111-1111-4111-8111-111111111111']);
assert.equal(ready.canonicalEventState.facts.metrics.length, 4);
assert.equal(lookup.calls.length, 1);
console.log('PASS exact retained artifacts produce one bounded, lookup-resolved CES V2 plan');

const malformedDb = db([]);
const malformed = await planBlsCpiProduction(dependencies(malformedDb), { ...input, headerBytes: new Uint8Array([0xff]) });
assert.deepEqual(malformed, {
  kind: 'BLOCKED', plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
  stage: 'PARSER', reason: 'MALFORMED:RELEASE_HEADER_MALFORMED',
});
assert.equal(malformedDb.calls.length, 0);
console.log('PASS parser failure blocks before identity lookup');

const unavailable = await planBlsCpiProduction(dependencies(db([], new Error('secret'))), input);
assert.deepEqual(unavailable, {
  kind: 'BLOCKED', plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
  stage: 'IDENTITY_LOOKUP', reason: 'IDENTITY_LOOKUP_UNAVAILABLE',
});
console.log('PASS unavailable identity lookup fails closed without leaking database detail');

const source = readFileSync(new URL('../backend/event_facts/bls_cpi_producer_planner.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|Date\.|new Date|Math\.random|fn_event_create|fn_event_assert|INSERT|UPDATE|DELETE/i);
console.log('PASS planner has no fetch, clock, environment, mutation RPC, or SQL write path');
