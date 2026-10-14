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
  'command_center/contract.ts', 'alert_engine/contract.ts', 'acceptance_engine/contract.ts',
  'shared/temporal_contract.ts',
  'decision_chain/dry_run.ts', 'observability/offline_receipt.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'xau-obs-0-'));
let run, receipt;
try {
  for (const source of sources) {
    const input = readFileSync(path.join(root, 'backend', source), 'utf8');
    const js = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const destination = path.join(temp, source.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, js);
  }
  ({ runDecisionChainDryRun: run } = await import(
    pathToFileURL(path.join(temp, 'decision_chain/dry_run.mjs')).href
  ));
  ({ buildOfflineAuditReceipt: receipt } = await import(
    pathToFileURL(path.join(temp, 'observability/offline_receipt.mjs')).href
  ));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const cutoff = '2026-10-13T15:00:00.000Z';
const input = {
  knowledgeCutoff: cutoff,
  eventImpact: {
    algorithmVersion: 'event-impact-deterministic-processor-v5',
    status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff,
  },
  goldTransmission: {
    algorithmVersion: 'gold-transmission-deterministic-processor-v5',
    status: 'INSUFFICIENT_EVIDENCE', knowledgeCutoff: cutoff,
  },
  marketPricing: {
    schemaVersion: 'xau.market-pricing-snapshot.v1',
    algorithmVersion: 'market-pricing-envelope-1.0.0',
    state: 'DEGRADED', reasonCodes: ['HISTORICAL_REPLAY_UNAVAILABLE'],
    knowledgeCutoff: cutoff,
  },
  positioning: {
    schemaVersion: 'xau.positioning-evidence.v1',
    algorithmVersion: 'positioning-evidence-normalizer-1.0.0',
    evidenceState: 'ABSTAIN', positioningState: 'UNAVAILABLE',
    reasonCodes: ['NO_POSITIONING_EVIDENCE'], knowledgeCutoff: cutoff,
  },
};
const chain = run(input);
const first = await receipt(chain);
const second = await receipt(structuredClone(chain));
assert.deepEqual(first, second, 'Checksum must replay byte for byte');
assert.equal(first.verification, 'VALID_HOLD');
assert.equal(first.execution, 'FORBIDDEN');
assert.deepEqual(first.problems, []);
assert.equal(first.lineage.length, 10);
assert.deepEqual(first.lineage.map((s) => s.stage), [
  'REGIME', 'HORIZONS', 'COMMITTEE', 'PRE_PM', 'PORTFOLIO_MANAGER',
  'FINAL_ACTION_RISK', 'ACTION', 'COMMAND_CENTER', 'ALERTS', 'ACCEPTANCE',
]);
assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
const changedInputs = structuredClone(input);
changedInputs.marketPricing.algorithmVersion = 'bad-version';
const changed = await receipt(run(changedInputs));
assert.equal(changed.verification, 'VALID_HOLD');
assert.notEqual(changed.fingerprint, first.fingerprint, 'Different reasons affect checksum');

// Forged envelopes must never yield a valid fingerprint.
for (const [change, expected] of [
  [(v) => { v.stages.horizons.knowledgeCutoff = '2026-10-14T01:00:00.000Z'; }, 'STAGE_CUTOFF_MISMATCH'],
  [(v) => { v.stages.action.execution = 'AUTHORIZED'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.portfolioManager.recommendation = 'BUY'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.alerts.payload = { message: 'fake' }; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.finalActionRisk.algorithmVersion = 'unknown'; }, 'STAGE_IDENTITY_INVALID'],
  [(v) => { v.stages.acceptance.reasonCodes = ['DUPLICATE', 'DUPLICATE']; }, 'REASON_CODES_INVALID'],
  [(v) => { v.systemState = 'READY'; }, 'CHAIN_STATE_INVALID'],
  [(v) => { v.stages.horizons.scenarios[0].horizon = 'H5'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.horizons.scenarios[2].confidence = 0.9; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.committee.request = { prompt: 'forced' }; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.prePm.riskVerdict = 'APPROVED'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.finalActionRisk.maximumLoss = 500; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.action.recommendation = 'BUY'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.commandCenter.observability.correlationId = 'fake-runtime-id'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.alerts.recipient = 'someone@example.invalid'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.alerts.channel = 'EMAIL'; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.acceptance.evidence.executionAuthorityApproved = true; }, 'UNSAFE_OUTPUT_PRESENT'],
  [(v) => { v.stages.acceptance.acceptanceRun = { success: true }; }, 'UNSAFE_OUTPUT_PRESENT'],
]) {
  const clone = structuredClone(chain);
  change(clone);
  const rejected = await receipt(clone);
  assert.equal(rejected.verification, 'REJECTED');
  assert.equal(rejected.fingerprint, null);
  assert.ok(rejected.problems.includes(expected), expected);
  assert.equal(rejected.execution, 'FORBIDDEN');
}
// Regression: Date.parse normalizes nonexistent days. No valid receipt for them.
for (const bad of [
  '2026-02-30T15:00:00.000Z',
  '2026-04-31T15:00:00.000Z',
  '2027-02-29T15:00:00.000Z',
  '1900-02-29T15:00:00.000Z',
  '2026-13-01T15:00:00.000Z',
  '2026-10-13T24:00:00.000Z',
  '2026-10-13T15:60:00.000Z',
  '2026-10-13T15:00:60.000Z',
  '2026-10-13T15:00:00+23:59',
  '2026-10-13T15:00:00+14:30',
  '2026-10-13T15:00:00',
]) {
  const mutated = structuredClone(input);
  mutated.knowledgeCutoff = bad;
  for (const key of ['eventImpact', 'goldTransmission', 'marketPricing', 'positioning']) {
    mutated[key].knowledgeCutoff = bad;
  }
  const negative = await receipt(run(mutated));
  assert.equal(negative.verification, 'REJECTED', bad);
  assert.equal(negative.fingerprint, null, bad);
  assert.ok(negative.problems.includes('CUTOFF_INVALID'), bad);
}
for (const good of ['2028-02-29T12:00:00Z', '2028-02-29T12:00:00+02:00', '2000-02-29T12:00:00Z']) {
  const modified = structuredClone(input);
  modified.knowledgeCutoff = good;
  for (const key of ['eventImpact', 'goldTransmission', 'marketPricing', 'positioning']) {
    modified[key].knowledgeCutoff = good;
  }
  const positive = await receipt(run(modified));
  assert.equal(positive.verification, 'VALID_HOLD', good);
  assert.match(positive.fingerprint, /^[0-9a-f]{64}$/, good);
}

const source = readFileSync(path.join(root, 'backend/observability/offline_receipt.ts'), 'utf8');
assert.doesNotMatch(source, /\bfetch\(|process\.env|Math\.random\(|Date\.now\(|new Date\(|\bWebSocket\b/);
console.log('PASS OBS-0 deterministic offline checksum and tamper fail-closed');
