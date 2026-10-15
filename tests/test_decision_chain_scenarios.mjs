// CHAIN-0 business scenarios and combinatorial no-execution invariant.
// Runs the real gates end to end; nothing is mocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const golden = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const cutoff = golden.knowledgeCutoff;
const baseline = golden.input;
const EVIDENCE_KEYS = Object.keys(baseline.acceptanceEvidence);
const AUTH_KEYS = Object.keys(baseline.authorizations);

/** Everything a caller can grant is granted; only methods stay unapproved. */
function maximal() {
  const input = structuredClone(baseline);
  for (const key of AUTH_KEYS) input.authorizations[key] = 'AUTHORIZED';
  Object.assign(input, {
    eventImpact: { ...input.eventImpact, status: 'ASSESSED' },
    goldTransmission: { ...input.goldTransmission, status: 'ASSESSED' },
    evidenceGraph: { schemaVersion: 'xau.evidence-graph.v0-test', complete: true, nodeCount: 3 },
    portfolioState: 'AVAILABLE', brokerConstraintsVersion: 'broker-test-1',
    brokerConnection: 'CONNECTED', recipientPolicyVersion: 'recipients-test-1',
    runtimeEvidence: { correlationId: 'corr-test-1', deploymentId: 'deploy-test-1' },
    acceptanceEvidence: Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, true])),
  });
  return input;
}

/** The invariant every outcome must satisfy, whatever the input. */
function assertNoExecution(outcome, label) {
  assert.equal(outcome.chainState ?? outcome.result?.chainState, 'HOLD', label);
  assert.equal(outcome.execution ?? outcome.result?.execution, 'FORBIDDEN', label);
  if (outcome.kind !== 'COMPLETED') return;
  const { result } = outcome;
  assert.equal(result.integrity, 'CONSISTENT', `${label}: ${JSON.stringify(result.violations)}`);
  const s = result.stages;
  assert.equal(s.action.decision, 'ABSTAIN', label);
  assert.equal(s.action.order, null, label);
  assert.equal(s.action.recommendation, null, label);
  assert.equal(s.finalActionRisk.actionEligibility, 'BLOCKED', label);
  assert.equal(s.finalActionRisk.positionSize, null, label);
  assert.equal(s.portfolioManager.sizing, null, label);
  assert.equal(s.commandCenter.tradeTicket, null, label);
  assert.equal(s.alert.delivery, 'FORBIDDEN', label);
  assert.equal(s.acceptance.acceptanceState, 'NOT_ACCEPTED', label);
  assert.equal(s.committee.providerInvocation, 'FORBIDDEN', label);
  for (const scenario of s.horizonSynthesis.scenarios) assert.equal(scenario.status, 'ABSTAIN', label);
}

const stageReasons = (outcome, stage) =>
  outcome.result.trace.find((item) => item.stage === stage).reasonCodes;

