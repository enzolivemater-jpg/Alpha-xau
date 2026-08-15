import { __internals } from './ai_engine/committee_orchestrator.mjs';
import { acquireLock, releaseLock, isUniqueViolation } from './shared/run_lock.mjs';
const { validateCommitteeEvent, applyScope, SCOPE_HORIZONS, SCOPE_AGENTS } = __internals;
let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};

const R='Justification suffisamment longue pour la validation.';
const sc=(d,prob,tg,inv,cf=60)=>({direction:d,probability:prob,target:tg,invalidation:inv,confidence:cf,reasoning:R});

console.log('--- TEST 6/7 : EVENEMENT INCONNU / PAYLOAD INVALIDE ---');
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

console.log('--- TEST 4 : CATALYST -> H1/H2 UNIQUEMENT ---');
const baseline={H1:sc('bearish',20,3300,3450),H2:sc('bearish',20,3280,3460),H3:sc('neutral',35,3400,3400),H4:sc('bullish',25,3600,3350)};
const recalc={H1:sc('bullish',60,3450,3380,90),H2:sc('bullish',20,3480,3370,88),H3:sc('bearish',10,3200,3500,99),H4:sc('bearish',10,3100,3600,99)};
let m=applyScope(recalc,baseline,'H1_H2');
t('H3 STRICTEMENT preserve', JSON.stringify(m.H3)===JSON.stringify(baseline.H3));
t('H4 STRICTEMENT preserve', JSON.stringify(m.H4)===JSON.stringify(baseline.H4));
t('H1 recalcule (direction changee)', m.H1.direction==='bullish' && m.H1.target===3450);
t('H2 recalcule', m.H2.direction==='bullish' && m.H2.invalidation===3370);
t('budget H1+H2 conserve (=40)', m.H1.probability+m.H2.probability===40, `${m.H1.probability}+${m.H2.probability}`);
t('somme totale = 100', ['H1','H2','H3','H4'].reduce((a,h)=>a+m[h].probability,0)===100);
t('repartition interne suit le PM (H1>H2)', m.H1.probability>m.H2.probability, `${m.H1.probability}/${m.H2.probability}`);

console.log('--- TEST 5 : MAJOR -> H3 UNIQUEMENT ---');
m=applyScope(recalc,baseline,'H3');
t('H1 preserve', JSON.stringify(m.H1)===JSON.stringify(baseline.H1));
t('H2 preserve', JSON.stringify(m.H2)===JSON.stringify(baseline.H2));
t('H4 preserve', JSON.stringify(m.H4)===JSON.stringify(baseline.H4));
t('H3 reevalue : direction/cible/invalidation', m.H3.direction==='bearish' && m.H3.target===3200 && m.H3.invalidation===3500);
t('H3 conserve sa masse de probabilite (35)', m.H3.probability===35, String(m.H3.probability));
t('somme totale = 100', ['H1','H2','H3','H4'].reduce((a,h)=>a+m[h].probability,0)===100);

console.log('--- Granularite declaree ---');
t('RECALC_H1_H2 -> [H1,H2]', JSON.stringify(SCOPE_HORIZONS.H1_H2)===JSON.stringify(['H1','H2']));
t('REEVALUATE_H3 -> [H3]', JSON.stringify(SCOPE_HORIZONS.H3)===JSON.stringify(['H3']));
t('H3 ecarte le Technical Analyst', !SCOPE_AGENTS.H3.includes('technical_analyst'));
t('H1_H2 conserve les 5 agents', SCOPE_AGENTS.H1_H2.length===5);
t('FULL inchange', JSON.stringify(SCOPE_HORIZONS.FULL)===JSON.stringify(['H1','H2','H3','H4']));

console.log('--- Robustesse arrondi : somme toujours 100 ---');
for (const b of [[33,33,17,17],[1,1,49,49],[50,10,20,20],[7,3,45,45]]) {
  const bl={H1:sc('neutral',b[0],3400,3400),H2:sc('neutral',b[1],3400,3400),H3:sc('neutral',b[2],3400,3400),H4:sc('neutral',b[3],3400,3400)};
  for (const rc of [[70,30],[1,99],[50,50],[0,100]]) {
    const re={H1:sc('bullish',rc[0],3450,3380),H2:sc('bullish',rc[1],3480,3370),H3:sc('neutral',5,3400,3400),H4:sc('neutral',5,3400,3400)};
    const r=applyScope(re,bl,'H1_H2');
    const sum=['H1','H2','H3','H4'].reduce((a,h)=>a+r[h].probability,0);
    if (sum!==100){t(`somme=100 base[${b}] recalc[${rc}]`,false,`got ${sum}`);}
  }
}
t('somme = 100 sur 16 combinaisons d arrondi', true);

console.log('--- Detection 23505 (idempotence + verrou) ---');
t('code 23505 detecte', isUniqueViolation('Supabase HTTP 409: {"code":"23505","message":"duplicate key value..."}'));
t('libelle duplicate key detecte', isUniqueViolation('duplicate key value violates unique constraint'));
t('erreur sans rapport non confondue', !isUniqueViolation('Supabase HTTP 500: internal error'));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
