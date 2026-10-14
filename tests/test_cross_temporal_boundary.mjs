/** TIME-0 ↔ legacy strict-timestamp conformance at the offline trust boundary. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const [time0, legacy, bridge] = await Promise.all([
  loadBackendModule('shared/temporal_contract.ts'),
  loadBackendModule('shared/strict_timestamp.ts'),
  loadBackendModule('observability/unified_rehearsal.ts'),
]);
const dates = ['2024-02-29', '2026-10-01', '2026-12-31'];
const clocks = ['00:00:00', '12:30:15', '23:59:59'];
const fractions = ['', '.0', '.001', '.123456', '.000000001', '.999999999'];
const zones = ['Z', '+00:00', '+02:00', '-05:00', '+14:00', '-12:00'];
let checked = 0;
for (const date of dates) {
  for (const clock of clocks) {
    for (const fraction of fractions) {
      for (const zone of zones) {
        const input = `${date}T${clock}${fraction}${zone}`;
        const modern = time0.parseStrictInstant(input);
        const old = legacy.parseStrictTimestampNanos(input);
        assert.ok(modern !== null && old !== null, `unexpectedly rejected: ${input}`);
        assert.equal(modern.epochNanoseconds, old,
          `nanosecond instant differs between the two readers: ${input}`);
        checked++;
      }
    }
  }
}

const equivalent = [
  ['2026-10-01T12:30:00.000000001Z', '2026-10-01T14:30:00.000000001+02:00'],
  ['2026-10-01T02:00:00.000000009Z', '2026-09-30T21:00:00.000000009-05:00'],
  ['2026-02-28T23:00:00Z', '2026-03-01T01:00:00+02:00'],
];
for (const [a, b] of equivalent) {
  assert.equal(time0.compareStrictInstants(a, b), 0);
  assert.equal(legacy.parseStrictTimestampNanos(a),
    legacy.parseStrictTimestampNanos(b));
}

// Deliberate boundary mismatch: the legacy utility permits timezone offsets
// that TIME-0 rejects. Never silently weaken TIME-0 to preserve that behavior.
const forbiddenAtBoundary = [
  '2026-10-01T14:15:00+14:01',
  '2026-10-01T14:15:00-14:30',
  '2026-10-01T14:15:00+15:00',
  '2026-10-01T14:15:00-00:00',
  '0000-01-01T00:00:00Z',
  '2026-02-30T12:30:00Z',
];
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8',
));
for (const badCutoff of forbiddenAtBoundary) {
  assert.equal(time0.isStrictTimestamp(badCutoff), false, badCutoff);
  const output = await bridge.runUnifiedOfflineRehearsal({
    chainInput: structuredClone(fixture.input),
    knowledgeCutoff: badCutoff,
    evidenceClaims: [],
    origin: { kind: 'GOLDEN_FIXTURE', label: 'temporal-regression' },
    generatedAt: '2026-10-14T12:00:00Z',
  });
  assert.equal(output.decision, 'HOLD', badCutoff);
  assert.equal(output.execution, 'FORBIDDEN', badCutoff);
  assert.equal(output.authorization, 'NONE', badCutoff);
  assert.equal(output.provenance, 'UNVERIFIED', badCutoff);
  assert.equal(output.outcome, 'REJECTED', badCutoff);
  assert.equal(output.receipt, null, badCutoff);
  assert.equal(output.evidence.structuralStatus, 'REJECTED', badCutoff);
  assert.ok(output.evidence.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'), badCutoff);
  assert.equal(output.terminal.chain.digest, null, badCutoff);
}

console.log(`PASS TIME-0/legacy conformance: ${checked} common instants, exact UTC offsets and six rejected boundary cutoffs`);
