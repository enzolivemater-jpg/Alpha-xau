/**
 * RC-0: one offline systems-level smoke across DATA-4E/4F/4G and
 * CHAIN-0 / OBS-0 / terminal / advisory. No external I/O, DB or broker.
 * Synthetic successful receipts NEVER authorize real market decisions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { buildLocalView } from '../scripts/serve_terminal_local.mjs';

const [schedule, replay, readiness, unified] = await Promise.all([
  loadBackendModule('market_engine/capture_schedule.ts'),
  loadBackendModule('market_engine/offline_capture_replay.ts'),
  loadBackendModule('market_engine/collector_readiness.ts'),
  loadBackendModule('observability/unified_rehearsal.ts'),
]);
const policy = {
  schemaVersion: 'xau.capture-schedule-policy.v1',
  planId: 'rc0-offline-only',
  windowStart: '2026-10-15T00:00:00.000Z',
  windowEnd: '2026-10-16T00:00:00.000Z',
  requestBudgets: {fred: 1, twelve_data: 1},
  series: [
    {provider:'fred',symbol:'US10Y',sourceRecordId:'DGS10',windows:[
      {slotId:'fred-dgs10',earliestAt:'2026-10-15T08:00:00.000Z',
       deadlineAt:'2026-10-15T08:10:00.000Z'},
    ]},
    {provider:'twelve_data',symbol:'XAUUSD',sourceRecordId:'XAU/USD',windows:[
      {slotId:'twelve-xau',earliestAt:'2026-10-15T09:00:00.000Z',
       deadlineAt:'2026-10-15T09:10:00.000Z'},
    ]},
  ],
};
const compiled = schedule.compileCaptureSchedule(policy);
const planFingerprint = await readiness.fingerprintCaptureSchedule(policy);
assert.equal(compiled.plannedRequests, 2);
assert.equal(compiled.authorization, 'OFFLINE_ONLY');
assert.equal(compiled.calendarCompleteness, 'NOT_PROVEN');
assert.match(planFingerprint, /^sha256:[a-f0-9]{64}$/);

const cutoff = '2026-10-16T00:00:00.000Z';
const fakeDigest = 'sha256:' + 'f'.repeat(64);
const attempts = [
  {slotId:'fred-dgs10',attempt:1,at:'2026-10-15T08:02:00.000Z',
   outcome:'CAPTURED',rawPayloadDigest:fakeDigest,failureCode:null},
  {slotId:'twelve-xau',attempt:1,at:'2026-10-15T09:01:00.000Z',
   outcome:'RETRYABLE_FAILURE',rawPayloadDigest:null,failureCode:'TIMEOUT'},
  {slotId:'twelve-xau',attempt:2,at:'2026-10-15T09:03:00.000Z',
   outcome:'CAPTURED',rawPayloadDigest:fakeDigest,failureCode:null},
];
const retry = {
  maxAttemptsPerSlot: 2, minimumRetryDelayMs: 60_000,
  maxProviderAttempts: {fred: 1, twelve_data: 2},
};
const simulated = replay.replayOfflineCaptureAttempts(policy, attempts, cutoff, retry);
assert.equal(simulated.status, 'SIMULATED');
assert.equal(simulated.audit.status, 'ATTEMPTS_RECORDED');
assert.equal(simulated.simulationOnly, true);
assert.equal(simulated.providerAuthenticity, 'NOT_PROVEN');
assert.equal(simulated.archiveCoverage, 'NOT_ESTABLISHED');
assert.equal(simulated.decision, 'HOLD');
assert.equal(simulated.execution, 'FORBIDDEN');
assert.deepEqual(replay.replayOfflineCaptureAttempts(
  policy, [...attempts].reverse(), cutoff, retry), simulated);

const review = {
  schemaVersion: readiness.COLLECTOR_READINESS_SCHEMA_VERSION,
  planId: policy.planId, planFingerprint,
  gates: readiness.REQUIRED_COLLECTOR_GATES.map(gate_id => ({
    gate_id, status:'PENDING', evidence_reference:null, evidence_digest:null,
    reviewer:null, reviewed_at_utc:null, expiry_or_review_due:null,
    scope:null, version:null, rejection_reasons:[],
  })),
};
const result = await readiness.evaluateCollectorReadinessForSchedule(policy, review, cutoff);
assert.equal(result.status, 'INCOMPLETE');
assert.equal(result.unapprovedGates.length, readiness.REQUIRED_COLLECTOR_GATES.length);
assert.equal(result.execution, 'FORBIDDEN');
await assert.rejects(() => readiness.evaluateCollectorReadinessForSchedule(
  {...policy, series: [{...policy.series[0], windows: [{...policy.series[0].windows[0],
    deadlineAt:'2026-10-15T08:11:00.000Z'}]}, policy.series[1]]},
  review, cutoff,
), /COLLECTOR_READINESS_PLAN_MISMATCH/);

const golden = JSON.parse(readFileSync(new URL(
  './fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const generatedAt = '2026-10-14T12:00:00.000Z';
const unifiedResult = await unified.runUnifiedOfflineRehearsal({
  chainInput: golden.input, knowledgeCutoff: golden.knowledgeCutoff,
  evidenceClaims: [], origin: {kind:'GOLDEN_FIXTURE',label:'rc0-golden'},
  generatedAt,
});
assert.equal(unifiedResult.outcome, 'COMPLETED');
assert.equal(unifiedResult.terminal.stages.length, 12);
assert.equal(unifiedResult.receipt.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.equal(unifiedResult.receipt.fingerprint, unifiedResult.terminal.chain.digest);
assert.equal(unifiedResult.terminal.chain.execution, 'FORBIDDEN');
assert.equal(unifiedResult.advisory.tradeTicket, null);
assert.equal(unifiedResult.transport.packet?.actionability, 'NONE');
assert.equal(unifiedResult.provenance, 'UNVERIFIED');

const localView = await buildLocalView({now: () => ({toISOString: () => generatedAt})});
const terminal = await localView();
assert.equal(terminal.chain.chainState, 'HOLD');
assert.equal(terminal.chain.execution, 'FORBIDDEN');
assert.equal(terminal.chain.digest, unifiedResult.receipt.fingerprint,
  'one accepted OBS-0 digest, regardless of presentation entrypoint');
assert.equal(terminal.simulated, true);
assert.equal(terminal.origin.kind, 'GOLDEN_FIXTURE');
console.log('PASS RC-0: DATA-4E/F/G + CHAIN-0/OBS-0/terminal/advisory agree on HOLD with no live authority');
