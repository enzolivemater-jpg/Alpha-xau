// Import direct du module TS via le "type stripping" natif de Node 22.6+
// (--experimental-strip-types), même pattern que test_federal_reserve_collector.mjs :
// aucune dépendance de build ajoutée, aucun fichier .mjs compilé tiers.
import { collectEcbNews } from '../backend/news_sources/ecb.ts';
import { readFileSync } from 'node:fs';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const PRESS_URL = 'https://www.ecb.europa.eu/rss/press.html';
const STATPRESS_URL = 'https://www.ecb.europa.eu/rss/statpress.html';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED_AT = '2026-09-02T18:05:00Z';

function xmlItem({ title, link, guid, description, pubDate, rawTitle }) {
  const parts = ['<item>'];
  if (rawTitle !== undefined) {
    parts.push(`<title>${rawTitle}</title>`);
  } else if (title !== undefined) {
    parts.push(`<title>${title}</title>`);
  }
  if (link !== undefined) parts.push(`<link>${link}</link>`);
  if (guid !== undefined) parts.push(`<guid>${guid}</guid>`);
  if (description !== undefined) parts.push(`<description>${description}</description>`);
  if (pubDate !== undefined) parts.push(`<pubDate>${pubDate}</pubDate>`);
  parts.push('</item>');
  return parts.join('\n    ');
}
function xmlFeed(items) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>ECB - European Central Bank</title><link>https://www.ecb.europa.eu/</link>
    <description>test</description>
    ${items.join('\n    ')}
</channel></rss>`;
}
function neutralItem(n = 0) {
  return xmlItem({
    title: `Neutral item ${n}`,
    link: `https://www.ecb.europa.eu/n${n}`,
    guid: `https://www.ecb.europa.eu/n${n}`,
    pubDate: 'Tue, 01 Sep 2026 18:00:00 +0200',
  });
}

function makeFakeFetch(responseByUrl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const cfg = responseByUrl[url];
    if (!cfg) throw new Error(`no fake response configured for ${url}`);
    if (cfg.abort) {
      const err = new Error('The operation was aborted');
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

async function run(fetchFn, opts = {}) {
  return collectEcbNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn, ...opts });
}

// -----------------------------------------------------------------------
console.log('--- 1-9. PRESS FEED HAPPY PATH (full field mapping) ---');
{
  const press = xmlFeed([xmlItem({
    title: 'Isabel Schnabel: Central banks on-chain',
    link: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260828.en.html',
    guid: 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260828.en.html',
    description: 'Speech by Isabel Schnabel',
    pubDate: 'Fri, 28 Aug 2026 18:00:00 +0200',
  })]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  const obs = result.observations.find((o) => o.providerCategory === 'press_communication');
  t('1. exact press URL used', fakeFetch.calls.some((c) => c.url === PRESS_URL));
  t('2. exact statpress URL used', fakeFetch.calls.some((c) => c.url === STATPRESS_URL));
  t('3. provider = ecb', obs?.provider === 'ecb');
  t('3. sourceCode = ecb', obs?.sourceCode === 'ecb');
  t('3. sourceDomain = ecb.europa.eu', obs?.sourceDomain === 'ecb.europa.eu');
  t('4. providerCategory = press_communication', obs?.providerCategory === 'press_communication');
  t('5. title mapped', obs?.title === 'Isabel Schnabel: Central banks on-chain', obs?.title);
  t('6. guid mapped to providerItemId', obs?.providerItemId === 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260828.en.html');
  t('7. link mapped to canonicalUrl', obs?.canonicalUrl === 'https://www.ecb.europa.eu/press/key/date/2026/html/ecb.sp260828.en.html');
  t('8. description mapped to summary', obs?.summary === 'Speech by Isabel Schnabel', obs?.summary);
  t('9. raw pubDate preserved exactly', obs?.providerPublishedRaw === 'Fri, 28 Aug 2026 18:00:00 +0200', obs?.providerPublishedRaw);
}

console.log('--- STATPRESS CATEGORY ---');
{
  const statpress = xmlFeed([xmlItem({
    title: 'Euro area bank interest rate statistics: July 2026',
    link: 'https://www.ecb.europa.eu/press/stats/mfi/html/x.en.html',
    guid: 'https://www.ecb.europa.eu/press/stats/mfi/html/x.en.html',
    pubDate: 'Wed, 02 Sep 2026 10:00:00 +0200',
  })]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: xmlFeed([neutralItem(1)]) }, [STATPRESS_URL]: { body: statpress } });
  const result = await run(fakeFetch);
  const obs = result.observations.find((o) => o.providerCategory === 'statistical_press_release');
  t('providerCategory = statistical_press_release', obs?.providerCategory === 'statistical_press_release');
}

