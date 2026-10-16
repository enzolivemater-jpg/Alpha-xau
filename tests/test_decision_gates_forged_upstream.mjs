/**
 * Gate-level forged-upstream sweep. CHAIN-0 feeds every gate the exact envelope
 * of the previous stage; this test calls each gate DIRECTLY with that argument
 * object mutated (forged or malformed upstream envelope, authorizations,
 * policy versions, cutoff), on both the honest golden chain and a chain where
 * every caller-grantable authorization is AUTHORIZED. A gate may refuse by
 * throwing (CHAIN-0 turns that into a REJECTED, HOLD outcome) but it may never
 * return an output that CHAIN-0's integrity check calls positive or in a state
 * other than the stage's approved one. No positive method is approved.
 * Offline and deterministic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { TERMINAL_SCENARIOS } from '../scripts/lib/terminal_scenarios.mjs';
import { mutationCases } from './lib/mutation_cases.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const gates = {
  regime: await loadBackendModule('regime_engine/contract.ts'),
  horizon: await loadBackendModule('horizon_engine/contract.ts'),
  committee: await loadBackendModule('ai_engine/v2_committee_contract.ts'),
  prePm: await loadBackendModule('risk_engine/pre_pm_contract.ts'),
  pm: await loadBackendModule('portfolio_engine/contract.ts'),
  far: await loadBackendModule('risk_engine/final_action_contract.ts'),
  action: await loadBackendModule('action_engine/contract.ts'),
  cc: await loadBackendModule('command_center/contract.ts'),
  alert: await loadBackendModule('alert_engine/contract.ts'),
  acceptance: await loadBackendModule('acceptance_engine/contract.ts'),
};
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const granted = TERMINAL_SCENARIOS.find((s) => s.id === 'everything-granted').build(golden);

/** [stage key in the chain, stage name, builder, argument factory from honest input + stages] */
const GATES = [
  ['regime', 'REGIME', gates.regime.buildRegimeAssessmentContract, (i, s) => ({ marketPricing: s.marketPricing, positioning: s.positioning })],
  ['horizonSynthesis', 'HORIZON_SYNTHESIS', gates.horizon.buildHorizonSynthesisContract, (i, s) => ({
    eventImpact: i.eventImpact, goldTransmission: i.goldTransmission,
    marketPricing: s.marketPricing, positioning: s.positioning, regime: s.regime })],
  ['committee', 'AI_COMMITTEE', gates.committee.buildCommitteeV2Gate, (i, s) => ({
    horizonSynthesis: s.horizonSynthesis, providerAuthorization: i.authorizations.provider, costAuthorization: i.authorizations.cost })],
  ['prePm', 'PRE_PM', gates.prePm.buildPrePmEvidenceRiskGate, (i, s) => ({ committee: s.committee, evidenceGraph: i.evidenceGraph })],
  ['portfolioManager', 'PORTFOLIO_MANAGER', gates.pm.buildPortfolioManagerGate, (i, s) => ({
    prePm: s.prePm, portfolioPolicyAuthorization: i.authorizations.portfolioPolicy, portfolioState: i.portfolioState })],
  ['finalActionRisk', 'FINAL_ACTION_RISK', gates.far.buildFinalActionRiskGate, (i, s) => ({
    portfolioManager: s.portfolioManager, riskPolicyAuthorization: i.authorizations.riskPolicy,
    brokerConstraintsVersion: i.brokerConstraintsVersion })],
  ['action', 'ACTION', gates.action.buildActionAbstentionGate, (i, s) => ({
    finalRisk: s.finalActionRisk, executionAuthorization: i.authorizations.execution, brokerConnection: i.brokerConnection })],
  ['commandCenter', 'COMMAND_CENTER', gates.cc.buildCommandCenterProjection, (i, s) => ({ action: s.action, runtimeEvidence: i.runtimeEvidence })],
  ['alert', 'ALERT', gates.alert.buildAlertSuppressionGate, (i, s) => ({
    commandCenter: s.commandCenter, alertPolicyAuthorization: i.authorizations.alertPolicy,
    deliveryAuthorization: i.authorizations.delivery, recipientPolicyVersion: i.recipientPolicyVersion })],
  ['acceptance', 'ACCEPTANCE', gates.acceptance.buildInstitutionalAcceptanceGate, (i, s) => ({ alert: s.alert, evidence: i.acceptanceEvidence })],
];

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { returned: 0, refused: 0 };

for (const [documentName, document] of [['golden', golden], ['everything-granted', granted]]) {
  const outcome = chain.evaluateDecisionChain(document.input, document.knowledgeCutoff);
  assert.equal(outcome.kind, 'COMPLETED', documentName);
  const honest = outcome.result;
  assert.equal(honest.integrity, 'CONSISTENT', documentName);
  const cutoff = document.knowledgeCutoff;

  for (const [key, stage, build, args] of GATES) {
    const base = args(document.input, honest.stages);
    // The honest call reproduces the chain's own stage output: the sweep starts from the real thing.
    assert.deepEqual(build(structuredClone(base), cutoff), honest.stages[key], `${documentName} ${stage} honest call`);
    const cases = [['<base>', structuredClone(base), cutoff], ...mutationCases(base).map(([l, a]) => [l, a, cutoff])];
    // Hostile cutoffs against the honest argument object.
    for (const [l, hostile] of mutationCases({ cutoff }).filter(([l]) => l.startsWith('cutoff'))) {
      cases.push([`cutoff ${l}`, structuredClone(base), hostile.cutoff]);
    }
    for (const [mutation, argument, usedCutoff] of cases) {
      const label = `${documentName} ${stage} ${mutation}`;
      let output;
      try {
        output = build(argument, usedCutoff);
      } catch {
        tally.refused += 1;
        continue;
      }
      tally.returned += 1;
      try {
        const violations = chain.verifyDecisionChainIntegrity({ ...honest, stages: { ...honest.stages, [key]: output } });
        const bad = violations.filter((v) => v.stage === stage
          && (v.code === 'POSITIVE_OUTPUT_FORBIDDEN' || v.code === 'STAGE_STATE_FORBIDDEN'));
        if (bad.length) note(label, `positive or forbidden-state output ${JSON.stringify(bad)}`);
        // An output CHAIN-0 cannot read (for instance one echoing a non-string cutoff, which the
        // chain's own entry point never passes) is reported as MALFORMED_RESULT and OBS-0 refuses it.
      } catch (error) {
        note(label, `verification THREW ${error && error.message}`);
      }
    }
  }
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `FORGED-UPSTREAM failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.returned > 100 && tally.refused > 100, `the sweep exercises results and refusals ${JSON.stringify(tally)}`);
console.log(`PASS decision gates under forged upstream: ${tally.returned + tally.refused} direct hostile calls over 10 gates x 2 chains, `
  + `${tally.returned} outputs without a positive or forbidden state, ${tally.refused} refusals`);
