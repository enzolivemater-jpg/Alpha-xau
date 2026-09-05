// Test statique déterministe : preuve par lecture de source que
// backend/ingest.ts câble correctement l'adaptateur OFAC RAW dans la
// barrière de cycle de vie à six tâches (NEWS-OFFICIAL-027). Même
// philosophie que test_us_treasury_raw_integration.mjs.
import { readFileSync } from 'node:fs';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const source = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');

console.log('--- IMPORT CONTRACT ---');
{
  t('ingest.ts importe ingestOfacRaw depuis ./news_sources/ofac_raw.js',
    /import\s*\{\s*ingestOfacRaw,\s*type\s+OfacRawIngestResult\s*\}\s*from\s*['"]\.\/news_sources\/ofac_raw\.js['"]/.test(source));
  t('ingest.ts n\'importe PAS directement le collecteur OFAC (./news_sources/ofac.js)',
    !/from\s+['"]\.\/news_sources\/ofac\.js['"]/.test(source));
}

console.log('--- SHARED officialObservedAt / runId ---');
{
  t('OFAC reçoit ingestRunId: runId',
    /ingestOfacRaw\(\{[\s\S]{0,120}?ingestRunId:\s*runId/.test(source));
  t('OFAC reçoit observedAt: officialObservedAt (même variable que Fed/ECB/Treasury)',
    /ingestOfacRaw\(\{[\s\S]{0,160}?observedAt:\s*officialObservedAt/.test(source));
  t('un seul officialObservedAt déclaré (jamais treasuryObservedAt/ofacObservedAt)',
    !/\btreasuryObservedAt\b/.test(source) && !/\bofacObservedAt\b/.test(source));
}

console.log('--- STARTS BEFORE LIFECYCLE BARRIER ---');
{
  const ofacDeclIdx = source.indexOf('const ofacRawPromise: Promise<OfacRawIngestResult> = ingestOfacRaw({');
  const allSettledIdx = source.indexOf('await Promise.allSettled([');
  t('ofacRawPromise déclaré', ofacDeclIdx !== -1);
  t('ofacRawPromise démarre avant la barrière allSettled', ofacDeclIdx !== -1 && allSettledIdx !== -1 && ofacDeclIdx < allSettledIdx);
  t('ofacRawPromise porte un .catch() immédiat (pas d\'unhandled rejection)',
    /ingestOfacRaw\(\{[\s\S]{0,200}?\}\)\.catch\(/.test(source));
}

console.log('--- FLAT SIX-TASK BARRIER PARTICIPATION ---');
{
  t('ofacRawPromise est un argument direct du même Promise.allSettled à plat (six tâches)',
    /await Promise\.allSettled\(\[\s*gdeltPromise,\s*newsapiPromise,\s*fedRawPromise,\s*ecbRawPromise,\s*treasuryRawPromise,\s*ofacRawPromise,?\s*\]\)/.test(source));
  t('aucun agrégat imbriqué ne regroupe ofacRawPromise séparément (pas de Promise.all([...ofacRawPromise...]))',
    !/Promise\.all\(\s*\[[^\]]*ofacRawPromise[^\]]*\]\s*\)/.test(source));
}

console.log('--- PROVIDER REPORT KEY ---');
{
  t('providers.ofac exposé (clé exacte)',
    /ofac:\s*\{/.test(source));
  t('providers.ofac.count = ofacRaw.observations',
    /ofac:\s*\{[\s\S]{0,40}?count:\s*ofacRaw\.observations/.test(source));
  t('providers.ofac.rejected = collectorRejected + writerRejected',
    /ofac:\s*\{[\s\S]{0,320}?rejected:\s*ofacRaw\.collectorRejected \+ ofacRaw\.writerRejected/.test(source));
}

console.log('--- UNHEALTHY => PARTIAL, NOT FAILED ---');
{
  t('allProvidersOk inclut ofacRaw.ok',
    /allProvidersOk = gdelt\.report\.ok && newsapi\.report\.ok && fedRaw\.ok && ecbRaw\.ok && treasuryRaw\.ok && ofacRaw\.ok/.test(source));
  t('status devient "partial" (pas "failed") sur simple déséquilibre provider',
    /status: errors\.length === 0 && allProvidersOk \? 'success' : 'partial'/.test(source));
  t('un provider OFAC non ok pousse un message run-level (errors.push)',
    /if \(!ofacRaw\.ok\) errors\.push\(`ofac: /.test(source));
}

console.log('--- NO LEGACY COUNTER CONTAMINATION ---');
{
  t('top-level fetched reste calculé uniquement depuis gdelt+newsapi (jamais ofacRaw)',
    /const fetched = gdelt\.articles\.length \+ newsapi\.articles\.length;/.test(source) && !/fetched[\s\S]{0,40}ofacRaw/.test(source));
  t('deduplicate() ne référence jamais ofacRaw',
    !/deduplicate\(\[[^\]]*ofacRaw/.test(source));
  t('persisted/critical/major ne référencent jamais ofacRaw',
    !/\b(persisted|critical|major)\b[^;\n]{0,60}ofacRaw/.test(source));
}

console.log('--- NO SCORING / NEWS_EVENTS CROSSOVER ---');
{
  t('scoreArticle() ne référence jamais ofacRaw',
    !/scoreArticle\([^)]*ofacRaw/.test(source));
  t('aucune observation OFAC ne transite par toRow()/insertNews()',
    !/toRow\([^)]*ofacRaw/.test(source) && !/insertNews\([^)]*ofacRaw/.test(source));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
