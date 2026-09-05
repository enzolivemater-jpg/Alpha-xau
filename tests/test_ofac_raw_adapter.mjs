// Import direct des modules TS via le "type stripping" natif de Node 22.6+
// (--experimental-strip-types), même pattern que
// tests/test_us_treasury_raw_adapter.mjs : aucune dépendance de build
// ajoutée, aucun fichier .mjs compilé tiers, aucun réseau, aucun
// Supabase.
//
// ofac_raw.ts importe ses dépendances via des spécificateurs '.js'
// (convention du projet). Le "type stripping" natif de Node ne fait PAS
// la résolution '.js' -> '.ts' sœur (contrairement à un bundler). On
// enregistre donc le même hook de résolution minimal, chargé depuis une
// URL data: (SANS créer de troisième fichier ni ajouter de dépendance) —
// ne change RIEN au code de production, seulement à la résolution de CE
// test.
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

const { ingestOfacRaw } = await import('../backend/news_sources/ofac_raw.ts');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const LISTING_URL = 'https://ofac.treasury.gov/recent-actions';
const RUN_ID = '88888888-8888-4888-8888-888888888888';
const OBSERVED_AT = '2026-09-05T18:00:00.000Z';

// --- Fixtures HTML, calquées sur la structure OFAC réellement observée ---
function titleAnchor(href, title) {
  if (href === null && title === null) return '';
  const hrefAttr = href === null ? '' : ` href="${href}"`;
  const titleHtml = title === null ? '' : title;
  return `<div><div class="font-sans-lg margin-bottom-05 margin-top-1 text-no-underline"><a${hrefAttr} hreflang="en">${titleHtml}</a></div></div>`;
}
function metadataBlock(date, categoryHref, categoryLabel) {
  const dateText = date === null ? '' : `${date} -   \n`;
  const catAnchor = (categoryHref === null && categoryLabel === null)
    ? ''
    : `<a href="${categoryHref === null ? '' : categoryHref}">${categoryLabel === null ? '' : categoryLabel}</a>`;
  return `<div><div class="margin-top-1 font-sans-2xs line-height-sans-3 margin-bottom-1">${dateText}${catAnchor}</div></div>`;
}
function itemBlock({
  href = '/recent-actions/20260904',
  title = 'Sample OFAC Title',
  date = 'September 04, 2026',
  categoryHref = '/recent-actions/sanctions-list-updates',
  categoryLabel = 'Sanctions List Updates',
} = {}) {
  return `<div class="margin-bottom-4 search-result views-row">${titleAnchor(href, title)}${metadataBlock(date, categoryHref, categoryLabel)}</div>`;
}
function page(itemsHtml) {
  return `<!doctype html><html><body><div class="view-content">${itemsHtml.join('')}</div></body></html>`;
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

async function run(html, db, opts = {}) {
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body: html } });
  return ingestOfacRaw({ db, ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn, ...opts });
}

// -----------------------------------------------------------------------
console.log('--- A. VALID COLLECTOR OUTPUT -> INSERTED ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Item One' })]);
  const db = makeFakeRawDb(alwaysInserted);
  const result = await run(html, db);
  t('1 observation collected', result.observations === 1, JSON.stringify(result));
  t('inserted = 1', result.inserted === 1, JSON.stringify(result));
  t('ok = true', result.ok === true, JSON.stringify(result));
}

console.log('--- B. DUPLICATE WRITE -> DUPLICATE COUNT, OK STAYS TRUE ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Item One' })]);
  const db = makeFakeRawDb(alwaysDuplicate);
  const result = await run(html, db);
  t('duplicates = 1', result.duplicates === 1, JSON.stringify(result));
  t('inserted = 0', result.inserted === 0);
  t('ok = true (duplicates are healthy)', result.ok === true, JSON.stringify(result));
}

console.log('--- C. MULTIPLE OBSERVATIONS: INSERTED/DUPLICATE AGGREGATION ---');
{
  const html = page([
    itemBlock({ href: '/recent-actions/20260904', title: 'Item 1' }),
    itemBlock({ href: '/recent-actions/20260903', title: 'Item 2' }),
    itemBlock({ href: '/recent-actions/20260902', title: 'Item 3' }),
    itemBlock({ href: '/recent-actions/20260828', title: 'Item 4' }),
  ]);
  const db = makeFakeRawDb((index) => (index % 2 === 0 ? alwaysInserted(index) : alwaysDuplicate()));
  const result = await run(html, db);
  t('4 observations total', result.observations === 4, JSON.stringify(result));
  t('inserted = 2 (indices 0,2)', result.inserted === 2, JSON.stringify(result));
  t('duplicates = 2 (indices 1,3)', result.duplicates === 2, JSON.stringify(result));
  t('ok = true', result.ok === true);
}

