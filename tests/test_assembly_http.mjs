/**
 * TEST D'ASSEMBLAGE — jonction News -> HTTP -> Worker -> Committee.
 *
 * Ce qui est REELLEMENT exercé :
 *   - le vrai `buildNotification` du news_engine ;
 *   - un vrai serveur HTTP montant le vrai `handleRequest` du worker ;
 *   - le vrai routage event-driven du comité ;
 *   - le vrai verrou et la vraie idempotence, contre PostgreSQL RÉEL.
 *
 * Ce qui reste MOCKÉ (et donc NON prouvé) :
 *   - l'API Anthropic (aucune clé) ;
 *   - PostgREST (pont vers SQL local).
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { buildNotification } from './news_engine/ingest.mjs';
import worker from './worker.mjs';

const psql=s=>execFileSync('su',['postgres','-c',
  `/usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -d alphaxau -tAc ${JSON.stringify(s)}`],{encoding:'utf8'}).trim();
const firstRow=o=>o.split('\n').filter(l=>l.trim()&&!/^(INSERT|UPDATE|DELETE) \d+ \d+$/.test(l.trim()))[0];

// --- Pont PostgREST -> SQL reel ---
const q=v=>v===null||v===undefined?'NULL':(typeof v==='string'?`'${v.replace(/'/g,"''")}'`:String(v));
const rest=http.createServer((req,res)=>{
  let b=''; req.on('data',c=>b+=c);
  req.on('end',()=>{
    const send=(c,o)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(o));};
    const path=req.url.replace(/^\/rest\/v1\//,'');
    try{
      if(path.startsWith('rpc/fn_reclaim_stale_runs')){const j=JSON.parse(b);psql(`SELECT fn_reclaim_stale_runs('${j.p_engine}',${j.p_older_than_minutes});`);return send(200,[]);}
      if(req.method==='POST'&&path.startsWith('ingestion_runs')){const r=JSON.parse(b)[0];
        try{return send(201,[{id:firstRow(psql(`INSERT INTO ingestion_runs (engine,trigger_type,status) VALUES ('${r.engine}','${r.trigger_type}','running') RETURNING id;`))}]);}
        catch(e){return send(409,{code:'23505',message:'duplicate key value violates unique constraint'});}}
      if(req.method==='PATCH'&&path.startsWith('ingestion_runs')){const id=decodeURIComponent(path.split('id=eq.')[1]);const j=JSON.parse(b);
        psql(`UPDATE ingestion_runs SET status='${j.status}',finished_at=now(),duration_ms=${j.duration_ms} WHERE id='${id}';`);return send(204,[]);}
      if(req.method==='POST'&&path.startsWith('ai_events')){const r=JSON.parse(b)[0];
        try{psql(`INSERT INTO ai_events (event_id,event_type,status,source,triggered_at,news_event_id,news_score) VALUES (${q(r.event_id)},${q(r.event_type)},'RUNNING',${q(r.source)},${q(r.triggered_at)},${q(r.news_event_id)},${r.news_score??'NULL'});`);return send(201,[]);}
        catch(e){const m=String(e.stderr||e.message);
          // Ne mapper sur 409/23505 qu'une VRAIE violation d'unicite. Une
          // violation de FK (23503) doit remonter en 4xx distinct, sinon le
          // code la confondrait avec un doublon deja traite.
          if(/duplicate key|23505/.test(m)) return send(409,{code:'23505',message:'duplicate key value violates unique constraint'});
          return send(400,{code:'23503',message:m.slice(0,200)});}}
      if(req.method==='PATCH'&&path.startsWith('ai_events')){const id=decodeURIComponent(path.split('event_id=eq.')[1]);const j=JSON.parse(b);
        psql(`UPDATE ai_events SET status='${j.status}',finished_at=now(),duration_ms=${j.duration_ms},error=${q(j.error)} WHERE event_id='${id}';`);return send(204,[]);}
      if(req.method==='GET'&&path.startsWith('v_market_latest'))
        return send(200,JSON.parse(psql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT symbol,bid,ask,close,dxy_value,us10y_yield,real_yield,vix,wti,source,ts,staleness_seconds FROM v_market_latest) t;")));
      if(req.method==='GET'&&path.startsWith('v_news_actionable')) return send(200,[]);
      send(200,[]);
    }catch(e){send(500,{message:String(e.message).slice(0,200)});}
  });
});
await new Promise(r=>rest.listen(0,'127.0.0.1',r));
const REST=`http://127.0.0.1:${rest.address().port}`;

// --- Vrai serveur HTTP montant le vrai worker.fetch ---
const TOKEN='staging-token-de-test-non-secret';
const ENV={SUPABASE_URL:REST,SUPABASE_SERVICE_ROLE_KEY:'svc',ANTHROPIC_API_KEY:'',
  COMMITTEE_TOKEN:TOKEN,INGEST_TOKEN:TOKEN,AI_ENGINE_TOKEN:TOKEN,LOG_LEVEL:'warn'};
const wsrv=http.createServer(async(req,res)=>{
  const chunks=[]; for await (const c of req) chunks.push(c);
  const body=Buffer.concat(chunks);
  const r=await worker.fetch(new Request(`http://w${req.url}`,{method:req.method,
    headers:req.headers, body:['GET','HEAD'].includes(req.method)?undefined:body}),ENV);
  res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());
});
await new Promise(r=>wsrv.listen(0,'127.0.0.1',r));
const WORKER=`http://127.0.0.1:${wsrv.address().port}`;
ENV.AI_ENGINE_URL=`${WORKER}/committee`;

let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};
psql("DELETE FROM ai_events; UPDATE ingestion_runs SET status='failed',finished_at=now() WHERE status='running';");
// La FK fk_ai_events_news impose que la news existe : on cree de vraies
// lignes news_events plutot que des UUID inventes.
for (const [id,title] of [['11111111-1111-4111-8111-111111111111','Fed maintient ses taux'],
                          ['22222222-2222-4222-8222-222222222222','CPI US superieur aux attentes'],
                          ['33333333-3333-4333-8333-333333333333','Escalade au detroit d Ormuz'],
                          ['44444444-4444-4444-8444-444444444444','Achats de banques centrales']]) {
  psql(`INSERT INTO news_events (id,title,source,ts,region,category,macro_score,volatility_score,reliability_score,surprise_score,duration_score) VALUES ('${id}','${title}','reuters',now(),'US','monetary_policy',80,70,90,75,60) ON CONFLICT (id) DO NOTHING;`);
}

console.log('--- BLOCKER #2 : routes HTTP du Worker reellement joignables ---');
let r=await fetch(`${WORKER}/health`); let j=await r.json();
t('GET /health -> 200', r.status===200, String(r.status));
t('/health liste les 3 crons', Array.isArray(j.jobs)&&j.jobs.length===3, JSON.stringify(j.jobs));
r=await fetch(`${WORKER}/committee`,{method:'POST'});
t('POST /committee sans token -> 401', r.status===401, String(r.status));
r=await fetch(`${WORKER}/news`,{method:'POST'});
t('POST /news sans token -> 401', r.status===401, String(r.status));
r=await fetch(`${WORKER}/inconnu`);
t('route inconnue -> 404', r.status===404, String(r.status));
r=await fetch(`${WORKER}/committee`,{method:'GET'});
t('GET /committee -> 405', r.status===405, String(r.status));

console.log('--- Contrat : payload news_engine <-> validation comite ---');
const NEWS_ID='11111111-1111-4111-8111-111111111111';
const notif=buildNotification(NEWS_ID,'RECALC_H1_H2',86.2);
t('buildNotification produit les 6 champs du contrat',
  ['event_id','event_type','source','triggered_at','news_event_id','news_score'].every(k=>k in notif),
  Object.keys(notif).join(','));
t('event_id stable et derive de la news', notif.event_id===`news:${NEWS_ID}:RECALC_H1_H2`);
t('ARCHIVE_ONLY ne produit aucune notification', buildNotification(NEWS_ID,'ARCHIVE_ONLY',10)===null);

const post=(payload,token=TOKEN)=>fetch(`${WORKER}/committee`,{method:'POST',
  headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
  body:JSON.stringify(payload)});

console.log('--- Event -> Committee : mauvais token ---');
r=await post(notif,'mauvais-token');
t('token invalide -> 401, aucun traitement', r.status===401);
t('aucun evenement enregistre', Number(psql("SELECT count(*) FROM ai_events;"))===0);

console.log('--- Event -> Committee : payload invalide ---');
r=await post({event_type:'RECALC_H9',event_id:'x',source:'s',triggered_at:new Date().toISOString()});
j=await r.json();
t('event_type inconnu -> 400 INVALID_EVENT', r.status===400 && j.status==='INVALID_EVENT', `${r.status} ${j.status}`);
t('aucun appel LLM, aucun evenement stocke', Number(psql("SELECT count(*) FROM ai_events;"))===0);

console.log('--- Event valide, ETAT A : aucune donnee marche ---');
const savedTicks=psql("SELECT count(*) FROM market_ticks;");
psql("CREATE TEMP TABLE IF NOT EXISTS _t AS SELECT 1;");
psql("DELETE FROM market_ticks;");
r=await post(notif); j=await r.json();
t('sans prix -> HTTP 503 DATA_UNAVAILABLE', r.status===503 && j.status==='DATA_UNAVAILABLE', `${r.status} ${j.status}`);
t('portee correcte transmise', j.scope==='H1_H2' && JSON.stringify(j.horizons_recalculated)===JSON.stringify(['H1','H2']), JSON.stringify(j.scope));
let ev=psql("SELECT status||'|'||coalesce(news_event_id::text,'-')||'|'||coalesce(news_score::text,'-') FROM ai_events;");
t('cause DATA_UNAVAILABLE tracee en base', ev.startsWith('DATA_UNAVAILABLE'), ev);

console.log('--- ETAT B : prix present, Anthropic injoignable (aucune cle) ---');
psql("INSERT INTO market_ticks (symbol,asset_type,close,timeframe,source,ts,us10y_yield,real_yield,vix,wti) VALUES ('XAUUSD','metal',3401.55,'tick','stooq',now(),4.21,-0.85,16.42,68.31);");
psql("DELETE FROM ai_events;");
const nB=buildNotification('33333333-3333-4333-8333-333333333333','RECALC_H1_H2',91);
const rB=await post(nB); const jB=await rB.json();
t('avec prix mais sans LLM -> HTTP 500 FAILED', rB.status===500 && jB.status==='FAILED', `${rB.status} ${jB.status}`);
t('echec technique distinct de DATA_UNAVAILABLE', jB.status!=='DATA_UNAVAILABLE');
const evB=psql("SELECT status FROM ai_events;");
t('cause FAILED tracee en base', evB==='FAILED', evB);
t('verrou libere apres echec LLM', Number(psql("SELECT count(*) FROM ingestion_runs WHERE engine='ai_committee' AND status='running';"))===0);
psql("DELETE FROM ai_events;");
r=await post(notif); j=await r.json();
ev=psql("SELECT status||'|'||coalesce(news_event_id::text,'-')||'|'||coalesce(news_score::text,'-') FROM ai_events;");
t('news_event_id et news_score persistes', ev.includes(NEWS_ID)&&ev.includes('86.20'), ev);
t('verrou libere apres echec', Number(psql("SELECT count(*) FROM ingestion_runs WHERE engine='ai_committee' AND status='running';"))===0);

console.log('--- Idempotence sur le vrai canal HTTP ---');
r=await post(notif); j=await r.json();
t('rejeu -> 200 ALREADY_PROCESSED', r.status===200 && j.status==='ALREADY_PROCESSED', `${r.status} ${j.status}`);
t('toujours 1 seule ligne ai_events', Number(psql("SELECT count(*) FROM ai_events;"))===1);

console.log('--- REEVALUATE_H3 : portee distincte ---');
const n3=buildNotification('22222222-2222-4222-8222-222222222222','REEVALUATE_H3',72.5);
r=await post(n3); j=await r.json();
t('scope H3 uniquement', j.scope==='H3' && JSON.stringify(j.horizons_recalculated)===JSON.stringify(['H3']), JSON.stringify(j.scope));
t('2 evenements distincts traces', Number(psql("SELECT count(*) FROM ai_events;"))===2);

console.log('--- Verrou : deux events simultanes -> un seul comite ---');
psql("DELETE FROM ai_events;");
const a=buildNotification('33333333-3333-4333-8333-333333333333','RECALC_H1_H2',90);
const b=buildNotification('44444444-4444-4444-8444-444444444444','RECALC_H1_H2',88);
const [ra,rb]=await Promise.all([post(a),post(b)]);
const [ja,jb]=[await ra.json(),await rb.json()];
const statuts=[ja.status,jb.status].sort();
t('un seul traite, l autre ALREADY_RUNNING',
  statuts.includes('ALREADY_RUNNING') && statuts.length===2, statuts.join('+'));
t('l event non traite reste rejouable (non consomme)', Number(psql("SELECT count(*) FROM ai_events;"))===1);

rest.close(); wsrv.close();
console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
