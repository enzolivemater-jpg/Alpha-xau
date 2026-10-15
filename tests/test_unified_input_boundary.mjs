/** An offline integration input is untrusted even when TS types look sound. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { runUnifiedOfflineRehearsal } = await loadBackendModule('observability/unified_rehearsal.ts');
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8',
));
const valid = () => ({
  chainInput: structuredClone(fixture.input),
  knowledgeCutoff: fixture.knowledgeCutoff,
  evidenceClaims: [],
  origin: { kind: 'GOLDEN_FIXTURE', label: 'synthetic-fixture-v1' },
  generatedAt: '2026-10-14T12:00:00.000Z',
});

const accepted = await runUnifiedOfflineRehearsal(valid());
assert.equal(accepted.outcome, 'COMPLETED');
assert.equal(accepted.terminal.origin.kind, 'GOLDEN_FIXTURE');
assert.equal(accepted.receipt.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.equal(accepted.decision, 'HOLD');
assert.equal(accepted.execution, 'FORBIDDEN');

const cases = [
  ['null input', null],
  ['undefined input', undefined],
  ['array input', []],
  ['number input', 7],
  ['untrusted extra root authority', { ...valid(), allowLiveTrades: true }],
  ['forged LIVE origin', { ...valid(), origin: { kind: 'LIVE_PRODUCTION', label: 'fake' } }],
  ['forged LIVE source label', { ...valid(), origin: { kind: 'LOCAL_SCENARIO', label: '<script>alert(1)</script>' } }],
  ['unknown origin metadata', { ...valid(), origin: { kind: 'GOLDEN_FIXTURE', label: 'fixture', trusted: true } }],
  ['missing origin', { ...valid(), origin: null }],
  ['invalid generation date', { ...valid(), generatedAt: '2026-02-30T12:00:00.000Z' }],
  ['generation before cutoff', { ...valid(), generatedAt: '2026-09-30T12:00:00.000Z' }],
  ['timezone unknown', { ...valid(), generatedAt: '2026-10-14T12:00:00-00:00' }],
  ['invalid cutoff', { ...valid(), knowledgeCutoff: '2026-02-30T12:00:00.000Z' }],
  ['non-array claims', { ...valid(), evidenceClaims: { length: 0 } }],
  ['oversized claims', { ...valid(), evidenceClaims: Array(513).fill(null) }],
];
const rootGetter = valid();
Object.defineProperty(rootGetter, 'origin', { enumerable: true, get() { throw Error('no getter access'); } });
cases.push(['hostile root accessor', rootGetter]);
const originGetter = valid();
Object.defineProperty(originGetter.origin, 'kind', { enumerable: true, get() { throw Error('no getter access'); } });
cases.push(['hostile origin accessor', originGetter]);

for (const [label, untrusted] of cases) {
  const result = await runUnifiedOfflineRehearsal(untrusted);
  assert.equal(result.outcome, 'REJECTED', label);
  assert.equal(result.terminal.summary.status, 'INPUT_REJECTED', label);
  assert.equal(result.terminal.simulated, true, label);
  assert.equal(result.terminal.chain.digest, null, label);
  assert.equal(result.terminal.stages.length, 0, label);
  assert.equal(result.terminal.origin.kind, 'LOCAL_SCENARIO', label);
  assert.equal(result.terminal.origin.label, 'unverified-local-input', label);
  assert.equal(result.terminal.generatedAt, '', label);
  assert.equal(result.terminal.temporal.classification, 'UNKNOWN', label);
  assert.equal(result.receipt, null, label);
  assert.equal(result.advisory.systemState, 'HOLD', label);
  assert.equal(result.advisory.tradeTicket, null, label);
  assert.equal(result.transport.packet?.actionability, 'NONE', label);
  assert.equal(result.execution, 'FORBIDDEN', label);
  assert.equal(result.authorization, 'NONE', label);
}
console.log('PASS offline envelope: strict local origin, no caller authority spoof, malformed inputs fail closed');

const replay = await runUnifiedOfflineRehearsal(valid());
assert.deepEqual(replay, accepted, 'valid envelope replay stays deterministic');
assert.equal(replay.receipt.fingerprint, accepted.receipt.fingerprint);
console.log('PASS valid fixture replay and receipt unchanged after input-boundary hardening');
