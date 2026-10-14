/**
 * Cross-PR rehearsal: actual CHAIN-0 -> UI-0 + OBS-0 from fixed synthetic fixture.
 * Test only; no wiring to legacy terminal, Worker, network, providers or broker.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'event_impact/deterministic_processor.ts', 'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts', 'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
  'horizon_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
  'risk_engine/pre_pm_contract.ts', 'portfolio_engine/contract.ts',
  'risk_engine/final_action_contract.ts', 'action_engine/contract.ts',
  'command_center/contract.ts', 'alert_engine/contract.ts',
  'acceptance_engine/contract.ts', 'decision_chain/dry_run.ts',
  'observability/offline_receipt.ts', 'advisory_ui/contract.ts',
  'advisory_ui/transport_contract.ts',
];
const fixture = JSON.parse(readFileSync(
  path.join(root, 'tests/fixtures/chain0_hold_synthetic.json'), 'utf8',
));
assert.equal(fixture.fixtureType, 'SYNTHETIC_CONTRACT_ONLY');

const temp = mkdtempSync(path.join(tmpdir(), 'xau-chain-ui0-rehearsal-'));
let run, receipt, ui, transport;
try {
  for (const source of sourceFiles) {
    const sourceText = readFileSync(path.join(root, 'backend', source), 'utf8');
    const converted = ts.transpileModule(sourceText, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const destination = path.join(temp, source.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, converted);
  }
  const load = (file) => import(pathToFileURL(path.join(temp, file)).href);
  ({ runDecisionChainDryRun: run } = await load('decision_chain/dry_run.mjs'));
  ({ buildOfflineAuditReceipt: receipt } = await load('observability/offline_receipt.mjs'));
  ({ buildInstitutionalAdvisoryUi: ui } = await load('advisory_ui/contract.mjs'));
  transport = await load('advisory_ui/transport_contract.mjs');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const initialInput = structuredClone(fixture.input);
const chain = run(initialInput);
assert.deepEqual(initialInput, fixture.input, 'Do not mutate source claims');
const audited = await receipt(chain);
assert.equal(audited.verification, 'VALID_HOLD', 'OBS-0 proves only a coherent offline HOLD');
assert.match(audited.fingerprint, /^[0-9a-f]{64}$/);
const uiInput = (s) => ({
  commandCenter: s.commandCenter,
  alerts: s.alerts,
  acceptance: s.acceptance,
});
const view = ui(uiInput(chain.stages), chain.knowledgeCutoff);
const wire = transport.encodeOfflineAdvisoryPacket(uiInput(chain.stages), chain.knowledgeCutoff);
const checkedWire = transport.inspectOfflineAdvisoryPacket(wire);
assert.equal(checkedWire.status, 'STRUCTURALLY_VALID_UNVERIFIED');
assert.equal(checkedWire.packet.origin, 'UNVERIFIED');
assert.equal(checkedWire.packet.actionability, 'NONE');
assert.deepEqual(checkedWire.packet.advisory, view);
assert.equal(wire, transport.encodeOfflineAdvisoryPacket(uiInput(chain.stages), chain.knowledgeCutoff));
const forgedWire = JSON.parse(wire);
forgedWire.advisory.tradeTicket = { side: 'BUY', size: 1 };
const refusedWire = transport.inspectOfflineAdvisoryPacket(JSON.stringify(forgedWire));
assert.equal(refusedWire.status, 'REJECTED');
assert.equal(refusedWire.reason, 'UNSAFE_ADVISORY');
assert.deepEqual(view.reasonCodes, [
  'SOURCE_ATTESTATION_NOT_AVAILABLE', 'UI_RUNTIME_NOT_AUTHORIZED',
]);
assert.equal(view.provenance, 'UNVERIFIED');
assert.equal(view.deployment, 'NOT_CONNECTED');
assert.equal(view.decision, 'ABSTAIN');
assert.equal(view.execution, 'FORBIDDEN');
assert.equal(view.tradeTicket, null);
assert.equal(view.productionReadiness, 'HOLD');
assert.equal(view.claimedKnowledgeCutoff, chain.knowledgeCutoff);
assert.equal(view.horizons.length, 5);
const rerun = run(structuredClone(initialInput));
assert.deepEqual(view, ui(uiInput(rerun.stages), rerun.knowledgeCutoff));
assert.deepEqual(audited, await receipt(rerun));

for (const [label, mutate, reason] of [
  ['forged command-center ticket', (s) => { s.commandCenter.tradeTicket = { side: 'BUY' }; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['forged runtime identity', (s) => { s.commandCenter.observability.deploymentId = 'fake-prod'; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['forged alert recipient', (s) => { s.alerts.recipient = 'someone@example.invalid'; }, 'ALERT_CLAIM_REJECTED'],
  ['forged alert delivery', (s) => { s.alerts.delivery = 'AUTHORIZED'; }, 'ALERT_CLAIM_REJECTED'],
  ['forged acceptance proof', (s) => { s.acceptance.evidence.executionAuthorityApproved = true; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['forged acceptance report', (s) => { s.acceptance.report = { status: 'PASS' }; }, 'ACCEPTANCE_CLAIM_REJECTED'],
]) {
  const altered = structuredClone(chain);
  mutate(altered.stages);
  const rejectedReceipt = await receipt(altered);
  const rejectedView = ui(uiInput(altered.stages), altered.knowledgeCutoff);
  assert.equal(rejectedReceipt.verification, 'REJECTED', label);
  assert.equal(rejectedReceipt.fingerprint, null, label);
  assert.ok(rejectedView.reasonCodes.includes(reason), label);
  assert.equal(rejectedView.provenance, 'UNVERIFIED', label);
  assert.equal(rejectedView.execution, 'FORBIDDEN', label);
  assert.equal(rejectedView.tradeTicket, null, label);
}

// UI-0 checks only CC/AL/E2E claims; it never upgrades an earlier stage.
const compromised = structuredClone(chain);
compromised.stages.horizons.scenarios[0].direction = 'BUY';
assert.equal((await receipt(compromised)).verification, 'REJECTED');
const narrowView = ui(uiInput(compromised.stages), compromised.knowledgeCutoff);
assert.equal(narrowView.provenance, 'UNVERIFIED');
assert.equal(narrowView.deployment, 'NOT_CONNECTED');
assert.equal(narrowView.execution, 'FORBIDDEN');

// Joint cutoff rejection: OBS must not fingerprint a normalized February 30,
// and UI must not display its alleged as-of date as a valid calendar claim.
const invalid = structuredClone(initialInput);
invalid.knowledgeCutoff = '2026-02-30T15:00:00.000Z';
for (const key of ['eventImpact', 'goldTransmission', 'marketPricing', 'positioning']) {
  invalid[key].knowledgeCutoff = invalid.knowledgeCutoff;
}
const invalidChain = run(invalid);
const invalidReceipt = await receipt(invalidChain);
const invalidView = ui(uiInput(invalidChain.stages), invalidChain.knowledgeCutoff);
assert.equal(invalidReceipt.verification, 'REJECTED');
assert.ok(invalidReceipt.problems.includes('CUTOFF_INVALID'));
assert.equal(invalidReceipt.fingerprint, null);
assert.equal(invalidView.claimedKnowledgeCutoff, null);
assert.ok(invalidView.reasonCodes.includes('INVALID_CLAIMED_CUTOFF'));
assert.equal(invalidView.execution, 'FORBIDDEN');
const invalidWire = transport.inspectOfflineAdvisoryPacket(
  transport.encodeOfflineAdvisoryPacket(uiInput(invalidChain.stages), invalidChain.knowledgeCutoff),
);
assert.equal(invalidWire.status, 'STRUCTURALLY_VALID_UNVERIFIED');
assert.equal(invalidWire.packet.advisory.claimedKnowledgeCutoff, null);
assert.equal(invalidWire.packet.actionability, 'NONE');

console.log('Cross-PR CHAIN-0 / OBS-0 / UI-0: deterministic synthetic HOLD, spoof rejection PASS');
