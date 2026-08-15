import { execFileSync } from 'node:child_process';
const psql=(db,sql)=>execFileSync('su',['postgres','-c',
  `/usr/lib/postgresql/16/bin/psql -h /tmp -p 5433 -d ${db} -tAc ${JSON.stringify(sql)}`],{encoding:'utf8'}).trim();

// Réimplémentation littérale des poids de backend/news_engine/ingest.ts
const W={macro:0.30,volatility:0.20,reliability:0.15,surprise:0.20,duration:0.15};
const round2=x=>Math.round(x*100)/100;
const tsScore=(m,v,r,s,d)=>round2(m*W.macro+v*W.volatility+r*W.reliability+s*W.surprise+d*W.duration);
const cls=x=>x>=80?'critical':x>=60?'major':'noise';

let p=0,f=0; const t=(n,c,x='')=>{c?(p++,console.log(`  OK  ${n}`)):(f++,console.log(`  FAIL ${n} ${x}`))};

console.log('--- P1-5 : parite TS == SQL(schema.sql seul) == SQL(base migree) ---');
const cases=[[80,60,90,70,50],[100,100,100,100,100],[0,0,0,0,0],[100,90,80,100,70],
 [50,50,50,50,50],[90,85,95,88,60],[12.34,56.78,90.12,34.56,78.9],[99.99,0,0,0,0],
 [0,0,0,100,0],[0,0,100,0,0],[63.2,71.5,48.8,55.1,90.4],[85,85,85,85,85]];
let allMatch=true;
for(const c of cases){
  const ts=tsScore(...c);
  const bare=Number(psql('ax_bare',`SELECT fn_news_score(${c.join(',')});`));
  const migr=Number(psql('alphaxau',`SELECT fn_news_score(${c.join(',')});`));
  const ok = Math.abs(ts-bare)<1e-9 && Math.abs(ts-migr)<1e-9;
  if(!ok){allMatch=false;console.log(`  FAIL [${c}] ts=${ts} bare=${bare} migr=${migr}`);}
}
t(`${cases.length} jeux : TS == schema.sql seul == base migree`, allMatch);

console.log('--- Frontieres de classification ---');
for(const [score,expected] of [[59.99,'noise'],[60,'major'],[79.99,'major'],[80,'critical'],[59.995,'noise'],[79.995,'major']]){
  t(`${score} -> ${expected}`, cls(score)===expected, cls(score));
}
// Composantes produisant exactement les frontieres
const at60=[60,60,60,60,60], at80=[80,80,80,80,80];
t('composantes 60 -> score 60 -> major', tsScore(...at60)===60 && cls(tsScore(...at60))==='major');
t('composantes 80 -> score 80 -> critical', tsScore(...at80)===80 && cls(tsScore(...at80))==='critical');
const just=tsScore(79.99,79.99,79.99,79.99,79.99);
t('composantes 79.99 -> reste major (aucun arrondi vers critical)', just===79.99 && cls(just)==='major', String(just));

console.log('--- Ordre des parametres : fiabilite(0.15) != surprise(0.20) ---');
const a=tsScore(0,0,100,0,0), b=tsScore(0,0,0,100,0);
t('fiabilite=100 donne 15, surprise=100 donne 20', a===15 && b===20, `${a}/${b}`);
const sqlA=Number(psql('alphaxau','SELECT fn_news_score(0,0,100,0,0);'));
const sqlB=Number(psql('alphaxau','SELECT fn_news_score(0,0,0,100,0);'));
t('SQL respecte le meme ordre', sqlA===15 && sqlB===20, `${sqlA}/${sqlB}`);
t('inverser les deux CHANGERAIT le score (defaut reel corrige)', a!==b);

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f?1:0);
