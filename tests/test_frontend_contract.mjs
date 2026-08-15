import { JSDOM } from '/home/claude/alpha-xau/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const psql=s=>execFileSync('su',['postgres','-c',`/usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -d alphaxau -tAc ${JSON.stringify(s)}`],{encoding:'utf8'}).trim();

const html=readFileSync('/home/claude/alpha-xau/frontend/index.html','utf8');
let js=readFileSync('/home/claude/alpha-xau/frontend/js/dashboard.js','utf8');
js=js.replace('})();','window.__t={renderAnalysis,renderScenarios,renderNoAnalysis,refreshAnalysis};\n})();');

function boot(rows){
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://x.github.io/'});
  // fetch simule PostgREST en renvoyant les VRAIES lignes de la vue
  dom.window.fetch=(u)=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(
    String(u).includes('v_ai_latest')?rows:[])});
  // Config renseignee => mode connecte, pas mode demo.
  dom.window.ALPHA_XAU_CONFIG={SUPABASE_URL:'https://t.supabase.co',SUPABASE_ANON_KEY:'anon',
    POLL_INTERVAL_MS:100000,ANALYSIS_INTERVAL_MS:100000,STALE_THRESHOLD_S:60};
  const s=dom.window.document.createElement('script'); s.textContent=js;
  dom.window.document.body.appendChild(s);
  return dom;
}
let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};

// ---- On lit la VRAIE vue ----
const viewJson = psql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT id,symbol,model_version,market_regime,regime_confidence,spot_reference,summary,analysis_ts,valid_until,risk_verdict,execution_status,overall_bias,confidence_cap,data_quality,rejection_reasons,drivers,risks,invalidations,scenarios FROM v_ai_latest) t;");
const rows=JSON.parse(viewJson);
console.log('--- Contrat : colonnes reellement exposees par v_ai_latest ---');
const need=['risk_verdict','execution_status','overall_bias','confidence_cap','data_quality','rejection_reasons','drivers','risks','invalidations','scenarios'];
t('les 10 champs du contrat sont exposes', rows.length>0 && need.every(k=>k in rows[0]), rows.length?Object.keys(rows[0]).join(','):'vue vide');
t('scenarios portent activation_condition', rows.length>0 && rows[0].scenarios.H1 && 'activation_condition' in rows[0].scenarios.H1);

// ---- CAS D : CONFLICT (etat courant en base) ----
let dom=boot(rows); await new Promise(r=>setTimeout(r,200));
let d=dom.window.document, T=id=>(d.getElementById(id)||{}).textContent;
console.log(`--- CAS D : verdict courant en base = ${rows[0].risk_verdict} ---`);
t('bandeau de blocage visible', !d.getElementById('no-setup').hasAttribute('hidden'));
t('titre specifique au verdict (pas un rejet generique)', /CONFLIT/.test(T('no-setup-title')), T('no-setup-title'));
t('motif reel affiche', /divergence non reconnue/.test(T('no-setup-reason')), T('no-setup-reason'));
t('statut = NO VALID SETUP', T('execution-status')==='NO VALID SETUP', T('execution-status'));
t('verdict au pied = CONFLIT', T('risk-verdict')==='CONFLIT', T('risk-verdict'));
t('biais neutre', T('ai-bias')==='NEUTRE', T('ai-bias'));

// ---- CAS F/G/E/C + P1-6 : injection directe ----
const base=rows[0];
const mk=(over)=>[{...base,...over}];
const S=(dir,a)=>({direction:dir,probability:0.25,target:3450,invalidation:3380,activation_condition:a,confidence:0.7,reasoning:'Justification suffisamment longue.'});
const goodScen={H1:S('bullish','Cloture H1 au-dessus de 3412.50 avec expansion ATR.'),
 H2:S('bullish','Cassure de 3455 confirmee sur cloture H4.'),
 H3:S('neutral','Maintien dans le range 3370-3455 sur 3 seances.'),
 H4:S('bearish','Taux reels au-dessus de 2.05 pendant 5 seances.')};

