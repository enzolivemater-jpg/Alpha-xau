import { readFileSync } from 'node:fs';
import { collectTreasuryNews } from '../backend/news_sources/us_treasury.ts';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const LISTING_URL = 'https://home.treasury.gov/news/press-releases';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVED_AT = '2026-09-05T12:00:00.000Z';

// --- Fixtures HTML, calquées sur la structure Treasury réellement observée ---
function timeTag(datetime) {
  if (datetime === null) return '';
  const attr = datetime === undefined ? '' : ` datetime="${datetime}"`;
  return `<time${attr} class=datetime>Some Display Date</time>`;
}
function anchorTag(href, title) {
  const hrefAttr = href === null ? '' : ` href="${href}"`;
  const titleHtml = title === null ? '' : title;
  return `<a${hrefAttr} hreflang=en>${titleHtml}</a>`;
}
function itemBlock({ datetime = '2026-09-04T14:30:00Z', href = '/news/press-releases/sb0621/', title = 'Sample Treasury Title' } = {}) {
  return `<span class=date-format>${timeTag(datetime)}</span><span></span><h3 class=featured-stories__headline>${anchorTag(href, title)}</h3>`;
}
function page(itemsHtml) {
  return `<!doctype html><html><body><div id=block-hamilton-content class="block"><div class=views-element-container><div class="featured-stories content--2col"><div class=content--2col__body data-news-list data-news-search-list data-news-category=press-releases data-news-layout=standard data-news-manifest=/news-data/press-releases/manifest.json data-news-page-size=10 data-news-total=14845>${itemsHtml.join('')}</div></div></div></div></body></html>`;
}
/** Page structurellement valide (marqueurs présents) mais SANS aucun bloc item. */
function pageWithNoItems() {
  return `<!doctype html><html><body><div data-news-list data-news-category=press-releases data-news-page-size=10 data-news-total=0></div></body></html>`;
}
/** Page qui ne ressemble PAS du tout à une page de listing Treasury. */
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
  return collectTreasuryNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn, ...opts });
}

// -----------------------------------------------------------------------
console.log('--- A. HAPPY PATH MULTIPLE ITEMS ---');
{
  const html = page([
    itemBlock({ href: '/news/press-releases/sb0621/', title: 'First Item', datetime: '2026-09-03T13:00:00Z' }),
    itemBlock({ href: '/news/press-releases/sb0620/', title: 'Second Item', datetime: '2026-09-01T06:20:00Z' }),
    itemBlock({ href: '/news/press-releases/sb0619/', title: 'Third Item', datetime: '2026-08-30T23:00:00Z' }),
  ]);
  const result = await run(html);
  t('3 observations collected', result.observations.length === 3, JSON.stringify(result));
  t('page status ok', result.page.status === 'ok', JSON.stringify(result.page));
  t('page itemsAccepted = 3', result.page.itemsAccepted === 3);
  t('zero rejected', result.rejectedItems.length === 0, JSON.stringify(result.rejectedItems));
}

console.log('--- B. EXACT PROVENANCE ---');
{
  const html = page([itemBlock()]);
  const result = await run(html);
  const obs = result.observations[0];
  t('provider=us_treasury', obs.provider === 'us_treasury');
  t('sourceCode=us_treasury', obs.sourceCode === 'us_treasury');
  t('sourceDomain=home.treasury.gov', obs.sourceDomain === 'home.treasury.gov');
  t('providerItemId=null', obs.providerItemId === null);
  t('providerCategory=press_release', obs.providerCategory === 'press_release');
  t('summary=null', obs.summary === null);
  t('content=null', obs.content === null);
  t('ingestQualityState=VALID', obs.ingestQualityState === 'VALID');
  t('ingestQualityReasons=[]', Array.isArray(obs.ingestQualityReasons) && obs.ingestQualityReasons.length === 0);
}

console.log('--- C. PUBLICATION PRECISION (raw datetime preserved, no normalization) ---');
{
  const html = page([itemBlock({ datetime: '2026-09-04T14:30:00Z' })]);
  const result = await run(html);
  const obs = result.observations[0];
  t('providerPublishedRaw exact match', obs.providerPublishedRaw === '2026-09-04T14:30:00Z', obs.providerPublishedRaw);
  t('publicationPrecision=timestamp', obs.publicationPrecision === 'timestamp');
}