console.log('--- 10. MISSING PUBDATE ---');
{
  const press = xmlFeed([xmlItem({ title: 'No pubDate', link: 'https://www.ecb.europa.eu/x', guid: 'https://www.ecb.europa.eu/x' })]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  const obs = result.observations.find((o) => o.providerCategory === 'press_communication');
  t('10. providerPublishedRaw null when pubDate absent', obs?.providerPublishedRaw === null);
  t('10. publicationPrecision = none', obs?.publicationPrecision === 'none');
}
{
  const press = xmlFeed([xmlItem({ title: 'Has pubDate', link: 'https://www.ecb.europa.eu/x', guid: 'https://www.ecb.europa.eu/x', pubDate: 'Tue, 01 Sep 2026 18:00:00 +0200' })]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  const obs = result.observations.find((o) => o.providerCategory === 'press_communication');
  t('9(bis). publicationPrecision = timestamp when pubDate present', obs?.publicationPrecision === 'timestamp');
}

console.log('--- 11-13. CDATA + ENTITIES + NO DOUBLE DECODE ---');
{
  const press = xmlFeed([xmlItem({
    title: '<![CDATA[Piero Cipollone: Building Europe’s tokenised market <b>bold</b>]]>',
    link: 'https://www.ecb.europa.eu/x',
    guid: 'https://www.ecb.europa.eu/x',
    description: '<![CDATA[Interview &amp; Q&amp;A]]>',
    rawTitle: undefined,
  })]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  const obs = result.observations.find((o) => o.providerCategory === 'press_communication');
  t('11. CDATA title parsed, tags preserved as literal text', obs?.title.includes('<b>bold</b>'), obs?.title);
  t('11. CDATA description parsed', obs?.summary === 'Interview & Q&A', obs?.summary);
  t('13. no double-decoding of &amp; inside CDATA-decoded entity', obs?.summary === 'Interview & Q&A' && !obs?.summary.includes('&amp;'));
}
{
  const press = xmlFeed([xmlItem({
    rawTitle: 'Decimal &#39; hex &#x26; amp &amp; done',
    link: 'https://www.ecb.europa.eu/x2',
    guid: 'https://www.ecb.europa.eu/x2',
  })]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  const obs = result.observations.find((o) => o.canonicalUrl === 'https://www.ecb.europa.eu/x2');
  t('12. decimal entity decoded', obs?.title.includes("Decimal '"), obs?.title);
  t('12. hex entity decoded', obs?.title.includes('hex &'), obs?.title);
  t('12. amp entity decoded', obs?.title.endsWith('amp & done'), obs?.title);
}

console.log('--- 14-16. ITEM REJECTIONS ---');
{
  const press = xmlFeed([
    xmlItem({ link: 'https://www.ecb.europa.eu/no-title', guid: 'https://www.ecb.europa.eu/no-title' }),
    neutralItem(1),
  ]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('14. missing title -> rejected', result.rejectedItems.some((r) => r.reason === 'ecb_item_title_missing'), JSON.stringify(result.rejectedItems));
}
{
  const press = xmlFeed([xmlItem({ title: 'No identity' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('15. missing guid+link -> rejected', result.rejectedItems.some((r) => r.reason === 'ecb_item_identity_missing'), JSON.stringify(result.rejectedItems));
}
{
  const press = xmlFeed([xmlItem({ title: 'Malformed link', link: 'not-a-url-at-all' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('16. malformed link -> rejected (ecb_item_url_invalid)', result.rejectedItems.some((r) => r.reason === 'ecb_item_url_invalid'), JSON.stringify(result.rejectedItems));
}

console.log('--- 17-21. URL PROVENANCE GUARD ---');
{
  const press = xmlFeed([xmlItem({ title: 'HTTP link', link: 'http://www.ecb.europa.eu/x' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('17. http:// link -> rejected', result.rejectedItems.some((r) => r.reason === 'ecb_item_url_invalid'), JSON.stringify(result.rejectedItems));
}
{
  const press = xmlFeed([xmlItem({ title: 'External domain', link: 'https://example.com/not-ecb' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('18. external domain -> rejected (ecb_item_url_external)', result.rejectedItems.some((r) => r.reason === 'ecb_item_url_external'), JSON.stringify(result.rejectedItems));
  t('18. never emitted with sourceCode ecb for external URL', !result.observations.some((o) => o.canonicalUrl === 'https://example.com/not-ecb'));
}
{
  const press = xmlFeed([xmlItem({ title: 'Bare domain', link: 'https://ecb.europa.eu/x' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('19. ecb.europa.eu accepted', result.observations.some((o) => o.canonicalUrl === 'https://ecb.europa.eu/x'), JSON.stringify(result));
}
{
  const press = xmlFeed([xmlItem({ title: 'www subdomain', link: 'https://www.ecb.europa.eu/x' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('20. www.ecb.europa.eu accepted', result.observations.some((o) => o.canonicalUrl === 'https://www.ecb.europa.eu/x'), JSON.stringify(result));
}
{
  const press = xmlFeed([xmlItem({ title: 'data subdomain', link: 'https://data.ecb.europa.eu/x' }), neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  t('21. data.ecb.europa.eu accepted', result.observations.some((o) => o.canonicalUrl === 'https://data.ecb.europa.eu/x'), JSON.stringify(result));
}

console.log('--- 22-24. FEED-LEVEL FAILURE MODES ---');
{
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: '<html><body>not rss</body></html>' }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  t('22. malformed feed (no rss/channel) -> failed', result.feeds.find((s) => s.feed === 'press')?.status === 'failed', JSON.stringify(result.feeds));
}
{
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: '' }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  t('23. empty body -> failed, not successful empty feed', result.feeds.find((s) => s.feed === 'press')?.status === 'failed', JSON.stringify(result.feeds));
}
{
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: xmlFeed([]) }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  const press = result.feeds.find((s) => s.feed === 'press');
  t('24. RSS/channel present but ZERO items -> failed', press?.status === 'failed', JSON.stringify(press));
  t('24. error mentions item structure', /item/i.test(press?.error ?? ''), press?.error);
}

console.log('--- 25-26. PARTIAL FAILURE ISOLATION ---');
{
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { status: 500, body: 'error' }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(1)]) } });
  const result = await run(fakeFetch);
  t('25. HTTP 500 on one feed isolated: other feed observations preserved', result.observations.length === 1, JSON.stringify(result));
  t('25. failed feed explicitly reported', result.feeds.find((s) => s.feed === 'press')?.status === 'failed');
  t('25. healthy feed explicitly ok', result.feeds.find((s) => s.feed === 'statpress')?.status === 'ok');
}
{
  const press = xmlFeed([xmlItem({ title: 'Bad item', link: 'ftp://bad' }), neutralItem(1), neutralItem(2)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(3)]) } });
  const result = await run(fakeFetch);
  t('26. one bad item does not discard healthy items in same feed', result.observations.filter((o) => o.providerCategory === 'press_communication').length === 2, JSON.stringify(result));
}

console.log('--- 27-28. CONCURRENCY + DETERMINISTIC STATUS ---');
{
  const callOrder = [];
  let resolvePress, resolveStatpress;
  const pendingPress = new Promise((res) => { resolvePress = res; });
  const pendingStatpress = new Promise((res) => { resolveStatpress = res; });
  const fakeFetch = async (url) => {
    callOrder.push(url);
    if (url === PRESS_URL) { await pendingPress; return { ok: true, status: 200, async text() { return xmlFeed([neutralItem(1)]); } }; }
    await pendingStatpress; return { ok: true, status: 200, async text() { return xmlFeed([neutralItem(2)]); } };
  };
  const resultPromise = run(fakeFetch);
  await Promise.resolve(); await Promise.resolve();
  t('27. both feed requests initiated before either resolves', callOrder.length === 2, JSON.stringify(callOrder));
  resolvePress(); resolveStatpress();
  const result = await resultPromise;
  t('28. deterministic two-feed status output', result.feeds.length === 2 && result.feeds.every((s) => s.status === 'ok'), JSON.stringify(result.feeds));
}

console.log('--- 29-32. FIELD PROPAGATION / DEFAULTS ---');
{
  const press = xmlFeed([neutralItem(1)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(2)]) } });
  const result = await run(fakeFetch);
  const obs = result.observations[0];
  t('29. observedAt preserved exactly', obs?.observedAt === OBSERVED_AT);
  t('30. ingestRunId preserved exactly', obs?.ingestRunId === RUN_ID);
  t('31. content always null', result.observations.every((o) => o.content === null));
  t('32. ingestQualityState starts VALID', result.observations.every((o) => o.ingestQualityState === 'VALID'));
  t('32. ingestQualityReasons starts empty', result.observations.every((o) => Array.isArray(o.ingestQualityReasons) && o.ingestQualityReasons.length === 0));
}

console.log('--- 38-39. NO ARTICLE-PAGE FETCH / NO LOOKBACK ---');
{
  const press = xmlFeed([neutralItem(1), neutralItem(2), neutralItem(3)]);
  const fakeFetch = makeFakeFetch({ [PRESS_URL]: { body: press }, [STATPRESS_URL]: { body: xmlFeed([neutralItem(4)]) } });
  const result = await run(fakeFetch);
  t('38. exactly two feed requests total (no article-page fetch)', fakeFetch.calls.length === 2, JSON.stringify(fakeFetch.calls.map((c) => c.url)));
  t('39. no lookback filtering: all items from finite feed accepted', result.observations.filter((o) => o.providerCategory === 'press_communication').length === 3);
}

console.log('--- 33-37, 40. STATIC ISOLATION CHECKS ---');
{
  const source = readFileSync(new URL('../backend/news_sources/ecb.ts', import.meta.url), 'utf8');
  t('33. no DB import/use (no .request( call)', !/\.request\s*\(/.test(source));
  t('34. no RAW writer invocation', !source.includes('writeRawNewsObservation'));
  t('35. does not target news_events as a table literal', !/['"`]news_events\b/.test(source));
  t('35. no import from an ingest module', !/from\s+['"]\.\.\/ingest\.js['"]/.test(source));
  t('36. no scoring call', !/\bscoreArticle\s*\(/.test(source));
  t('37. no AI/committee/event cluster call', !/\bdispatchActions\s*\(|\bCommittee\s*\(/.test(source));
  t('37. no SourceRegistry usage', !/\bSourceRegistry\./.test(source));
  {
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const allRelative = specifiers.length > 0 && specifiers.every((spec) => spec.startsWith('./') || spec.startsWith('../'));
    t('40. no new runtime dependency (every import specifier is relative)', allRelative, JSON.stringify(specifiers));
  }
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
