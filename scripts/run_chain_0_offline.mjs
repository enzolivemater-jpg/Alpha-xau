#!/usr/bin/env node
/**
 * CHAIN-0 operator *offline simulation* from a fixed synthetic fixture.
 *
 * No arguments, network, database, environment variables, providers, alerts,
 * migration, broker or execution. Output is synthetic, never live evidence.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

if (process.argv.length !== 2) {
  console.error('CHAIN-0 accepts no arguments or live source paths. Synthetic fixture only.');
  process.exitCode = 2;
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = JSON.parse(readFileSync(
    path.join(root, 'tests/fixtures/chain0_hold_synthetic.json'), 'utf8',
  ));
  assert.equal(fixture.fixtureType, 'SYNTHETIC_CONTRACT_ONLY');
  const sourceFiles = [
    'event_impact/deterministic_processor.ts', 'gold_transmission/deterministic_processor.ts',
    'market_engine/types.ts', 'market_engine/institutional_snapshot.ts',
    'positioning_engine/evidence_contract.ts', 'regime_engine/contract.ts',
    'horizon_engine/contract.ts', 'ai_engine/v2_committee_contract.ts',
    'risk_engine/pre_pm_contract.ts', 'portfolio_engine/contract.ts',
    'risk_engine/final_action_contract.ts', 'action_engine/contract.ts',
    'command_center/contract.ts', 'alert_engine/contract.ts',
    'acceptance_engine/contract.ts', 'decision_chain/dry_run.ts',
    'observability/offline_receipt.ts',
  ];
  const temp = mkdtempSync(path.join(tmpdir(), 'xau-offline-cli-'));
  let run, buildReceipt;
  try {
    for (const source of sourceFiles) {
      const input = readFileSync(path.join(root, 'backend', source), 'utf8');
      const js = ts.transpileModule(input, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText.replaceAll(/(['"])(\.\.?\/[a-z0-9_]+\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1')
        .replaceAll(/(['"])(\.\/[a-z0-9_]+)\.js\1/g, '$1$2.mjs$1');
      const dst = path.join(temp, source.replace(/\.ts$/, '.mjs'));
      mkdirSync(path.dirname(dst), { recursive: true });
      writeFileSync(dst, js, 'utf8');
    }
    ({ runDecisionChainDryRun: run } = await import(
      pathToFileURL(path.join(temp, 'decision_chain/dry_run.mjs')).href
    ));
    ({ buildOfflineAuditReceipt: buildReceipt } = await import(
      pathToFileURL(path.join(temp, 'observability/offline_receipt.mjs')).href
    ));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const result = run(fixture.input);
  const receipt = await buildReceipt(result);
  assert.equal(result.systemState, 'HOLD');
  assert.equal(result.execution, 'FORBIDDEN');
  assert.equal(receipt.verification, 'VALID_HOLD');
  assert.equal(result.stages.action.order, null);
  assert.equal(result.stages.alerts.delivery, 'FORBIDDEN');
  assert.equal(result.stages.acceptance.productionReadiness, 'HOLD');
  // Do not print any provider/user input data beyond synthetic reason codes.
  console.log(JSON.stringify({
    evidenceType: fixture.fixtureType,
    mode: result.mode,
    knowledgeCutoff: result.knowledgeCutoff,
    state: result.systemState,
    decision: result.stages.action.decision,
    execution: result.execution,
    alertDelivery: result.stages.alerts.delivery,
    acceptance: result.stages.acceptance.acceptanceState,
    receiptVerification: receipt.verification,
    checksumSha256: receipt.fingerprint,
    stages: receipt.lineage.map((entry) => ({
      stage: entry.stage, state: entry.state, reasonCodes: entry.reasonCodes,
    })),
  }, null, 2));
}
