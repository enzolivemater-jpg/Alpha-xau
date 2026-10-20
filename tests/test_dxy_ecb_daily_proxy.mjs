import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateDxyProxy,parseEcbDailyCsv,PROXY_KIND} from '../shared/dxy_ecb_daily_proxy.mjs';

const sha='a'.repeat(64);
const rates={USD:1.1,JPY:160,GBP:0.85,CAD:1.5,SEK:11.5,CHF:0.95};
const header='KEY,FREQ,CURRENCY,CURRENCY_DENOM,TIME_PERIOD,OBS_VALUE';
const rows=(day,rs)=>Object.entries(rs).map(([cc,v])=>`EXR.D.${cc}.EUR.SP00.A,D,${cc},EUR,${day},${v}`);
const csv=(arr)=>[header,...arr].join('\\n');
test('ECB EUR-cross construction equals manually quoted ICE formula',()=>{
  const r=rates,u=r.USD;
  const quoted=50.14348112*(u**(-.576))*((r.JPY/u)**.136)*((u/r.GBP)**(-.119))
    *((r.CAD/u)**.091)*((r.SEK/u)**.042)*((r.CHF/u)**.036);
  assert.ok(Math.abs(calculateDxyProxy(r)-quoted)<1e-10);
});
test('complete date is labeled independent proxy, never verified for replay',()=>{
  const [x]=parseEcbDailyCsv(csv(rows('2026-10-15',rates)),{sourceSha256:sha});
  assert.equal(x.kind,PROXY_KIND);
  assert.equal(x.status,'CALCULATED');
  assert.equal(x.officialIceDxy,false);
  assert.equal(x.lookaheadSafeForReplay,false);
  assert.equal(x.publicationTimestampVerified,false);
  assert.equal(x.sourceSha256,sha);
});
test('missing currency is unavailable, never silently filled',()=>{
  const [x]=parseEcbDailyCsv(csv(rows('2026-10-15',{...rates,CHF:undefined}).filter(x=>!x.endsWith('undefined'))),{sourceSha256:sha});
  assert.equal(x.status,'UNAVAILABLE');assert.equal(x.value,null);
  assert.match(x.reason,/CHF/);
});
test('duplicate, negative, absent provenance, wrong denominator all reject',()=>{
  assert.throws(()=>parseEcbDailyCsv(csv(rows('2026-10-15',rates))),/SOURCE_SHA256_REQUIRED/);
  assert.throws(()=>parseEcbDailyCsv(csv([...rows('2026-10-15',rates),rows('2026-10-15',rates)[0]]),{sourceSha256:sha}),/DUPLICATE/);
  assert.throws(()=>parseEcbDailyCsv(csv(rows('2026-10-15',{...rates,JPY:-1})),{sourceSha256:sha}),/RATE_INVALID/);
  assert.throws(()=>parseEcbDailyCsv(csv(rows('2026-10-15',rates).map(x=>x.replace(',EUR,',',USD,'))),{sourceSha256:sha}),/DENOMINATOR_INVALID/);
});
test('reject malformed calendar date and missing values',()=>{
  assert.throws(()=>parseEcbDailyCsv(csv(rows('2026-02-30',rates)),{sourceSha256:sha}),/DATE_INVALID/);
  assert.throws(()=>calculateDxyProxy({...rates,USD:NaN}),/FX_INPUT_INVALID/);
});