console.log('--- D. COLLECTOR REJECTED SIBLING: VALID WRITES, ok=false ---');
{
  const html = page([
    itemBlock({ title: '' }), // rejected by collector: ofac_item_title_missing
    itemBlock({ href: '/recent-actions/20260903', title: 'Valid Sibling' }),
  ]);
  const db = makeFakeRawDb(alwaysInserted);
  const result = await run(html, db);
  t('collectorRejected = 1', result.collectorRejected === 1, JSON.stringify(result));
  t('valid sibling still written (1 inserted)', result.inserted === 1, JSON.stringify(result));
  t('ok = false', result.ok === false);
}

console.log('--- E. WRITER REJECTION: writerRejected COUNT, ok=false ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Item One' })]);
  const db = makeFakeRawDb(alwaysInserted);
  // ingestRunId volontairement non-UUID : le collecteur OFAC ne valide
  // pas ce champ, seul le writer RAW le rejette -> preuve d'un rejet
  // côté WRITER, pas côté collecteur.
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body: html } });
  const result = await ingestOfacRaw({ db, ingestRunId: 'not-a-uuid', observedAt: OBSERVED_AT, fetchFn });
  t('writerRejected > 0', result.writerRejected > 0, JSON.stringify(result));
  t('ok = false', result.ok === false);
  t('collectorRejected = 0 (rejection is writer-side)', result.collectorRejected === 0, JSON.stringify(result));
}

console.log('--- F. DATABASE ERROR: databaseErrors COUNT, ok=false ---');
{
  const html = page([
    itemBlock({ href: '/recent-actions/20260904', title: 'Item 1' }),
    itemBlock({ href: '/recent-actions/20260903', title: 'Item 2' }),
  ]);
  const db = makeFakeRawDb(alwaysThrows('simulated network failure'));
  const result = await run(html, db);
  t('databaseErrors = 2', result.databaseErrors === 2, JSON.stringify(result));
  t('ok = false', result.ok === false);
}

console.log('--- G. PAGE HTTP FAILURE: page.status=failed, observations=0, ok=false ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { status: 500, body: 'error' } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await ingestOfacRaw({ db, ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page.status = failed', result.page.status === 'failed', JSON.stringify(result.page));
  t('observations = 0', result.observations === 0);
  t('ok = false', result.ok === false);
  t('zero DB writes attempted', db.calls.length === 0, JSON.stringify(db.calls));
}

console.log('--- G2. PAGE-LEVEL GLOBALLY UNBALANCED HTML -> ok=false, zero writes ---');
{
  // Document globalement non balancé (fermeture propre du résultat
  // manquante) : le collecteur OFAC échoue closed au niveau page —
  // aucune observation n'est jamais produite ni écrite, la catégorie/
  // date restent entièrement possédées par le collecteur (l'adaptateur
  // ne réinterprète rien).
  const unbalancedHtml =
    '<!doctype html><html><body><div class="view-content"><div class="search-result views-row">' +
    titleAnchor('/recent-actions/20260905', 'Unbalanced Item') +
    metadataBlock('September 05, 2026', '/recent-actions/general-licenses', 'General Licenses') +
    // OMIS : la fermeture propre du résultat.
    '</div>' + // absorbée par la pile pour le search-result, laissant view-content non fermé.
    '<p>Trailing content</p></body></html>';
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body: unbalancedHtml } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await ingestOfacRaw({ db, ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page.status = failed', result.page.status === 'failed', JSON.stringify(result.page));
  t('observations = 0', result.observations === 0);
  t('ok = false', result.ok === false);
  t('zero DB writes attempted (no observations written when OFAC fails closed)', db.calls.length === 0, JSON.stringify(db.calls));
}

console.log('--- H. EXACT ingestRunId FORWARDED THROUGH COLLECTOR/WRITER ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Item One' })]);
  const db = makeFakeRawDb(alwaysInserted);
  await run(html, db);
  t('every payload carries the exact caller ingestRunId', db.calls.every((c) => c.body[0].ingest_run_id === RUN_ID), JSON.stringify(db.calls.map((c) => c.body[0].ingest_run_id)));
}

