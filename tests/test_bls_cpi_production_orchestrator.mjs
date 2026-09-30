import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';
import { parseBlsCpiArtifacts } from '../backend/event_facts/bls_cpi_artifact_parser.ts';
import { resolveActiveReleaseIdentity } from '../backend/event_facts/release_identity_lookup.ts';
// Prime Node's type-stripping resolver for the orchestrator's .js specifiers.
import { planBlsCpiProduction } from '../backend/event_facts/bls_cpi_producer_planner.ts';
import { persistBlsCpiProduction } from '../backend/event_facts/bls_cpi_production_writer.ts';
const {
  BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
  runBlsCpiProductionOnce,
} = await import('../backend/event_facts/bls_cpi_production_orchestrator.ts');

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
const artifacts = {
  headerBytes,
  headerArchivePath: '/news.release/archives/cpi_09112026.htm',
  table1Bytes: zipSync({
    'xl/sharedStrings.xml': strToU8(shared),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  }),
  table1ArtifactPath: '/cpi/tables/supplemental-files/news-release-table1-202608.xlsx',
};
const input = {
  artifacts,
  observationId: '10000000-0000-4000-8000-000000000001',
  headerArtifactId: '20000000-0000-4000-8000-000000000001',
  tableArtifactId: '30000000-0000-4000-8000-000000000001',
  operationIdempotencyFingerprint: 'a'.repeat(64),
};
const identityValue = '{"authority":"us_bls","release_family":"US_CPI","release_id":"USDL-26-1496","release_stage":"SINGLE","strategy":"OFFICIAL_RELEASE_ID","strategy_version":"bls_cpi_v1"}';
const strongIdentityKey = createHash('sha256').update([
  'xau_v2:official_release:us_bls:v1', 'official_release_id:bls_cpi_v1', identityValue,
].join('\u001f')).digest('hex');
const identityRow = {
  cluster_id: '40000000-0000-4000-8000-000000000001',
  identity_claim_id: '60000000-0000-4000-8000-000000000001',
  strong_identity_key: strongIdentityKey,
};
const productionRow = {
  cluster_id: identityRow.cluster_id,
  decision_id: '50000000-0000-4000-8000-000000000001',
  identity_claim_id: identityRow.identity_claim_id,
  event_version_id: '70000000-0000-4000-8000-000000000001',
  version_outcome: 'CREATED',
  operation_replayed: false,
};

function db({ identity = [identityRow], production = [productionRow], failPath = null } = {}) {
  return { calls: [], async request(method, path, body) {
    this.calls.push({ method, path, body });
    if (path === failPath) throw new Error('database secret');
    if (path === '/rpc/fn_event_lookup_active_identity_claims') return structuredClone(identity);
    if (path === '/rpc/fn_event_fact_produce_bls_cpi') return structuredClone(production);
    throw new Error('unexpected path');
  } };
}
const dependencies = database => ({
  db: database,
  plan: planBlsCpiProduction,
  persist: persistBlsCpiProduction,
  parse: parseBlsCpiArtifacts,
  adapt: mapBlsCpiReleaseToEventFacts,
  lookupIdentity: proposal => resolveActiveReleaseIdentity(database, proposal),
});

assert.equal(BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION, 'bls-cpi-production-orchestrator-v1');
const database = db();
const persisted = await runBlsCpiProductionOnce(dependencies(database), input);
assert.deepEqual(persisted, {
  kind: 'PERSISTED', orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
  plannerVersion: 'bls-cpi-producer-planner-v1', writerVersion: 'bls-cpi-production-writer-v1',
  clusterId: productionRow.cluster_id, decisionId: productionRow.decision_id,
  identityClaimId: productionRow.identity_claim_id, eventVersionId: productionRow.event_version_id,
  versionOutcome: 'CREATED', operationReplayed: false,
});
assert.deepEqual(database.calls.map(call => call.path), [
  '/rpc/fn_event_lookup_active_identity_claims', '/rpc/fn_event_fact_produce_bls_cpi',
]);
console.log('PASS exact artifacts flow once through identity lookup and the atomic production RPC');

const malformedDatabase = db();
const malformed = await runBlsCpiProductionOnce(dependencies(malformedDatabase), {
  ...input, artifacts: { ...artifacts, headerBytes: new Uint8Array([0xff]) },
});
assert.equal(malformed.kind, 'BLOCKED');
assert.equal(malformed.stage, 'PARSER');
assert.equal(malformedDatabase.calls.length, 0);
console.log('PASS parser abstention blocks all database I/O');

const identityFailureDb = db({ failPath: '/rpc/fn_event_lookup_active_identity_claims' });
assert.deepEqual(await runBlsCpiProductionOnce(dependencies(identityFailureDb), input), {
  kind: 'BLOCKED', orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
  stage: 'IDENTITY_LOOKUP', reason: 'IDENTITY_LOOKUP_UNAVAILABLE',
});
assert.equal(identityFailureDb.calls.length, 1);
console.log('PASS unavailable identity lookup never reaches persistence');

const productionFailureDb = db({ failPath: '/rpc/fn_event_fact_produce_bls_cpi' });
assert.deepEqual(await runBlsCpiProductionOnce(dependencies(productionFailureDb), input), {
  kind: 'BLOCKED', orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
  stage: 'PERSISTENCE', reason: 'PRODUCTION_RPC_UNAVAILABLE',
});
assert.equal(productionFailureDb.calls.length, 2);
console.log('PASS persistence failure is bounded and never retried');

const malformedResponseDb = db({ production: [{ ...productionRow, extra: true }] });
const malformedResponse = await runBlsCpiProductionOnce(dependencies(malformedResponseDb), input);
assert.equal(malformedResponse.kind, 'BLOCKED');
assert.equal(malformedResponse.stage, 'PERSISTENCE');
assert.equal(malformedResponse.reason, 'PRODUCTION_RESPONSE_MALFORMED');
assert.equal(malformedResponseDb.calls.length, 2);
console.log('PASS malformed atomic response fails closed without retry or detail leakage');

const replayDb = db({ production: [{ ...productionRow, version_outcome: 'NO_MATERIAL_CHANGE', operation_replayed: true }] });
const replay = await runBlsCpiProductionOnce(dependencies(replayDb), input);
assert.equal(replay.kind, 'PERSISTED');
assert.equal(replay.versionOutcome, 'NO_MATERIAL_CHANGE');
assert.equal(replay.operationReplayed, true);
console.log('PASS database-owned exact replay is preserved end to end');

const source = readFileSync(new URL('../backend/event_facts/bls_cpi_production_orchestrator.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|Date\.|new Date|Math\.random|setTimeout|setInterval/i);
assert.doesNotMatch(source, /\bfor\s*\(|\bwhile\s*\(|Promise\.all|\/rest\/v1\//i);
assert.equal((source.match(/dependencies\.plan\(/g) ?? []).length, 1);
assert.equal((source.match(/dependencies\.persist\(/g) ?? []).length, 1);
console.log('PASS orchestrator is one-shot with no fetch, discovery, clock, schedule, loop, or retry');
