/** Offline metadata anti-spoof regression; no network, database or broker. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { runUnifiedOfflineRehearsal } = await loadBackendModule(
  'observability/unified_rehearsal.ts',
);
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8',
));
const cutoff = fixture.knowledgeCutoff;
const validGeneration = '2026-10-14T12:00:00.000Z';
const run = (origin, generatedAt = validGeneration) => runUnifiedOfflineRehearsal({
  chainInput: structuredClone(fixture.input),
  knowledgeCutoff: cutoff,
  evidenceClaims: [],
  origin,
  generatedAt,
});

function assertNoAuthority(result, name) {
  assert.equal(result.mode, 'OFFLINE_ONLY', name);
  assert.equal(result.decision, 'HOLD', name);
  assert.equal(result.execution, 'FORBIDDEN', name);
  assert.equal(result.authorization, 'NONE', name);
  assert.equal(result.provenance, 'UNVERIFIED', name);
  assert.equal(result.terminal.simulated, true, name);
  assert.equal(result.advisory.tradeTicket, null, name);
  assert.equal(result.transport.packet?.actionability, 'NONE', name);
}

const allowed = await run({ kind: 'GOLDEN_FIXTURE', label: 'synthetic-baseline' });
assert.deepEqual(allowed.terminal.origin, {
  kind: 'GOLDEN_FIXTURE',
  label: 'SIMULATED:synthetic-baseline',
});
assert.equal(allowed.terminal.generatedAt, validGeneration);
assertNoAuthority(allowed, 'valid local origin');

const unsafeInputs = [
  ['forged production', { kind: 'PRODUCTION', label: 'official-live-market' }],
  ['forged empty', { kind: '', label: 'synthetic-baseline' }],
  ['live text', { kind: 'LOCAL_INPUT_FILE', label: 'LIVE MARKET DATA' }],
  ['HTML payload', { kind: 'LOCAL_SCENARIO', label: '<img/onerror=alert(1)>' }],
  ['long metadata', { kind: 'LOCAL_SCENARIO', label: 'X'.repeat(10000) }],
  ['extra properties', { kind: 'LOCAL_SCENARIO', label: 'safe', production: true }],
  ['null input', null],
  ['array input', []],
];
for (const [name, origin] of unsafeInputs) {
  const result = await run(origin);
  assert.deepEqual(result.terminal.origin, {
    kind: 'LOCAL_SCENARIO',
    label: 'SIMULATED:unverified-local-origin',
  }, name);
  assertNoAuthority(result, name);
}

let accessorCalls = 0;
const accessor = Object.defineProperties({}, {
  kind: { enumerable: true, get() { accessorCalls++; throw Error('untrusted accessor'); } },
  label: { enumerable: true, value: 'safe' },
});
const trapped = new Proxy({}, {
  ownKeys() { throw new Error('untrusted proxy'); },
});
for (const origin of [accessor, trapped]) {
  const result = await run(origin);
  assert.deepEqual(result.terminal.origin, {
    kind: 'LOCAL_SCENARIO',
    label: 'SIMULATED:unverified-local-origin',
  });
  assertNoAuthority(result, 'poisoned origin');
}
assert.equal(accessorCalls, 0, 'metadata validation must not execute accessors');
const badTime = await run({ kind: 'LOCAL_SCENARIO', label: 'local-test' },
  '2026-02-30T12:00:00.000Z');
assert.equal(badTime.terminal.generatedAt, 'INVALID_LOCAL_TIMESTAMP');
assert.equal(badTime.terminal.temporal.classification, 'UNKNOWN');
assertNoAuthority(badTime, 'invalid generation claim');

console.log('PASS local-origin anti-spoof: allowlist, poisoned descriptors, payload limits, fake clock denied');
