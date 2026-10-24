import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculateDxyProxy,ecbRatesToUsdxPairs,parseEcbDailyCsv,PROXY_KIND} from '../shared/dxy_ecb_daily_proxy.mjs';

const sha='a'.repeat(64);
const rates={USD:1.1,JPY:160,GBP:0.85,CAD:1.5,SEK:11.5,CHF:0.95};
const header='KEY,FREQ,CURRENCY,CURRENCY_DENOM,TIME_PERIOD,OBS_VALUE';
const rows=(day,rs)=>Object.entries(rs).map(([cc,v])=>`EXR.D.${cc}.EUR.SP00.A,D,${cc},EUR,${day},${v}`);
const csv=(arr)=>[header,...arr].join('\n');
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
test('each ECB EUR cross becomes the USDX pair as ICE quotes it',()=>{
  // Values chosen so every division is exact in binary floating point.
  assert.deepEqual({...ecbRatesToUsdxPairs({USD:2,JPY:300,GBP:0.5,CAD:3,SEK:20,CHF:1})},
    {EURUSD:2,USDJPY:150,GBPUSD:4,USDCAD:1.5,USDSEK:10,USDCHF:0.5});
});
test('index value from known pairs, independently of the cross construction',()=>{
  // Every pair at 1: the ICE constant alone.
  assert.equal(calculateDxyProxy({USD:1,JPY:1,GBP:1,CAD:1,SEK:1,CHF:1}),50.14348112);
  // EURUSD=2 and every other pair at 1: only the EURUSD weight applies.
  assert.ok(Math.abs(calculateDxyProxy({USD:2,JPY:2,GBP:2,CAD:2,SEK:2,CHF:2})-50.14348112*2**-0.576)<1e-12);
  // GBPUSD=2 (EURGBP=0.5 with EURUSD=1): only the GBPUSD weight applies, with its negative sign.
  assert.ok(Math.abs(calculateDxyProxy({USD:1,JPY:1,GBP:0.5,CAD:1,SEK:1,CHF:1})-50.14348112*2**-0.119)<1e-12);
  // USDJPY=2: a stronger dollar raises the index.
  assert.ok(calculateDxyProxy({USD:1,JPY:2,GBP:1,CAD:1,SEK:1,CHF:1})>50.14348112);
});
const FULL_HEADER='KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,TITLE_COMPL';
const fullRows=(day,rs,{status='A',suffix='A',freq='D'}={})=>Object.entries(rs).map(([cc,v])=>
  `EXR.${freq}.${cc}.EUR.SP00.${suffix},${freq},${cc},EUR,SP00,${suffix},${day},${v},${status},F,"ECB reference exchange rate, ${cc}/Euro, 2.15 pm (C.E.T.)"`);
test('full ECB csvdata layout (quoted comma in a title) parses',()=>{
  const out=parseEcbDailyCsv([FULL_HEADER,...fullRows('2026-10-15',rates),...fullRows('2026-10-16',rates)].join('\r\n'),{sourceSha256:sha});
  assert.deepEqual(out.map(x=>[x.date,x.status]),[['2026-10-15','CALCULATED'],['2026-10-16','CALCULATED']]);
  assert.equal(out[0].value,calculateDxyProxy(rates));
});
test('only the daily SP00.A reference series with a normal status is used',()=>{
  const parse=(rows)=>()=>parseEcbDailyCsv([FULL_HEADER,...rows].join('\n'),{sourceSha256:sha});
  assert.throws(parse(fullRows('2026-10-15',rates,{suffix:'E'})),/ECB_SERIES_KEY_INVALID/);
  assert.throws(parse(fullRows('2026-10-15',rates,{freq:'M'})),/ECB_SERIES_KEY_INVALID/);
  // A KEY that contradicts its own columns.
  assert.throws(parse(fullRows('2026-10-15',rates).map(x=>x.replace(',SP00,A,',',SP00,E,'))),/ECB_SERIES_KEY_INVALID/);
  assert.throws(parse(fullRows('2026-10-15',rates,{status:'P'})),/ECB_OBS_STATUS_NOT_NORMAL/);
  assert.throws(()=>parseEcbDailyCsv(csv(rows('2026-10-15',rates)).replace(/^KEY,/,'SERIES,'),{sourceSha256:sha}),/ECB_COLUMN_MISSING:KEY/);
});
test('the proxy stays out of the ICE official field and of every runtime path',()=>{
  assert.equal(PROXY_KIND,'DXY_PROXY_RECONSTRUCTED_ECB_DAILY');
  assert.ok(!/ICE|OFFICIAL/.test(PROXY_KIND));
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const allowed=new Set(['scripts/dxy_ecb_proxy_check.mjs']);
  const walk=(dir)=>readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(d=>
    d.isDirectory()?walk(path.join(dir,d.name)):/\.(m?js|ts|html)$/.test(d.name)?[path.join(dir,d.name)]:[]);
  const importers=['backend','frontend','scripts','shared'].flatMap(walk)
    .filter(f=>!allowed.has(f)&&f!=='shared/dxy_ecb_daily_proxy.mjs'&&/(shared\/|\.\/)dxy_ecb_daily_proxy/.test(readFileSync(path.join(root,f),'utf8')));
  assert.deepEqual(importers,[]);
});
test('KEY alone identifies the series when the dimension columns are absent',()=>{
  const lean=(suffix)=>['KEY,CURRENCY,CURRENCY_DENOM,TIME_PERIOD,OBS_VALUE',
    ...Object.entries(rates).map(([cc,v])=>`EXR.D.${cc}.EUR.SP00.${suffix},${cc},EUR,2026-10-15,${v}`)].join('\n');
  assert.equal(parseEcbDailyCsv(lean('A'),{sourceSha256:sha})[0].status,'CALCULATED');
  assert.throws(()=>parseEcbDailyCsv(lean('E'),{sourceSha256:sha}),/ECB_SERIES_KEY_INVALID/);
});
test('a row shorter or longer than the header rejects the file',()=>{
  const ok=rows('2026-10-15',rates);
  assert.throws(()=>parseEcbDailyCsv(csv([...ok.slice(1),ok[0].replace(/,[^,]*$/,'')]),{sourceSha256:sha}),/ECB_CSV_COLUMN_COUNT/);
  assert.throws(()=>parseEcbDailyCsv(csv([...ok.slice(1),ok[0]+',x']),{sourceSha256:sha}),/ECB_CSV_COLUMN_COUNT/);
});
