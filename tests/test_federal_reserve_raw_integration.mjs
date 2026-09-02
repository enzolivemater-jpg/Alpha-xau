// Import direct des modules TS via le "type stripping" natif de Node 22.6+
// (--experimental-strip-types), même pattern que les autres tests RAW de
// ce repo : aucune dépendance de build ajoutée, aucun fichier .mjs compilé
// tiers, aucun réseau, aucun Supabase.
//
// federal_reserve_raw.ts importe ses dépendances via des spécificateurs
// '.js' (convention du projet, cohérente avec la résolution esbuild/
// wrangler réelle — voir ingest.ts, run_lock.ts, etc.). Le "type
// stripping" natif de Node ne fait PAS cette résolution '.js' -> '.ts'
// sœur (contrairement à un bundler). On enregistre donc un hook de
// résolution minimal, chargé depuis une URL data: (donc SANS créer de
// troisième fichier ni ajouter de dépendance) qui retente uniquement en
// '.ts' quand un spécificateur '.js' échoue à résoudre — ne change RIEN
// au code de production, seulement à la résolution de CE test.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const RESOLVE_JS_TO_TS_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith('.js')) {
      try {
        return await nextResolve(specifier.slice(0, -3) + '.ts', context);
      } catch {}
    }
    throw err;
  }
}
`;
register('data:text/javascript,' + encodeURIComponent(RESOLVE_JS_TO_TS_HOOK));

const { ingestFederalReserveRaw } = await import('../backend/news_sources/federal_reserve_raw.ts');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const MONETARY_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
const SPEECHES_URL = 'https://www.federalreserve.gov/feeds/speeches.xml';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED_AT = '2026-08-25T18:05:00.000Z';

// --- Fixtures RSS (identiques dans l'esprit à test_federal_reserve_collector.mjs) ---
function xmlItem({ title, link, guid, description, pubDate, category = 'Monetary Policy' }) {
  const parts = ['<item>'];
  if (title !== undefined) parts.push(`<title><![CDATA[${title}]]></title>`);
  if (link !== undefined) parts.push(`<link><![CDATA[${link}]]></link>`);
  if (guid !== undefined) parts.push(`<guid><![CDATA[${guid}]]></guid>`);
  if (description !== undefined) parts.push(`<description><![CDATA[${description}]]></description>`);
  parts.push(`<category>${category}</category>`);
  if (pubDate !== undefined) parts.push(`<pubDate><![CDATA[${pubDate}]]></pubDate>`);
  parts.push('</item>');
  return parts.join('\n    ');
}
function xmlFeed(items) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link><![CDATA[https://www.federalreserve.gov/feeds/feeds.htm]]></link>
    <description><![CDATA[test]]></description>
    ${items.join('\n    ')}
  </channel>
</rss>`;
}
function neutralItem(n = 0) {
  return xmlItem({
    title: `Neutral item ${n}`,
    link: `https://www.federalreserve.gov/n${n}`,
    guid: `https://www.federalreserve.gov/n${n}`,
    description: 'neutral',
    pubDate: 'Wed, 29 Jul 2026 18:00:00 GMT',
  });
}

function makeFakeFetch(responseByUrl) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const cfg = responseByUrl[url];
    if (!cfg) throw new Error(`no fake response configured for ${url}`);
    if (cfg.abort) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: cfg.status === undefined ? true : cfg.status >= 200 && cfg.status < 300,
      status: cfg.status ?? 200,
      async text() { return cfg.body ?? ''; },
    };
  };
  fn.calls = calls;
  return fn;
}

// --- Fake RawNewsDb : une stratégie par index d'appel (POST séquentiel). ---
function makeFakeRawDb(strategy) {
  const calls = [];
  return {
    calls,
    async request(method, path, body, extraHeaders) {
      const index = calls.length;
      calls.push({ method, path, body, extraHeaders });
      return strategy(index, { method, path, body, extraHeaders });
    },
  };
}
const alwaysInserted = (index) => [{ id: `generated-id-${index}` }];
const alwaysDuplicate = () => [];
const alwaysThrows = (message) => () => { throw new Error(message); };

async function run(fetchFn, db, opts = {}) {
  return ingestFederalReserveRaw({ db, ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn, ...opts });
}

