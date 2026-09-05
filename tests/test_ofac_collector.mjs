import { readFileSync } from 'node:fs';
import { collectOfacNews } from '../backend/news_sources/ofac.ts';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const LISTING_URL = 'https://ofac.treasury.gov/recent-actions';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const OBSERVED_AT = '2026-09-05T12:00:00.000Z';

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
  classAttr = 'margin-bottom-4 search-result views-row',
  href = '/recent-actions/20260904',
  title = 'Sample OFAC Title',
  date = 'September 04, 2026',
  categoryHref = '/recent-actions/sanctions-list-updates',
  categoryLabel = 'Sanctions List Updates',
} = {}) {
  return `<div class="${classAttr}">${titleAnchor(href, title)}${metadataBlock(date, categoryHref, categoryLabel)}</div>`;
}
function page(itemsHtml) {
  return `<!doctype html><html><body><div class="view-content">${itemsHtml.join('')}</div></body></html>`;
}
function pageWithNoItems() {
  return `<!doctype html><html><body><div class="view-content"></div></body></html>`;
}
function unrelatedPage() {
  return `<!doctype html><html><body><h1>Page not found</h1></body></html>`;
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

async function run(body, opts = {}) {
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body } });
  return collectOfacNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn, ...opts });
}

// -----------------------------------------------------------------------
console.log('--- A. MULTIPLE VALID ITEMS ---');
{
  const html = page([
    itemBlock({ href: '/recent-actions/20260904', title: 'First Action', date: 'September 04, 2026', categoryLabel: 'Sanctions List Updates' }),
    itemBlock({ href: '/recent-actions/20260902', title: 'Second Action', date: 'September 02, 2026', categoryLabel: 'General Licenses' }),
    itemBlock({ href: '/recent-actions/20260828', title: 'Third Action', date: 'August 28, 2026', categoryLabel: 'Enforcement Actions' }),
  ]);
  const result = await run(html);
  t('3 observations collected', result.observations.length === 3, JSON.stringify(result));
  t('page status ok', result.page.status === 'ok');
  t('page itemsAccepted = 3', result.page.itemsAccepted === 3);
  t('zero rejected', result.rejectedItems.length === 0, JSON.stringify(result.rejectedItems));
}

console.log('--- B. EXACT PROVENANCE CONTRACT ---');
{
  const html = page([itemBlock()]);
  const result = await run(html);
  const obs = result.observations[0];
  t('provider=ofac', obs.provider === 'ofac');
  t('sourceCode=ofac', obs.sourceCode === 'ofac');
  t('sourceDomain=ofac.treasury.gov', obs.sourceDomain === 'ofac.treasury.gov');
  t('summary=null', obs.summary === null);
  t('content=null', obs.content === null);
  t('ingestQualityState=VALID', obs.ingestQualityState === 'VALID');
  t('ingestQualityReasons=[]', Array.isArray(obs.ingestQualityReasons) && obs.ingestQualityReasons.length === 0);
}

console.log('--- C. providerItemId=null ---');
{
  const html = page([itemBlock()]);
  const result = await run(html);
  t('providerItemId is null', result.observations[0].providerItemId === null);
}

console.log('--- D. publicationPrecision=date ---');
{
  const html = page([itemBlock()]);
  const result = await run(html);
  t('publicationPrecision=date', result.observations[0].publicationPrecision === 'date');
}

console.log('--- E. EXACT VISIBLE DATE_RAW PASSED THROUGH ---');
{
  const html = page([itemBlock({ date: 'September 04, 2026' })]);
  const result = await run(html);
  t('providerPublishedRaw exact match', result.observations[0].providerPublishedRaw === 'September 04, 2026', result.observations[0].providerPublishedRaw);
}

console.log('--- F. CATEGORY PRESERVED FROM VISIBLE LABEL ---');
{
  const html = page([itemBlock({ categoryLabel: 'General Licenses' })]);
  const result = await run(html);
  t('providerCategory exact match, not lowercased/mapped', result.observations[0].providerCategory === 'General Licenses', result.observations[0].providerCategory);
}

