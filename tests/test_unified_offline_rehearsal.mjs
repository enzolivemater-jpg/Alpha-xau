import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const [bridge, chain, obs, ui, tr, time] = await Promise.all([
  loadBackendModule('observability/unified_rehearsal.ts'),
  loadBackendModule('decision_chain/dry_run.ts'),
  loadBackendModule('observability/offline_receipt.ts'),
  loadBackendModule('advisory_ui/contract.ts'),
  loadBackendModule('advisory_ui/transport_contract.ts'),
  loadBackendModule('shared/temporal_contract.ts'),
]);
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8',
));
const cutoff = fixture.knowledgeCutoff;
const claim = {
  kind: 'OFFICIAL_RELEASE', evidenceId: 'synthetic-release-001',
  sourceAuthority: 'synthetic_fixture', revision: 'v1',
  artifactSha256: 'a'.repeat(64), effectiveAt: '2026-09-30T12:00:00.000Z',
  publishedAt: '2026-10-01T12:00:00.000Z',
  firstIngestedAt: '2026-10-01T12:01:00.000Z', producerVersion: 'fixture-1',
};
const input = (options = {}) => ({
  chainInput: structuredClone(fixture.input), knowledgeCutoff: cutoff,
  evidenceClaims: [claim], origin: { kind: 'GOLDEN_FIXTURE', label: 'synthetic-baseline' },
  generatedAt: '2026-10-14T12:00:00.000Z', ...options,
});
const baseline = await bridge.runUnifiedOfflineRehearsal(input());
assert.equal(baseline.schemaVersion, 'xau.unified-offline-rehearsal.v1');
assert.equal(baseline.mode, 'OFFLINE_ONLY');
assert.equal(baseline.outcome, 'COMPLETED');
assert.equal(baseline.decision, 'HOLD');
assert.equal(baseline.execution, 'FORBIDDEN');
assert.equal(baseline.authorization, 'NONE');
assert.equal(baseline.provenance, 'UNVERIFIED');
assert.equal(baseline.terminal.simulated, true);
assert.equal(baseline.terminal.chain.execution, 'FORBIDDEN');
assert.equal(baseline.terminal.stages.length, 12);
assert.equal(baseline.terminal.chain.integrity, 'CONSISTENT');
assert.equal(baseline.receipt.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.deepEqual(baseline.receipt.problems, []);
assert.equal(baseline.receipt.lineage.length, 12);
assert.equal(baseline.receipt.fingerprint, baseline.terminal.chain.digest);
assert.equal(baseline.evidence.structuralStatus, 'COHERENT');
assert.equal(baseline.evidence.evidenceState, 'UNVERIFIED');
assert.equal(baseline.evidence.authorization, 'NONE');
assert.deepEqual(baseline.evidence.reasonCodes, ['SOURCE_ATTESTATION_UNAVAILABLE']);
assert.equal(baseline.advisory.systemState, 'HOLD');
assert.equal(baseline.advisory.execution, 'FORBIDDEN');
assert.equal(baseline.advisory.deployment, 'NOT_CONNECTED');
assert.equal(baseline.advisory.provenance, 'UNVERIFIED');
assert.equal(baseline.advisory.tradeTicket, null);
assert.equal(baseline.transport.status, 'STRUCTURALLY_VALID_UNVERIFIED');
assert.equal(baseline.transport.packet.actionability, 'NONE');
assert.equal(baseline.transport.packet.origin, 'UNVERIFIED');
assert.equal(baseline.transport.packet.transport, 'NOT_CONNECTED');
assert.deepEqual((await bridge.runUnifiedOfflineRehearsal(input())).receipt, baseline.receipt,
  'identical input and cutoff produce identical audit checksum and lineage');
console.log('PASS canonical CHAIN-0 -> TV-2/OBS-0/EVIDENCE-0/TIME-0/UI-0/TR-0 synthetic replay');

const forgedResult = chain.evaluateDecisionChain(fixture.input, cutoff);
assert.equal(forgedResult.kind, 'COMPLETED');
const mutations = [
  ['execution', (r) => { r.execution = 'ALLOWED'; }],
  ['approval', (r) => { r.stages.acceptance.evidence.executionAuthorityApproved = true; }],
  ['broker-ticket', (r) => { r.stages.commandCenter.tradeTicket = { id: 'fake' }; }],
  ['provider', (r) => { r.stages.committee.providerInvocation = 'ALLOWED'; }],
  ['runtime', (r) => { r.stages.commandCenter.observability.deploymentId = 'spoofed'; }],
  ['alert', (r) => { r.stages.alert.payload = { message: 'BUY' }; }],
  ['horizon', (r) => { r.stages.horizonSynthesis.scenarios[0].direction = 'BULLISH'; }],
  ['unknown-key', (r) => { r.liveTradingAuthorized = true; }],
  ['missing-trace', (r) => { r.trace = []; }],
  ['bad-cutoff', (r) => { r.knowledgeCutoff = '2026-02-30T14:15:00.000Z'; }],
  ['nano-drift', (r) => { r.trace[0].knowledgeCutoff = '2026-10-01T14:15:00.000000001Z'; }],
];
for (const [name, mutate] of mutations) {
  const tampered = structuredClone(forgedResult.result);
  mutate(tampered);
  const receipt = await obs.buildOfflineAuditReceipt(tampered);
  assert.equal(receipt.verification, 'REJECTED', name);
  assert.equal(receipt.fingerprint, null, name);
  assert.ok(receipt.problems.length > 0, name);
  assert.equal(receipt.execution, 'FORBIDDEN', name);
}
console.log('PASS eleven spoof/runtime/approval/clock/trace mutations fail closed without checksum');

const future = { ...claim, firstIngestedAt: '2026-10-01T14:15:00.001Z' };
const newer = await bridge.runUnifiedOfflineRehearsal(input({ evidenceClaims: [future] }));
assert.equal(newer.evidence.structuralStatus, 'REJECTED');
assert.ok(newer.evidence.reasonCodes.includes('INGESTION_AFTER_CUTOFF'));
assert.equal(newer.evidence.claims.length, 0);
assert.equal(newer.advisory.decision, 'ABSTAIN');
assert.equal(newer.execution, 'FORBIDDEN');
const invalid = await bridge.runUnifiedOfflineRehearsal(input({
  knowledgeCutoff: '2026-02-30T14:15:00.000Z',
}));
assert.equal(invalid.terminal.chain.chainState, 'HOLD');
assert.equal(invalid.outcome, 'REJECTED', 'malformed cutoff must stop the chain at preflight');
assert.equal(invalid.terminal.chain.outcome, 'REJECTED');
assert.equal(invalid.receipt, null, 'invalid preflight must not create a receipt');
assert.equal(invalid.terminal.chain.digest, null, 'invalid preflight must not mint any fingerprint');
assert.equal(invalid.advisory.execution, 'FORBIDDEN');
assert.equal(invalid.evidence.structuralStatus, 'REJECTED');
assert.ok(invalid.evidence.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));
assert.notEqual(invalid.transport.status, 'REJECTED',
  'even invalid source claims are safely encoded as an unauthoritative HOLD packet');
assert.equal(time.compareStrictInstants('2026-10-01T14:15:00.000000001Z', cutoff), 1);
assert.equal(time.compareStrictInstants('2026-02-30T00:00:00Z', cutoff), null);

const claims = {
  commandCenter: forgedResult.result.stages.commandCenter,
  alerts: forgedResult.result.stages.alert,
  acceptance: forgedResult.result.stages.acceptance,
};
const altered = structuredClone(claims);
altered.commandCenter.observability.deploymentId = 'forged';
const denied = ui.buildInstitutionalAdvisoryUi(altered, cutoff);
assert.ok(denied.reasonCodes.includes('COMMAND_CENTER_CLAIM_REJECTED'));
assert.equal(denied.tradeTicket, null);
assert.equal(tr.inspectOfflineAdvisoryPacket(
  tr.encodeOfflineAdvisoryPacket(altered, cutoff)).status, 'STRUCTURALLY_VALID_UNVERIFIED');
console.log('PASS independent source attestation, UTC nanoseconds and forged UI authority remain denied');