console.log('--- I. EXACT observedAt FORWARDED UNCHANGED ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Item One' })]);
  const db = makeFakeRawDb(alwaysInserted);
  await run(html, db);
  t('every payload carries the exact caller observedAt', db.calls.every((c) => c.body[0].observed_at === OBSERVED_AT), JSON.stringify(db.calls.map((c) => c.body[0].observed_at)));
}

console.log('--- J. fetchFn INJECTION WORKS ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Injected Fetch Item' })]);
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body: html } });
  const db = makeFakeRawDb(alwaysInserted);
  const result = await ingestOfacRaw({ db, ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('injected fetchFn was actually used', fetchFn.calls.length === 1 && fetchFn.calls[0] === LISTING_URL, JSON.stringify(fetchFn.calls));
  t('observation reflects injected fixture', result.observations === 1 && result.inserted === 1);
}

console.log('--- K. ERRORS BOUNDED <= 5 ---');
{
  const html = page([
    itemBlock({ href: '/recent-actions/20260904', title: 'Item 1' }),
    itemBlock({ href: '/recent-actions/20260903', title: 'Item 2' }),
    itemBlock({ href: '/recent-actions/20260902', title: 'Item 3' }),
    itemBlock({ href: '/recent-actions/20260828', title: 'Item 4' }),
    itemBlock({ href: '/recent-actions/20260827', title: 'Item 5' }),
    itemBlock({ href: '/recent-actions/20260826', title: 'Item 6' }),
    itemBlock({ href: '/recent-actions/20260824', title: 'Item 7' }),
  ]);
  const db = makeFakeRawDb(alwaysThrows('simulated network failure'));
  const result = await run(html, db);
  t('databaseErrors = 7 (exact count preserved)', result.databaseErrors === 7, JSON.stringify(result.databaseErrors));
  t('errors[] bounded (<=5)', result.errors.length <= 5, JSON.stringify(result.errors));
  t('errors[] deterministic shape', result.errors.length > 0 && result.errors[0].startsWith('database_error:'), JSON.stringify(result.errors));
}

console.log('--- CATEGORY/DATE OWNERSHIP: adapter never reinterprets OFAC fields ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904', title: 'Ownership Item', date: 'September 04, 2026', categoryLabel: 'Enforcement Actions' })]);
  const db = makeFakeRawDb(alwaysInserted);
  await run(html, db);
  const payload = db.calls[0].body[0];
  t('providerCategory passed through unchanged from collector', payload.provider_category === 'Enforcement Actions', payload.provider_category);
  t('provider_published_raw passed through unchanged from collector', payload.provider_published_raw === 'September 04, 2026', payload.provider_published_raw);
}

console.log('--- L. NO news_events / NO LEGACY DEPENDENCIES (static) ---');
{
  const source = readFileSync(new URL('../backend/news_sources/ofac_raw.ts', import.meta.url), 'utf8');
  t('ne cible pas news_events comme table (littéral quoté)', !/['"`]news_events\b/.test(source));
  t('n\'appelle pas scoreArticle(', !/\bscoreArticle\s*\(/.test(source));
  t('n\'appelle pas dispatchActions(', !/\bdispatchActions\s*\(/.test(source));
  t('n\'appelle pas SourceRegistry.', !/\bSourceRegistry\./.test(source));
  t('n\'appelle pas Committee(', !/\bCommittee\s*\(/.test(source));
  t('ne référence pas Anthropic', !/\bAnthropic\b/.test(source));
  t('ne calcule pas observation_hash (littéral quoté)', !/['"`]observation_hash\b/.test(source));
}

console.log('--- M. NO ingest.ts / SourceRegistry / scoring / AI / Committee / Event Cluster IMPORT (static) ---');
{
  const source = readFileSync(new URL('../backend/news_sources/ofac_raw.ts', import.meta.url), 'utf8');
  t('n\'importe rien depuis ../ingest.js', !/from\s+['"]\.\.\/ingest\.js['"]/.test(source));
  t('n\'importe pas SourceRegistry', !/import[\s\S]{0,80}SourceRegistry/.test(source));
  t('n\'importe pas depuis un module de scoring', !/from\s+['"][^'"]*scoring/i.test(source));
  t('n\'importe rien depuis run_lock (pas de verrou)', !/from\s+['"][^'"]*run_lock/i.test(source));
  t('n\'importe que son propre collecteur et raw_news.js', (() => {
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return specifiers.length > 0 && specifiers.every((s) => s === './ofac.js' || s === '../shared/raw_news.js');
  })());
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
