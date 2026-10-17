// Event-driven committee routing: payload validation, scope -> horizons and
// probability-mass conservation of a partial recalculation (applyScope).
// Expectations follow the documented H1-H5 scopes of committee_orchestrator.ts:
//   FULL  -> H1..H5 recalculated
//   H1_H2 -> H1, H2, H3 recalculated; H4, H5 preserved
//   H3    -> only H4 re-evaluated;   H1, H2, H3, H5 preserved
// Probabilities are integer percentages summing to 100 (persisted / 100).
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { __internals } = await loadBackendModule('ai_engine/committee_orchestrator.ts');
const { isUniqueViolation } = await loadBackendModule('shared/run_lock.ts');
const { validateCommitteeEvent, applyScope, SCOPE_HORIZONS, SCOPE_AGENTS } = __internals;
let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};

const HORIZONS=['H1','H2','H3','H4','H5'];
const R='Justification suffisamment longue pour la validation.';
const sc=(d,prob,tg,inv,cf=60)=>({direction:d,probability:prob,target:tg,invalidation:inv,confidence:cf,reasoning:R});
const total=(m)=>HORIZONS.reduce((a,h)=>a+m[h].probability,0);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

console.log('--- EVENEMENT INCONNU / PAYLOAD INVALIDE ---');
let v=validateCommitteeEvent({event_id:'NEWS-1',event_type:'RECALC_H9',source:'news',triggered_at:new Date().toISOString()});
t('event_type inconnu -> REJECTED', !v.ok && v.errors.some(e=>/event_type inconnu/.test(e)));
v=validateCommitteeEvent({event_type:'RECALC_H1_H2',source:'news',triggered_at:new Date().toISOString()});
t('event_id manquant -> REJECTED', !v.ok && v.errors.some(e=>/event_id/.test(e)));
v=validateCommitteeEvent({event_id:'X',event_type:'RECALC_H1_H2',source:'news',triggered_at:'pas-une-date'});
t('triggered_at invalide -> REJECTED', !v.ok && v.errors.some(e=>/triggered_at/.test(e)));
v=validateCommitteeEvent({event_id:'X',event_type:'RECALC_H1_H2',source:'',triggered_at:new Date().toISOString()});
t('source vide -> REJECTED', !v.ok);
v=validateCommitteeEvent({event_id:'X',event_type:'RECALC_H1_H2',source:'n',triggered_at:new Date().toISOString(),news_event_id:'pas-un-uuid'});
t('news_event_id non-UUID -> REJECTED (pas de nettoyage silencieux)', !v.ok && v.errors.some(e=>/UUID/.test(e)));
v=validateCommitteeEvent({event_id:'X',event_type:'RECALC_H1_H2',source:'n',triggered_at:new Date().toISOString(),news_score:150});
t('news_score hors [0,100] -> REJECTED', !v.ok);
t('null -> REJECTED', !validateCommitteeEvent(null).ok);
t('chaine -> REJECTED', !validateCommitteeEvent('RECALC_H1_H2').ok);

const good={event_id:'news:11111111-1111-4111-8111-111111111111:RECALC_H1_H2',event_type:'RECALC_H1_H2',
  source:'news_engine',triggered_at:'2026-08-08T10:00:00.000Z',
  news_event_id:'11111111-1111-4111-8111-111111111111',news_score:86.2};
v=validateCommitteeEvent(good);
t('payload complet -> ACCEPTE', v.ok, v.ok?'':JSON.stringify(v.errors));
t('champs normalises', v.ok && v.event.news_score===86.2 && v.event.event_type==='RECALC_H1_H2');
v=validateCommitteeEvent({event_id:'Y',event_type:'REEVALUATE_H3',source:'news_engine',triggered_at:'2026-08-08T10:00:00Z'});
t('optionnels absents -> ACCEPTE avec null', v.ok && v.event.news_event_id===null && v.event.news_score===null);

console.log('--- Granularite declaree ---');
t('FULL -> [H1..H5]', same(SCOPE_HORIZONS.FULL,HORIZONS));
t('RECALC_H1_H2 (portee H1_H2) -> [H1,H2,H3]', same(SCOPE_HORIZONS.H1_H2,['H1','H2','H3']));
t('REEVALUATE_H3 (portee H3) -> [H4]', same(SCOPE_HORIZONS.H3,['H4']));
t('H3 ecarte le Technical Analyst', !SCOPE_AGENTS.H3.includes('technical_analyst'));
t('H1_H2 conserve les 5 agents', SCOPE_AGENTS.H1_H2.length===5);

const baseline={H1:sc('bearish',15,3300,3450),H2:sc('bearish',15,3280,3460),H3:sc('neutral',20,3400,3400),
  H4:sc('bullish',25,3600,3350),H5:sc('bullish',25,3700,3300)};
