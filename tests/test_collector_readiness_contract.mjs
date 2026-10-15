// DATA-4G: purely offline metadata review; never grants collection/trading.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const m = await loadBackendModule('market_engine/collector_readiness.ts');
const cutoff = '2026-10-16T12:00:00.000Z';
const approved = (gate_id) => ({
  gate_id, status: 'APPROVED', evidence_reference: 'private://review/' + gate_id,
  evidence_digest: 'sha256:' + 'a'.repeat(64), reviewer: 'reviewer-1',
  reviewed_at_utc: '2026-10-15T12:00:00.000Z',
  expiry_or_review_due: '2026-10-17T12:00:00.000Z',
  scope: 'operator-declared-20261015', version: 'v1', rejection_reasons: [],
});
const full = () => ({
  schemaVersion: m.COLLECTOR_READINESS_SCHEMA_VERSION,
  planId: 'operator-declared-20261015',
  gates: m.REQUIRED_COLLECTOR_GATES.map(approved),
});
const empty = m.evaluateCollectorReadiness({
  schemaVersion: m.COLLECTOR_READINESS_SCHEMA_VERSION,
  planId: 'operator-declared-20261015', gates: [],
}, cutoff);
assert.equal(empty.status, 'INCOMPLETE');
assert.equal(empty.missingGates.length, 11);
assert.equal(empty.execution, 'FORBIDDEN');
assert.equal(empty.decision, 'HOLD');
const complete = m.evaluateCollectorReadiness(full(), cutoff);
assert.equal(complete.status, 'READY_FOR_HUMAN_REVIEW');
assert.deepEqual(complete.missingGates, []);
assert.deepEqual(complete.unapprovedGates, []);
assert.equal(complete.authorization, 'OFFLINE_ONLY');
assert.equal(complete.providerAuthenticity, 'NOT_PROVEN');
assert.equal(complete.calendarCompleteness, 'NOT_PROVEN');
assert.equal(complete.execution, 'FORBIDDEN');
assert.equal(complete.decision, 'HOLD');
assert.deepEqual(m.evaluateCollectorReadiness(full(), cutoff), complete);
const reject = (packet, code = 'INVALID_GATE', at = cutoff) => assert.throws(
  () => m.evaluateCollectorReadiness(packet, at),
  new RegExp('COLLECTOR_READINESS_' + code),
);
const mutate = (update) => {
  const packet = full();
  packet.gates[0] = {...packet.gates[0], ...update};
  return packet;
};
reject({...full(), extra: true}, 'INVALID_PACKET');
reject({...full(), schemaVersion: 'unreviewed'}, 'INVALID_PACKET');
reject({...full(), gates: [...full().gates, approved('INVALID')]}, 'INVALID_PACKET');
reject({...full(), gates: [full().gates[0], full().gates[0]]});
reject(mutate({evidence_reference: null}), 'INVALID_APPROVAL');
reject(mutate({evidence_digest: null}), 'INVALID_APPROVAL');
reject(mutate({evidence_digest: 'sha256:pretend'}));
reject(mutate({reviewer: null}), 'INVALID_APPROVAL');
reject(mutate({reviewed_at_utc: '2026-10-17T00:00:00.000Z'}), 'INVALID_APPROVAL');
reject(mutate({expiry_or_review_due: cutoff}), 'INVALID_APPROVAL');
reject(mutate({expiry_or_review_due: '2026-10-15T00:00:00.000Z'}), 'INVALID_APPROVAL');
reject(mutate({scope: 'another-plan'}), 'INVALID_APPROVAL');
reject(mutate({rejection_reasons: ['MISSING_EVIDENCE']}), 'INVALID_APPROVAL');
reject(mutate({unrecognized: 'yes'}));
reject(mutate({reviewed_at_utc: '2026-02-30T00:00:00.000Z'}));
reject(mutate({status: 'REJECTED', rejection_reasons: []}), 'MISSING_REJECTION_REASON');
reject(mutate({status: 'PENDING', rejection_reasons: ['UNKNOWN']}), 'INVALID_PENDING');
reject(full(), 'INVALID_CUTOFF', '2026-02-30T00:00:00.000Z');
const pending = m.evaluateCollectorReadiness(mutate({
  status: 'PENDING', evidence_reference: null, evidence_digest: null,
  reviewer: null, reviewed_at_utc: null, expiry_or_review_due: null,
  scope: null, version: null,
}), cutoff);
assert.equal(pending.status, 'INCOMPLETE');
assert.deepEqual(pending.unapprovedGates, ['SUPPLIER_RIGHTS']);
const rejected = m.evaluateCollectorReadiness(mutate({
  status: 'REJECTED', rejection_reasons: ['CONTRACT_NOT_VERIFIED'],
}), cutoff);
assert.equal(rejected.status, 'INCOMPLETE');
const source = readFileSync(new URL('../backend/market_engine/collector_readiness.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\\bfetch\\(|process\\.env|Date\\.now\\(|new Date\\(\\)|\\bquery\\(|\\bexec\\(/);
const imports = listBackendImportClosure('market_engine/collector_readiness.ts');
assert.ok(!imports.includes('market_engine/providers.ts'));
console.log('PASS DATA-4G metadata gate rejects missing, inconsistent, expired and fake approvals; remains HOLD/FORBIDDEN');
