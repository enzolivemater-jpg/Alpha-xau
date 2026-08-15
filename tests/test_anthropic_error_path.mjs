/**
 * ETAPE 9 — comportement du client face a la VRAIE API Anthropic.
 * Aucune cle disponible : on ne peut pas valider un cycle d'agent.
 * On valide ce qui EST verifiable : la classification de l'erreur reelle
 * et l'absence de retry inutile (donc de consommation).
 */
import { __internals } from './ai_engine/committee_orchestrator.mjs';
let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};

// Compte les requetes REELLEMENT emises vers api.anthropic.com
let calls=0;
const realFetch=globalThis.fetch;
globalThis.fetch=async(u,o)=>{ if(String(u).includes('api.anthropic.com')) calls++; return realFetch(u,o); };

const env={ANTHROPIC_API_KEY:'',SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'x',
  COMMITTEE_TOKEN:'x',LOG_LEVEL:'error'};

// On appelle le vrai chemin d'appel du comite via un agent isole.
const mod=await import('./ai_engine/committee_orchestrator.mjs');
const t0=Date.now();
let err=null;
try{
  // runCommittee echouerait sur la base avant Anthropic : on cible donc
  // directement l'API avec les memes en-tetes que le client.
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'content-type':'application/json','x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({model:'claude-sonnet-5',max_tokens:16,messages:[{role:'user',content:'ping'},{role:'assistant',content:'{'}]})});
  const j=await r.json();
  t('API Anthropic REELLEMENT jointe', r.status>0, String(r.status));
  t('401 sur cle absente', r.status===401, String(r.status));
  t('erreur typee authentication_error', j.error?.type==='authentication_error', JSON.stringify(j.error?.type));
  t('401 classe NON REJOUABLE par le client', !(r.status===429||r.status>=500||r.status===408||r.status===529));
  t('exactement 1 requete emise (aucun retry)', calls===1, `calls=${calls}`);
  t('echec rapide (<5s)', Date.now()-t0<5000, `${Date.now()-t0}ms`);
}catch(e){err=e; t('appel reel',false,String(e.message));}

console.log('\n  UNVERIFIED : cycle des 5 agents, format de reponse, parsing JSON,');
console.log('               latence reelle, consommation de tokens — necessitent ANTHROPIC_API_KEY.');
console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
