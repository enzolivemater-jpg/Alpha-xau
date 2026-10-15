// DATA-4F — deterministic, no-network simulation of retries, dedup and resumption.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const mod = await loadBackendModule('market_engine/offline_capture_replay.ts');
const ts = (h,m) => '2026-10-15T'+h+':'+m+':00.000Z';
const win = (id,a,b) => ({slotId:id,earliestAt:a,deadlineAt:b});
const policy = {
  schemaVersion:'xau.capture-schedule-policy.v1',planId:'simulation-001',
  windowStart:ts('00','00'),windowEnd:'2026-10-16T00:00:00.000Z',
  requestBudgets:{fred:2,twelve_data:1},
  series:[
    {provider:'fred',symbol:'US10Y',sourceRecordId:'DGS10',windows:[
      win('fred-a',ts('08','00'),ts('08','10')),
      win('fred-b',ts('08','20'),ts('08','30')),
    ]},
    {provider:'twelve_data',symbol:'XAUUSD',sourceRecordId:'XAU/USD',windows:[
      win('xau-a',ts('09','00'),ts('09','15')),
    ]},
  ],
};
const retry = {
  maxAttemptsPerSlot:3,minimumRetryDelayMs:60_000,
  maxProviderAttempts:{fred:4,twelve_data:3},
};
const digest='sha256:'+'a'.repeat(64);
const event=(slotId,attempt,at,outcome,rawPayloadDigest=null,failureCode=null)=>({
  slotId,attempt,at,outcome,rawPayloadDigest,failureCode,
});
const trace = [
  event('fred-a',1,ts('08','01'),'RETRYABLE_FAILURE',null,'TIMEOUT'),
  event('fred-a',2,ts('08','02'),'CAPTURED',digest),
  event('fred-b',1,ts('08','21'),'FAILED',null,'HTTP_ERROR'),
  event('xau-a',1,ts('09','01'),'RETRYABLE_FAILURE',null,'QUOTA'),
  event('xau-a',2,ts('09','02'),'CAPTURED',digest),
];
const cutoff='2026-10-16T00:00:00.000Z';
const replay=(t=trace,when=cutoff,r=retry,p=policy)=>mod.replayOfflineCaptureAttempts(p,t,when,r);
const result=replay();
assert.equal(result.simulationOnly,true);
assert.equal(result.status,'SIMULATED_INCOMPLETE','terminal failure must prevent simulated completeness');
assert.equal(result.attemptsAccepted,5);
assert.deepEqual(result.attemptsByProvider,{fred:3,twelve_data:2});
assert.deepEqual(result.pendingRetrySlots,[]);
assert.deepEqual(result.simulatedReceipts.map(x=>[x.slotId,x.outcome]),[
  ['fred-a','CAPTURED'],['fred-b','FAILED'],['xau-a','CAPTURED'],
]);
assert.equal(result.audit.failedSlots,1);
assert.ok(result.audit.reasons.includes('PROVIDER_FAILED'));
assert.deepEqual([
 result.providerAuthenticity,result.archiveCoverage,result.authorization,
 result.decision,result.execution,result.audit.decision,result.audit.execution,
],['NOT_PROVEN','NOT_ESTABLISHED','OFFLINE_ONLY','HOLD','FORBIDDEN','HOLD','FORBIDDEN']);
assert.deepEqual(replay([...trace].reverse()),result,'input order independent');
assert.deepEqual(replay([...trace,trace[0],trace[3]]),result,'identical redelivery is idempotent');
assert.deepEqual(replay(),result,'stable replay after interruption and restart');
console.log('PASS DATA-4F deterministic retry, terminal failure, duplicate redelivery and HOLD');

const early=ts('08','01');
const earlyTrace=replay(trace.slice(0,1),early);
assert.deepEqual(replay(trace,early),earlyTrace,'future outcomes must not affect as-of audit');
assert.deepEqual(earlyTrace.pendingRetrySlots,['fred-a']);
assert.deepEqual(earlyTrace.simulatedReceipts,[]);
assert.equal(earlyTrace.audit.status,'INCOMPLETE');
assert.deepEqual(replay(trace.slice(0,2),ts('08','02')),replay(trace,ts('08','02')));
const capturedAll=replay(trace.map(e=>e.slotId==='fred-b'?{...e,outcome:'CAPTURED',failureCode:null,rawPayloadDigest:digest}:e));
assert.equal(capturedAll.status,'SIMULATED');
assert.equal(capturedAll.audit.status,'ATTEMPTS_RECORDED');
assert.equal(capturedAll.providerAuthenticity,'NOT_PROVEN');
assert.equal(capturedAll.archiveCoverage,'NOT_ESTABLISHED');
assert.equal(capturedAll.decision,'HOLD');
assert.equal(capturedAll.execution,'FORBIDDEN');
console.log('PASS explicit cutoff, historical resumption and no simulated trust elevation');