console.log('--- G. RELATIVE DATED-ACTION HREF ACCEPTED/RESOLVED ---');
{
  const html = page([itemBlock({ href: '/recent-actions/20260904' })]);
  const result = await run(html);
  t('resolved to absolute URL', result.observations[0].canonicalUrl === 'https://ofac.treasury.gov/recent-actions/20260904', result.observations[0].canonicalUrl);
}

console.log('--- H. ABSOLUTE DATED-ACTION URL ACCEPTED ---');
{
  const html = page([itemBlock({ href: 'https://ofac.treasury.gov/recent-actions/20260904' })]);
  const result = await run(html);
  t('absolute URL accepted as-is', result.observations[0].canonicalUrl === 'https://ofac.treasury.gov/recent-actions/20260904');
}

console.log('--- I. HTTP REJECTED ---');
{
  const html = page([itemBlock({ href: 'http://ofac.treasury.gov/recent-actions/20260904' })]);
  const result = await run(html);
  t('http rejected as invalid', result.rejectedItems.some((r) => r.reason === 'ofac_item_url_invalid'), JSON.stringify(result.rejectedItems));
}

console.log('--- J. EXTERNAL HOST REJECTED ---');
{
  const html = page([itemBlock({ href: 'https://example.com/recent-actions/20260904' })]);
  const result = await run(html);
  t('rejected as external', result.rejectedItems.some((r) => r.reason === 'ofac_item_url_external'), JSON.stringify(result.rejectedItems));
  t('page failed (zero accepted)', result.page.status === 'failed');
}

console.log('--- K. DECEPTIVE HOSTS REJECTED ---');
{
  const html1 = page([itemBlock({ href: 'https://ofac.treasury.gov.evil.example/recent-actions/20260904' })]);
  const r1 = await run(html1);
  t('ofac.treasury.gov.evil.example rejected as external', r1.rejectedItems.some((r) => r.reason === 'ofac_item_url_external'), JSON.stringify(r1.rejectedItems));

  const html2 = page([itemBlock({ href: 'https://treasury.gov.evil.example/recent-actions/20260904' })]);
  const r2 = await run(html2);
  t('treasury.gov.evil.example rejected as external', r2.rejectedItems.some((r) => r.reason === 'ofac_item_url_external'), JSON.stringify(r2.rejectedItems));
}

console.log('--- L. /recent-actions ROOT REJECTED ---');
{
  const html1 = page([itemBlock({ href: 'https://ofac.treasury.gov/recent-actions/' })]);
  const r1 = await run(html1);
  t('root with trailing slash rejected', r1.rejectedItems.some((r) => r.reason === 'ofac_item_url_wrong_path'), JSON.stringify(r1.rejectedItems));

  const html2 = page([itemBlock({ href: 'https://ofac.treasury.gov/recent-actions' })]);
  const r2 = await run(html2);
  t('root without trailing slash rejected', r2.rejectedItems.some((r) => r.reason === 'ofac_item_url_wrong_path'), JSON.stringify(r2.rejectedItems));
}

console.log('--- M. CATEGORY URL REJECTED AS ITEM URL ---');
{
  const html = page([itemBlock({ href: '/recent-actions/sanctions-list-updates' })]);
  const result = await run(html);
  t('category-style URL rejected as wrong path', result.rejectedItems.some((r) => r.reason === 'ofac_item_url_wrong_path'), JSON.stringify(result.rejectedItems));
}

console.log('--- N. UNRELATED OFAC PATH REJECTED ---');
{
  const html = page([itemBlock({ href: 'https://ofac.treasury.gov/sanctions-programs/some-program' })]);
  const result = await run(html);
  t('unrelated path rejected', result.rejectedItems.some((r) => r.reason === 'ofac_item_url_wrong_path'), JSON.stringify(result.rejectedItems));
}

console.log('--- O. NON-8-DIGIT DATED PATH REJECTED ---');
{
  const html1 = page([itemBlock({ href: '/recent-actions/2026090' })]); // 7 digits
  const r1 = await run(html1);
  t('7-digit path rejected', r1.rejectedItems.some((r) => r.reason === 'ofac_item_url_wrong_path'), JSON.stringify(r1.rejectedItems));

  const html2 = page([itemBlock({ href: '/recent-actions/202609044' })]); // 9 digits
  const r2 = await run(html2);
  t('9-digit path rejected', r2.rejectedItems.some((r) => r.reason === 'ofac_item_url_wrong_path'), JSON.stringify(r2.rejectedItems));
}

