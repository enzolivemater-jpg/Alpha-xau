/**
 * DATA-4A/4E/4F/4G mutation sweep (continuity audit, capture schedule, offline
 * replay, collector readiness, persisted receipts). Each module either returns
 * a HOLD / FORBIDDEN, canonically hashable result or refuses with its own named
 * error; an internal TypeError / RangeError, an unhashable result or any
 * authorization is a defect. Offline and deterministic.
 */
import assert from 'node:assert/strict';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { HOSTILE_VALUES, mutationCases } from './lib/mutation_cases.mjs';

const [schedule, replay, readiness, continuity, persisted, canonical] = await Promise.all([
  loadBackendModule('market_engine/capture_schedule.ts'),
  loadBackendModule('market_engine/offline_capture_replay.ts'),
  loadBackendModule('market_engine/collector_readiness.ts'),
  loadBackendModule('market_engine/capture_continuity.ts'),
  loadBackendModule('market_engine/persisted_capture_receipts.ts'),
  loadBackendModule('shared/canonical_json.ts'),
]);

const policy = {
  schemaVersion: 'xau.capture-schedule-policy.v1',
  planId: 'rc0-offline-only',
  windowStart: '2026-10-15T00:00:00.000Z',
  windowEnd: '2026-10-16T00:00:00.000Z',
  requestBudgets: { fred: 1, twelve_data: 1 },
  series: [
    { provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10', windows: [
      { slotId: 'fred-dgs10', earliestAt: '2026-10-15T08:00:00.000Z', deadlineAt: '2026-10-15T08:10:00.000Z' }] },
    { provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD', windows: [
      { slotId: 'twelve-xau', earliestAt: '2026-10-15T09:00:00.000Z', deadlineAt: '2026-10-15T09:10:00.000Z' }] },
  ],
};
const cutoff = '2026-10-16T00:00:00.000Z';
const digest = `sha256:${'f'.repeat(64)}`;
const attempts = [
  { slotId: 'fred-dgs10', attempt: 1, at: '2026-10-15T08:02:00.000Z', outcome: 'CAPTURED', rawPayloadDigest: digest, failureCode: null },
  { slotId: 'twelve-xau', attempt: 1, at: '2026-10-15T09:01:00.000Z', outcome: 'RETRYABLE_FAILURE', rawPayloadDigest: null, failureCode: 'TIMEOUT' },
  { slotId: 'twelve-xau', attempt: 2, at: '2026-10-15T09:03:00.000Z', outcome: 'CAPTURED', rawPayloadDigest: digest, failureCode: null },
];
const retry = { maxAttemptsPerSlot: 2, minimumRetryDelayMs: 60_000, maxProviderAttempts: { fred: 1, twelve_data: 2 } };
const compiled = schedule.compileCaptureSchedule(policy);
const fingerprint = await readiness.fingerprintCaptureSchedule(policy);
const review = {
  schemaVersion: readiness.COLLECTOR_READINESS_SCHEMA_VERSION, planId: policy.planId, planFingerprint: fingerprint,
  gates: readiness.REQUIRED_COLLECTOR_GATES.map((gate_id) => ({
    gate_id, status: 'PENDING', evidence_reference: null, evidence_digest: null, reviewer: null,
    reviewed_at_utc: null, expiry_or_review_due: null, scope: null, version: null, rejection_reasons: [],
  })),
};
const receipts = [
  { slotId: 'fred-dgs10', receivedAt: '2026-10-15T08:02:00.000Z', outcome: 'CAPTURED', rawPayloadDigest: digest },
  { slotId: 'twelve-xau', receivedAt: '2026-10-15T09:03:00.000Z', outcome: 'CAPTURED', rawPayloadDigest: digest },
];
const rows = [
  { plan_id: policy.planId, slot_id: 'fred-dgs10', provider: 'fred', source_record_id: 'DGS10', symbol: 'US10Y',
    outcome: 'CAPTURED', source_received_at: '2026-10-15T08:02:00.000Z', recorded_at: '2026-10-15T08:02:01.000Z',
    failure_code: null, content_sha256: 'f'.repeat(64) },
  { plan_id: policy.planId, slot_id: 'twelve-xau', provider: 'twelve_data', source_record_id: 'XAU/USD', symbol: 'XAUUSD',
    outcome: 'CAPTURED', source_received_at: '2026-10-15T09:03:00.000Z', recorded_at: '2026-10-15T09:03:01.000Z',
    failure_code: null, content_sha256: 'f'.repeat(64) },
];

