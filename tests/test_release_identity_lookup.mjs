import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  RELEASE_IDENTITY_LOOKUP_VERSION,
  ReleaseIdentityLookupError,
  resolveActiveReleaseIdentity,
} from '../backend/event_facts/release_identity_lookup.ts';

const proposal = {
  authorityNamespace: 'xau_v2:official_release:us_bls:v1',
  identityType: 'official_release_id:bls_cpi_v1',
  identityValue: '{"authority":"us_bls","release_family":"US_CPI","release_id":"USDL-26-1496","release_stage":"SINGLE","strategy":"OFFICIAL_RELEASE_ID","strategy_version":"bls_cpi_v1"}',
};
const cluster = '11111111-1111-4111-8111-111111111111';
const claim = '22222222-2222-4222-8222-222222222222';
const key = createHash('sha256').update([
  proposal.authorityNamespace, proposal.identityType, proposal.identityValue,
].join('\u001f')).digest('hex');

function db(response, thrown = null) {
  return {
    calls: [],
    async request(method, path, body) {
      this.calls.push({ method, path, body });
      if (thrown) throw thrown;
      return structuredClone(response);
    },
  };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof ReleaseIdentityLookupError && error.code === code);
}

assert.equal(RELEASE_IDENTITY_LOOKUP_VERSION, 'release-identity-active-lookup-v1');
const noneDb = db([]);
assert.deepEqual(await resolveActiveReleaseIdentity(noneDb, proposal), {
  kind: 'CURATED_STRONG_IDENTITY', ...proposal, candidateClusterIds: [],
});
assert.deepEqual(noneDb.calls, [{
  method: 'POST', path: '/rpc/fn_event_lookup_active_identity_claims',
  body: {
    p_authority_namespace: proposal.authorityNamespace,
    p_identity_type: proposal.identityType,
    p_identity_value: proposal.identityValue,
  },
}]);
console.log('PASS zero active claims yields an explicit empty candidate set only after a successful lookup');

const one = [{ cluster_id: cluster, identity_claim_id: claim, strong_identity_key: key }];
assert.deepEqual((await resolveActiveReleaseIdentity(db(one), proposal)).candidateClusterIds, [cluster]);
console.log('PASS one exact active claim resolves to exactly one cluster');

await rejectsCode(resolveActiveReleaseIdentity(db([...one, {
  cluster_id: '33333333-3333-4333-8333-333333333333',
  identity_claim_id: '44444444-4444-4444-8444-444444444444', strong_identity_key: key,
}]), proposal), 'IDENTITY_LOOKUP_COLLISION');
await rejectsCode(resolveActiveReleaseIdentity(db({}, new Error('secret db detail')), proposal),
  'IDENTITY_LOOKUP_UNAVAILABLE');
for (const malformed of [null, {}, [{}], [{ ...one[0], extra: true }], [{ ...one[0], cluster_id: 'bad' }]]) {
  await rejectsCode(resolveActiveReleaseIdentity(db(malformed), proposal), 'IDENTITY_LOOKUP_MALFORMED');
}
await rejectsCode(resolveActiveReleaseIdentity(db([{ ...one[0], strong_identity_key: 'a'.repeat(64) }]), proposal),
  'IDENTITY_LOOKUP_MALFORMED');
for (const malformedProposal of [null, {}, { ...proposal, extra: true }, { ...proposal, identityValue: ' ' }]) {
  const invalidDb = db([]);
  await rejectsCode(resolveActiveReleaseIdentity(invalidDb, malformedProposal), 'IDENTITY_PROPOSAL_INVALID');
  assert.equal(invalidDb.calls.length, 0);
}
console.log('PASS collisions, unavailable reads, malformed rows, and invalid proposals fail closed');
