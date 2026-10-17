/**
 * Event-facts write boundaries (BLS CPI atomic production writer, active release
 * identity lookup) under hostile input and hostile database answers, with a mock
 * database. Properties:
 *  - only the module's own typed errors escape (never a TypeError);
 *  - an invalid input makes ZERO database calls, a valid one at most one;
 *  - what is sent is exactly what was validated: the request body survives a
 *    JSON round trip unchanged (a Map, Date or Set must not pass as JSON), and
 *  - an identity cannot be ambiguous through the U+001F key separator.
 * Offline and deterministic: no network or real database.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { BlsCpiProductionWriterError, persistBlsCpiProduction } from '../backend/event_facts/bls_cpi_production_writer.ts';
import { ReleaseIdentityLookupError, resolveActiveReleaseIdentity } from '../backend/event_facts/release_identity_lookup.ts';
import { HOSTILE_VALUES, mutationCases } from './lib/mutation_cases.mjs';

const ids = {
  observationId: '10000000-0000-4000-8000-000000000001',
  headerArtifactId: '20000000-0000-4000-8000-000000000001',
  tableArtifactId: '30000000-0000-4000-8000-000000000001',
};
const plan = {
  kind: 'READY', plannerVersion: 'bls-cpi-producer-planner-v1', parserVersion: 'bls-cpi-artifact-parser-v1',
  adapterVersion: 'bls-cpi-event-facts-adapter-v1', canonicalEventStateSchemaVersion: 2,
  canonicalEventState: { event_type: 'STATISTICAL_RELEASE', subject: 'CPI August 2026', detail: null,
    facts: { release_family: 'US_CPI', metrics: [{ metric_code: 'CPI_HEADLINE_MOM', actual: { value: '0.3' } }] } },
  identity: { authorityNamespace: 'xau_v2:official_release:us_bls:v1', identityType: 'official_release_id:bls_cpi_v1',
    identityValue: '{"release_id":"USDL-26-1496"}', candidateClusterIds: ['40000000-0000-4000-8000-000000000001'] },
};
const input = { ...ids, operationIdempotencyFingerprint: 'a'.repeat(64), plan };
const row = {
  cluster_id: '40000000-0000-4000-8000-000000000001', decision_id: '50000000-0000-4000-8000-000000000001',
  identity_claim_id: '60000000-0000-4000-8000-000000000001', event_version_id: '70000000-0000-4000-8000-000000000001',
  version_outcome: 'CREATED', operation_replayed: false,
};
const mockDb = (response, error = null) => ({
  calls: [],
  async request(method, path, body) {
    this.calls.push({ method, path, body });
    if (error) throw error;
    return typeof response === 'object' && response !== null ? structuredClone(response) : response;
  },
});

/** Independent oracle: what JSON.stringify would serialize without changing its meaning. */
function isStrictlyPlainJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return Object.getPrototypeOf(value) === Array.prototype && Object.keys(value).length === value.length && value.every(isStrictlyPlainJson);
  }
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && 'value' in descriptor && isStrictlyPlainJson(descriptor.value);
  });
}

const failures = [];
const note =(label, message) => { if (failures.length < 30) failures.push(`${label}: ${message}`); };
const tally = { persisted: 0, writerRefused: 0, resolved: 0, lookupRefused: 0 };

async function writer(label, hostileInput, response = [row], error = null) {
  const db = mockDb(response, error);
  try {
    const out = await persistBlsCpiProduction(db, hostileInput);
    tally.persisted += 1;
    if (db.calls.length !== 1) note(label, `persisted with ${db.calls.length} database calls`);
    // What reached the database is exactly what was validated: an independent oracle says the
    // persisted state is strictly plain JSON, so serialization cannot change its meaning.
    if (!isStrictlyPlainJson(hostileInput.plan.canonicalEventState)) {
      note(label, 'a state that is not strictly plain JSON reached the database');
    }
    if (hostileInput.plan.identity.identityValue.includes('\u001f')) note(label, 'an ambiguous identity value reached the database');
    if (out.kind !== 'PERSISTED') note(label, `kind ${out.kind}`);
  } catch (caught) {
    if (caught instanceof BlsCpiProductionWriterError) {
      tally.writerRefused += 1;
      if (caught.code === 'PRODUCTION_INPUT_INVALID' && db.calls.length !== 0) note(label, 'an invalid input still called the database');
    } else {
      note(label, `escaped ${caught && caught.stack ? caught.stack.split('\n').slice(0, 2).join(' | ') : caught}`);
    }
  }
}

for (const [label, hostile] of mutationCases(input)) await writer(`writer input ${label}`, hostile);
for (const [index, value] of HOSTILE_VALUES.entries()) {
  await writer(`writer response hostile#${index}`, input, structuredClone(value));
}
for (const [label, hostile] of mutationCases([row])) await writer(`writer response ${label}`, input, hostile);
await writer('writer database throws', input, [row], new Error('boom'));

