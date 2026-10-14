/**
 * TR-0: real safe CC/AL/E2E claims -> UI-0 -> canonical JSON transport.
 * Entirely offline; rejects spoofed fields and cannot send orders/alerts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'event_impact/deterministic_processor.ts', 'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts', 'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
  'horizon_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
  'risk_engine/pre_pm_contract.ts', 'portfolio_engine/contract.ts',
  'risk_engine/final_action_contract.ts', 'action_engine/contract.ts',
  'command_center/contract.ts', 'alert_engine/contract.ts',
  'shared/temporal_contract.ts', 'shared/strict_timestamp.ts',
  'acceptance_engine/contract.ts', 'advisory_ui/contract.ts',
  'advisory_ui/transport_contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'xau-tr0-contract-'));
let transport, action, cc, alert, acceptance, risk;
try {
  for (const source of sources) {
    const input = readFileSync(path.join(root, 'backend', source), 'utf8');
    const js = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const dst = path.join(temp, source.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, js, 'utf8');
  }
  const load = (file) => import(pathToFileURL(path.join(temp, file)).href);
  [transport, action, cc, alert, acceptance, risk] = await Promise.all([
    load('advisory_ui/transport_contract.mjs'), load('action_engine/contract.mjs'),
    load('command_center/contract.mjs'), load('alert_engine/contract.mjs'),
    load('acceptance_engine/contract.mjs'), load('risk_engine/final_action_contract.mjs'),
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-13T16:00:00.000Z';
function claims() {
  const finalRisk = {
    schemaVersion: risk.FINAL_ACTION_RISK_SCHEMA_VERSION,
    algorithmVersion: risk.FINAL_ACTION_RISK_ALGORITHM_VERSION,
    state: 'HOLD', actionEligibility: 'INELIGIBLE', knowledgeCutoff: cutoff,
  };
  const actionClaim = action.buildActionAbstentionGate({
    finalRisk, executionAuthorization: 'UNAUTHORIZED', brokerConnection: 'ABSENT',
  }, cutoff);
  const commandCenter = cc.buildCommandCenterProjection({
    action: actionClaim, runtimeEvidence: { correlationId: null, deploymentId: null },
  }, cutoff);
  const alerts = alert.buildAlertSuppressionGate({
    commandCenter, alertPolicyAuthorization: 'UNAUTHORIZED',
    deliveryAuthorization: 'UNAUTHORIZED', recipientPolicyVersion: null,
  }, cutoff);
  const evidence = Object.fromEntries(acceptance.ACCEPTANCE_EVIDENCE_KEYS.map((key) => [key, false]));
  const admitted = acceptance.buildInstitutionalAcceptanceGate({ alert: alerts, evidence }, cutoff);
  return { commandCenter, alerts, acceptance: admitted };
}
const input = claims();
const original = structuredClone(input);
const wire = transport.encodeOfflineAdvisoryPacket(input, cutoff);
assert.deepEqual(input, original, 'Untrusted claim must remain immutable');
assert.equal(wire, transport.encodeOfflineAdvisoryPacket(structuredClone(input), cutoff),
  'Exactly deterministic canonical bytes');
assert.ok(new TextEncoder().encode(wire).byteLength < transport.ADVISORY_TRANSPORT_MAX_BYTES);
const good = transport.inspectOfflineAdvisoryPacket(wire);
assert.equal(good.status, 'STRUCTURALLY_VALID_UNVERIFIED');
assert.equal(good.reason, null);
assert.equal(good.packet.origin, 'UNVERIFIED');
assert.equal(good.packet.transport, 'NOT_CONNECTED');
assert.equal(good.packet.actionability, 'NONE');
assert.equal(good.packet.advisory.execution, 'FORBIDDEN');
assert.equal(good.packet.advisory.tradeTicket, null);
assert.equal(good.packet.advisory.claimedKnowledgeCutoff, cutoff);
assert.deepEqual(good.packet.advisory.horizons.map((s) => s.horizon),
  ['H1', 'H2', 'H3', 'H4', 'H5']);
assert.deepEqual(good.packet.advisory.reasonCodes, [
  'SOURCE_ATTESTATION_NOT_AVAILABLE', 'UI_RUNTIME_NOT_AUTHORIZED',
]);

function mutation(label, change, reason) {
  const packet = JSON.parse(wire);
  change(packet);
  const altered = JSON.stringify(packet);
  const inspect = transport.inspectOfflineAdvisoryPacket(altered);
  assert.equal(inspect.status, 'REJECTED', label);
  assert.equal(inspect.reason, reason, label);
  assert.equal(inspect.packet, null, label);
}
const UNSAFE = 'UNSAFE_ADVISORY', UNSUPPORTED = 'UNSUPPORTED_PACKET';
[
  ['forged authorization', (x) => { x.actionability = 'ORDER_ALLOWED'; }, UNSUPPORTED],
  ['claimed live source', (x) => { x.origin = 'VERIFIED'; }, UNSUPPORTED],
  ['claimed live transport', (x) => { x.transport = 'PRODUCTION'; }, UNSUPPORTED],
  ['unknown field at root', (x) => { x.brokerAccount = 'fake'; }, UNSUPPORTED],
  ['protocol version mismatch', (x) => { x.schemaVersion = 'v99'; }, UNSUPPORTED],
  ['version spoof', (x) => { x.algorithmVersion = 'altered'; }, UNSUPPORTED],
  ['fake action', (x) => { x.advisory.decision = 'BUY'; }, UNSAFE],
  ['fake execution', (x) => { x.advisory.execution = 'AUTHORIZED'; }, UNSAFE],
  ['order injected', (x) => { x.advisory.tradeTicket = { side: 'BUY' }; }, UNSAFE],
  ['size injected', (x) => { x.advisory.positionSize = 10; }, UNSAFE],
  ['fake horizon', (x) => { x.advisory.horizons[0].direction = 'BULLISH'; }, UNSAFE],
  ['fake confidence', (x) => { x.advisory.horizons[1].confidence = 0.95; }, UNSAFE],
  ['horizons reordered', (x) => { x.advisory.horizons.reverse(); }, UNSAFE],
  ['fake alert', (x) => { x.advisory.alertDelivery = 'AUTHORIZED'; }, UNSAFE],
  ['fake readiness', (x) => { x.advisory.productionReadiness = 'READY'; }, UNSAFE],
  ['changed UI version', (x) => { x.advisory.algorithmVersion = 'unknown'; }, UNSAFE],
  ['missing source reason', (x) => { x.advisory.reasonCodes.pop(); }, UNSAFE],
  ['reason reordered', (x) => { x.advisory.reasonCodes.reverse(); }, UNSAFE],
  ['reason injected', (x) => { x.advisory.reasonCodes.unshift('APPROVED'); }, UNSAFE],
  ['invalid claimed date', (x) => { x.advisory.claimedKnowledgeCutoff = '2026-02-30T10:00:00.000Z'; }, UNSAFE],
  ['fake null cutoff', (x) => { x.advisory.claimedKnowledgeCutoff = null; }, UNSAFE],
  ['extra advisory field', (x) => { x.advisory.credentials = 'no'; }, UNSAFE],
  ['extra horizon field', (x) => { x.advisory.horizons[0].stopLoss = 123; }, UNSAFE],
  ['noncanonical horizon key order', (x) => {
    x.advisory.horizons[0] = {
      direction: 'UNAVAILABLE', horizon: 'H1', state: 'UNAVAILABLE',
      confidence: null, target: null,
    };
  }, UNSAFE],
  ['noncanonical root key order', (x) => {
    const origin = x.origin; delete x.origin; x.origin = origin;
  }, UNSUPPORTED],
].forEach(([label, change, reason]) => mutation(label, change, reason));

for (const raw of [null, 4, {}, undefined]) {
  const inspected = transport.inspectOfflineAdvisoryPacket(raw);
  assert.equal(inspected.reason, 'NOT_A_STRING');
}
assert.equal(transport.inspectOfflineAdvisoryPacket('{').reason, 'INVALID_JSON');
assert.equal(transport.inspectOfflineAdvisoryPacket(wire + '\n').reason, 'NON_CANONICAL_JSON');
assert.equal(transport.inspectOfflineAdvisoryPacket(
  wire.replace('"mediaType":', '"duplicate":null,"mediaType":')
).reason, 'UNSUPPORTED_PACKET');
assert.equal(transport.inspectOfflineAdvisoryPacket(
  wire.replace('"mediaType":', '"mediaType":"application/json","mediaType":')
).reason, 'NON_CANONICAL_JSON');
assert.equal(transport.inspectOfflineAdvisoryPacket('X'.repeat(16385)).reason, 'PAYLOAD_TOO_LARGE');
assert.equal(transport.inspectOfflineAdvisoryPacket(
  JSON.stringify({ data: 'é'.repeat(8500) })
).reason, 'PAYLOAD_TOO_LARGE');

// An attacker can create a well-formed synthetic packet, so acceptance does
// not become an authenticity check — NEVER promote structural status to LIVE.
const copied = JSON.parse(wire);
copied.advisory.claimedKnowledgeCutoff = '2026-10-13T17:00:00.000Z';
const coerced = transport.inspectOfflineAdvisoryPacket(JSON.stringify(copied));
assert.equal(coerced.status, 'STRUCTURALLY_VALID_UNVERIFIED');
assert.equal(coerced.packet.origin, 'UNVERIFIED');
assert.equal(coerced.packet.actionability, 'NONE');

// Broken upstream claims get only extra diagnostics, never output authority.
const spoofClaims = claims();
spoofClaims.commandCenter.tradeTicket = { side: 'BUY' };
const degraded = transport.inspectOfflineAdvisoryPacket(
  transport.encodeOfflineAdvisoryPacket(spoofClaims, cutoff),
);
assert.equal(degraded.status, 'STRUCTURALLY_VALID_UNVERIFIED');
assert.ok(degraded.packet.advisory.reasonCodes.includes('COMMAND_CENTER_CLAIM_REJECTED'));
assert.equal(degraded.packet.advisory.tradeTicket, null);
assert.equal(degraded.packet.actionability, 'NONE');

const source = readFileSync(path.join(root, 'backend/advisory_ui/transport_contract.ts'), 'utf8');
assert.doesNotMatch(source, /\bfetch\(|\bWebSocket\b|Date\.now\(|new Date\(|Math\.random\(|process\.env|document\.|window\.|import\(/);
for (const entrypoint of ['backend/worker.ts', 'frontend/js/dashboard.js']) {
  assert.doesNotMatch(readFileSync(path.join(root, entrypoint), 'utf8'),
    /advisory_ui\/transport_contract/, 'Transport must not be wired live');
}
console.log('TR-0 PASS: deterministic canonical offline packet, 25 mutations, and no authority');