const reject=(t,reason,r=retry,p=policy)=>assert.throws(
 ()=>replay(t,cutoff,r,p),new RegExp('OFFLINE_CAPTURE_'+reason),reason);
reject([...trace,{...trace[0],failureCode:'QUOTA'}],'CONFLICTING_ATTEMPT_REPLAY');
reject([...trace,event('fred-a',3,ts('08','03'),'CAPTURED',digest)],'RETRY_AFTER_TERMINAL');
reject([trace[1]],'ATTEMPT_SEQUENCE_GAP');
reject([trace[0],{...trace[1],at:ts('08','01')}],'RETRY_TOO_EARLY');
reject([event('fred-a',1,ts('07','59'),'CAPTURED',digest)],'ATTEMPT_OUTSIDE_SLOT');
reject([event('fred-a',1,ts('08','11'),'CAPTURED',digest)],'ATTEMPT_OUTSIDE_SLOT');
reject([event('wrong-slot',1,ts('08','01'),'CAPTURED',digest)],'UNKNOWN_SLOT');
reject([event('fred-a',1,ts('08','01'),'CAPTURED',null)],'INVALID_OUTCOME');
reject([event('fred-a',1,ts('08','01'),'CAPTURED',digest,'TIMEOUT')],'INVALID_OUTCOME');
reject([event('fred-a',1,ts('08','01'),'FAILED',digest,'TIMEOUT')],'INVALID_OUTCOME');
reject([event('fred-a',1,ts('08','01'),'FAILED',null,'api-key-secret')],'INVALID_OUTCOME');
reject([event('fred-a',1,'2026-10-15T08:01:00+00:00','CAPTURED',digest)],'INVALID_ATTEMPT_TIME');
reject([{...trace[0],someKey:true}],'INVALID_ATTEMPT');
reject([event('fred-a',0,ts('08','01'),'FAILED',null,'TIMEOUT')],'INVALID_ATTEMPT');
reject([event('fred-a',4,ts('08','01'),'FAILED',null,'TIMEOUT')],'RETRY_LIMIT_EXCEEDED');
reject(trace,'PROVIDER_ATTEMPT_BUDGET_EXCEEDED',{
  ...retry,maxProviderAttempts:{fred:2,twelve_data:3},
});
reject(trace,'INVALID_RETRY_BUDGET',{...retry,maxProviderAttempts:{fred:1,twelve_data:3}});
reject(trace,'INVALID_RETRY_POLICY',{...retry,minimumRetryDelayMs:0});
reject(trace,'INVALID_RETRY_POLICY',{...retry,maxAttemptsPerSlot:6});
reject(Array.from({length:2049},()=>trace[0]),'INVALID_TRACE');
assert.throws(()=>replay(trace,'2026-02-30T00:00:00.000Z'),/OFFLINE_CAPTURE_INVALID_CUTOFF/);

const exhausted=replay([
 event('fred-a',1,ts('08','01'),'RETRYABLE_FAILURE',null,'TIMEOUT'),
 event('fred-a',2,ts('08','02'),'RETRYABLE_FAILURE',null,'TIMEOUT'),
 event('fred-a',3,ts('08','03'),'RETRYABLE_FAILURE',null,'TIMEOUT'),
],cutoff);
assert.equal(exhausted.simulatedReceipts.length,0,'never fabricate a terminal receipt');
assert.equal(exhausted.audit.status,'INCOMPLETE');
assert.equal(exhausted.audit.missingSlots,3);
console.log('PASS retry bounds, backoff, provider budget, malformed traces and no invented failures');

const closure=listBackendImportClosure('market_engine/offline_capture_replay.ts');
assert.ok(!closure.includes('market_engine/providers.ts'),'no network provider import');
const src=readFileSync(new URL('../backend/market_engine/offline_capture_replay.ts',import.meta.url),'utf8');
assert.doesNotMatch(src,/\bfetch\(|process\.env|Date\.now\(|new Date\(\)|\bquery\(|\bexec\(/);
console.log('PASS offline only; no provider, environment, clock, database or execution path');
