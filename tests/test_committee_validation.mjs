import { __internals } from './committee_orchestrator.mjs';
import Ajv from '/home/claude/alpha-xau/node_modules/ajv/dist/2020.js';
import addFormats from '/home/claude/alpha-xau/node_modules/ajv-formats/dist/index.js';
import { readFileSync } from 'node:fs';

const { validateScenario, validateCommitteeOutput, normalizeProbabilities,
        riskReward, buildNoValidSetup, asUnitConfidence } = __internals;

let pass=0, fail=0;
const t=(n,c,x='')=>{ if(c){pass++;console.log(`  OK  ${n}`);} else {fail++;console.log(`  FAIL ${n} ${x}`);} };
const SPOT = 3400;
const R = 'Justification suffisamment longue pour passer le seuil de validation.';

console.log('--- RÈGLE ABSOLUE : les 3 éléments obligatoires ---');
let r = validateScenario('H1', { direction:'bullish', probability:40, target:3450, invalidation:3380, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('scénario complet accepté', r.scenario !== null, JSON.stringify(r.errors));

r = validateScenario('H1', { direction:'bullish', probability:40, target:3450, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('invalidation absente -> rejet', r.scenario===null && r.errors.some(e=>e.includes('invalidation')));

r = validateScenario('H1', { direction:'bullish', probability:40, target:3450, invalidation:'si le contexte se dégrade', confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('invalidation textuelle -> rejet', r.scenario===null && r.errors.some(e=>e.includes('non numérique')));

r = validateScenario('H1', { direction:'bullish', probability:40, target:3450, invalidation:0, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('invalidation = 0 -> rejet', r.scenario===null);

r = validateScenario('H1', { direction:'bullish', probability:40, target:3450, invalidation:3380, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:'trop court' }, SPOT);
t('justification insuffisante -> rejet', r.scenario===null && r.errors.some(e=>e.includes('justification')));

r = validateScenario('H1', { direction:'bullish', target:3450, invalidation:3380, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('probabilité absente -> rejet', r.scenario===null && r.errors.some(e=>e.includes('probabilité')));

console.log('--- Géométrie (miroir contrainte SQL) ---');
r = validateScenario('H1', { direction:'bullish', probability:40, target:3350, invalidation:3450, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('bullish avec target < invalidation -> rejet', r.scenario===null && r.errors.some(e=>e.includes('Géométrie')));
r = validateScenario('H1', { direction:'bearish', probability:40, target:3450, invalidation:3350, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('bearish avec target > invalidation -> rejet', r.scenario===null && r.errors.some(e=>e.includes('Géométrie')));

console.log('--- Risk / Reward ---');
t('RR calculé', Math.abs(riskReward(3400,3450,3380) - 2.5) < 0.001, String(riskReward(3400,3450,3380)));
t('RR incalculable si invalidation=spot', riskReward(3400,3450,3400) === null);
r = validateScenario('H1', { direction:'bullish', probability:40, target:3410, invalidation:3380, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('RR 0.5 < 1.0 -> rejet', r.scenario===null && r.errors.some(e=>e.includes('risk/reward')), JSON.stringify(r.errors));
r = validateScenario('H1', { direction:'neutral', probability:40, target:3400, invalidation:3400, confidence:70, activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',reasoning:R }, SPOT);
t('neutral exempté du RR mais garde invalidation', r.scenario!==null);

console.log('--- Normalisation des probabilités ---');
const mk=(p)=>({direction:'neutral',probability:p,target:3400,invalidation:3400,activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',confidence:50,reasoning:R});
for (const input of [[33,33,33,33],[40,30,20,10],[1,1,1,1],[70,20,5,5],[0,0,0,0],[99,1,0,0]]) {
  const n = normalizeProbabilities({H1:mk(input[0]),H2:mk(input[1]),H3:mk(input[2]),H4:mk(input[3])});
  const sum = ['H1','H2','H3','H4'].reduce((s,h)=>s+n[h].probability,0);
  t(`somme = 100 pour [${input}]`, sum===100, `got ${sum}`);
}

console.log('--- Validation complète ---');
const goodPM = { market_regime:'risk_off', overall_bias:'bullish', confidence:72, scenarios:{
  H1:{direction:'bullish',probability:35,target:3450,invalidation:3380,activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',confidence:70,reasoning:R},
  H2:{direction:'bullish',probability:30,target:3480,invalidation:3370,activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',confidence:65,reasoning:R},
  H3:{direction:'neutral',probability:20,target:3400,invalidation:3400,activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',confidence:50,reasoning:R},
  H4:{direction:'bearish',probability:16,target:3300,invalidation:3500,activation_condition:'Clôture H1 au-dessus de 3412.50 avec expansion ATR.',confidence:45,reasoning:R}},
  drivers:['Real yield decline'], risks:['Fed hawkish surprise'], invalidations:['Perte de 3380'] };
let v = validateCommitteeOutput(goodPM, SPOT);
t('PM valide accepté', v.valid, JSON.stringify(v.errors));
t('probabilités renormalisées à 100', v.valid && ['H1','H2','H3','H4'].reduce((s,h)=>s+v.scenarios[h].probability,0)===100);

const badPM = structuredClone(goodPM); delete badPM.scenarios.H3.invalidation;
v = validateCommitteeOutput(badPM, SPOT);
t('un scénario invalide -> analyse entière invalide', !v.valid && v.scenarios===null);

const missing = structuredClone(goodPM); delete missing.scenarios.H4;
v = validateCommitteeOutput(missing, SPOT);
t('horizon manquant -> rejet', !v.valid && v.errors.some(e=>e.includes('H4')));

console.log('--- Coercition confiance ---');
t('0.72 -> 0.72', asUnitConfidence(0.72)===0.72);
t('72 -> 0.72', Math.abs(asUnitConfidence(72)-0.72)<1e-9);
t('valeur absurde bornée', asUnitConfidence(500)===1 && asUnitConfidence(-5)===0);

console.log('--- Validation JSON Schema (ajv) ---');
const schema = JSON.parse(readFileSync('/home/claude/alpha-xau/backend/ai_engine/schema/committee_output.schema.json','utf8'));
const ajv = new Ajv.default({ strict:true, allErrors:true });
addFormats.default(ajv);
const validate = ajv.compile(schema);
t('schéma lui-même compilable (strict)', typeof validate === 'function');

const full = { ...goodPM, scenarios: v0(), meta:{ analysis_id:'11111111-1111-4111-8111-111111111111',
  model_version:'ai-committee-1.0.0', execution_status:'VALID_SETUP', risk_verdict:'APPROVED',
  confidence_cap:0.9, spot_reference:3400, data_quality_issues:[], validation_errors:[],
  agents:{macro_analyst:{model:'claude-sonnet-5',latency_ms:1200}},
  generated_at:new Date().toISOString(), total_latency_ms:8000 } };
function v0(){ return validateCommitteeOutput(goodPM, SPOT).scenarios; }
t('sortie complète conforme au schéma', validate(full), JSON.stringify(validate.errors));

const noInval = structuredClone(full); noInval.scenarios.H1.invalidation = null;
t('schéma rejette invalidation null', !validate(noInval));
const strInval = structuredClone(full); strInval.scenarios.H1.invalidation = 'si ça se dégrade';
t('schéma rejette invalidation textuelle', !validate(strInval));
const shortR = structuredClone(full); shortR.scenarios.H1.reasoning = 'court';
t('schéma rejette justification courte', !validate(shortR));

console.log('--- NO_VALID_SETUP ---');
const nvs = buildNoValidSetup(SPOT, ['Contradiction non résolue'], {});
t('NO_VALID_SETUP conforme au schéma', validate(nvs), JSON.stringify(validate.errors));
t('bias forcé neutral + confiance 0', nvs.overall_bias==='neutral' && nvs.confidence===0);
t('4 scénarios présents malgré le rejet', Object.keys(nvs.scenarios).length===4);
t('somme probabilités = 100', ['H1','H2','H3','H4'].reduce((s,h)=>s+nvs.scenarios[h].probability,0)===100);

// ===================== AJOUTS P1-3 / P1-4 =====================
console.log('--- P1-4 : activation_condition obligatoire ---');
const A='Clôture H1 au-dessus de 3412.50 avec expansion ATR.';
const base={direction:'bullish',probability:40,target:3450,invalidation:3380,confidence:70,reasoning:R};
let z=validateScenario('H1',{...base,activation_condition:A},SPOT);
t('avec activation -> accepte', z.scenario!==null);
z=validateScenario('H1',{...base},SPOT);
t('sans activation -> rejet', z.scenario===null && z.errors.some(e=>/activation/.test(e)));
z=validateScenario('H1',{...base,activation_condition:'court'},SPOT);
t('activation trop courte -> rejet', z.scenario===null);
z=validateScenario('H1',{...base,activation_condition:null},SPOT);
t('activation null -> rejet', z.scenario===null);
z=validateScenario('H1',{...base,activation_condition:A},SPOT);
t('activation conservee dans la sortie', z.scenario.activation_condition===A);

console.log('--- P1-3 : verdicts distincts ---');
const { BLOCKING_VERDICTS, isBlockingVerdict } = await import('./committee_orchestrator.mjs');
t('5 verdicts, 3 bloquants', BLOCKING_VERDICTS.length===3);
t('REJECTED bloquant', isBlockingVerdict('REJECTED'));
t('DATA_INSUFFICIENT bloquant ET distinct', isBlockingVerdict('DATA_INSUFFICIENT') && BLOCKING_VERDICTS.includes('DATA_INSUFFICIENT'));
t('CONFLICT bloquant ET distinct', isBlockingVerdict('CONFLICT'));
t('APPROVED non bloquant', !isBlockingVerdict('APPROVED'));
t('APPROVED_WITH_CONDITIONS non bloquant', !isBlockingVerdict('APPROVED_WITH_CONDITIONS'));

console.log('--- P1-2/P1-3 : NO_VALID_SETUP conserve la cause ---');
for (const v of ['REJECTED','DATA_INSUFFICIENT','CONFLICT']) {
  const n=buildNoValidSetup(SPOT,[`motif ${v}`],{},v);
  t(`${v} conserve son verdict (pas replie sur REJECTED)`, n.meta.risk_verdict===v, n.meta.risk_verdict);
  t(`${v} : biais neutre + confiance 0`, n.overall_bias==='neutral' && n.confidence===0);
  t(`${v} : motif non vide (contrainte SQL)`, n.meta.validation_errors.length>0);
  t(`${v} : scenarios portent une activation explicite`,
    ['H1','H2','H3','H4'].every(h=>typeof n.scenarios[h].activation_condition==='string' && n.scenarios[h].activation_condition.length>=15));
}
const nEmpty=buildNoValidSetup(SPOT,[],{},'CONFLICT');
t('blocage sans motif -> motif genere non vide', nEmpty.meta.validation_errors.length>0);

console.log('--- P1-4 : schema JSON exige activation_condition ---');
const full2 = { ...goodPM, scenarios: validateCommitteeOutput(goodPM,SPOT).scenarios, meta:{ analysis_id:null,
  model_version:'t', execution_status:'NO_VALID_SETUP', risk_verdict:'DATA_INSUFFICIENT',
  confidence_cap:0, spot_reference:3400, data_quality_issues:[], validation_errors:['x'],
  agents:{}, generated_at:new Date().toISOString(), total_latency_ms:1 } };
t('DATA_INSUFFICIENT accepte par le schema', validate(full2), JSON.stringify(validate.errors));
const noAct = structuredClone(full2); delete noAct.scenarios.H1.activation_condition;
t('schema rejette un scenario sans activation_condition', !validate(noAct));
const shortAct = structuredClone(full2); shortAct.scenarios.H1.activation_condition='court';
t('schema rejette une activation trop courte', !validate(shortAct));
const badVerdict = structuredClone(full2); badVerdict.meta.risk_verdict='UNKNOWN';
t('schema rejette un verdict hors enum', !validate(badVerdict));

console.log(`\nFINAL: ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
