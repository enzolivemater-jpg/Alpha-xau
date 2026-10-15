// DATA-4 — deterministic receipt-ledger accounting, no provider, clock or DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const mod = await loadBackendModule('market_engine/capture_continuity.ts');
const digest = 'sha256:' + 'a'.repeat(64);
const plan = {
  planId: 'unit-test', windowStart: '2026-10-10T00:00:00Z', windowEnd: '2026-10-10T01:00:00Z',
  slots: [
    { slotId: 'us10y-0', provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10',
      earliestAt: '2026-10-10T00:05:00Z', deadlineAt: '2026-10-10T00:10:00Z' },
    { slotId: 'spot-0', provider: 'twelve_data', symbol: 'XAUUSD', sourceRecordId: 'XAU/USD',
      earliestAt: '2026-10-10T00:15:00Z', deadlineAt: '2026-10-10T00:20:00Z' },
  ],
};
const success = [
  { slotId: 'us10y-0', receivedAt: '2026-10-10T00:09:00Z', outcome: 'CAPTURED', rawPayloadDigest: digest },
  { slotId: 'spot-0', receivedAt: '2026-10-10T00:19:00Z', outcome: 'CAPTURED', rawPayloadDigest: digest },
];
const done = '2026-10-10T01:00:00Z';
const audit = (p=plan,r=success,cutoff=done) => mod.auditCaptureContinuity(p,r,cutoff);
const ok = audit();
assert.deepEqual([ok.status, ok.plannedSlots, ok.dueSlots, ok.capturedSlots, ok.missingSlots],
  ['ATTEMPTS_RECORDED', 2, 2, 2, 0]);
assert.deepEqual([ok.providerAuthenticity, ok.archiveCoverage, ok.decision, ok.execution],
  ['NOT_PROVEN', 'NOT_ESTABLISHED', 'HOLD', 'FORBIDDEN']);
assert.equal(JSON.stringify(audit()), JSON.stringify(ok), 'determinism');
assert.equal(JSON.stringify(audit(plan,[...success].reverse())), JSON.stringify(ok), 'receipt ordering does not matter');

const beforeReceipt = audit(plan,success,'2026-10-10T00:18:00Z');
const beforeOnly = audit(plan,[success[0]],'2026-10-10T00:18:00Z');
assert.deepEqual(beforeReceipt,beforeOnly,'later receipts never influence an earlier cutoff');
assert.equal(beforeReceipt.status,'INCOMPLETE');
assert.ok(beforeReceipt.reasons.includes('WINDOW_STILL_OPEN'));
assert.ok(audit(plan,success,'2026-10-10T00:00:00Z').reasons.includes('WINDOW_STILL_OPEN'));
assert.equal(audit(plan,[],done).missingSlots,2);
assert.equal(audit(plan,success.slice(0,1),done).status,'INCOMPLETE');
assert.ok(audit(plan,success.slice(0,1),done).reasons.includes('RECEIPT_MISSING'));

const failed=[success[0], {...success[1],outcome:'FAILED',rawPayloadDigest:null}];
assert.equal(audit(plan,failed).failedSlots,1);
assert.ok(audit(plan,failed).reasons.includes('PROVIDER_FAILED'));
assert.equal(audit(plan,failed).status,'INCOMPLETE');
const late=[success[0], {...success[1],receivedAt:'2026-10-10T00:25:00Z'}];
assert.ok(audit(plan,late).reasons.includes('CAPTURE_LATE'));
assert.equal(audit(plan,late).status,'INCOMPLETE');
assert.equal(audit(plan,[success[0],success[0],success[1]]).status,'INVALID');
assert.ok(audit(plan,[...success,{...success[0],slotId:'unknown'}]).reasons.includes('UNKNOWN_SLOT'));
assert.ok(audit(plan,[success[0],{...success[1],rawPayloadDigest:'sha256:FAKE'}]).reasons.includes('INVALID_RECEIPT'));
assert.ok(audit({...plan,slots:[plan.slots[0],plan.slots[0]]}).reasons.includes('DUPLICATE_SLOT'));
assert.ok(audit({...plan,slots:[{...plan.slots[0],sourceRecordId:'VIXCLS'},plan.slots[1]]}).reasons.includes('INVALID_SLOT'));
assert.ok(audit({...plan,windowStart:'2026-02-30T00:00:00Z'}).reasons.includes('INVALID_PLAN'));
assert.ok(audit(plan,success,'2026-02-30T00:00:00Z').reasons.includes('INVALID_CUTOFF'));
assert.equal(audit({...plan,slots:[]}).status,'INVALID', 'empty schedule never proves coverage');
for(const r of [ok,beforeReceipt,audit(plan,failed),audit(plan,late),audit({},[],done)]) {
  assert.equal(r.archiveCoverage,'NOT_ESTABLISHED');
  assert.equal(r.decision,'HOLD');
  assert.equal(r.execution,'FORBIDDEN');
}
const imports=listBackendImportClosure('market_engine/capture_continuity.ts');
assert.ok(!imports.includes('market_engine/providers.ts'),'no provider/network imported');
// Only the DATA-4 entry must be pure. Existing DATA-2 dependencies include
// validate.ts, whose optional runtime default clock is outside this audit.
const source=readFileSync(new URL('../backend/market_engine/capture_continuity.ts',import.meta.url),'utf8');
assert.doesNotMatch(source,/\bfetch\(|process\.env|Date\.now\(|new Date\(\)/,'DATA-4 audit has no I/O or clock');
console.log('PASS DATA-4 continuity ledger: as-of, gaps, failure, duplicates, source identity and fail-closed HOLD');
