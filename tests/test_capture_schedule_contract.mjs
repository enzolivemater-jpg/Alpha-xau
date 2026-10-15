// DATA-4E — policy compiler is entirely offline and never infers provider calendars.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule, listBackendImportClosure } from '../scripts/lib/backend_module_loader.mjs';

const mod = await loadBackendModule('market_engine/capture_schedule.ts');
const audit = await loadBackendModule('market_engine/capture_continuity.ts');
const ts = (day,hh,mm) => '2026-10-'+day+'T'+hh+':'+mm+':00.000Z';
const slot = (id, day, hh, mm, endMinute) => ({
  slotId:id, earliestAt:ts(day,hh,mm), deadlineAt:ts(day,hh,endMinute),
});
const policy = {
  schemaVersion:'xau.capture-schedule-policy.v1',planId:'operator-declared-20261015',
  windowStart:ts('15','00','00'),windowEnd:ts('17','00','00'),
  requestBudgets:{fred:5,twelve_data:2},
  series:[
    {provider:'fred',symbol:'US10Y',sourceRecordId:'DGS10',windows:[
      slot('us10y-15','15','08','00','05'),slot('us10y-16','16','08','00','05'),
    ]},
    {provider:'fred',symbol:'US10YR',sourceRecordId:'DFII10',windows:[
      slot('real-15','15','08','00','05'),
    ]},
    {provider:'fred',symbol:'VIX',sourceRecordId:'VIXCLS',windows:[
      slot('vix-15','15','08','00','05'),
    ]},
    {provider:'fred',symbol:'WTI',sourceRecordId:'DCOILWTICO',windows:[
      slot('wti-15','15','08','00','05'),
    ]},
    {provider:'twelve_data',symbol:'XAUUSD',sourceRecordId:'XAU/USD',windows:[
      slot('xau-15a','15','09','00','05'),slot('xau-15b','15','09','10','15'),
    ]},
  ],
};
const compilation = mod.compileCaptureSchedule(policy);
assert.equal(compilation.plannedRequests,7);
assert.deepEqual(compilation.plannedByProvider,{fred:5,twelve_data:2});
assert.deepEqual([compilation.calendarCompleteness,compilation.supplierQuotaApproval,
  compilation.providerAuthenticity,compilation.archiveCoverage,compilation.authorization,
  compilation.decision,compilation.execution],
  ['NOT_PROVEN','NOT_PROVEN','NOT_PROVEN','NOT_ESTABLISHED','OFFLINE_ONLY','HOLD','FORBIDDEN']);
assert.equal(compilation.plan.planId,policy.planId);
assert.equal(compilation.plan.slots.length,7);
assert.equal(JSON.stringify(mod.compileCaptureSchedule(policy)),JSON.stringify(compilation));
assert.deepEqual(
 mod.compileCaptureSchedule({...policy,series:policy.series.slice().reverse().map(s=>({
   ...s,windows:s.windows.slice().reverse(),
 }))}),
 compilation,'canonical ordering independent of author input ordering');
console.log('PASS explicit operator slots compile deterministically with 5 series and no invented recurrence');

const digest='sha256:'+'a'.repeat(64);
const receipts=compilation.plan.slots.map(s=>({
  slotId:s.slotId,receivedAt:s.deadlineAt,outcome:'CAPTURED',rawPayloadDigest:digest,
}));
const cutoff=ts('17','00','00');
const complete=audit.auditCaptureContinuity(compilation.plan,receipts,cutoff);
assert.equal(complete.status,'ATTEMPTS_RECORDED');
assert.equal(complete.plannedSlots,7);
assert.equal(complete.providerAuthenticity,'NOT_PROVEN');
assert.equal(complete.archiveCoverage,'NOT_ESTABLISHED');
assert.equal(complete.decision,'HOLD');
assert.equal(complete.execution,'FORBIDDEN');
const missing=audit.auditCaptureContinuity(compilation.plan,receipts.slice(0,-1),cutoff);
assert.equal(missing.status,'INCOMPLETE');
assert.equal(missing.missingSlots,1);
const quotaFailure=audit.auditCaptureContinuity(compilation.plan,[
 ...receipts.slice(0,-1),
 {...receipts.at(-1),outcome:'FAILED',rawPayloadDigest:null},
],cutoff);
assert.equal(quotaFailure.status,'INCOMPLETE');
assert.ok(quotaFailure.reasons.includes('PROVIDER_FAILED'));
console.log('PASS DATA-4A accounts for omitted/failed planned attempts; HOLD remains mandatory');