console.log('--- P. TITLE MISSING ISOLATED ---');
{
  const html = page([
    itemBlock({ title: '' }),
    itemBlock({ href: '/recent-actions/20260902', title: 'Valid Sibling' }),
  ]);
  const result = await run(html);
  t('missing title rejected', result.rejectedItems.some((r) => r.reason === 'ofac_item_title_missing'), JSON.stringify(result.rejectedItems));
  t('sibling still accepted', result.observations.length === 1 && result.observations[0].title === 'Valid Sibling');
  t('page still ok', result.page.status === 'ok');
}

console.log('--- Q. DATE MISSING ISOLATED ---');
{
  const html = page([
    itemBlock({ date: null }),
    itemBlock({ href: '/recent-actions/20260902', title: 'Valid Sibling 2' }),
  ]);
  const result = await run(html);
  t('missing date rejected', result.rejectedItems.some((r) => r.reason === 'ofac_item_publication_missing'), JSON.stringify(result.rejectedItems));
  t('sibling still accepted', result.observations.length === 1 && result.observations[0].title === 'Valid Sibling 2');
}

console.log('--- R. CATEGORY MISSING ISOLATED ---');
{
  const html = page([
    itemBlock({ categoryHref: null, categoryLabel: null }),
    itemBlock({ href: '/recent-actions/20260902', title: 'Valid Sibling 3' }),
  ]);
  const result = await run(html);
  t('missing category rejected', result.rejectedItems.some((r) => r.reason === 'ofac_item_category_missing'), JSON.stringify(result.rejectedItems));
  t('sibling still accepted', result.observations.length === 1 && result.observations[0].title === 'Valid Sibling 3');
  // Date extraction must succeed independently even though category is absent.
  t('date-missing and category-missing are independent failure modes', !result.rejectedItems.some((r) => r.reason === 'ofac_item_publication_missing'), JSON.stringify(result.rejectedItems));
}

console.log('--- S. ENTITY DECODING EXACTLY ONCE IN TITLE ---');
{
  const html = page([itemBlock({ title: 'Cuba &amp;amp; Russia Designations' })]);
  const result = await run(html);
  t('title decoded exactly once', result.observations[0].title === 'Cuba &amp; Russia Designations', result.observations[0].title);
}

console.log('--- T. ENTITY DECODING EXACTLY ONCE IN CATEGORY ---');
{
  const html = page([itemBlock({ categoryLabel: 'Sanctions &amp;amp; Compliance' })]);
  const result = await run(html);
  t('category decoded exactly once', result.observations[0].providerCategory === 'Sanctions &amp; Compliance', result.observations[0].providerCategory);
}

console.log('--- U. DECIMAL NUMERIC ENTITY DECODING ---');
{
  const html = page([itemBlock({ title: 'Syria&#039;s designation' })]);
  const result = await run(html);
  t('decimal numeric entity decoded in title', result.observations[0].title === "Syria's designation", result.observations[0].title);
}

console.log('--- V. HEX NUMERIC ENTITY DECODING ---');
{
  const html = page([itemBlock({ categoryLabel: 'Caf&#xe9; Sanctions' })]);
  const result = await run(html);
  t('hex numeric entity decoded in category', result.observations[0].providerCategory === 'Café Sanctions', result.observations[0].providerCategory);
}

console.log('--- W. HTTP FAILURE ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { status: 500, body: 'error' } });
  const result = await collectOfacNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page failed', result.page.status === 'failed');
  t('zero observations', result.observations.length === 0);
  t('error message present', result.page.error?.includes('500'), result.page.error);
}

console.log('--- X. ABORTERROR / TIMEOUT ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { abort: true } });
  const result = await collectOfacNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page failed on timeout', result.page.status === 'failed');
  t('timeout message present', result.page.error?.includes('timeout'), result.page.error);
}

console.log('--- Y. EMPTY BODY FAILURE ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body: '' } });
  const result = await collectOfacNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page failed on empty body', result.page.status === 'failed');
  t('empty body message present', result.page.error?.includes('empty'), result.page.error);
}