// --- 1. Named scenarios: each blocks for its own explicit, traceable reason.
const scenarios = [
  ['no approved strategy (everything else granted)', (i) => i, [
    ['REGIME', 'REGIME_METHODOLOGY_NOT_APPROVED'], ['HORIZON_SYNTHESIS', 'HORIZON_METHODOLOGY_NOT_APPROVED'],
    ['ACTION', 'ACTION_METHOD_NOT_APPROVED'],
  ]],
  ['contradictory evidence: impact assessed, transmission insufficient', (i) => {
    i.goldTransmission.status = 'INSUFFICIENT_EVIDENCE';
  }, [['HORIZON_SYNTHESIS', 'GOLD_TRANSMISSION_INSUFFICIENT']]],
  ['risk not computable: no broker constraints, no risk policy', (i) => {
    i.brokerConstraintsVersion = null;
    i.authorizations.riskPolicy = 'UNAUTHORIZED';
  }, [['FINAL_ACTION_RISK', 'BROKER_CONSTRAINTS_UNAVAILABLE'], ['FINAL_ACTION_RISK', 'RISK_POLICY_NOT_APPROVED']]],
  ['unknown positioning: no retained evidence', (i) => { i.positioningEvidence = []; }, [
    ['POSITIONING', 'NO_POSITIONING_EVIDENCE'], ['REGIME', 'POSITIONING_EVIDENCE_ABSTAINED'],
  ]],
  ['stale market: spot observed 2h before cutoff', (i) => {
    for (const name of ['spot', 'bid', 'ask']) i.marketSnapshot[name].observedAt = '2026-10-01T12:15:00.000Z';
    i.marketSnapshot.capturedAt = '2026-10-01T12:15:00.000Z';
  }, [['MARKET_PRICING', 'SPOT_NOT_LIVE'], ['HORIZON_SYNTHESIS', 'MARKET_PRICING_NOT_AVAILABLE']]],
  ['unvalidated macro event: impact unavailable', (i) => { i.eventImpact.status = 'UNAVAILABLE'; },
    [['HORIZON_SYNTHESIS', 'EVENT_IMPACT_INSUFFICIENT']]],
  ['incoherent version: legacy event-impact processor', (i) => {
    i.eventImpact.algorithmVersion = 'event-impact-deterministic-processor-v4';
  }, [['HORIZON_SYNTHESIS', 'EVENT_IMPACT_VERSION_MISMATCH']]],
  ['incoherent cutoff: upstream summary one second early', (i) => {
    i.goldTransmission.knowledgeCutoff = '2026-10-01T14:14:59.000Z';
  }, [['HORIZON_SYNTHESIS', 'UPSTREAM_CUTOFF_MISMATCH']]],
  ['incoherent identifier: blank correlation ID', (i) => { i.runtimeEvidence.correlationId = ''; },
    [['COMMAND_CENTER', 'RUNTIME_CORRELATION_UNAVAILABLE']]],
  ['look-ahead market data', (i) => { i.marketSnapshot.wti.observedAt = '2026-10-01T15:00:00.000Z'; },
    [['MARKET_PRICING', 'OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'], ['REGIME', 'MARKET_PRICING_ABSTAINED']]],
  ['execution not authorized and broker absent', (i) => {
    i.authorizations.execution = 'UNAUTHORIZED';
    i.brokerConnection = 'ABSENT';
  }, [['ACTION', 'EXECUTION_NOT_AUTHORIZED'], ['ACTION', 'BROKER_NOT_CONNECTED']]],
  ['acceptance evidence partially missing', (i) => { i.acceptanceEvidence.incidentRecoveryProven = false; },
    [['ACCEPTANCE', 'REQUIRED_EVIDENCE_MISSING']]],
];
for (const [label, mutate, expected] of scenarios) {
  const input = maximal();
  mutate(input);
  const outcome = chain.evaluateDecisionChain(input, cutoff);
  assert.equal(outcome.kind, 'COMPLETED', label);
  assertNoExecution(outcome, label);
  for (const [stage, code] of expected) {
    assert.ok(stageReasons(outcome, stage).includes(code), `${label}: ${stage} lacks ${code}`);
  }
}

// --- 2. Intermediate engine failure and malformed input are explicit HOLD outcomes.
const broken = maximal();
broken.positioningEvidence = [new Proxy({}, { ownKeys() { throw new RangeError('engine fault'); } })];
const brokenOutcome = chain.evaluateDecisionChain(broken, cutoff);
assert.equal(brokenOutcome.kind, 'REJECTED');
assert.equal(brokenOutcome.failedAt, 'POSITIONING');
assert.match(brokenOutcome.stageError, /^POSITIONING: RangeError: engine fault$/);
assertNoExecution(brokenOutcome, 'engine failure');
const malformed = maximal();
malformed.authorizations.execution = true;
const malformedOutcome = chain.evaluateDecisionChain(malformed, cutoff);
assert.equal(malformedOutcome.kind, 'REJECTED');
assert.deepEqual(malformedOutcome.inputErrors, [{ path: 'authorizations.execution', code: 'INVALID_TYPE' }]);
assertNoExecution(malformedOutcome, 'malformed input');

