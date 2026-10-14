/** UI-0 offline-only contract: end-to-end sample from actual CC/AL/E2E gates. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'event_impact/deterministic_processor.ts',
  'gold_transmission/deterministic_processor.ts',
  'market_engine/types.ts', 'market_engine/institutional_snapshot.ts',
  'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
  'horizon_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
  'risk_engine/pre_pm_contract.ts', 'portfolio_engine/contract.ts',
  'risk_engine/final_action_contract.ts', 'action_engine/contract.ts',
  'command_center/contract.ts', 'alert_engine/contract.ts',
  'shared/temporal_contract.ts', 'shared/strict_timestamp.ts',
  'acceptance_engine/contract.ts', 'advisory_ui/contract.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'xau-advisory-ui-0-'));
let ui, actionMod, ccMod, alertMod, acceptanceMod, riskMod;
try {
  for (const source of sources) {
    const original = readFileSync(path.join(root, 'backend', source), 'utf8');
    const output = ts.transpileModule(original, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
      .replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const target = path.join(temp, source.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, output, 'utf8');
  }
  const load = (s) => import(pathToFileURL(path.join(temp, s)).href);
  [ui, actionMod, ccMod, alertMod, acceptanceMod, riskMod] = await Promise.all([
    load('advisory_ui/contract.mjs'),
    load('action_engine/contract.mjs'),
    load('command_center/contract.mjs'),
    load('alert_engine/contract.mjs'),
    load('acceptance_engine/contract.mjs'),
    load('risk_engine/final_action_contract.mjs'),
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const cutoff = '2026-10-13T17:00:00.000Z';
function originalClaims() {
  const action = actionMod.buildActionAbstentionGate({
    finalRisk: {
      schemaVersion: riskMod.FINAL_ACTION_RISK_SCHEMA_VERSION,
      algorithmVersion: riskMod.FINAL_ACTION_RISK_ALGORITHM_VERSION,
      state: 'HOLD', actionEligibility: 'INELIGIBLE', knowledgeCutoff: cutoff,
    },
    executionAuthorization: 'UNAUTHORIZED', brokerConnection: 'ABSENT',
  }, cutoff);
  const commandCenter = ccMod.buildCommandCenterProjection({
    action, runtimeEvidence: { correlationId: null, deploymentId: null },
  }, cutoff);
  const alerts = alertMod.buildAlertSuppressionGate({
    commandCenter, alertPolicyAuthorization: 'UNAUTHORIZED',
    deliveryAuthorization: 'UNAUTHORIZED', recipientPolicyVersion: null,
  }, cutoff);
  const evidence = Object.fromEntries(acceptanceMod.ACCEPTANCE_EVIDENCE_KEYS.map((key) => [key, false]));
  const acceptance = acceptanceMod.buildInstitutionalAcceptanceGate({ alert: alerts, evidence }, cutoff);
  return { commandCenter, alerts, acceptance };
}

const claims = originalClaims();
const before = structuredClone(claims);
const baseline = ui.buildInstitutionalAdvisoryUi(claims, cutoff);
assert.deepEqual(claims, before, 'Projection must not mutate incoming claims');
assert.deepEqual(baseline, ui.buildInstitutionalAdvisoryUi(structuredClone(claims), cutoff), 'Deterministic replay');
assert.deepEqual(baseline.reasonCodes, [
  'SOURCE_ATTESTATION_NOT_AVAILABLE', 'UI_RUNTIME_NOT_AUTHORIZED',
]);
assert.equal(baseline.provenance, 'UNVERIFIED');
assert.equal(baseline.deployment, 'NOT_CONNECTED');
assert.equal(baseline.mode, 'OFFLINE_CONTRACT_ONLY');
assert.equal(baseline.claimedKnowledgeCutoff, cutoff);
assert.deepEqual(baseline.horizons.map((h) => h.horizon), ['H1', 'H2', 'H3', 'H4', 'H5']);
assert.ok(baseline.horizons.every((h) => h.confidence === null && h.direction === 'UNAVAILABLE'));
for (const [key, value] of Object.entries({
  systemState: 'HOLD', decision: 'ABSTAIN', execution: 'FORBIDDEN',
  scenarioTreeStatus: 'UNAVAILABLE', recommendation: null,
  tradeTicket: null, positionSize: null, alertDelivery: 'SUPPRESSED',
  alertPayload: null, productionReadiness: 'HOLD',
})) assert.equal(baseline[key], value, key);

function checkMutation(label, update, mandatory) {
  const altered = structuredClone(claims);
  update(altered);
  const actual = ui.buildInstitutionalAdvisoryUi(altered, cutoff);
  assert.ok(actual.reasonCodes.includes(mandatory), label);
  assert.equal(actual.tradeTicket, null, label);
  assert.equal(actual.execution, 'FORBIDDEN', label);
  assert.equal(actual.provenance, 'UNVERIFIED', label);
}
[
  ['CC approved flag', (x) => { x.commandCenter.approved = true; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC mode forged', (x) => { x.commandCenter.mode = 'LIVE'; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC ready forged', (x) => { x.commandCenter.systemState = 'READY'; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC ticket injected', (x) => { x.commandCenter.tradeTicket = { order: 'BUY' }; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC correlation fabricated', (x) => { x.commandCenter.observability.correlationId = 'fake'; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC lineage altered', (x) => { x.commandCenter.lineage[0].algorithmVersion = 'spoof'; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC cutoff drift', (x) => { x.commandCenter.knowledgeCutoff = '2026-10-14T17:00:00.000Z'; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['CC missing required veto', (x) => { x.commandCenter.reasonCodes = []; }, 'COMMAND_CENTER_CLAIM_REJECTED'],
  ['Alert delivery forged', (x) => { x.alerts.delivery = 'AUTHORIZED'; }, 'ALERT_CLAIM_REJECTED'],
  ['Alert recipient forged', (x) => { x.alerts.recipient = 'webhook'; }, 'ALERT_CLAIM_REJECTED'],
  ['Alert policy injected', (x) => { x.alerts.approved = true; }, 'ALERT_CLAIM_REJECTED'],
  ['Alert payload forged', (x) => { x.alerts.payload = { price: 9000 }; }, 'ALERT_CLAIM_REJECTED'],
  ['Alert version drift', (x) => { x.alerts.algorithmVersion = 'different'; }, 'ALERT_CLAIM_REJECTED'],
  ['Acceptance positive forged', (x) => { x.acceptance.acceptanceState = 'ACCEPTED'; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['Acceptance live proof forged', (x) => { x.acceptance.evidence.runtimeDeploymentProven = true; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['Acceptance report forged', (x) => { x.acceptance.report = { status: 'PASS' }; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['Acceptance extra field', (x) => { x.acceptance.authorized = true; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['Acceptance missing evidence hidden', (x) => { x.acceptance.missingEvidence = []; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['Acceptance cutoff drift', (x) => { x.acceptance.knowledgeCutoff = '2026-10-12T17:00:00.000Z'; }, 'ACCEPTANCE_CLAIM_REJECTED'],
  ['Root authority injected', (x) => { x.executionAuthorization = 'AUTHORIZED'; }, 'INVALID_INPUT_SHAPE'],
].forEach(([label, update, mandatory]) => checkMutation(label, update, mandatory));

for (const bad of [null, undefined, {}, [], 'approved', { commandCenter: null }]) {
  const projection = ui.buildInstitutionalAdvisoryUi(bad, cutoff);
  assert.ok(projection.reasonCodes.includes('INVALID_INPUT_SHAPE'));
  assert.equal(projection.tradeTicket, null);
  assert.equal(projection.execution, 'FORBIDDEN');
}
for (const bad of ['not-a-date', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
  '2026-10-13T24:00:00Z', '2026-10-13T11:11:60Z',
  '2026-10-13T11:11:11+14:30', '', null]) {
  const projection = ui.buildInstitutionalAdvisoryUi(claims, bad);
  assert.equal(projection.claimedKnowledgeCutoff, null);
  assert.ok(projection.reasonCodes.includes('INVALID_CLAIMED_CUTOFF'));
}
assert.equal(ui.buildInstitutionalAdvisoryUi({}, '2028-02-29T12:00:00+02:00')
  .claimedKnowledgeCutoff, '2028-02-29T12:00:00+02:00', 'Leap day and offset accepted only as a claim');

const source = readFileSync(path.join(root, 'backend/advisory_ui/contract.ts'), 'utf8');
assert.doesNotMatch(source, /\bfetch\(|\bWebSocket\b|new Date\(|Date\.now\(|Math\.random\(|process\.env|document\.|window\.|import\(/);
for (const entrypoint of ['backend/worker.ts', 'frontend/js/dashboard.js']) {
  assert.doesNotMatch(readFileSync(path.join(root, entrypoint), 'utf8'), /advisory_ui\/contract/,
    'UI-0 must not be wired into live or legacy entrypoints');
}
assert.match(readFileSync(path.join(root, 'docs/XAU_V2_UI_0_OFFLINE_CONTRACT.md'), 'utf8'),
  /structural claims are not authenticated evidence/i);
console.log('UI-0 PASS: actual CC/AL/E2E abstention, replay and 20 adversarial tamper cases');
