/** Fixed adversarial corpus. No network, production data or runtime wiring. */
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
  'acceptance_engine/contract.ts', 'decision_chain/dry_run.ts',
  'shared/temporal_contract.ts',
  'observability/offline_receipt.ts',
];
const temp = mkdtempSync(path.join(tmpdir(), 'xau-chain-attack-'));
let run, receipt;
try {
  for (const source of sources) {
    const input = readFileSync(path.join(root, 'backend', source), 'utf8');
    const js = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
      .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
    const outputPath = path.join(temp, source.replace(/\.ts$/, '.mjs'));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, js);
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
const baseline = () => ({
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
});
function assertSafe(value) {
  assert.equal(value.systemState, 'HOLD');
  assert.equal(value.execution, 'FORBIDDEN');
  assert.equal(value.stages.horizons.scenarios.length, 5);
  assert.ok(value.stages.horizons.scenarios.every((s) =>
    s.status === 'ABSTAIN' && s.target === null && s.invalidation === null));
  assert.equal(value.stages.committee.providerInvocation, 'FORBIDDEN');
  assert.equal(value.stages.portfolioManager.sizing, null);
  assert.equal(value.stages.finalActionRisk.stopLoss, null);
  assert.equal(value.stages.action.decision, 'ABSTAIN');
  assert.equal(value.stages.action.order, null);
  assert.equal(value.stages.commandCenter.tradeTicket, null);
  assert.equal(value.stages.alerts.delivery, 'FORBIDDEN');
  assert.equal(value.stages.acceptance.productionReadiness, 'HOLD');
}

const corpus = JSON.parse(readFileSync(
  path.join(root, 'tests/fixtures/chain_0_negative_corpus.json'), 'utf8',
));
assert.equal(corpus.schemaVersion, 'xau.chain-0-negative-corpus.v1');
assert.ok(corpus.cases.length >= 12);
const names = new Set();
for (const spec of corpus.cases) {
  assert.ok(!names.has(spec.name), 'Duplicate corpus entry');
  names.add(spec.name);
  const trial = baseline();
  const parts = spec.path.split('.');
  assert.ok(parts.length >= 1 && parts.length <= 2);
  const receiver = parts.length === 1 ? trial : trial[parts[0]];
  assert.ok(Object.hasOwn(receiver, parts.at(-1)), spec.path);
  receiver[parts.at(-1)] = spec.value;
  const result = run(trial);
  assertSafe(result);
  assert.ok(result.stages[spec.stage].reasonCodes.includes(spec.reason),
    `${spec.name}: expected ${spec.stage} to flag ${spec.reason}`);
  assert.deepEqual(result, run(structuredClone(trial)), `${spec.name}: determinism`);
  const audit = await receipt(result);
  if (spec.path === 'knowledgeCutoff') {
    assert.equal(audit.verification, 'REJECTED');
    assert.equal(audit.fingerprint, null);
    assert.ok(audit.problems.includes('CUTOFF_INVALID'));
  } else {
    assert.equal(audit.verification, 'VALID_HOLD', spec.name);
    assert.match(audit.fingerprint, /^[a-f0-9]{64}$/);
  }
}

// Unknown, malicious authorization-like properties must be ignored by
// this offline-only API and must not enable any action/provider.
const hostile = baseline();
hostile.providerAuthorization = 'AUTHORIZED';
hostile.costAuthorization = 'AUTHORIZED';
hostile.executionAuthorization = 'AUTHORIZED';
hostile.brokerConnection = 'CONNECTED';
hostile.portfolioPolicyAuthorization = 'AUTHORIZED';
hostile.alertPolicyAuthorization = 'AUTHORIZED';
hostile.acceptanceEvidence = { executionAuthorityApproved: true };
assert.deepEqual(run(hostile), run(baseline()),
  'Untrusted extra flags cannot authorize offline behavior');

// Future proof: spoofing positive upstream labels does not turn the
// contract-only chain into a positive decision.
const spoofed = baseline();
spoofed.eventImpact.status = 'ASSESSED';
spoofed.goldTransmission.status = 'ASSESSED';
spoofed.marketPricing.state = 'AVAILABLE';
spoofed.positioning.evidenceState = 'EVIDENCE_READY';
const positiveSpoof = run(spoofed);
assertSafe(positiveSpoof);
assert.ok(positiveSpoof.stages.horizons.reasonCodes.includes('REGIME_UNAVAILABLE'));
assert.ok(positiveSpoof.stages.horizons.reasonCodes.includes('HORIZON_METHODOLOGY_NOT_APPROVED'));
console.log(`PASS CHAIN-0 adversarial corpus: ${corpus.cases.length} variants + forged approvals`);
