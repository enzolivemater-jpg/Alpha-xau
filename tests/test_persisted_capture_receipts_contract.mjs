// DATA-4C: strict persisted receipt normalization; deterministic and offline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const adapter=await loadBackendModule('market_engine/persisted_capture_receipts.ts');
const audit=await loadBackendModule('market_engine/capture_continuity.ts');
const plan={
  planId:'persisted-proof', windowStart:'2026-10-15T08:00:00Z',windowEnd:'2026-10-15T09:00:00Z',
  slots:[
    {slotId:'fred-1',provider:'fred',symbol:'US10Y',sourceRecordId:'DGS10',
      earliestAt:'2026-10-15T08:00:00Z',deadlineAt:'2026-10-15T08:10:00Z'},
    {slotId:'xau-1',provider:'twelve_data',symbol:'XAUUSD',sourceRecordId:'XAU/USD',
      earliestAt:'2026-10-15T08:20:00Z',deadlineAt:'2026-10-15T08:30:00Z'},
  ],
};
const hex='a'.repeat(64);
const a={
  plan_id:'persisted-proof',slot_id:'fred-1',provider:'fred',source_record_id:'DGS10',symbol:'US10Y',
  outcome:'CAPTURED',source_received_at:'2026-10-15T08:02:00Z',
  recorded_at:'2026-10-15T08:04:00.000001Z',failure_code:null,content_sha256:hex,
};
const b={
  plan_id:'persisted-proof',slot_id:'xau-1',provider:'twelve_data',source_record_id:'XAU/USD',symbol:'XAUUSD',
  outcome:'CAPTURED',source_received_at:'2026-10-15T08:23:00Z',
  recorded_at:'2026-10-15T08:25:00.000001Z',failure_code:null,content_sha256:hex,
};
const cutoff='2026-10-15T09:00:00Z';
const rec=adapter.normalizePersistedCaptureReceipts([b,a],cutoff);
assert.deepEqual(rec,[
  {slotId:'fred-1',receivedAt:a.recorded_at,outcome:'CAPTURED',rawPayloadDigest:'sha256:'+hex},
  {slotId:'xau-1',receivedAt:b.recorded_at,outcome:'CAPTURED',rawPayloadDigest:'sha256:'+hex},
]);
assert.deepEqual(adapter.normalizePersistedCaptureReceipts([a,b],cutoff),rec,'ordering independent');
assert.deepEqual(adapter.auditPersistedCaptureContinuity(plan,[a,b],cutoff),
  audit.auditCaptureContinuity(plan,rec,cutoff),'DATA-4A is the one canonical audit');
const success=adapter.auditPersistedCaptureContinuity(plan,[a,b],cutoff);
assert.equal(success.status,'ATTEMPTS_RECORDED');
assert.equal(success.archiveCoverage,'NOT_ESTABLISHED');
assert.equal(success.providerAuthenticity,'NOT_PROVEN');
assert.equal(success.decision,'HOLD');
assert.equal(success.execution,'FORBIDDEN');
console.log('PASS DB recorded_at defines first knowledge; canonical DATA-4A audit, never market coverage');

const late={...b,recorded_at:'2026-10-15T08:35:00Z'};
const lateResult=adapter.auditPersistedCaptureContinuity(plan,[a,late],cutoff);
assert.equal(lateResult.status,'INCOMPLETE');
assert.ok(lateResult.reasons.includes('CAPTURE_LATE'),'DB latency counts as late even when collector clock says on time');
const fail={...b,outcome:'FAILED',failure_code:'QUOTA',content_sha256:null};
const failResult=adapter.auditPersistedCaptureContinuity(plan,[a,fail],cutoff);
assert.ok(failResult.reasons.includes('PROVIDER_FAILED'));
assert.equal(failResult.execution,'FORBIDDEN');

const onlyPrior=adapter.auditPersistedCaptureContinuity(plan,[a],'2026-10-15T08:20:00Z');
assert.equal(onlyPrior.status,'INCOMPLETE');
assert.ok(onlyPrior.reasons.includes('WINDOW_STILL_OPEN'));
assert.equal(adapter.normalizePersistedCaptureReceipts([],cutoff).length,0);

const bad=(rows,why)=>assert.throws(()=>adapter.normalizePersistedCaptureReceipts(rows,cutoff),/CAPTURE_RPC_/,why);
bad([a,a],'duplicate plan/slot');
bad([{...a,slot_id:'--bad'}],'bad slot');
bad([{...a,source_record_id:'DFII10'}],'wrong source series');
bad([{...a,symbol:'VIX'}],'wrong provider/symbol');
bad([{...a,content_sha256:hex.toUpperCase()}],'upper-case digest not canonical');
bad([{...a,content_sha256:null}],'missing captured digest');
bad([{...a,outcome:'FAILED'}],'failed with body hash');
bad([{...a,outcome:'FAILED',content_sha256:null}],'failed without failure code');
bad([{...a,outcome:'FAILED',content_sha256:null,failure_code:'myapikey=secret'}],'free-text error rejected');
bad([{...a,recorded_at:'2026-10-15T07:59:00Z'}],'received after DB knowledge');
bad([{...a,recorded_at:'2026-10-15T09:00:00.000001Z'}],'future as-of row must be rejected');
bad([{...a,extra:true}],'unexpected columns rejected');
bad([null],'invalid row type');
bad('not an array','invalid RPC result');
assert.throws(()=>adapter.normalizePersistedCaptureReceipts([a],'2026-02-30T00:00:00Z'),/CAPTURE_RPC_CUTOFF_INVALID/);
console.log('PASS malformed and divergent RPC rows fail closed with no loss or implicit trust');

const imports=listBackendImportClosure('market_engine/persisted_capture_receipts.ts');
assert.ok(!imports.includes('market_engine/providers.ts'),'adapter cannot import network provider');
const source=readFileSync(new URL('../backend/market_engine/persisted_capture_receipts.ts',import.meta.url),'utf8');
assert.doesNotMatch(source,/\bfetch\(|process\.env|Date\.now\(|new Date\(\)|\bexec\(|\bquery\(/);
console.log('PASS no network, runtime clock, DB or new independent audit policy');