console.log('--- D. RELATIVE HREF -> CANONICAL ABSOLUTE TREASURY URL ---');
{
  const html = page([itemBlock({ href: '/news/press-releases/sb0621/' })]);
  const result = await run(html);
  t('resolved to absolute URL', result.observations[0].canonicalUrl === 'https://home.treasury.gov/news/press-releases/sb0621/', result.observations[0].canonicalUrl);
}

console.log('--- E. ABSOLUTE TREASURY URL ACCEPTED ---');
{
  const html = page([itemBlock({ href: 'https://home.treasury.gov/news/press-releases/sb0621/' })]);
  const result = await run(html);
  t('absolute URL accepted as-is', result.observations[0].canonicalUrl === 'https://home.treasury.gov/news/press-releases/sb0621/');
}

console.log('--- F. EXTERNAL HOST REJECTED ---');
{
  const html = page([itemBlock({ href: 'https://example.com/news/press-releases/sb0621/' })]);
  const result = await run(html);
  t('rejected as external', result.rejectedItems.some((r) => r.reason === 'treasury_item_url_external'), JSON.stringify(result.rejectedItems));
  t('page failed (zero accepted)', result.page.status === 'failed');
}

console.log('--- G. DECEPTIVELY SIMILAR HOST REJECTED ---');
{
  const html1 = page([itemBlock({ href: 'https://home.treasury.gov.evil.example/news/press-releases/sb0621/' })]);
  const r1 = await run(html1);
  t('home.treasury.gov.evil.example rejected as external', r1.rejectedItems.some((r) => r.reason === 'treasury_item_url_external'), JSON.stringify(r1.rejectedItems));

  const html2 = page([itemBlock({ href: 'https://treasury.gov.evil.example/news/press-releases/sb0621/' })]);
  const r2 = await run(html2);
  t('treasury.gov.evil.example rejected as external', r2.rejectedItems.some((r) => r.reason === 'treasury_item_url_external'), JSON.stringify(r2.rejectedItems));
}

console.log('--- H. HTTP REJECTED ---');
{
  const html = page([itemBlock({ href: 'http://home.treasury.gov/news/press-releases/sb0621/' })]);
  const result = await run(html);
  t('http rejected as invalid', result.rejectedItems.some((r) => r.reason === 'treasury_item_url_invalid'), JSON.stringify(result.rejectedItems));
}

console.log('--- I. WRONG TREASURY PATH REJECTED ---');
{
  const html = page([itemBlock({ href: 'https://home.treasury.gov/policy-issues/something/' })]);
  const result = await run(html);
  t('wrong path rejected', result.rejectedItems.some((r) => r.reason === 'treasury_item_url_wrong_path'), JSON.stringify(result.rejectedItems));
}

console.log('--- J. LISTING ROOT REJECTED ---');
{
  const html = page([itemBlock({ href: 'https://home.treasury.gov/news/press-releases/' })]);
  const result = await run(html);
  t('listing root rejected', result.rejectedItems.some((r) => r.reason === 'treasury_item_url_wrong_path'), JSON.stringify(result.rejectedItems));
  const html2 = page([itemBlock({ href: 'https://home.treasury.gov/news/press-releases' })]);
  const result2 = await run(html2);
  t('listing root without trailing slash rejected', result2.rejectedItems.some((r) => r.reason === 'treasury_item_url_wrong_path'), JSON.stringify(result2.rejectedItems));
}

console.log('--- K. MISSING TITLE REJECTED WITHOUT LOSING SIBLINGS ---');
{
  const html = page([
    itemBlock({ title: '' }),
    itemBlock({ href: '/news/press-releases/sb0620/', title: 'Valid Sibling' }),
  ]);
  const result = await run(html);
  t('missing title rejected', result.rejectedItems.some((r) => r.reason === 'treasury_item_title_missing'), JSON.stringify(result.rejectedItems));
  t('sibling still accepted', result.observations.length === 1 && result.observations[0].title === 'Valid Sibling');
  t('page still ok (one valid observation)', result.page.status === 'ok');
}