console.log('--- Z. EXPECTED LISTING WITH ZERO RESULT ITEMS => FAILURE ---');
{
  const result = await run(pageWithNoItems());
  t('page failed', result.page.status === 'failed');
  t('zero result-container message', result.page.error?.includes('zero result-container'), result.page.error);
  t('zero observations', result.observations.length === 0);
}

console.log('--- (bonus) UNRELATED PAGE (missing listing structure entirely) => FAILURE ---');
{
  const result = await run(unrelatedPage());
  t('page failed', result.page.status === 'failed');
  t('missing structure message', result.page.error?.includes('missing expected OFAC listing structure'), result.page.error);
}

console.log('--- AA. ALL ITEMS MALFORMED => FAILURE ---');
{
  const html = page([
    itemBlock({ title: '' }),
    itemBlock({ date: null }),
    itemBlock({ categoryHref: null, categoryLabel: null }),
  ]);
  const result = await run(html);
  t('page failed (zero accepted)', result.page.status === 'failed');
  t('zero observations', result.observations.length === 0);
  t('three rejected items recorded', result.rejectedItems.length === 3, JSON.stringify(result.rejectedItems));
  t('zero accepted message present', result.page.error?.includes('zero accepted observations'), result.page.error);
}

console.log('--- AB. OBSERVEDAT UNCHANGED ---');
{
  const html = page([itemBlock()]);
  const result = await run(html);
  t('observedAt exact match', result.observations[0].observedAt === OBSERVED_AT, result.observations[0].observedAt);
}

console.log('--- AC. MALFORMED-BUT-NONEMPTY DATE STILL EMITTED (no local validation) ---');
{
  const html = page([itemBlock({ date: 'not-a-real-date-at-all' })]);
  const result = await run(html);
  t('malformed date still emitted verbatim', result.observations[0].providerPublishedRaw === 'not-a-real-date-at-all', result.observations[0].providerPublishedRaw);
  t('precision still date (writer owns degradation)', result.observations[0].publicationPrecision === 'date');
  t('page still ok (collector never rejects on parse failure)', result.page.status === 'ok');
}

console.log('--- AD. CROSS-ITEM CORRUPTION REGRESSION ---');
{
  // Item A : conteneur de résultat valide, mais métadonnées partiellement
  // malformées (titre manquant). Item B : entièrement valide.
  const itemA_malformed = itemBlock({ title: '', date: 'January 01, 2026', categoryLabel: 'General Licenses' });
  const itemB_valid = itemBlock({ href: '/recent-actions/20260903', title: 'TITLE_B', date: 'September 03, 2026', categoryLabel: 'Enforcement Actions' });
  const html = page([itemA_malformed, itemB_valid]);
  const result = await run(html);

  t('exactly one accepted observation', result.observations.length === 1, JSON.stringify(result.observations));
  const obs = result.observations[0];
  t('B title originates from B', obs?.title === 'TITLE_B', obs?.title);
  t('B URL originates from B', obs?.canonicalUrl === 'https://ofac.treasury.gov/recent-actions/20260903', obs?.canonicalUrl);
  t('B DATE_RAW originates from B', obs?.providerPublishedRaw === 'September 03, 2026', obs?.providerPublishedRaw);
  t('B category originates from B', obs?.providerCategory === 'Enforcement Actions', obs?.providerCategory);
  t('no field from A ever combined with B', obs?.providerPublishedRaw !== 'January 01, 2026' && obs?.providerCategory !== 'General Licenses');
  t('A rejected independently', result.rejectedItems.length === 1 && result.rejectedItems[0]?.reason === 'ofac_item_title_missing', JSON.stringify(result.rejectedItems));
  t('page remains status=ok (B is valid)', result.page.status === 'ok');

  // Cas inverse : A valide, B malformé => A doit rester intact.
  const itemA_valid = itemBlock({ href: '/recent-actions/20260904', title: 'TITLE_A_VALID', date: 'September 04, 2026', categoryLabel: 'Sanctions List Updates' });
  const itemB_malformed = itemBlock({ title: '', date: 'January 02, 2026', categoryLabel: 'General Licenses' });
  const html2 = page([itemA_valid, itemB_malformed]);
  const result2 = await run(html2);

  t('inverse: exactly one accepted observation', result2.observations.length === 1, JSON.stringify(result2.observations));
  const obs2 = result2.observations[0];
  t('inverse: A preserved (title)', obs2?.title === 'TITLE_A_VALID', obs2?.title);
  t('inverse: A preserved (url)', obs2?.canonicalUrl === 'https://ofac.treasury.gov/recent-actions/20260904', obs2?.canonicalUrl);
  t('inverse: A preserved (date)', obs2?.providerPublishedRaw === 'September 04, 2026', obs2?.providerPublishedRaw);
  t('inverse: A preserved (category)', obs2?.providerCategory === 'Sanctions List Updates', obs2?.providerCategory);
  t('inverse: B rejected independently (last item)', result2.rejectedItems.length === 1 && result2.rejectedItems[0]?.reason === 'ofac_item_title_missing', JSON.stringify(result2.rejectedItems));
}

