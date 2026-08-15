/**
 * PHASE 2 — modes d'echec des providers, exerces contre un serveur HTTP REEL
 * (localhost). Le code provider n'est pas simule : ce sont les vraies
 * fonctions fetchStooq / fetchFred / fetchTwelveData qui tournent.
 */
import http from 'node:http';
import { fetchStooq, fetchFred, fetchTwelveData } from './providers.mjs';
import { validatePoint } from './validate.mjs';

let mode='ok', hits=0;
const server=http.createServer((req,res)=>{
  hits++;
  const u=req.url;
  if(mode==='empty'){ res.writeHead(200,{'content-type':'text/plain'}); return res.end(''); }
  if(mode==='http500'){ res.writeHead(500); return res.end('boom'); }
  if(mode==='http404'){ res.writeHead(404); return res.end('nope'); }
  if(mode==='ratelimit'){ res.writeHead(429,{'retry-after':'1'}); return res.end('slow down'); }
  if(mode==='ratelimit_long'){ res.writeHead(429,{'retry-after':'600'}); return res.end('quota'); }
  if(mode==='timeout'){ return; } // ne repond jamais
  if(mode==='garbage'){ res.writeHead(200); return res.end('<html>not json</html>'); }
  if(mode==='partial'){ res.writeHead(200); return res.end(JSON.stringify({observations:[{date:'2026-08-07'}]})); }
  if(u.includes('/q/l/')){
    res.writeHead(200,{'content-type':'text/csv'});
    if(mode==='nd') return res.end('Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,2026-08-08,11:59:00,N/D,N/D,N/D,N/D,0');
    if(mode==='future') return res.end('Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,2030-01-01,00:00:00,3400,3405,3395,3401.55,0');
    if(mode==='old') return res.end('Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,2020-01-01,00:00:00,3400,3405,3395,3401.55,0');
    if(mode==='negative') return res.end('Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,2026-08-08,11:59:00,3400,3405,3395,-12,0');
    if(mode==='absurd') return res.end('Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,2026-08-08,11:59:00,3400,3405,3395,999999999,0');
    const now=new Date(); const d=now.toISOString().slice(0,10); const t=now.toISOString().slice(11,19);
    return res.end(`Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,${d},${t},3395.2,3405.1,3392.0,3401.55,0`);
  }
  if(u.includes('/series/observations')){
    res.writeHead(200,{'content-type':'application/json'});
    if(mode==='alldots') return res.end(JSON.stringify({observations:[{date:'2026-08-07',value:'.'}]}));
    return res.end(JSON.stringify({observations:[{date:'2026-08-06',value:'4.21'},{date:'2026-08-07',value:'.'}]}));
  }
  if(u.includes('/quote')){
    res.writeHead(200,{'content-type':'application/json'});
    if(mode==='quota') return res.end(JSON.stringify({status:'error',code:429,message:'limit'}));
    return res.end(JSON.stringify({close:'97.842',timestamp:Math.floor(Date.now()/1000)}));
  }
  res.writeHead(404); res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const ENV={STOOQ_BASE_URL:`http://127.0.0.1:${port}/q/l/`,FRED_BASE_URL:`http://127.0.0.1:${port}`,
  TWELVE_DATA_BASE_URL:`http://127.0.0.1:${port}`,FRED_API_KEY:'test',TWELVE_DATA_KEY:'test'};

let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};
const NOW=new Date();

console.log('--- Cas nominal (serveur reel) ---');
mode='ok';
let d=await fetchStooq('XAUUSD','xauusd',ENV);
t('XAUUSD : valeur parsee', d.value===3401.55, String(d.value));
let v=validatePoint(d,NOW); t('XAUUSD : valide et LIVE', v.ok && v.point.freshness==='LIVE', v.ok?v.point.freshness:v.rejection.reason);
d=await fetchFred('US10Y','DGS10',ENV);
t('FRED : ignore le "." final, prend 4.21', d.value===4.21, String(d.value));
d=await fetchTwelveData('DXY','DXY',ENV);
t('DXY : valeur parsee', d.value===97.842, String(d.value));

console.log('--- Reponse vide ---');
mode='empty'; d=await fetchStooq('XAUUSD','xauusd',ENV);
t('valeur null, motif explicite', d.value===null && !!d.unavailableReason, d.unavailableReason);
t('PAS de 0 substitue', d.value!==0);

console.log('--- Erreurs HTTP ---');
mode='http404'; let err=null; try{await fetchStooq('XAUUSD','xauusd',ENV);}catch(e){err=e;}
t('404 -> exception (non rejouable)', err!==null && /404/.test(err.message));
mode='http500'; hits=0; err=null; try{await fetchStooq('XAUUSD','xauusd',ENV);}catch(e){err=e;}
t('500 -> retry puis echec', err!==null && hits>1, `tentatives=${hits}`);

console.log('--- Rate limit ---');
mode='ratelimit'; hits=0; err=null; try{await fetchStooq('XAUUSD','xauusd',ENV);}catch(e){err=e;}
t('429 court -> rejoue', hits>1, `tentatives=${hits}`);
mode='ratelimit_long'; hits=0; err=null; try{await fetchStooq('XAUUSD','xauusd',ENV);}catch(e){err=e;}
t('429 Retry-After 600s -> abandon immediat (pas d attente)', hits===1, `tentatives=${hits}`);

console.log('--- Timeout ---');
mode='timeout'; hits=0; const t0=Date.now(); err=null;
try{await fetchStooq('XAUUSD','xauusd',ENV);}catch(e){err=e;}
t('timeout -> exception, pas de blocage infini', err!==null && Date.now()-t0<70000, `${Date.now()-t0}ms`);

console.log('--- Reponses degradees ---');
mode='garbage'; d=await fetchFred('US10Y','DGS10',ENV);
t('JSON invalide -> unavailable', d.value===null && /non JSON/.test(d.unavailableReason));
mode='partial'; d=await fetchFred('US10Y','DGS10',ENV);
t('observation sans value -> unavailable', d.value===null);
mode='alldots'; d=await fetchFred('US10Y','DGS10',ENV);
t('FRED "." seul -> unavailable, JAMAIS 0', d.value===null);
mode='quota'; d=await fetchTwelveData('DXY','DXY',ENV);
t('quota Twelve Data -> unavailable', d.value===null && /429/.test(d.unavailableReason));
mode='nd'; d=await fetchStooq('XAUUSD','xauusd',ENV);
t('Stooq N/D -> unavailable', d.value===null);

console.log('--- Valeurs et horodatages aberrants ---');
mode='negative'; d=await fetchStooq('XAUUSD','xauusd',ENV); v=validatePoint(d,NOW);
t('prix negatif -> REJET', !v.ok && /négative/.test(v.rejection.reason), v.ok?'accepte':v.rejection.reason);
mode='absurd'; d=await fetchStooq('XAUUSD','xauusd',ENV); v=validatePoint(d,NOW);
t('valeur absurde -> REJET (pas de clamp)', !v.ok && /plausibilité/.test(v.rejection.reason));
mode='future'; d=await fetchStooq('XAUUSD','xauusd',ENV); v=validatePoint(d,NOW);
t('horodatage futur -> REJET', !v.ok && /futur/.test(v.rejection.reason));
mode='old'; d=await fetchStooq('XAUUSD','xauusd',ENV); v=validatePoint(d,NOW);
t('horodatage 2020 -> REJET (trop ancien)', !v.ok && /trop ancienne/.test(v.rejection.reason));

console.log('--- Cle absente : collecteur desactive, pas d appel ---');
d=await fetchFred('US10Y','DGS10',{});
t('sans FRED_API_KEY -> unavailable sans appel', d.value===null && /FRED_API_KEY/.test(d.unavailableReason));
d=await fetchTwelveData('DXY','DXY',{});
t('sans TWELVE_DATA_KEY -> DXY unavailable, substitution refusee',
  d.value===null && /Substitution par DTWEXBGS refusée/.test(d.unavailableReason));

server.close();
console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