console.log('--- L. MISSING DATETIME REJECTED WITHOUT LOSING SIBLINGS ---');
{
  const html = page([
    itemBlock({ datetime: null }),
    itemBlock({ href: '/news/press-releases/sb0620/', title: 'Valid Sibling 2' }),
  ]);
  const result = await run(html);
  t('missing datetime rejected', result.rejectedItems.some((r) => r.reason === 'treasury_item_publication_missing'), JSON.stringify(result.rejectedItems));
  t('sibling still accepted', result.observations.length === 1 && result.observations[0].title === 'Valid Sibling 2');
}

console.log('--- M. MISSING HREF REJECTED WITHOUT LOSING SIBLINGS ---');
{
  const html = page([
    itemBlock({ href: null }),
    itemBlock({ href: '/news/press-releases/sb0620/', title: 'Valid Sibling 3' }),
  ]);
  const result = await run(html);
  t('missing href rejected', result.rejectedItems.some((r) => r.reason === 'treasury_item_url_missing'), JSON.stringify(result.rejectedItems));
  t('sibling still accepted', result.observations.length === 1 && result.observations[0].title === 'Valid Sibling 3');
}

console.log('--- N. HTML ENTITY DECODING EXACTLY ONCE ---');
{
  const html = page([itemBlock({ title: 'Fed &amp;amp; Treasury Statement' })]);
  const result = await run(html);
  t('decoded exactly once (no double-decode)', result.observations[0].title === 'Fed &amp; Treasury Statement', result.observations[0].title);

  const html2 = page([itemBlock({ title: 'Syria&#039;s designation' })]);
  const result2 = await run(html2);
  t('named/numeric mix decoded', result2.observations[0].title === "Syria's designation", result2.observations[0].title);
}

console.log('--- O. NUMERIC ENTITY DECODING ---');
{
  const html = page([itemBlock({ title: 'Caf&#233; Meeting Readout' })]);
  const result = await run(html);
  t('decimal numeric entity decoded', result.observations[0].title === 'Café Meeting Readout', result.observations[0].title);

  const html2 = page([itemBlock({ title: 'Tr&#xe9;asury Note' })]);
  const result2 = await run(html2);
  t('hex numeric entity decoded', result2.observations[0].title === 'Tréasury Note', result2.observations[0].title);
}

console.log('--- P. MALFORMED ITEM ISOLATED ---');
{
  // Bloc structurellement borné mais dont le contenu interne est
  // complètement absent (pas de <time>, pas de <a>) : doit être rejeté
  // proprement sans jamais faire disparaître le sibling valide.
  const malformed = '<span class=date-format></span><span></span><h3 class=featured-stories__headline></h3>';
  const html = `<!doctype html><html><body><div data-news-list data-news-category=press-releases>${malformed}${itemBlock({ href: '/news/press-releases/sb0620/', title: 'Valid Sibling 4' })}</div></body></html>`;
  const result = await run(html);
  t('malformed item rejected (some reason)', result.rejectedItems.length >= 1, JSON.stringify(result.rejectedItems));
  t('valid sibling still accepted', result.observations.some((o) => o.title === 'Valid Sibling 4'));
}

console.log('--- Q. HTTP FAILURE ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { status: 500, body: 'error' } });
  const result = await collectTreasuryNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page failed', result.page.status === 'failed');
  t('zero observations', result.observations.length === 0);
  t('error message present', typeof result.page.error === 'string' && result.page.error.includes('500'), result.page.error);
}

console.log('--- R. TIMEOUT / ABORTERROR ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { abort: true } });
  const result = await collectTreasuryNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page failed on timeout', result.page.status === 'failed');
  t('timeout message present', result.page.error?.includes('timeout'), result.page.error);
}

console.log('--- S. EMPTY BODY ---');
{
  const fetchFn = makeFakeFetch({ [LISTING_URL]: { body: '' } });
  const result = await collectTreasuryNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn });
  t('page failed on empty body', result.page.status === 'failed');
  t('empty body message present', result.page.error?.includes('empty'), result.page.error);
}