// -----------------------------------------------------------------------
console.log('--- A. HAPPY PATH ---');
{
  const monetary = xmlFeed([xmlItem({ title: 'M1', link: 'https://www.federalreserve.gov/m1', guid: 'https://www.federalreserve.gov/m1', pubDate: 'Wed, 29 Jul 2026 18:00:00 GMT' }), neutralItem(1)]);
  const speeches = xmlFeed([xmlItem({ title: 'S1', link: 'https://www.federalreserve.gov/s1', guid: 'https://www.federalreserve.gov/s1', pubDate: 'Fri, 28 Aug 2026 14:00:00 GMT', category: 'Speech' })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: speeches } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await run(fakeFetch, db);
  t('3 observations collected', result.observations === 3, JSON.stringify(result));
  t('inserted count correct', result.inserted === 3, JSON.stringify(result));
  t('ok = true', result.ok === true, JSON.stringify(result));
  t('duration_ms present', typeof result.durationMs === 'number');
}

console.log('--- B. DUPLICATES ONLY ---');
{
  const monetary = xmlFeed([neutralItem(1), neutralItem(2)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(3)]) } });
  const db = makeFakeRawDb(alwaysDuplicate);
  const result = await run(fakeFetch, db);
  t('duplicate count = observations', result.duplicates === 3, JSON.stringify(result));
  t('inserted = 0', result.inserted === 0);
  t('ok = true (duplicates are healthy)', result.ok === true, JSON.stringify(result));
}

console.log('--- C. INSERTED + DUPLICATES MIXED ---');
{
  const monetary = xmlFeed([neutralItem(1), neutralItem(2), neutralItem(3), neutralItem(4)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(5)]) } });
  const db = makeFakeRawDb((index) => (index % 2 === 0 ? alwaysInserted(index) : alwaysDuplicate()));
  const result = await run(fakeFetch, db);
  t('5 observations total', result.observations === 5, JSON.stringify(result));
  t('inserted = 3 (indices 0,2,4)', result.inserted === 3, JSON.stringify(result));
  t('duplicates = 2 (indices 1,3)', result.duplicates === 2, JSON.stringify(result));
  t('ok = true', result.ok === true);
}

console.log('--- D. COLLECTOR REJECTED ITEM ---');
{
  const monetary = xmlFeed([
    xmlItem({ title: 'No identity item' }), // rejected by collector: fed_item_identity_missing
    neutralItem(1),
  ]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await run(fakeFetch, db);
  t('collectorRejected > 0', result.collectorRejected === 1, JSON.stringify(result));
  t('ok = false', result.ok === false);
  t('valid items still written (2 inserted)', result.inserted === 2, JSON.stringify(result));
}

console.log('--- E. ONE FEED FAILED ---');
{
  const speeches = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { status: 500, body: 'error' }, [SPEECHES_URL]: { body: speeches } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await run(fakeFetch, db);
  t('successful feed observations still written', result.inserted === 1, JSON.stringify(result));
  t('ok = false', result.ok === false);
  t('feeds report press_monetary failed', result.feeds.find((s) => s.feed === 'press_monetary')?.status === 'failed');
}

console.log('--- F. BOTH FEEDS FAILED ---');
{
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { status: 500, body: 'error' }, [SPEECHES_URL]: { status: 503, body: 'error' } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await run(fakeFetch, db);
  t('zero writes', db.calls.length === 0, JSON.stringify(db.calls));
  t('ok = false', result.ok === false);
  t('observations = 0', result.observations === 0);
}

console.log('--- G. WRITER REJECTED (invalid ingestRunId) ---');
{
  const monetary = xmlFeed([neutralItem(1), neutralItem(2)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([]).length ? xmlFeed([]) : xmlFeed([neutralItem(3)]) } });
  const db = makeFakeRawDb(alwaysInserted);
  // ingestRunId volontairement non-UUID : le collecteur Fed ne valide pas ce
  // champ (il le propage tel quel), seul le writer RAW (raw_news.ts) le
  // rejette -> preuve d'un rejet côté WRITER, pas côté collecteur.
  const result = await ingestFederalReserveRaw({ db, ingestRunId: 'not-a-uuid', observedAt: OBSERVED_AT, fetchFn: fakeFetch });
  t('writerRejected > 0', result.writerRejected > 0, JSON.stringify(result));
  t('ok = false', result.ok === false);
  t('collectorRejected = 0 (rejection is writer-side, not collector-side)', result.collectorRejected === 0, JSON.stringify(result));
  t('no DB write attempted for rejected rows', db.calls.length === 0, JSON.stringify(db.calls));
}

console.log('--- H. DB ERROR ---');
{
  const monetary = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const db = makeFakeRawDb(alwaysThrows('simulated network failure'));
  const result = await run(fakeFetch, db);
  t('databaseErrors = 2', result.databaseErrors === 2, JSON.stringify(result));
  t('ok = false', result.ok === false);
}

console.log('--- I. MULTIPLE DB ERRORS (bounded error list) ---');
{
  const monetary = xmlFeed([neutralItem(1), neutralItem(2), neutralItem(3), neutralItem(4)]);
  const speeches = xmlFeed([neutralItem(5), neutralItem(6), neutralItem(7)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: speeches } });
  const db = makeFakeRawDb(alwaysThrows('simulated network failure'));
  const result = await run(fakeFetch, db);
  t('databaseErrors = 7 (exact count preserved)', result.databaseErrors === 7, JSON.stringify(result.databaseErrors));
  t('errors[] bounded (<=5)', result.errors.length <= 5, JSON.stringify(result.errors));
  t('errors[] nonempty and deterministic shape', result.errors.length > 0 && result.errors[0].startsWith('database_error:'), JSON.stringify(result.errors));
}