const reject = (change, reason) => assert.throws(
 () => mod.compileCaptureSchedule(change),new RegExp('CAPTURE_SCHEDULE_'+reason),
 reason);
reject({...policy,schemaVersion:'xau.capture-schedule-policy.v2'},'INVALID_POLICY');
reject({...policy,unapproved:true},'INVALID_POLICY');
reject({...policy,planId:'invalid plan'},'INVALID_POLICY');
reject({...policy,windowStart:'2026-10-15T00:00:00Z'},'INVALID_WINDOW');
reject({...policy,windowEnd:ts('15','00','00')},'INVALID_WINDOW');
reject({...policy,windowEnd:'2026-10-23T00:00:00.000Z'},'INVALID_WINDOW');
reject({...policy,windowStart:'2026-02-30T00:00:00.000Z'},'INVALID_WINDOW');
reject({...policy,requestBudgets:{fred:4,twelve_data:2}},'BUDGET_EXCEEDED');
reject({...policy,requestBudgets:{fred:-1,twelve_data:2}},'INVALID_BUDGET');
reject({...policy,requestBudgets:{fred:5,twelve_data:2,unknown:3}},'INVALID_BUDGET');
reject({...policy,requestBudgets:{fred:5,twelve_data:0}},'BUDGET_EXCEEDED');
reject({...policy,series:[]},'INVALID_SERIES');
reject({...policy,series:[policy.series[0],policy.series[0]]},'DUPLICATE_SERIES');
reject({...policy,series:[{...policy.series[0],sourceRecordId:'VIXCLS'}]},'INVALID_SERIES');
reject({...policy,series:[{...policy.series[0],windows:[]}]},'INVALID_SERIES');
reject({...policy,series:[{...policy.series[0],windows:[
  policy.series[0].windows[0],{...policy.series[0].windows[1],slotId:'us10y-15'},
]}]},'DUPLICATE_SLOT');
reject({...policy,series:[{...policy.series[0],windows:[
  policy.series[0].windows[0],{...policy.series[0].windows[1],slotId:'x',earliestAt:ts('15','08','03'),deadlineAt:ts('15','08','06')},
]}]},'OVERLAPPING_SERIES_SLOTS');
reject({...policy,series:[{...policy.series[0],windows:[
  {...policy.series[0].windows[0],deadlineAt:ts('15','08','00')},
]}]},'INVALID_SLOT');
reject({...policy,series:[{...policy.series[0],windows:[
  {...policy.series[0].windows[0],earliestAt:'2026-10-15T10:00:00+02:00'},
]}]},'INVALID_SLOT');
reject({...policy,series:[{...policy.series[0],windows:[
  {...policy.series[0].windows[0],deadlineAt:ts('17','00','01')},
]}]},'INVALID_SLOT');
reject({...policy,series:[{...policy.series[0],windows:[
  {...policy.series[0].windows[0],surprise:true},
]}]},'INVALID_SLOT');
reject({...policy,series:[{...policy.series[0],windows:[
  {...policy.series[0].windows[0],slotId:'unsafe key'},
]}]},'INVALID_SLOT');
const huge={...policy,requestBudgets:{fred:512,twelve_data:512},
  series:[{...policy.series[0],windows:Array.from({length:513},(_,i)=>({
    slotId:'slot-'+i,earliestAt:ts('15','08','00'),deadlineAt:ts('15','08','05'),
  }))}]};
reject(huge,'PLAN_TOO_LARGE');
console.log('PASS bad series, source, DST offset, overlap, duplicates, bounded horizon and request quotas fail closed');

const imports=listBackendImportClosure('market_engine/capture_schedule.ts');
assert.ok(!imports.includes('market_engine/providers.ts'),'no provider client imported');
const source=readFileSync(new URL('../backend/market_engine/capture_schedule.ts',import.meta.url),'utf8');
assert.doesNotMatch(source,/\bfetch\(|process\.env|Date\.now\(|new Date\(\)|\bquery\(|\bexec\(/);
console.log('PASS no network/DB/secret/clock dependency or trading authorization');