console.log('--- T. STRUCTURALLY VALID-LOOKING PAGE WITH ZERO ITEMS => FAILURE ---');
{
  const result = await run(pageWithNoItems());
  t('page failed', result.page.status === 'failed');
  t('zero item blocks message', result.page.error?.includes('zero item blocks'), result.page.error);
  t('zero observations', result.observations.length === 0);
}

console.log('--- (bonus) UNRELATED PAGE (missing listing structure entirely) => FAILURE ---');
{
  const result = await run(unrelatedPage());
  t('page failed', result.page.status === 'failed');
  t('missing structure message', result.page.error?.includes('missing expected Treasury listing structure'), result.page.error);
}

console.log('--- U. ALL ITEMS MALFORMED => FAILURE ---');
{
  const html = page([
    itemBlock({ title: '' }),
    itemBlock({ href: null }),
    itemBlock({ datetime: null }),
  ]);
  const result = await run(html);
  t('page failed (zero accepted)', result.page.status === 'failed');
  t('zero observations', result.observations.length === 0);
  t('three rejected items recorded', result.rejectedItems.length === 3, JSON.stringify(result.rejectedItems));
  t('zero accepted message present', result.page.error?.includes('zero accepted observations'), result.page.error);
}

console.log('--- V. OBSERVEDAT PASSED THROUGH UNCHANGED ---');
{
  const html = page([itemBlock()]);
  const result = await run(html);
  t('observedAt exact match', result.observations[0].observedAt === OBSERVED_AT, result.observations[0].observedAt);
}

console.log('--- W. NO APPLICATION-LEVEL PUBLICATION PARSING (malformed-but-nonempty datetime still emitted) ---');
{
  const html = page([itemBlock({ datetime: 'not-a-real-timestamp-at-all' })]);
  const result = await run(html);
  t('malformed datetime still emitted verbatim', result.observations[0].providerPublishedRaw === 'not-a-real-timestamp-at-all', result.observations[0].providerPublishedRaw);
  t('precision still timestamp (writer owns degradation)', result.observations[0].publicationPrecision === 'timestamp');
  t('page still ok (collector never rejects on parse failure)', result.page.status === 'ok');
}