console.log('--- P1-6 : overall_bias NEUTRAL alors que H1 est BULLISH ---');
dom=boot(mk({risk_verdict:'APPROVED',execution_status:'VALID_SETUP',overall_bias:'neutral',
  regime_confidence:0.72,scenarios:goodScen,rejection_reasons:[]}));
await new Promise(r=>setTimeout(r,200)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('affiche NEUTRE et non HAUSSIER', T('ai-bias')==='NEUTRE', T('ai-bias'));
t('H1 reste bullish dans l arbre', [...d.querySelectorAll('#scenario-tree .scen')][0].querySelector('[data-field="direction"]').textContent==='HAUSSIER');
t('aucun recalcul cote client', !js.includes('dominantBias'));
t('condition d activation affichee', /3412.50/.test([...d.querySelectorAll('[data-field="activation"]')][0].textContent));
t('4 scenarios affiches', d.querySelectorAll('#scenario-tree .scen').length===4);
t('bandeau masque', d.getElementById('no-setup').hasAttribute('hidden'));

console.log('--- CAS G : APPROVED_WITH_CONDITIONS ---');
dom=boot(mk({risk_verdict:'APPROVED_WITH_CONDITIONS',execution_status:'VALID_SETUP',overall_bias:'bullish',scenarios:goodScen,rejection_reasons:[]}));
await new Promise(r=>setTimeout(r,200)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('verdict conditionnel affiche', T('risk-verdict')==='APPROUVÉ SOUS CONDITIONS', T('risk-verdict'));
t('setup valide', T('execution-status')==='SETUP VALIDE');

console.log('--- CAS C : DATA_INSUFFICIENT distinct de REJECTED ---');
dom=boot(mk({risk_verdict:'DATA_INSUFFICIENT',execution_status:'NO_VALID_SETUP',overall_bias:'neutral',
  rejection_reasons:['Prix XAUUSD perime et DXY indisponible.'],data_quality:['DXY N/A']}));
await new Promise(r=>setTimeout(r,200)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('titre DONNEES INSUFFISANTES', /DONNÉES INSUFFISANTES/.test(T('no-setup-title')), T('no-setup-title'));
t('non confondu avec un rejet', !/REJET/.test(T('no-setup-title')));
t('qualite des donnees remontee', /DXY N\/A/.test(T('no-setup-reason')), T('no-setup-reason'));

console.log('--- Aucun statut optimiste par defaut ---');
dom=boot(mk({risk_verdict:null,execution_status:null,overall_bias:null,rejection_reasons:[]}));
await new Promise(r=>setTimeout(r,200)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('execution_status NULL -> STATUT INCONNU (jamais VALID_SETUP)', T('execution-status')==='STATUT INCONNU', T('execution-status'));
t('risk_verdict NULL -> N/A (jamais APPROVED)', T('risk-verdict')==='N/A', T('risk-verdict'));

console.log('--- Aucune analyse : NO_DATA ---');
dom=boot([]); await new Promise(r=>setTimeout(r,200)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('etat NO_DATA explicite', T('execution-status')==='AUCUNE ANALYSE', T('execution-status'));
t('aucun scenario affiche', d.querySelectorAll('#scenario-tree .scen').length===0);
t('biais N/A', T('ai-bias')==='N/A');

console.log('--- P1-4 : scenario sans condition d activation filtre ---');
const bad={...goodScen,H2:{...goodScen.H2,activation_condition:''},H3:{...goodScen.H3,activation_condition:'court'}};
dom=boot(mk({risk_verdict:'APPROVED',execution_status:'VALID_SETUP',overall_bias:'bullish',scenarios:bad,rejection_reasons:[]}));
await new Promise(r=>setTimeout(r,200)); d=dom.window.document;
const hz=[...d.querySelectorAll('#scenario-tree .scen')].map(s=>s.querySelector('[data-field="horizon"]').textContent);
t('H2/H3 sans activation exploitable -> non affiches', JSON.stringify(hz)===JSON.stringify(['H1','H4']), hz.join(','));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
