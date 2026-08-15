/**
 * Verrou et idempotence exercés contre la VRAIE base PostgreSQL,
 * via un faux PostgREST qui traduit les requêtes en SQL réel.
 * Les contraintes testées sont donc celles de PostgreSQL, pas des mocks.
 */
import { acquireLock, releaseLock } from './shared/run_lock.mjs';
import { execFileSync } from 'node:child_process';

const psql = (sql) => execFileSync('su',['postgres','-c',
  `/usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -d alphaxau -tAc ${JSON.stringify(sql)}`],
  {encoding:'utf8'});

// Faux client PostgREST : traduit les 3 opérations utilisées en SQL réel.
let llmCalls = 0;
const db = {
  async request(method, path, body) {
    if (path.startsWith('rpc/fn_reclaim_stale_runs')) {
      psql(`SELECT fn_reclaim_stale_runs('${body.p_engine}', ${body.p_older_than_minutes});`);
      return [];
    }
    if (method === 'POST' && path.startsWith('ingestion_runs')) {
      const r = body[0];
      try {
        const out = psql(`INSERT INTO ingestion_runs (engine,trigger_type,status) VALUES ('${r.engine}','${r.trigger_type}','running') RETURNING id;`);
        return [{ id: out.trim().split(/\r?\n/)[0].trim() }];
      } catch (e) {
        const msg = String(e.stderr || e.message);
        throw new Error(`Supabase HTTP 409: ${msg}`);
      }
    }
    if (method === 'POST' && path.startsWith('ai_events')) {
      const r = body[0];
      try {
        psql(`INSERT INTO ai_events (event_id,event_type,status,source,triggered_at) VALUES ('${r.event_id}','${r.event_type}','RUNNING','${r.source}','${r.triggered_at}');`);
        return [];
      } catch (e) {
        throw new Error(`Supabase HTTP 409: ${String(e.stderr || e.message)}`);
      }
    }
    if (method === 'PATCH' && path.startsWith('ingestion_runs')) {
      const id = decodeURIComponent(path.split('id=eq.')[1]);
      psql(`UPDATE ingestion_runs SET status='success', finished_at=now(), duration_ms=${body.duration_ms} WHERE id='${id}';`);
      return [];
    }
    return [];
  }
};

let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};
psql("DELETE FROM ai_events; UPDATE ingestion_runs SET status='failed', finished_at=now() WHERE status='running';");

console.log('--- TEST 1 : verrou libre -> PASS ---');
const l1 = await acquireLock(db,'ai_committee','cron');
t('verrou acquis', l1.acquired===true, JSON.stringify(l1));

console.log('--- TEST 2 : verrou occupe -> SKIPPED ---');
const l2 = await acquireLock(db,'ai_committee','webhook');
t('second verrou REFUSE', l2.acquired===false && l2.reason==='ALREADY_RUNNING', JSON.stringify(l2));

console.log('--- TEST 3 : cron + event simultanes -> UN SEUL comite ---');
psql("UPDATE ingestion_runs SET status='failed', finished_at=now() WHERE status='running';");
const results = await Promise.all([
  acquireLock(db,'ai_committee','cron'),
  acquireLock(db,'ai_committee','webhook'),
  acquireLock(db,'ai_committee','webhook'),
]);
const won = results.filter(r=>r.acquired).length;
t('exactement 1 gagnant sur 3 tentatives simultanees', won===1, `gagnants=${won}`);
t('les 2 perdants renvoient ALREADY_RUNNING', results.filter(r=>!r.acquired).every(r=>r.reason==='ALREADY_RUNNING'));
const active = Number(psql("SELECT count(*) FROM ingestion_runs WHERE engine='ai_committee' AND status='running';").trim());
t('1 seule ligne running en base', active===1, `running=${active}`);

console.log('--- TEST 9 : erreur comite -> verrou libere ---');
const holder = results.find(r=>r.acquired);
try {
  await (async () => { try { throw new Error('panne LLM simulee'); } finally {
    await releaseLock(db, holder.runRowId, {status:'success', durationMs:5});
  }})();
} catch { /* l'erreur remonte, c'est voulu */ }
const stillRunning = Number(psql("SELECT count(*) FROM ingestion_runs WHERE engine='ai_committee' AND status='running';").trim());
t('verrou libere malgre l erreur', stillRunning===0, `running=${stillRunning}`);
const l3 = await acquireLock(db,'ai_committee','cron');
t('nouveau comite possible apres erreur', l3.acquired===true);
await releaseLock(db, l3.runRowId, {status:'success', durationMs:1});

console.log('--- Recuperation stale ---');
const l4 = await acquireLock(db,'ai_committee','cron');
psql("UPDATE ingestion_runs SET started_at = now() - interval '30 minutes' WHERE id='"+l4.runRowId+"';");
const l5 = await acquireLock(db,'ai_committee','cron');
t('verrou abandonne recupere (>15min)', l5.acquired===true, JSON.stringify(l5));
await releaseLock(db, l5.runRowId, {status:'success', durationMs:1});

console.log('--- TEST 8 : IDEMPOTENCE d un event_id ---');
const ev = {event_id:'news:abc:RECALC_H1_H2', event_type:'RECALC_H1_H2', source:'news_engine', triggered_at:new Date().toISOString()};
const claim = async () => {
  try { await db.request('POST','ai_events',[ev]); llmCalls++; return 'PROCESS'; }
  catch (e) { return /23505|duplicate key/i.test(e.message) ? 'ALREADY_PROCESSED' : 'ERROR'; }
};
const first = await claim();
const second = await claim();
t('1ere reception -> PROCESS', first==='PROCESS', first);
t('2eme reception -> ALREADY_PROCESSED', second==='ALREADY_PROCESSED', second);
t('AUCUN second appel LLM', llmCalls===1, `appels=${llmCalls}`);
const rows = Number(psql("SELECT count(*) FROM ai_events WHERE event_id='news:abc:RECALC_H1_H2';").trim());
t('1 seule ligne ai_events', rows===1, `rows=${rows}`);

console.log('--- Isolation par moteur ---');
const lm = await acquireLock(db,'market_engine','cron');
t('market_engine non bloque par ai_committee', lm.acquired===true);
await releaseLock(db, lm.runRowId, {status:'success', durationMs:1});

psql("DELETE FROM ai_events; UPDATE ingestion_runs SET status='failed', finished_at=now() WHERE status='running';");
console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
