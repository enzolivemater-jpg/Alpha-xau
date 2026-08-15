import { JSDOM } from '/home/claude/alpha-xau/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'node:fs';
const html=readFileSync('/home/claude/alpha-xau/frontend/index.html','utf8');
const js=readFileSync('/home/claude/alpha-xau/frontend/js/dashboard.js','utf8');
function boot(cfg,fetchImpl){
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://x.github.io/'});
  dom.window.fetch=fetchImpl;
  if(cfg) dom.window.ALPHA_XAU_CONFIG=cfg;
  const s=dom.window.document.createElement('script'); s.textContent=js;
  dom.window.document.body.appendChild(s);
  return dom;
}
const CFG={SUPABASE_URL:'https://t.supabase.co',SUPABASE_ANON_KEY:'a',POLL_INTERVAL_MS:50,ANALYSIS_INTERVAL_MS:1e6,STALE_THRESHOLD_S:60};
let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};

console.log('--- PHASE 8 : API en panne, config VALIDE ---');
let dom=boot(CFG,()=>Promise.reject(new Error('ECONNREFUSED')));
await new Promise(r=>setTimeout(r,400));
let d=dom.window.document, T=id=>(d.getElementById(id)||{}).textContent;
t('AUCUN mode demo silencieux', d.getElementById('demo-flag').hasAttribute('hidden'));
t('bandeau incident affiche', !d.getElementById('error-banner').hasAttribute('hidden'));
t('fraicheur = FLUX ROMPU (pas LIVE)', T('price-freshness')==='FLUX ROMPU', T('price-freshness'));
t('aucun prix invente', T('spot-price')==='----.--', T('spot-price'));
t('aucun verdict optimiste', T('risk-verdict')!=='APPROUVÉ', T('risk-verdict'));

console.log('--- Mode demo : uniquement si config VIDE, et signale ---');
dom=boot(null,()=>Promise.reject(new Error('x')));
await new Promise(r=>setTimeout(r,300)); d=dom.window.document;
t('mode demo explicitement affiche', !d.getElementById('demo-flag').hasAttribute('hidden'));
t('libelle MODE DÉMO visible', /MODE DÉMO/.test(d.getElementById('demo-flag').textContent));

console.log('--- HTTP 500 backend ---');
dom=boot(CFG,()=>Promise.resolve({ok:false,status:500,json:()=>Promise.resolve({})}));
await new Promise(r=>setTimeout(r,400)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('500 -> incident, pas de donnee inventee', !d.getElementById('error-banner').hasAttribute('hidden') && T('spot-price')==='----.--');

console.log('--- PHASE 9 : donnee STALE ---');
const stale=[{symbol:'XAUUSD',bid:3401,ask:3402,spread:1,close:3401.5,dxy_value:null,us10y_yield:null,real_yield:null,vix:null,wti:null,ts:new Date(Date.now()-3600e3).toISOString(),staleness_seconds:3600}];
dom=boot(CFG,(u)=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(String(u).includes('v_market_latest')?stale:[])}));
await new Promise(r=>setTimeout(r,400)); d=dom.window.document; T=id=>(d.getElementById(id)||{}).textContent;
t('badge STALE affiche', /STALE/.test(T('price-freshness')), T('price-freshness'));
t('prix affiche mais marque perime', T('spot-price')==='3401.50' && /STALE/.test(T('price-freshness')));

console.log('--- PHASE 9 : pas de listeners multiples ni de timers cumules ---');
let calls=0;
dom=boot(CFG,(u)=>{calls++;return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve([])});});
await new Promise(r=>setTimeout(r,500));
const c1=calls;
dom.window.dispatchEvent(new dom.window.Event('online'));
dom.window.dispatchEvent(new dom.window.Event('online'));
dom.window.dispatchEvent(new dom.window.Event('online'));
await new Promise(r=>setTimeout(r,500));
const rate1=c1/500, rate2=(calls-c1)/500;
t('3 reconnexions ne multiplient pas la cadence', rate2 < rate1*3, `avant=${rate1.toFixed(2)}/ms apres=${rate2.toFixed(2)}/ms`);
console.log(`     (appels avant=${c1}, apres 3 evenements online=${calls-c1})`);

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