console.log('--- J. RUN ID PROPAGATION ---');
{
  const monetary = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const db = makeFakeRawDb(alwaysInserted);
  await run(fakeFetch, db);
  t('every payload carries the exact caller ingestRunId', db.calls.every((c) => c.body[0].ingest_run_id === RUN_ID), JSON.stringify(db.calls.map((c) => c.body[0].ingest_run_id)));
}

console.log('--- K. OBSERVEDAT PROPAGATION ---');
{
  const monetary = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const db = makeFakeRawDb(alwaysInserted);
  await run(fakeFetch, db);
  t('every payload carries the exact caller observedAt', db.calls.every((c) => c.body[0].observed_at === OBSERVED_AT), JSON.stringify(db.calls.map((c) => c.body[0].observed_at)));
}

console.log('--- L. RAW TARGET ONLY ---');
{
  const monetary = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const db = makeFakeRawDb(alwaysInserted);
  await run(fakeFetch, db);
  t('every request targets news_articles', db.calls.every((c) => c.path.startsWith('news_articles?')), JSON.stringify(db.calls.map((c) => c.path)));
  t('never targets news_events', !db.calls.some((c) => c.path.includes('news_events')));
}

console.log('--- M. DUPLICATE IDEMPOTENCE HEADERS (RAW writer contract preserved) ---');
{
  const monetary = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: monetary }, [SPEECHES_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const db = makeFakeRawDb(alwaysInserted);
  await run(fakeFetch, db);
  t('path includes on_conflict=observation_hash', db.calls.every((c) => c.path.includes('on_conflict=observation_hash')), JSON.stringify(db.calls.map((c) => c.path)));
  t('Prefer header exact', db.calls.every((c) => c.extraHeaders?.prefer === 'return=representation,resolution=ignore-duplicates'), JSON.stringify(db.calls.map((c) => c.extraHeaders)));
}

console.log('--- N. NO LEGACY DEPENDENCIES (static) ---');
{
  // On interdit l'USAGE réel (appel de fonction / littéral de table cible /
  // import), pas la simple mention en prose dans le commentaire d'en-tête
  // qui explique précisément les non-buts du module (même principe que
  // test_federal_reserve_collector.mjs).
  const source = readFileSync(new URL('../backend/news_sources/federal_reserve_raw.ts', import.meta.url), 'utf8');
  t('n\'appelle pas SourceRegistry.', !/\bSourceRegistry\./.test(source));
  t('n\'appelle pas scoreArticle(', !/\bscoreArticle\s*\(/.test(source));
  t('n\'appelle pas dispatchActions(', !/\bdispatchActions\s*\(/.test(source));
  t('ne cible pas news_events comme table (littéral quoté)', !/['"`]news_events\b/.test(source));
  t('n\'appelle pas Committee', !/\bCommittee\s*\(/.test(source));
  t('n\'importe pas depuis gdelt/GDELT', !/from\s+['"][^'"]*gdelt/i.test(source));
  t('n\'importe pas depuis newsapi/NewsAPI', !/from\s+['"][^'"]*newsapi/i.test(source));
  t('ne référence pas SupabaseClient', !source.includes('SupabaseClient'));
  t('n\'importe rien depuis ../ingest.js', !/from\s+['"]\.\.\/ingest\.js['"]/.test(source));
}

console.log('--- INGEST INTEGRATION STATIC INVARIANTS ---');
{
  const source = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');
  t('ingest.ts importe/utilise ingestFederalReserveRaw', source.includes('ingestFederalReserveRaw'));
  t('ingestRunId: runId transmis', source.includes('ingestRunId: runId'));
  t('officialObservedAt déclaré une fois avec new Date().toISOString()', source.includes('const officialObservedAt = new Date().toISOString();'));
  t('officialObservedAt transmis à ingestFederalReserveRaw', source.includes('observedAt: officialObservedAt'));
  t('providers.federal_reserve exposé', /federal_reserve:\s*\{/.test(source));
  t('scoreArticle() ne référence pas fedRaw', !/scoreArticle\([^)]*fedRaw/.test(source));
  t('collectGdelt toujours présent (legacy inchangé)', source.includes('function collectGdelt'));
  t('collectNewsApi toujours présent (legacy inchangé)', source.includes('function collectNewsApi'));
  t('allProvidersOk inclut fedRaw.ok', /allProvidersOk = gdelt\.report\.ok && newsapi\.report\.ok && fedRaw\.ok/.test(source));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
