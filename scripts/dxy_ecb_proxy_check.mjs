#!/usr/bin/env node
/**
 * Research-only local reader. NO network, trading, official ICE field or file writes.
 * node scripts/dxy_ecb_proxy_check.mjs /path/to/downloaded-ecb.csv
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseEcbDailyCsv} from '../shared/dxy_ecb_daily_proxy.mjs';

export async function runDxyEcbProxyCheck(args, out=process.stdout, err=process.stderr) {
  if (args.length!==1 || args[0].startsWith('-')) {
    err.write('usage: node scripts/dxy_ecb_proxy_check.mjs <downloaded-ecb.csv>\n');
    return 64;
  }
  try {
    const bytes=await readFile(args[0]);
    const sha=createHash('sha256').update(bytes).digest('hex');
    const series=parseEcbDailyCsv(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{sourceSha256:sha});
    const complete=series.filter(x=>x.status==='CALCULATED').length;
    out.write(JSON.stringify({
      kind:'DXY_PROXY_ECB_DAILY_RESEARCH_REPORT',
      sourceSha256:sha,days:series.length,complete,unavailable:series.length-complete,
      iceOfficial:false,verified:false,tradingAuthorized:false,
      observations:series,
    },null,2)+'\n');
    return complete===series.length?0:1;
  } catch(e) {
    err.write('DXY_PROXY_CHECK_FAILED: '+String(e?.message||e)+'\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.exitCode=await runDxyEcbProxyCheck(process.argv.slice(2));
}
