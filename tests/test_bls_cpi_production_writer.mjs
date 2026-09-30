import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BLS_CPI_PRODUCTION_WRITER_VERSION,
  BlsCpiProductionWriterError,
  persistBlsCpiProduction,
} from '../backend/event_facts/bls_cpi_production_writer.ts';

const ids = {
  observationId: '10000000-0000-4000-8000-000000000001',
  headerArtifactId: '20000000-0000-4000-8000-000000000001',
  tableArtifactId: '30000000-0000-4000-8000-000000000001',
};
const plan = {
  kind: 'READY',
  plannerVersion: 'bls-cpi-producer-planner-v1',
  parserVersion: 'bls-cpi-artifact-parser-v1',
  adapterVersion: 'bls-cpi-event-facts-adapter-v1',
  canonicalEventStateSchemaVersion: 2,
  canonicalEventState: { event_type: 'STATISTICAL_RELEASE', subject: 'CPI August 2026', detail: null,
    facts: { release_family: 'US_CPI', metrics: [] } },
  identity: {
    authorityNamespace: 'xau_v2:official_release:us_bls:v1',
    identityType: 'official_release_id:bls_cpi_v1',
    identityValue: '{"release_id":"USDL-26-1496"}',
    candidateClusterIds: ['40000000-0000-4000-8000-000000000001'],
  },
};
const input = { ...ids, operationIdempotencyFingerprint: 'a'.repeat(64), plan };
const row = {
  cluster_id: '40000000-0000-4000-8000-000000000001',
  decision_id: '50000000-0000-4000-8000-000000000001',
  identity_claim_id: '60000000-0000-4000-8000-000000000001',
  event_version_id: '70000000-0000-4000-8000-000000000001',
  version_outcome: 'CREATED',
  operation_replayed: false,
};

function db(response = [row], error = null) {
  return { calls: [], async request(method, path, body) {
    this.calls.push({ method, path, body });
    if (error) throw error;
    return structuredClone(response);
  } };
}
async function rejectsCode(fn, code) {
  await assert.rejects(fn, error => error instanceof BlsCpiProductionWriterError && error.code === code);
}

assert.equal(BLS_CPI_PRODUCTION_WRITER_VERSION, 'bls-cpi-production-writer-v1');
const database = db();
assert.deepEqual(await persistBlsCpiProduction(database, input), {
  kind: 'PERSISTED', writerVersion: BLS_CPI_PRODUCTION_WRITER_VERSION,
  clusterId: row.cluster_id, decisionId: row.decision_id,
  identityClaimId: row.identity_claim_id, eventVersionId: row.event_version_id,
  versionOutcome: 'CREATED', operationReplayed: false,
});
assert.deepEqual(database.calls, [{
  method: 'POST', path: '/rpc/fn_event_fact_produce_bls_cpi', body: {
    p_observation_id: ids.observationId,
    p_header_artifact_id: ids.headerArtifactId,
    p_table_artifact_id: ids.tableArtifactId,
    p_authority_namespace: plan.identity.authorityNamespace,
    p_identity_type: plan.identity.identityType,
    p_identity_value: plan.identity.identityValue,
    p_canonical_event_state: plan.canonicalEventState,
    p_operation_idempotency_fingerprint: input.operationIdempotencyFingerprint,
  },
}]);
assert.ok(!('candidateClusterIds' in database.calls[0].body));
console.log('PASS READY plan crosses exactly one atomic RPC boundary without trusting planner candidates');

const replay = await persistBlsCpiProduction(db([{ ...row, version_outcome: 'NO_MATERIAL_CHANGE', operation_replayed: true }]), input);
assert.equal(replay.versionOutcome, 'NO_MATERIAL_CHANGE');
assert.equal(replay.operationReplayed, true);
console.log('PASS exact replay and no-material-change outcomes are represented explicitly');

for (const invalid of [
  { ...input, operationIdempotencyFingerprint: 'A'.repeat(64) },
  { ...input, headerArtifactId: input.tableArtifactId },
  { ...input, extra: true },
  { ...input, plan: { ...plan, kind: 'BLOCKED' } },
  { ...input, plan: { ...plan, identity: { ...plan.identity, candidateClusterIds: ['invalid'] } } },
]) {
  const never = db();
  await rejectsCode(() => persistBlsCpiProduction(never, invalid), 'PRODUCTION_INPUT_INVALID');
  assert.equal(never.calls.length, 0);
}
console.log('PASS invalid identifiers, fingerprint, keys, blocked plans, and candidates fail before I/O');

await rejectsCode(() => persistBlsCpiProduction(db([], new Error('database secret')), input), 'PRODUCTION_RPC_UNAVAILABLE');
for (const malformed of [null, {}, [], [row, row], [{ ...row, extra: true }],
  [{ ...row, cluster_id: 'bad' }], [{ ...row, version_outcome: 'IGNORED' }],
  [{ ...row, operation_replayed: 'false' }]]) {
  await rejectsCode(() => persistBlsCpiProduction(db(malformed), input), 'PRODUCTION_RESPONSE_MALFORMED');
}
console.log('PASS unavailable and malformed responses fail closed without leaking database detail');

const source = readFileSync(new URL('../backend/event_facts/bls_cpi_production_writer.ts', import.meta.url), 'utf8');
assert.equal((source.match(/\/rpc\/fn_event_fact_produce_bls_cpi/g) ?? []).length, 1);
assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|Date\.|new Date|Math\.random|\/rest\/v1\//i);
assert.doesNotMatch(source, /fn_event_assign_observation|fn_event_assert_identity_claim|fn_event_create_event_version/i);
console.log('PASS writer has one mutation boundary and no direct table, clock, environment, or nested RPC path');
