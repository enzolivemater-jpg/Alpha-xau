// Test statique déterministe : preuve par lecture de source que
// backend/ingest.ts câble correctement l'adaptateur Treasury RAW dans la
// barrière de cycle de vie à six tâches (NEWS-OFFICIAL-027). Aucun
// réseau, aucun Supabase, aucune exécution réelle de runIngestion()
// (qui exigerait un Env Cloudflare complet) — uniquement des invariants
// structurels sur le code source, dans le même esprit que les sections
// "LIFECYCLE BARRIER" / "INGEST INTEGRATION STATIC INVARIANTS" déjà
// présentes dans test_federal_reserve_raw_integration.mjs et
// test_ecb_raw_integration.mjs.
import { readFileSync } from 'node:fs';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const source = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');

console.log('--- IMPORT CONTRACT ---');
{
  t('ingest.ts importe ingestTreasuryRaw depuis ./news_sources/us_treasury_raw.js',
    /import\s*\{\s*ingestTreasuryRaw,\s*type\s+TreasuryRawIngestResult\s*\}\s*from\s*['"]\.\/news_sources\/us_treasury_raw\.js['"]/.test(source));
  t('ingest.ts n\'importe PAS directement le collecteur Treasury (./news_sources/us_treasury.js)',
    !/from\s+['"]\.\/news_sources\/us_treasury\.js['"]/.test(source));
}

console.log('--- SHARED officialObservedAt / runId ---');
{
  t('Treasury reçoit ingestRunId: runId',
    /ingestTreasuryRaw\(\{[\s\S]{0,120}?ingestRunId:\s*runId/.test(source));
  t('Treasury reçoit observedAt: officialObservedAt (même variable que Fed/ECB)',
    /ingestTreasuryRaw\(\{[\s\S]{0,160}?observedAt:\s*officialObservedAt/.test(source));
  t('un seul officialObservedAt déclaré (jamais treasuryObservedAt/ofacObservedAt)',
    !/\btreasuryObservedAt\b/.test(source) && !/\bofacObservedAt\b/.test(source));
}

console.log('--- STARTS BEFORE LIFECYCLE BARRIER ---');
{
  const treasuryDeclIdx = source.indexOf('const treasuryRawPromise: Promise<TreasuryRawIngestResult> = ingestTreasuryRaw({');
  const allSettledIdx = source.indexOf('await Promise.allSettled([');
  t('treasuryRawPromise déclaré', treasuryDeclIdx !== -1);
  t('treasuryRawPromise démarre avant la barrière allSettled', treasuryDeclIdx !== -1 && allSettledIdx !== -1 && treasuryDeclIdx < allSettledIdx);
  t('treasuryRawPromise porte un .catch() immédiat (pas d\'unhandled rejection)',
    /ingestTreasuryRaw\(\{[\s\S]{0,200}?\}\)\.catch\(/.test(source));
}

console.log('--- FLAT SIX-TASK BARRIER PARTICIPATION ---');
{
  t('treasuryRawPromise est un argument direct du même Promise.allSettled à plat (six tâches)',
    /await Promise\.allSettled\(\[\s*gdeltPromise,\s*newsapiPromise,\s*fedRawPromise,\s*ecbRawPromise,\s*treasuryRawPromise,\s*ofacRawPromise,?\s*\]\)/.test(source));
  t('aucun agrégat imbriqué ne regroupe treasuryRawPromise séparément (pas de Promise.all([...treasuryRawPromise...]))',
    !/Promise\.all\(\s*\[[^\]]*treasuryRawPromise[^\]]*\]\s*\)/.test(source));
}

console.log('--- PROVIDER REPORT KEY ---');
{
  t('providers.us_treasury exposé (clé exacte, jamais "treasury")',
    /us_treasury:\s*\{/.test(source));
  t('aucune clé provider "treasury" (sans préfixe us_) introduite par erreur',
    !/\btreasury:\s*\{/.test(source));
  t('providers.us_treasury.count = treasuryRaw.observations',
    /us_treasury:\s*\{[\s\S]{0,40}?count:\s*treasuryRaw\.observations/.test(source));
  t('providers.us_treasury.rejected = collectorRejected + writerRejected',
    /us_treasury:\s*\{[\s\S]{0,320}?rejected:\s*treasuryRaw\.collectorRejected \+ treasuryRaw\.writerRejected/.test(source));
}

console.log('--- UNHEALTHY => PARTIAL, NOT FAILED ---');
{
  t('allProvidersOk inclut treasuryRaw.ok',
    /allProvidersOk = gdelt\.report\.ok && newsapi\.report\.ok && fedRaw\.ok && ecbRaw\.ok && treasuryRaw\.ok && ofacRaw\.ok/.test(source));
  t('status devient "partial" (pas "failed") sur simple déséquilibre provider',
    /status: errors\.length === 0 && allProvidersOk \? 'success' : 'partial'/.test(source));
  t('un provider Treasury non ok pousse un message run-level (errors.push)',
    /if \(!treasuryRaw\.ok\) errors\.push\(`us_treasury: /.test(source));
}

console.log('--- NO LEGACY COUNTER CONTAMINATION ---');
{
  t('top-level fetched reste calculé uniquement depuis gdelt+newsapi (jamais treasuryRaw)',
    /const fetched = gdelt\.articles\.length \+ newsapi\.articles\.length;/.test(source) && !/fetched[\s\S]{0,40}treasuryRaw/.test(source));
  t('deduplicate() ne référence jamais treasuryRaw',
    !/deduplicate\(\[[^\]]*treasuryRaw/.test(source));
  t('persisted/critical/major ne référencent jamais treasuryRaw',
    !/\b(persisted|critical|major)\b[^;\n]{0,60}treasuryRaw/.test(source));
}

console.log('--- NO SCORING / NEWS_EVENTS CROSSOVER ---');
{
  t('scoreArticle() ne référence jamais treasuryRaw',
    !/scoreArticle\([^)]*treasuryRaw/.test(source));
  t('aucune observation Treasury ne transite par toRow()/insertNews() (littéraux news_events réservés au legacy)',
    !/toRow\([^)]*treasuryRaw/.test(source) && !/insertNews\([^)]*treasuryRaw/.test(source));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