// --- 3. Final-control failure: a tampered result is always detected.
const good = chain.evaluateDecisionChain(maximal(), cutoff).result;
const forged = structuredClone(good);
forged.stages.action.order = { side: 'BUY', quantity: 1 };
forged.stages.action.execution = 'AUTHORIZED';
assert.deepEqual(chain.verifyDecisionChainIntegrity(forged).map((v) => `${v.stage}:${v.code}`),
  ['ACTION:POSITIVE_OUTPUT_FORBIDDEN']);

// --- 4. Exhaustive over every grantable authorization and broker/portfolio state.
let runs = 0;
for (let mask = 0; mask < 2 ** (AUTH_KEYS.length + 2); mask += 1) {
  const input = maximal();
  AUTH_KEYS.forEach((key, bit) => {
    input.authorizations[key] = mask & (1 << bit) ? 'AUTHORIZED' : 'UNAUTHORIZED';
  });
  input.brokerConnection = mask & (1 << AUTH_KEYS.length) ? 'CONNECTED' : 'ABSENT';
  input.portfolioState = mask & (1 << (AUTH_KEYS.length + 1)) ? 'AVAILABLE' : 'UNAVAILABLE';
  assertNoExecution(chain.evaluateDecisionChain(input, cutoff), `mask ${mask}`);
  runs += 1;
}

// --- 5. Seeded sampling of the remaining dimensions (deterministic, no Math.random).
let seed = 0x2f6b9d1;
const next = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
};
const pick = (options) => options[next() % options.length];
const STATUSES = ['ASSESSED', 'INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'];
const CUTOFFS = [cutoff, '2026-10-01T14:14:59.000Z', '2026-02-30T14:15:00.000Z', '2026-10-01'];
const OBSERVED = ['2026-10-01T14:14:00.000Z', '2026-10-01T12:15:00.000Z', '2026-09-27T14:14:00.000Z',
  '2026-10-01T15:00:00.000Z', '2026-09-31T14:14:00.000Z'];
for (let index = 0; index < 1500; index += 1) {
  const input = maximal();
  for (const key of AUTH_KEYS) input.authorizations[key] = pick(['AUTHORIZED', 'UNAUTHORIZED']);
  input.eventImpact.status = pick(STATUSES);
  input.goldTransmission.status = pick(STATUSES);
  input.eventImpact.knowledgeCutoff = pick(CUTOFFS);
  input.goldTransmission.knowledgeCutoff = pick(CUTOFFS);
  for (const name of ['spot', 'vix', 'wti']) input.marketSnapshot[name].observedAt = pick(OBSERVED);
  input.marketSnapshot.capturedAt = input.marketSnapshot.spot.observedAt;
  input.brokerConstraintsVersion = pick([null, '', 'broker-test-1']);
  input.recipientPolicyVersion = pick([null, ' ', 'recipients-test-1']);
  input.runtimeEvidence = { correlationId: pick([null, '', 'corr-1']), deploymentId: pick([null, 'deploy-1']) };
  input.evidenceGraph = pick([
    { schemaVersion: null, complete: false, nodeCount: 0 },
    { schemaVersion: 'graph-1', complete: true, nodeCount: 4 },
    { schemaVersion: 'graph-1', complete: true, nodeCount: -1 },
  ]);
  if (next() % 5 === 0) input.positioningEvidence = [];
  for (const key of EVIDENCE_KEYS) input.acceptanceEvidence[key] = pick([true, false]);
  const at = pick(CUTOFFS);
  const outcome = chain.evaluateDecisionChain(input, at);
  assertNoExecution(outcome, `sample ${index}`);
  // Replay: the same input gives the same result.
  assert.deepEqual(chain.evaluateDecisionChain(structuredClone(input), at), outcome, `replay ${index}`);
  runs += 1;
}

console.log(`PASS CHAIN-0 holds with execution forbidden across ${scenarios.length} scenarios and ${runs} combinations`);
