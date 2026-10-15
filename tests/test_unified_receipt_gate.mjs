/**
 * ARCH-5: a completed CHAIN-0 is not enough to mint a terminal fingerprint.
 * The fingerprint is admitted exclusively by a structurally accepted OBS-0
 * offline receipt. No source attestation or signature is implied.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const [unified, chain, obs] = await Promise.all([
  loadBackendModule('observability/unified_rehearsal.ts'),
  loadBackendModule('decision_chain/dry_run.ts'),
  loadBackendModule('observability/offline_receipt.ts'),
]);
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8',
));
const outcome = chain.evaluateDecisionChain(fixture.input, fixture.knowledgeCutoff);
assert.equal(outcome.kind, 'COMPLETED');
const acceptedReceipt = await obs.buildOfflineAuditReceipt(outcome.result);
assert.equal(acceptedReceipt.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.match(acceptedReceipt.fingerprint, /^sha256:[0-9a-f]{64}$/);
assert.equal(unified.fingerprintFromAcceptedReceipt(acceptedReceipt), acceptedReceipt.fingerprint);

const forged = structuredClone(outcome.result);
forged.stages.action.order = { type: 'fake-order' };
const rejectedReceipt = await obs.buildOfflineAuditReceipt(forged);
assert.equal(rejectedReceipt.verification, 'REJECTED');
assert.equal(rejectedReceipt.fingerprint, null);
assert.ok(rejectedReceipt.problems.length > 0);
assert.equal(unified.fingerprintFromAcceptedReceipt(rejectedReceipt), null);

const mutations = [
  ['missing receipt', null],
  ['declared rejected', { ...acceptedReceipt, verification: 'REJECTED' }],
  ['forged authorization', { ...acceptedReceipt, authorization: 'GRANTED' }],
  ['forged execution', { ...acceptedReceipt, execution: 'ALLOWED' }],
  ['forged provenance', { ...acceptedReceipt, provenance: 'VERIFIED' }],
  ['unsafe mode', { ...acceptedReceipt, mode: 'LIVE' }],
  ['rejection reason concealed', { ...acceptedReceipt, problems: ['UNSAFE_OUTPUT_PRESENT'] }],
  ['missing hash', { ...acceptedReceipt, fingerprint: null }],
  ['invalid hash', { ...acceptedReceipt, fingerprint: 'not-sha-256' }],
  ['uppercase hash', { ...acceptedReceipt, fingerprint: 'A'.repeat(64) }],
];
for (const [label, receipt] of mutations) {
  assert.equal(unified.fingerprintFromAcceptedReceipt(receipt), null, label);
}

const bridgeInput = {
  chainInput: structuredClone(fixture.input), knowledgeCutoff: fixture.knowledgeCutoff,
  evidenceClaims: [], origin: { kind: 'GOLDEN_FIXTURE', label: 'fixture' },
  generatedAt: '2026-10-14T12:00:00.000Z',
};
const result = await unified.runUnifiedOfflineRehearsal(bridgeInput);
assert.equal(result.outcome, 'COMPLETED');
assert.equal(result.terminal.chain.digest, acceptedReceipt.fingerprint);
assert.equal(result.receipt.fingerprint, acceptedReceipt.fingerprint);
assert.equal(result.decision, 'HOLD');
assert.equal(result.execution, 'FORBIDDEN');
assert.equal(result.transport.packet?.actionability, 'NONE');
assert.deepEqual(await unified.runUnifiedOfflineRehearsal(bridgeInput), result);

const source = readFileSync(
  new URL('../backend/observability/unified_rehearsal.ts', import.meta.url), 'utf8',
);
assert.doesNotMatch(source, /\bcomputeDecisionChainDigest\b/,
  'reintroducing a direct digest calculation would bypass OBS-0');
console.log('PASS ARCH-5: only accepted OBS receipt can populate simulated terminal fingerprint');