const recalc={H1:sc('bullish',50,3450,3380,90),H2:sc('bullish',20,3480,3370,88),H3:sc('bullish',10,3500,3360,85),
  H4:sc('bearish',10,3100,3600,99),H5:sc('bearish',10,3000,3700,99)};

console.log('--- CATALYST (H1_H2) -> H1/H2/H3 UNIQUEMENT ---');
let m=applyScope(recalc,baseline,'H1_H2');
t('H4 STRICTEMENT preserve', same(m.H4,baseline.H4));
t('H5 STRICTEMENT preserve', same(m.H5,baseline.H5));
t('H1 recalcule (direction changee)', m.H1.direction==='bullish' && m.H1.target===3450);
t('H2 recalcule', m.H2.direction==='bullish' && m.H2.invalidation===3370);
t('H3 recalcule', m.H3.direction==='bullish' && m.H3.target===3500);
t('budget H1+H2+H3 conserve (=50)', m.H1.probability+m.H2.probability+m.H3.probability===50,
  `${m.H1.probability}+${m.H2.probability}+${m.H3.probability}`);
t('somme totale = 100', total(m)===100, String(total(m)));
t('repartition interne suit le PM (H1>H2>H3)', m.H1.probability>m.H2.probability && m.H2.probability>m.H3.probability,
  `${m.H1.probability}/${m.H2.probability}/${m.H3.probability}`);

console.log('--- MAJOR (H3) -> H4 UNIQUEMENT ---');
m=applyScope(recalc,baseline,'H3');
for (const h of ['H1','H2','H3','H5']) t(`${h} preserve`, same(m[h],baseline[h]));
t('H4 reevalue : direction/cible/invalidation', m.H4.direction==='bearish' && m.H4.target===3100 && m.H4.invalidation===3600);
t('H4 conserve sa masse de probabilite (25)', m.H4.probability===25, String(m.H4.probability));
t('somme totale = 100', total(m)===100, String(total(m)));

console.log('--- FULL -> tout recalcule ---');
m=applyScope(recalc,baseline,'FULL');
t('FULL renvoie le recalcul tel quel', same(m,recalc));

console.log('--- Robustesse arrondi : somme toujours 100, preserves intacts ---');
let combos=0, broken=[];
for (const b of [[33,33,17,9,8],[1,1,49,24,25],[50,10,20,10,10],[7,3,45,25,20]]) {
  const bl=Object.fromEntries(HORIZONS.map((h,i)=>[h,sc('neutral',b[i],3400,3400)]));
  for (const rc of [[70,30,0],[1,99,1],[50,50,50],[0,0,0],[33,33,34]]) {
    const re={...Object.fromEntries(HORIZONS.map((h)=>[h,sc('neutral',5,3400,3400)])),
      H1:sc('bullish',rc[0],3450,3380),H2:sc('bullish',rc[1],3480,3370),H3:sc('bullish',rc[2],3500,3360)};
    const r=applyScope(re,bl,'H1_H2');
    combos++;
    const budget=b[0]+b[1]+b[2];
    if (total(r)!==100 || r.H1.probability+r.H2.probability+r.H3.probability!==budget
        || !same(r.H4,bl.H4) || !same(r.H5,bl.H5)
        || HORIZONS.some((h)=>!Number.isInteger(r[h].probability) || r[h].probability<0)) {
      broken.push(`base[${b}] recalc[${rc}]`);
    }
  }
}
t(`${combos} combinaisons : somme=100, budget conserve, H4/H5 intacts, entiers >= 0`, broken.length===0, broken.join('; '));

console.log('--- Detection 23505 (idempotence + verrou) ---');
t('code 23505 detecte', isUniqueViolation('Supabase HTTP 409: {"code":"23505","message":"duplicate key value..."}'));
t('libelle duplicate key detecte', isUniqueViolation('duplicate key value violates unique constraint'));
t('erreur sans rapport non confondue', !isUniqueViolation('Supabase HTTP 500: internal error'));
t('code=23505 (forme PostgREST abregee) detecte', isUniqueViolation('PostgREST 409 code=23505 duplicate key'));
t('code 23505 seul, entre guillemets, detecte', isUniqueViolation('Supabase HTTP 409: {"code": "23505"}'));
// Une VRAIE panne ne doit jamais passer pour « un run est deja actif » (SKIPPED silencieux).
for (const message of [
  'Supabase HTTP 500: request id 1235057 failed',
  'timeout after 23505ms',
  'Supabase HTTP 503: upstream connect error 23505',
  'Supabase HTTP 500: relation "ingestion_runs" already exists',
  'Supabase HTTP 400: {"code":"42P07","message":"relation \\"x\\" already exists"}',
  'Supabase HTTP 500: {"code":"23503","message":"foreign key violation"}',
  'Supabase HTTP 500: {"code":"23502","message":"null value violates not-null constraint"}',
  '',
]) {
  t(`faux positif refuse : ${JSON.stringify(message).slice(0, 70)}`, !isUniqueViolation(message));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