console.log('--- AE. RESULT-CONTAINER CLASS DETECTION ---');
{
  const html1 = page([itemBlock({ classAttr: 'margin-bottom-4 search-result views-row extra-token', title: 'Extra Tokens OK' })]);
  const r1 = await run(html1);
  t('extra class tokens accepted', r1.observations.length === 1 && r1.observations[0].title === 'Extra Tokens OK', JSON.stringify(r1));

  const html2 = page([itemBlock({ classAttr: 'views-row search-result', title: 'Order Variation OK' })]);
  const r2 = await run(html2);
  t('token order variation accepted', r2.observations.length === 1 && r2.observations[0].title === 'Order Variation OK', JSON.stringify(r2));

  const html3 = page([itemBlock({ classAttr: 'not-search-result views-row-extra', title: 'Should Not Match' })]);
  const r3 = await run(html3);
  t('substring lookalikes rejected (page fails: zero result-containers found)', r3.page.status === 'failed' && r3.observations.length === 0, JSON.stringify(r3));
}

console.log('--- AF. STATIC GUARDS ---');
{
  const source = readFileSync(new URL('../backend/news_sources/ofac.ts', import.meta.url), 'utf8');
  t('ne cible pas news_events comme table (littéral quoté)', !/['"`]news_events\b/.test(source));
  t('n\'appelle pas scoreArticle(', !/\bscoreArticle\s*\(/.test(source));
  t('n\'appelle pas SourceRegistry.', !/\bSourceRegistry\./.test(source));
  t('n\'appelle pas dispatchActions(', !/\bdispatchActions\s*\(/.test(source));
  t('n\'appelle pas Committee(', !/\bCommittee\s*\(/.test(source));
  t('ne référence pas Anthropic', !/\bAnthropic\b/.test(source));
  t('ne calcule pas observation_hash (littéral quoté)', !/['"`]observation_hash\b/.test(source));
  t('n\'effectue pas d\'écriture DB applicative (db.request/db.insert)', !/\bdb\.(request|insert)\s*\(/.test(source));
  t('n\'appelle pas Date.parse(', !/\bDate\.parse\s*\(/.test(source));
  t('ne construit pas de new Date(', !/\bnew\s+Date\s*\(/.test(source));
  t('ne référence pas SupabaseClient', !source.includes('SupabaseClient'));
  t('n\'importe rien depuis ../ingest.js', !/from\s+['"]\.\.\/ingest\.js['"]/.test(source));
}

console.log('--- AG. NO RUNTIME DEPENDENCY (static) ---');
{
  const source = readFileSync(new URL('../backend/news_sources/ofac.ts', import.meta.url), 'utf8');
  const importLines = source.match(/^import .+$/gm) ?? [];
  const allRelative = importLines.every((line) => /from\s+['"]\.\.?\//.test(line));
  t('tous les imports sont relatifs (aucune nouvelle dépendance npm)', allRelative, JSON.stringify(importLines));
}

console.log('--- AH. LAST ITEM CATEGORY MISSING + TRAILING PAGE CONTENT (P1, XAU-V2-NEWS-OFFICIAL-023) ---');
{
  // Item est le DERNIER (et seul) résultat de la page, sans sa propre
  // ancre de catégorie — mais son propre conteneur <div> reste bien
  // balancé. Immédiatement après sa fermeture, du contenu de page
  // totalement étranger (barre latérale "Filter by Category") est
  // présent, exactement comme sur la page live réelle.
  const lastItemHtml = itemBlock({
    href: '/recent-actions/20260905',
    title: 'Last Item No Category',
    date: 'September 05, 2026',
    categoryHref: null,
    categoryLabel: null,
  });
  const trailingContent =
    '<h3>Filter by Category</h3>' +
    '<a href="/recent-actions">All Recent Actions</a>' +
    '<a href="/recent-actions/general-licenses">General Licenses</a>';
  const html = `<!doctype html><html><body><div class="view-content">${lastItemHtml}</div>${trailingContent}</body></html>`;
  const result = await run(html);

  t('zero accepted observations for the malformed result', result.observations.length === 0, JSON.stringify(result.observations));
  t('rejection reason = ofac_item_category_missing', result.rejectedItems.length === 1 && result.rejectedItems[0]?.reason === 'ofac_item_category_missing', JSON.stringify(result.rejectedItems));
  t('"All Recent Actions" never used as providerCategory', !result.observations.some((o) => o.providerCategory === 'All Recent Actions'));
  t('trailing "General Licenses" never used as providerCategory', !result.observations.some((o) => o.providerCategory === 'General Licenses'));
  t('providerPublishedRaw never constructed from trailing page text', !result.observations.some((o) => o.providerPublishedRaw?.includes('Filter by Category')));
  t('page.status = failed (only item, malformed)', result.page.status === 'failed', JSON.stringify(result.page));
}

console.log('--- AI. VALID LAST ITEM + TRAILING LINKS (P1, XAU-V2-NEWS-OFFICIAL-023) ---');
{
  const lastItemHtml = itemBlock({
    href: '/recent-actions/20260906',
    title: 'Valid Last Item',
    date: 'September 06, 2026',
    categoryHref: '/recent-actions/enforcement-actions',
    categoryLabel: 'Enforcement Actions',
  });
  const trailingContent =
    '<footer><h3>Filter by Category</h3>' +
    '<a href="/recent-actions">All Recent Actions</a>' +
    '<a href="/recent-actions/sanctions-list-updates">Sanctions List Updates</a>' +
    '<p>Some arbitrary trailing paragraph text — September 01, 2099</p></footer>';
  const html = `<!doctype html><html><body><div class="view-content">${lastItemHtml}</div>${trailingContent}</body></html>`;
  const result = await run(html);

  t('exactly one accepted observation', result.observations.length === 1, JSON.stringify(result));
  const obs = result.observations[0];
  t('own title preserved', obs?.title === 'Valid Last Item', obs?.title);
  t('own canonicalUrl preserved', obs?.canonicalUrl === 'https://ofac.treasury.gov/recent-actions/20260906', obs?.canonicalUrl);
  t('own DATE_RAW preserved', obs?.providerPublishedRaw === 'September 06, 2026', obs?.providerPublishedRaw);
  t('own category preserved', obs?.providerCategory === 'Enforcement Actions', obs?.providerCategory);
  t('trailing anchors had zero effect', result.rejectedItems.length === 0, JSON.stringify(result.rejectedItems));
  t('page status ok', result.page.status === 'ok');
}

console.log('--- AJ. MALFORMED / UNBALANCED DIV SAFETY (P1, XAU-V2-NEWS-OFFICIAL-023) ---');
{
  // Conteneur A : ancre de titre valide, mais balisage <div> corrompu —
  // aucune balise fermante avant le début du conteneur B suivant. La
  // barrière de sécurité doit s'arrêter AVANT B, jamais l'absorber.
  const malformedA =
    '<div class="search-result views-row"><div><div class="font-sans-lg margin-bottom-05 margin-top-1 text-no-underline">' +
    '<a href="/recent-actions/20260101" hreflang="en">Malformed A</a>';
  const itemB = itemBlock({
    href: '/recent-actions/20260906',
    title: 'Valid B After Malformed',
    date: 'September 06, 2026',
    categoryLabel: 'General Licenses',
  });
  const html = page([malformedA, itemB]);
  const result = await run(html);

  t('exactly one accepted observation (B only)', result.observations.length === 1, JSON.stringify(result.observations));
  const obs = result.observations[0];
  t('B parsed independently: title', obs?.title === 'Valid B After Malformed', obs?.title);
  t('B parsed independently: url', obs?.canonicalUrl === 'https://ofac.treasury.gov/recent-actions/20260906', obs?.canonicalUrl);
  t('B parsed independently: date', obs?.providerPublishedRaw === 'September 06, 2026', obs?.providerPublishedRaw);
  t('B parsed independently: category', obs?.providerCategory === 'General Licenses', obs?.providerCategory);
  t('malformed A rejected specifically as ofac_item_container_unbalanced (XAU-V2-NEWS-OFFICIAL-024)', result.rejectedItems.length === 1 && result.rejectedItems[0]?.reason === 'ofac_item_container_unbalanced', JSON.stringify(result.rejectedItems));
  t('no field from A ever present on B (title check)', obs?.title !== 'Malformed A');
  t('page remains status=ok (B is valid)', result.page.status === 'ok');
}

console.log('--- AK. UNBALANCED LAST ITEM => FAIL CLOSED (XAU-V2-NEWS-OFFICIAL-024) ---');
{
  // Dernier (et seul) conteneur de résultat : titre valide, URL datée
  // valide, DATE_RAW visible valide, PAS de catégorie, et surtout
  // AUCUNE balise </div> de fermeture — le conteneur ne peut jamais être
  // prouvé structurellement fermé. Contenu de page étranger réaliste
  // ("Filter by Category") ajouté immédiatement après.
  const unbalancedLastHtml =
    '<div class="search-result views-row"><div><div class="font-sans-lg margin-bottom-05 margin-top-1 text-no-underline">' +
    '<a href="/recent-actions/20260907" hreflang="en">Unbalanced Last Item</a></div></div>' +
    '<div><div class="margin-top-1 font-sans-2xs line-height-sans-3 margin-bottom-1">September 07, 2026 -   \n';
  const trailingContent =
    '<h3>Filter by Category</h3>' +
    '<a href="/recent-actions">All Recent Actions</a>' +
    '<a href="/recent-actions/general-licenses">General Licenses</a>';
  const html = `<!doctype html><html><body><div class="view-content">${unbalancedLastHtml}${trailingContent}</body></html>`;
  const result = await run(html);

  t('observations.length === 0', result.observations.length === 0, JSON.stringify(result.observations));
  t('rejectedItems.length === 1', result.rejectedItems.length === 1, JSON.stringify(result.rejectedItems));
  t('reason === ofac_item_container_unbalanced', result.rejectedItems[0]?.reason === 'ofac_item_container_unbalanced', JSON.stringify(result.rejectedItems));
  t('page.status === failed', result.page.status === 'failed', JSON.stringify(result.page));
  t('"All Recent Actions" never becomes providerCategory', !result.observations.some((o) => o.providerCategory === 'All Recent Actions'));
  t('trailing "General Licenses" never becomes providerCategory', !result.observations.some((o) => o.providerCategory === 'General Licenses'));
}

console.log('--- AL. STRONGER FAIL-CLOSED: ALL FIELDS VALID-LOOKING BUT UNCLOSED (XAU-V2-NEWS-OFFICIAL-024) ---');
{
  // Cette fois le conteneur non fermé contient TOUT ce qu'il faudrait
  // pour être accepté (titre valide, URL datée valide, DATE_RAW valide,
  // catégorie valide) — l'intégrité structurelle doit primer sur
  // l'apparence de validité du contenu.
  const unbalancedFullyValidLooking =
    '<div class="search-result views-row"><div><div class="font-sans-lg margin-bottom-05 margin-top-1 text-no-underline">' +
    '<a href="/recent-actions/20260908" hreflang="en">Fully Valid Looking But Unbalanced</a></div></div>' +
    '<div><div class="margin-top-1 font-sans-2xs line-height-sans-3 margin-bottom-1">September 08, 2026 -   \n' +
    '<a href="/recent-actions/sanctions-list-updates">Sanctions List Updates</a>';
  const html = `<!doctype html><html><body><div class="view-content">${unbalancedFullyValidLooking}</body></html>`;
  const result = await run(html);

  t('rejected despite all fields looking valid', result.observations.length === 0, JSON.stringify(result.observations));
  t('reason === ofac_item_container_unbalanced', result.rejectedItems.length === 1 && result.rejectedItems[0]?.reason === 'ofac_item_container_unbalanced', JSON.stringify(result.rejectedItems));
  t('page.status === failed', result.page.status === 'failed');
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
