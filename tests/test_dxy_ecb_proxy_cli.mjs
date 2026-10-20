import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runDxyEcbProxyCheck} from '../scripts/dxy_ecb_proxy_check.mjs';

const csv='KEY,FREQ,CURRENCY,CURRENCY_DENOM,TIME_PERIOD,OBS_VALUE\n'
  +['USD,1.1','JPY,160','GBP,0.85','CAD,1.5','SEK,11.5','CHF,0.95']
    .map(x=>{const [c,v]=x.split(',');return `EXR.D.${c}.EUR.SP00.A,D,${c},EUR,2026-10-15,${v}`;}).join('\n');
test('CLI hashes exact CSV bytes, prints safe research-only output, no file writes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'xau-dxy-proxy-'));
  try {
    const file=path.join(dir,'input.csv');await writeFile(file,csv);
    let stdout='',stderr='';
    const status=await runDxyEcbProxyCheck([file],{write:s=>stdout+=s},{write:s=>stderr+=s});
    assert.equal(status,0,stderr);
    const report=JSON.parse(stdout);
    assert.equal(report.complete,1);
    assert.equal(report.unavailable,0);
    assert.equal(report.iceOfficial,false);
    assert.equal(report.verified,false);
    assert.equal(report.tradingAuthorized,false);
    assert.match(report.sourceSha256,/^[a-f0-9]{64}$/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI rejects incomplete day without claiming successful qualification',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'xau-dxy-proxy-'));
  try{
    const file=path.join(dir,'input.csv');await writeFile(file,csv.split('\n').slice(0,-1).join('\n'));
    let stdout='',stderr='';
    const status=await runDxyEcbProxyCheck([file],{write:s=>stdout+=s},{write:s=>stderr+=s});
    assert.equal(status,1);
    assert.equal(JSON.parse(stdout).observations[0].status,'UNAVAILABLE');
  }finally{await rm(dir,{recursive:true,force:true});}
});