console.log('--- X. STATIC REGRESSION GUARDS ---');
{
  const source = readFileSync(new URL('../backend/news_sources/us_treasury.ts', import.meta.url), 'utf8');
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

console.log('--- Y. NO RUNTIME DEPENDENCY ADDED (static) ---');
{
  const source = readFileSync(new URL('../backend/news_sources/us_treasury.ts', import.meta.url), 'utf8');
  const importLines = source.match(/^import .+$/gm) ?? [];
  const allRelativeOrTypeOnly = importLines.every((line) => /from\s+['"]\.\.?\//.test(line));
  t('tous les imports sont relatifs (aucune nouvelle dépendance npm)', allRelativeOrTypeOnly, JSON.stringify(importLines));
}

console.log('--- Z. CROSS-ITEM BOUNDARY (P1, XAU-V2-NEWS-OFFICIAL-021) ---');
{
  // Item A : date-format valide mais AUCUN <h3> du tout (headline
  // totalement absente, pas seulement un <a> vide à l'intérieur d'un
  // <h3> présent). Sous l'ancien motif `[\s\S]*?</h3>` non borné par le
  // prochain marqueur date-format, la recherche non gourmande aurait pu
  // "déborder" jusqu'au </h3> de l'item B suivant, absorbant B tout
  // entier dans le bloc "A" et produisant DATE_A + TITLE_B + URL_B.
  const DATE_A = '2026-01-01T00:00:00Z';
  const itemA_noHeadlineAtAll = `<span class=date-format><time datetime="${DATE_A}" class=datetime>January 1, 2026</time></span><span></span>`;
  const itemB = itemBlock({
    datetime: '2026-09-03T13:00:00Z',
    href: '/news/press-releases/sb0621/',
    title: 'TITLE_B',
  });
  const html = `<!doctype html><html><body><div data-news-list data-news-category=press-releases>${itemA_noHeadlineAtAll}${itemB}</div></body></html>`;
  const result = await run(html);

  t('exactly one accepted observation', result.observations.length === 1, JSON.stringify(result.observations));
  const obs = result.observations[0];
  t('accepted title == TITLE_B', obs?.title === 'TITLE_B', obs?.title);
  t('accepted canonicalUrl == URL_B', obs?.canonicalUrl === 'https://home.treasury.gov/news/press-releases/sb0621/', obs?.canonicalUrl);
  t('accepted providerPublishedRaw == DATE_B (never DATE_A)', obs?.providerPublishedRaw === '2026-09-03T13:00:00Z', obs?.providerPublishedRaw);
  t('DATE_A never associated with TITLE_B', obs?.providerPublishedRaw !== DATE_A);
  t('malformed A is rejected', result.rejectedItems.length === 1, JSON.stringify(result.rejectedItems));
  t('A rejected as title_missing (headline entirely absent)', result.rejectedItems[0]?.reason === 'treasury_item_title_missing', JSON.stringify(result.rejectedItems));
  t('page remains status=ok (B is valid)', result.page.status === 'ok', JSON.stringify(result.page));

  // Cas inverse : A valide, B malformé (pas de headline du tout) => A
  // doit rester intact et indépendant, B ne doit jamais "voler" le titre
  // d'un item ultérieur ni A ne doit être contaminé par B.
  const itemA_valid = itemBlock({
    datetime: '2026-09-04T14:30:00Z',
    href: '/news/press-releases/sb0622/',
    title: 'TITLE_A_VALID',
  });
  const DATE_B2 = '2026-01-02T00:00:00Z';
  const itemB_noHeadlineAtAll = `<span class=date-format><time datetime="${DATE_B2}" class=datetime>January 2, 2026</time></span><span></span>`;
  const html2 = `<!doctype html><html><body><div data-news-list data-news-category=press-releases>${itemA_valid}${itemB_noHeadlineAtAll}</div></body></html>`;
  const result2 = await run(html2);

  t('inverse case: exactly one accepted observation', result2.observations.length === 1, JSON.stringify(result2.observations));
  const obs2 = result2.observations[0];
  t('inverse case: A preserved unchanged (title)', obs2?.title === 'TITLE_A_VALID', obs2?.title);
  t('inverse case: A preserved unchanged (url)', obs2?.canonicalUrl === 'https://home.treasury.gov/news/press-releases/sb0622/', obs2?.canonicalUrl);
  t('inverse case: A preserved unchanged (datetime)', obs2?.providerPublishedRaw === '2026-09-04T14:30:00Z', obs2?.providerPublishedRaw);
  t('inverse case: B (malformed, last item) rejected independently', result2.rejectedItems.length === 1 && result2.rejectedItems[0]?.reason === 'treasury_item_title_missing', JSON.stringify(result2.rejectedItems));
  t('inverse case: page remains status=ok (A is valid)', result2.page.status === 'ok');
}

console.log('--- AA. RAW DATETIME EXACT FIDELITY (P1, XAU-V2-NEWS-OFFICIAL-021) ---');
{
  // Valeur volontairement inhabituelle mais non vide : espaces
  // d'encadrement à l'intérieur des guillemets + une séquence
  // ressemblant à une entité HTML — toute transformation (trim et/ou
  // décodage) serait immédiatement détectable dans le résultat.
  const UNUSUAL_RAW = '  2026-09-04T14:30:00Z&amp;RAW-MARKER  ';
  const html = `<!doctype html><html><body><div data-news-list data-news-category=press-releases><span class=date-format><time datetime="${UNUSUAL_RAW}" class=datetime>Display</time></span><span></span><h3 class=featured-stories__headline><a href="/news/press-releases/sb0699/" hreflang=en>Fidelity Test Item</a></h3></div></body></html>`;
  const result = await run(html);

  t('exactly one accepted observation', result.observations.length === 1, JSON.stringify(result));
  const obs = result.observations[0];
  t('providerPublishedRaw preserved EXACTLY (no trim, no entity decode)', obs?.providerPublishedRaw === UNUSUAL_RAW, JSON.stringify(obs?.providerPublishedRaw));
  t('publicationPrecision still timestamp', obs?.publicationPrecision === 'timestamp');
  t('page status ok (collector never validates the timestamp itself)', result.page.status === 'ok');
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
