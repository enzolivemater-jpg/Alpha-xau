/**
 * Cycle COMPLET du market_engine : providers HTTP reels (localhost)
 * -> validation -> normalisation -> ecriture PostgreSQL REELLE via un
 * pont PostgREST->SQL -> relecture par le contrat du comite.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { runMarketIngestion } from './ingest_market.mjs';
import { buildSnapshot } from './context.mjs';

const psql=s=>execFileSync('su',['postgres','-c',
  `/usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -d alphaxau -tAc ${JSON.stringify(s)}`],{encoding:'utf8'}).trim();

let mode='ok';
const FROZEN=new Date(); // horodatage de cotation stable, comme une vraie source
const provider=http.createServer((req,res)=>{
  const u=req.url;
  if(u.includes('/q/l/')){
    if(mode==='gold_down'){ res.writeHead(500); return res.end('down'); }
    const n=FROZEN, d=n.toISOString().slice(0,10), t=n.toISOString().slice(11,19);
    res.writeHead(200); return res.end(`Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,${d},${t},3395.2,3405.1,3392.0,3401.55,0`);
  }
  if(u.includes('/series/observations')){
    const id=new URL(u,'http://x').searchParams.get('series_id');
    const val={DGS10:'4.21',DFII10:'-0.85',VIXCLS:'16.42',DCOILWTICO:'68.31'}[id];
    res.writeHead(200); return res.end(JSON.stringify({observations:[{date:new Date(Date.now()-864e5).toISOString().slice(0,10),value:val}]}));
  }
  if(u.includes('/quote')){ res.writeHead(200); return res.end(JSON.stringify({status:'error',code:429,message:'no key'})); }
  res.writeHead(404); res.end();
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const pport=provider.address().port;

// Pont PostgREST -> SQL reel
const q=(v)=>v===null||v===undefined?'NULL':(typeof v==='string'?`'${v.replace(/'/g,"''")}'`:String(v));
const rest=http.createServer((req,res)=>{
  let body='';
  req.on('data',c=>body+=c);
  req.on('end',()=>{
    const send=(code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
    try{
      const path=req.url.replace(/^\/rest\/v1\//,'');
      if(path.startsWith('rpc/fn_reclaim_stale_runs')){
        const b=JSON.parse(body); psql(`SELECT fn_reclaim_stale_runs('${b.p_engine}',${b.p_older_than_minutes});`); return send(200,[]);
      }
      if(req.method==='POST'&&path.startsWith('ingestion_runs')){
        const r=JSON.parse(body)[0];
        try{ const id=psql(`INSERT INTO ingestion_runs (engine,trigger_type,status) VALUES ('${r.engine}','${r.trigger_type}','running') RETURNING id;`).split('\n')[0];
          return send(201,[{id}]); }
        catch(e){ return send(409,{code:'23505',message:'duplicate key'}); }
      }
      if(req.method==='PATCH'&&path.startsWith('ingestion_runs')){
        const id=decodeURIComponent(path.split('id=eq.')[1]); const b=JSON.parse(body);
        psql(`UPDATE ingestion_runs SET status='${b.status}',finished_at=now(),duration_ms=${b.duration_ms},persisted_count=${b.persisted_count},rejected_count=${b.rejected_count} WHERE id='${id}';`);
        return send(204,[]);
      }
      if(req.method==='POST'&&path.startsWith('market_ticks')){
        const rows=JSON.parse(body); const out=[];
        for(const r of rows){
          const cols=['symbol','asset_type','close','open','high','low','bid','ask','volume','timeframe','source','ts','dxy_value','us10y_yield','real_yield','vix','wti'];
          // psql -tAc imprime les lignes PUIS l'etiquette de commande
          // ("INSERT 0 0"). Ne compter que les lignes reellement retournees.
          try{
            const raw=psql(`INSERT INTO market_ticks (${cols.join(',')}) VALUES (${cols.map(c=>q(r[c]??null)).join(',')}) ON CONFLICT (symbol,timeframe,ts,source) DO NOTHING RETURNING symbol;`);
            const returned=raw.split('\n').filter(l=>l.trim()&&!/^INSERT \d+ \d+$/.test(l.trim()));
            if(returned.length>0) out.push({symbol:r.symbol});
          }catch(e){}
        }
        return send(201,out.filter(Boolean));
      }
      if(req.method==='GET'&&path.startsWith('v_market_latest')){
        const j=psql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT symbol,bid,ask,close,dxy_value,us10y_yield,real_yield,vix,wti,source,ts,staleness_seconds FROM v_market_latest) t;");
        return send(200,JSON.parse(j));
      }
      send(200,[]);
    }catch(e){ send(500,{message:String(e.message).slice(0,200)}); }
  });
});
await new Promise(r=>rest.listen(0,'127.0.0.1',r));
const rport=rest.address().port;

const ENV={SUPABASE_URL:`http://127.0.0.1:${rport}`,SUPABASE_SERVICE_ROLE_KEY:'svc',
 STOOQ_BASE_URL:`http://127.0.0.1:${pport}/q/l/`,FRED_BASE_URL:`http://127.0.0.1:${pport}`,
 TWELVE_DATA_BASE_URL:`http://127.0.0.1:${pport}`,FRED_API_KEY:'k',TWELVE_DATA_KEY:'k',LOG_LEVEL:'warn'};

let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};
psql("DELETE FROM market_ticks; UPDATE ingestion_runs SET status='failed',finished_at=now() WHERE status='running';");

console.log('--- RUN 1 : cycle complet reel ---');
let rep=await runMarketIngestion(ENV,'manual');
console.log(`   statut=${rep.status} persistes=${rep.persisted} rejetes=${rep.rejected} duree=${rep.durationMs}ms`);
t('run PARTIAL (DXY indisponible, or present)', rep.status==='PARTIAL', rep.status);
t('1 ligne persistee (or uniquement)', rep.persisted===1, String(rep.persisted));
t('DXY rejete explicitement', rep.rejections.some(r=>r.symbol==='DXY'), JSON.stringify(rep.rejections.map(r=>r.symbol)));
const row=JSON.parse(psql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT symbol,close,real_yield,us10y_yield,vix,wti,dxy_value,spread FROM market_ticks) t;"))[0];
t('ecriture PostgreSQL reelle', row && Number(row.close)===3401.55, JSON.stringify(row));
t('real_yield NEGATIF conserve', Number(row.real_yield)===-0.85, String(row.real_yield));
t('DXY reste NULL (jamais 0)', row.dxy_value===null);
t('spread NULL car Stooq ne publie pas de book (aucune valeur inventee)', row.spread===null, String(row.spread));

console.log('--- RUN 2 : idempotence (meme tick) ---');
rep=await runMarketIngestion(ENV,'manual');
console.log('   RUN2 rapport:',JSON.stringify({status:rep.status,persisted:rep.persisted,duplicates:rep.duplicates}));
console.log('   lignes en base apres run2:',psql("SELECT count(*) FROM market_ticks;"));
t('doublon absorbe par la contrainte', rep.duplicates>=1 || rep.persisted===0, `pers=${rep.persisted} dup=${rep.duplicates}`);
const n=Number(psql("SELECT count(*) FROM market_ticks;"));
t('toujours 1 seule ligne en base', n===1, String(n));

console.log('--- Contrat de lecture du comite ---');
const snap=buildSnapshot(JSON.parse(psql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT symbol,bid,ask,close,dxy_value,us10y_yield,real_yield,vix,wti,source,ts,staleness_seconds FROM v_market_latest) t;")));
t('snapshot disponible', snap.available);
t('spot LIVE', snap.spot.status==='LIVE' && snap.spot.value===3401.55);
t('DXY UNAVAILABLE cote comite', snap.dxy.status==='UNAVAILABLE' && snap.dxy.value===null);
t('real_yield transmis negatif', snap.realYield.value===-0.85);

console.log('--- Source de l or en panne : donnees existantes preservees ---');
mode='gold_down';
psql("UPDATE ingestion_runs SET status='failed',finished_at=now() WHERE status='running';");
rep=await runMarketIngestion(ENV,'manual');
t('run FAILED sans or', rep.status==='FAILED', rep.status);
const still=Number(psql("SELECT count(*) FROM market_ticks;"));
t('ancienne donnee NON detruite', still===1, String(still));
t('aucune valeur inventee', rep.persisted===0);

console.log('--- Observabilite : ingestion_runs ---');
const runs=psql("SELECT status||':'||coalesce(persisted_count,0)::text FROM ingestion_runs WHERE engine='market_engine' ORDER BY started_at DESC LIMIT 3;");
console.log('   derniers runs :', runs.replace(/\n/g,' | '));
t('runs traces avec statut et compteurs', runs.length>0);

provider.close(); rest.close();
console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