// Sanity: the base data really exercises the happy paths.
assert.equal(replay.replayOfflineCaptureAttempts(policy, attempts, cutoff, retry).status, 'SIMULATED');
assert.equal((await readiness.evaluateCollectorReadinessForSchedule(policy, review, cutoff)).status, 'INCOMPLETE');
assert.equal(continuity.auditCaptureContinuity(compiled.plan, receipts, cutoff).status, 'ATTEMPTS_RECORDED');
assert.equal(persisted.auditPersistedCaptureContinuity(compiled.plan, rows, cutoff).status, 'ATTEMPTS_RECORDED');

const NAMED_REFUSAL = /^(CAPTURE_SCHEDULE_|OFFLINE_CAPTURE_|COLLECTOR_READINESS_|CAPTURE_RPC_)[A-Z0-9_]+$/;
const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { returned: 0, refused: 0 };

async function probe(label, run) {
  try {
    const out = await run();
    tally.returned += 1;
    if (out !== null && typeof out === 'object') {
      if (out.execution !== undefined && out.execution !== 'FORBIDDEN') note(label, `execution ${out.execution}`);
      if (out.decision !== undefined && out.decision !== 'HOLD') note(label, `decision ${out.decision}`);
      if (out.authorization !== undefined && out.authorization !== 'OFFLINE_ONLY') note(label, `authorization ${out.authorization}`);
      if (out.providerAuthenticity !== undefined && out.providerAuthenticity !== 'NOT_PROVEN') note(label, 'provider authenticity claimed');
      try { canonical.canonicalJson(out); } catch (error) { note(label, `unhashable result: ${error.message}`); }
    }
  } catch (error) {
    if (error instanceof Error && NAMED_REFUSAL.test(error.message)) tally.refused += 1;
    else note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

for (const [label, mutated] of mutationCases(policy)) {
  await probe(`policy ${label} compile`, () => schedule.compileCaptureSchedule(mutated));
  await probe(`policy ${label} fingerprint`, () => readiness.fingerprintCaptureSchedule(mutated));
  await probe(`policy ${label} replay`, () => replay.replayOfflineCaptureAttempts(mutated, attempts, cutoff, retry));
  await probe(`policy ${label} readiness`, () => readiness.evaluateCollectorReadinessForSchedule(mutated, review, cutoff));
}
for (const [label, mutated] of mutationCases(attempts)) {
  await probe(`attempts ${label}`, () => replay.replayOfflineCaptureAttempts(policy, mutated, cutoff, retry));
}
for (const [label, mutated] of mutationCases(retry)) {
  await probe(`retry ${label}`, () => replay.replayOfflineCaptureAttempts(policy, attempts, cutoff, mutated));
}
for (const [label, mutated] of mutationCases(review)) {
  await probe(`review ${label} packet`, () => readiness.evaluateCollectorReadiness(mutated, cutoff));
  await probe(`review ${label} bound`, () => readiness.evaluateCollectorReadinessForSchedule(policy, mutated, cutoff));
}
for (const [label, mutated] of mutationCases(compiled.plan)) {
  await probe(`plan ${label} audit`, () => continuity.auditCaptureContinuity(mutated, receipts, cutoff));
}
for (const [label, mutated] of mutationCases(receipts)) {
  await probe(`receipts ${label} audit`, () => continuity.auditCaptureContinuity(compiled.plan, mutated, cutoff));
}
for (const [label, mutated] of mutationCases(rows)) {
  await probe(`rows ${label} normalize`, () => persisted.normalizePersistedCaptureReceipts(mutated, cutoff));
  await probe(`rows ${label} audit`, () => persisted.auditPersistedCaptureContinuity(compiled.plan, mutated, cutoff));
}
for (const [index, value] of HOSTILE_VALUES.entries()) {
  const label = `cutoff hostile#${index}`;
  await probe(`${label} compile+replay`, () => replay.replayOfflineCaptureAttempts(policy, attempts, structuredClone(value), retry));
  await probe(`${label} readiness`, () => readiness.evaluateCollectorReadinessForSchedule(policy, review, structuredClone(value)));
  await probe(`${label} audit`, () => continuity.auditCaptureContinuity(compiled.plan, receipts, structuredClone(value)));
  await probe(`${label} persisted`, () => persisted.auditPersistedCaptureContinuity(compiled.plan, rows, structuredClone(value)));
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.returned > 100 && tally.refused > 100, `the sweep exercises results and refusals ${JSON.stringify(tally)}`);
console.log(`PASS DATA-4 mutation sweep: ${tally.returned + tally.refused} hostile calls, `
  + `${tally.returned} HOLD/FORBIDDEN hashable results, ${tally.refused} named refusals, no internal error`);