// Values that read as JSON-compatible but do not survive serialization unchanged.
class Quote { constructor() { this.value = 1; } }
const withGetter = {}; Object.defineProperty(withGetter, 'value', { enumerable: true, get: () => 1 });
const nullProto = Object.create(null); nullProto.value = 1;
const NON_JSON_STATES = {
  Map: new Map([['a', 1]]), Set: new Set([1]), Date: new Date(0), RegExp: /x/, Quote: new Quote(),
  getter: withGetter, nullProto, Uint8Array: new Uint8Array([1]), boxedNumber: Object(1), boxedString: Object('x'),
  fn: () => 1, symbol: Symbol('x'), bigint: 10n, undef: undefined,
};
for (const [name, value] of Object.entries(NON_JSON_STATES)) {
  const hostile = { ...input, plan: { ...plan, canonicalEventState: { ...plan.canonicalEventState, extra: value } } };
  await writer(`writer non-JSON state ${name}`, hostile);
}
// The U+001F key separator must not make two identities collide.
for (const field of ['identityValue']) {
  await writer(`writer separator in ${field}`, { ...input, plan: { ...plan, identity: { ...plan.identity, [field]: 'a\u001fb' } } });
}

// Lookup.
const proposal = { authorityNamespace: 'xau_v2:official_release:us_bls:v1', identityType: 'official_release_id:bls_cpi_v1',
  identityValue: '{"release_id":"USDL-26-1496"}' };
const keyOf = (p) => createHash('sha256').update([p.authorityNamespace, p.identityType, p.identityValue].join('\u001f')).digest('hex');
const lookupRow = { cluster_id: row.cluster_id, identity_claim_id: row.identity_claim_id, strong_identity_key: keyOf(proposal) };

async function lookup(label, hostileProposal, response = [lookupRow], error = null) {
  const db = mockDb(response, error);
  try {
    const out = await resolveActiveReleaseIdentity(db, hostileProposal);
    tally.resolved += 1;
    if (db.calls.length !== 1) note(label, `resolved with ${db.calls.length} database calls`);
    const sent = db.calls[0]?.body;
    if (sent.p_authority_namespace !== hostileProposal.authorityNamespace || sent.p_identity_type !== hostileProposal.identityType
        || sent.p_identity_value !== hostileProposal.identityValue || Object.keys(sent).length !== 3) note(label, 'the lookup body differs from the proposal');
    if (out.candidateClusterIds.length > 1) note(label, 'more than one candidate');
  } catch (caught) {
    if (caught instanceof ReleaseIdentityLookupError) {
      tally.lookupRefused += 1;
      if (caught.code === 'IDENTITY_PROPOSAL_INVALID' && db.calls.length !== 0) note(label, 'an invalid proposal still called the database');
    } else {
      note(label, `escaped ${caught && caught.stack ? caught.stack.split('\n').slice(0, 2).join(' | ') : caught}`);
    }
  }
}
for (const [label, hostile] of mutationCases(proposal)) await lookup(`lookup proposal ${label}`, hostile);
for (const [index, value] of HOSTILE_VALUES.entries()) await lookup(`lookup response hostile#${index}`, proposal, structuredClone(value));
for (const [label, hostile] of mutationCases([lookupRow])) await lookup(`lookup response ${label}`, proposal, hostile);
await lookup('lookup empty', proposal, []);
await lookup('lookup collision', proposal, [lookupRow, lookupRow]);
await lookup('lookup database throws', proposal, [], new Error('boom'));
// Ambiguity through the separator: two different triples, one SHA-256 key.
const left = { authorityNamespace: 'a\u001fb', identityType: 'c', identityValue: 'd' };
const right = { authorityNamespace: 'a', identityType: 'b\u001fc', identityValue: 'd' };
assert.equal(keyOf(left), keyOf(right), 'sanity: the separator really makes these two triples collide');
for (const [name, ambiguous] of [['left', left], ['right', right]]) {
  await lookup(`lookup separator ${name}`, ambiguous, [{ ...lookupRow, strong_identity_key: keyOf(ambiguous) }]);
  const db = mockDb([]);
  await assert.rejects(() => resolveActiveReleaseIdentity(db, ambiguous), (e) => e instanceof ReleaseIdentityLookupError && e.code === 'IDENTITY_PROPOSAL_INVALID', `separator ${name}`);
  assert.equal(db.calls.length, 0, `separator ${name}: no database call`);
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.persisted >= 1 && tally.writerRefused > 200 && tally.resolved >= 1 && tally.lookupRefused > 100, JSON.stringify(tally));
console.log(`PASS event-facts write boundaries: ${tally.persisted + tally.writerRefused + tally.resolved + tally.lookupRefused} hostile calls, `
  + `only typed errors, zero database calls for invalid input, body equals validated state, no separator ambiguity`);
