// Import direct du module TS via le "type stripping" natif de Node 22.6+
// (--experimental-strip-types), même pattern que test_raw_news_writer.mjs :
// aucune dépendance de build ajoutée, aucun fichier .mjs compilé tiers.
import { collectFederalReserveNews } from '../backend/news_sources/federal_reserve.ts';
import { readFileSync } from 'node:fs';

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

const MONETARY_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
const SPEECHES_URL = 'https://www.federalreserve.gov/feeds/speeches.xml';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED_AT = '2026-08-25T18:05:00Z';

function xmlItem({ title, link, guid, description, pubDate, category = 'Monetary Policy', rawTitle }) {
  const parts = ['<item>'];
  if (rawTitle !== undefined) {
    parts.push(`<title>${rawTitle}</title>`);
  } else if (title !== undefined) {
    parts.push(`<title><![CDATA[${title}]]></title>`);
  }
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
    if (cfg.networkError) throw cfg.networkError;
    return {
      ok: cfg.status === undefined ? true : cfg.status >= 200 && cfg.status < 300,
      status: cfg.status ?? 200,
      async text() { return cfg.body ?? ''; },
    };
  };
  fn.calls = calls;
  return fn;
}

async function run(name, fetchFn, opts = {}) {
  return collectFederalReserveNews({ ingestRunId: RUN_ID, observedAt: OBSERVED_AT, fetchFn, ...opts });
}

// -----------------------------------------------------------------------
console.log('--- A. MONETARY FEED HAPPY PATH ---');
{
  const feed = xmlFeed([xmlItem({
    title: 'Federal Reserve issues FOMC statement',
    link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm',
    guid: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm',
    description: 'Federal Reserve issues FOMC statement',
    pubDate: 'Wed, 29 Jul 2026 18:00:00 GMT',
  })]);
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { body: feed },
    [SPEECHES_URL]: { body: xmlFeed([]) },
  });
  const result = await run('A', fakeFetch);
  const obs = result.observations.find((o) => o.provider === 'federal_reserve' && o.providerCategory === 'monetary_policy_press_release');
  t('one observation produced', result.observations.length === 1, JSON.stringify(result));
  t('sourceCode = federalreserve', obs?.sourceCode === 'federalreserve');
  t('sourceDomain = federalreserve.gov', obs?.sourceDomain === 'federalreserve.gov');
  t('providerCategory = monetary_policy_press_release', obs?.providerCategory === 'monetary_policy_press_release');
  t('guid mapped to providerItemId', obs?.providerItemId === 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm');
  t('link mapped to canonicalUrl', obs?.canonicalUrl === 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm');
  t('title mapped', obs?.title === 'Federal Reserve issues FOMC statement');
  t('description mapped to summary', obs?.summary === 'Federal Reserve issues FOMC statement');
  t('pubDate -> providerPublishedRaw + precision=timestamp',
    obs?.providerPublishedRaw === 'Wed, 29 Jul 2026 18:00:00 GMT' && obs?.publicationPrecision === 'timestamp');
  t('caller ingestRunId propagated', obs?.ingestRunId === RUN_ID);
  t('caller observedAt propagated exactly', obs?.observedAt === OBSERVED_AT);
  t('content = null (no article-page fetch)', obs?.content === null);
  t('feed status ok', result.feeds.find((s) => s.feed === 'press_monetary')?.status === 'ok');
}

console.log('--- B. SPEECHES HAPPY PATH ---');
{
  const feed = xmlFeed([xmlItem({
    title: 'Warsh, In Our Time',
    link: 'https://www.federalreserve.gov/newsevents/speech/warsh20260828a.htm',
    guid: 'https://www.federalreserve.gov/newsevents/speech/warsh20260828a.htm',
    description: 'Speech at a symposium',
    pubDate: 'Fri, 28 Aug 2026 14:00:00 GMT',
    category: 'Speech',
  })]);
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { body: xmlFeed([]) },
    [SPEECHES_URL]: { body: feed },
  });
  const result = await run('B', fakeFetch);
  const obs = result.observations[0];
  t('one observation produced', result.observations.length === 1, JSON.stringify(result));
  t('providerCategory = speech', obs?.providerCategory === 'speech');
}

console.log('--- C. CDATA ---');
{
  const feed = xmlFeed([xmlItem({
    title: 'CDATA <Title> With Tags',
    link: 'https://www.federalreserve.gov/x',
    guid: 'https://www.federalreserve.gov/x',
    description: 'CDATA <b>description</b> body',
    pubDate: 'Wed, 29 Jul 2026 18:00:00 GMT',
  })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('C', fakeFetch);
  const obs = result.observations[0];
  t('CDATA title parsed correctly (tags preserved as literal text)', obs?.title === 'CDATA <Title> With Tags', obs?.title);
  t('CDATA description parsed correctly', obs?.summary === 'CDATA <b>description</b> body', obs?.summary);
}

console.log('--- D. ENTITIES ---');
{
  const feed = xmlFeed([xmlItem({
    rawTitle: "Minutes of the Board&#39;s meeting &amp; hexcheck &#x26; done",
    link: 'https://www.federalreserve.gov/x',
    guid: 'https://www.federalreserve.gov/x',
    description: 'plain',
    pubDate: 'Wed, 29 Jul 2026 18:00:00 GMT',
  })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('D', fakeFetch);
  const obs = result.observations[0];
  t('&#39; (decimal) decoded', obs?.title.includes("Board's meeting"), obs?.title);
  t('&amp; decoded', obs?.title.includes('meeting & hexcheck'), obs?.title);
  t('&#x26; (hex) decoded', obs?.title.endsWith('& done'), obs?.title);
}

console.log('--- E. MISSING PUBDATE ---');
{
  const feed = xmlFeed([xmlItem({
    title: 'No pubDate here',
    link: 'https://www.federalreserve.gov/x',
    guid: 'https://www.federalreserve.gov/x',
    description: 'desc',
  })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('E', fakeFetch);
  const obs = result.observations[0];
  t('providerPublishedRaw null', obs?.providerPublishedRaw === null, JSON.stringify(obs));
  t('publicationPrecision = none', obs?.publicationPrecision === 'none');
}

console.log('--- F. MALFORMED TIMESTAMP TEXT (collector must NOT fix it) ---');
{
  const feed = xmlFeed([xmlItem({
    title: 'Bad timestamp',
    link: 'https://www.federalreserve.gov/x',
    guid: 'https://www.federalreserve.gov/x',
    description: 'desc',
    pubDate: 'this is not a real date',
  })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('F', fakeFetch);
  const obs = result.observations[0];
  t('providerPublishedRaw preserved verbatim', obs?.providerPublishedRaw === 'this is not a real date', obs?.providerPublishedRaw);
  t('publicationPrecision still timestamp (writer degrades, not collector)', obs?.publicationPrecision === 'timestamp');
}

console.log('--- G. NO TITLE ---');
{
  const feed = xmlFeed([
    xmlItem({ link: 'https://www.federalreserve.gov/no-title', guid: 'https://www.federalreserve.gov/no-title' }),
    xmlItem({ title: 'Valid item', link: 'https://www.federalreserve.gov/valid', guid: 'https://www.federalreserve.gov/valid' }),
  ]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('G', fakeFetch);
  t('exactly 1 observation preserved', result.observations.length === 1, JSON.stringify(result));
  t('rejected item recorded with fed_item_title_missing', result.rejectedItems.some((r) => r.reason === 'fed_item_title_missing'), JSON.stringify(result.rejectedItems));
}

console.log('--- H. NO GUID BUT VALID FED URL ---');
{
  const feed = xmlFeed([xmlItem({ title: 'No guid item', link: 'https://www.federalreserve.gov/no-guid' })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('H', fakeFetch);
  t('accepted with providerItemId null and canonicalUrl set',
    result.observations.length === 1 && result.observations[0].providerItemId === null
      && result.observations[0].canonicalUrl === 'https://www.federalreserve.gov/no-guid',
    JSON.stringify(result));
}

console.log('--- I. NO GUID + NO URL ---');
{
  const feed = xmlFeed([xmlItem({ title: 'No identity item' })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('I', fakeFetch);
  t('rejected: fed_item_identity_missing', result.observations.length === 0 && result.rejectedItems.some((r) => r.reason === 'fed_item_identity_missing'), JSON.stringify(result));
}

console.log('--- J. EXTERNAL URL ---');
{
  const feed = xmlFeed([xmlItem({ title: 'External link item', link: 'https://example.com/not-fed' })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('J', fakeFetch);
  t('rejected: fed_item_url_external, never emitted', result.observations.length === 0 && result.rejectedItems.some((r) => r.reason === 'fed_item_url_external'), JSON.stringify(result));
  t('no observation claims sourceCode federalreserve for this item', !result.observations.some((o) => o.canonicalUrl === 'https://example.com/not-fed'));
}

console.log('--- K. INVALID URL ---');
{
  const feed = xmlFeed([xmlItem({ title: 'Invalid url item', link: 'not-a-url-at-all' })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('K', fakeFetch);
  t('rejected: fed_item_url_invalid', result.observations.length === 0 && result.rejectedItems.some((r) => r.reason === 'fed_item_url_invalid'), JSON.stringify(result));
}

console.log('--- L. ONE FEED HTTP 500 ---');
{
  const goodFeed = xmlFeed([xmlItem({ title: 'Still works', link: 'https://www.federalreserve.gov/ok', guid: 'https://www.federalreserve.gov/ok' })]);
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { status: 500, body: 'error' },
    [SPEECHES_URL]: { body: goodFeed },
  });
  const result = await run('L', fakeFetch);
  t('speeches observations preserved despite monetary 500', result.observations.length === 1, JSON.stringify(result));
  t('monetary feed status explicitly failed', result.feeds.find((s) => s.feed === 'press_monetary')?.status === 'failed');
  t('failed status carries an error message', typeof result.feeds.find((s) => s.feed === 'press_monetary')?.error === 'string');
  t('speeches feed status ok', result.feeds.find((s) => s.feed === 'speeches')?.status === 'ok');
}

console.log('--- M. BOTH FEEDS FAIL ---');
{
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { status: 500, body: 'error' },
    [SPEECHES_URL]: { status: 503, body: 'error' },
  });
  const result = await run('M', fakeFetch);
  t('zero observations', result.observations.length === 0, JSON.stringify(result));
  t('both statuses failed', result.feeds.every((s) => s.status === 'failed'), JSON.stringify(result.feeds));
  t('exactly two feed statuses reported', result.feeds.length === 2);
}

console.log('--- N. TIMEOUT / ABORTERROR ---');
{
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { abort: true },
    [SPEECHES_URL]: { body: xmlFeed([]) },
  });
  const result = await run('N', fakeFetch);
  const monetary = result.feeds.find((s) => s.feed === 'press_monetary');
  t('monetary feed explicitly failed on abort', monetary?.status === 'failed', JSON.stringify(monetary));
  t('error message mentions timeout', /timeout/i.test(monetary?.error ?? ''), monetary?.error);
}

console.log('--- O. EMPTY BODY ---');
{
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { body: '' },
    [SPEECHES_URL]: { body: xmlFeed([]) },
  });
  const result = await run('O', fakeFetch);
  const monetary = result.feeds.find((s) => s.feed === 'press_monetary');
  t('empty body -> failed, not successful empty feed', monetary?.status === 'failed', JSON.stringify(monetary));
}

console.log('--- P. MALFORMED FEED ---');
{
  const fakeFetch = makeFakeFetch({
    [MONETARY_URL]: { body: '<html><body>not rss at all</body></html>' },
    [SPEECHES_URL]: { body: xmlFeed([]) },
  });
  const result = await run('P', fakeFetch);
  const monetary = result.feeds.find((s) => s.feed === 'press_monetary');
  t('malformed feed -> failed', monetary?.status === 'failed', JSON.stringify(monetary));
}

console.log('--- Q. CONCURRENCY ---');
{
  const callOrder = [];
  let resolveMonetary, resolveSpeeches;
  const pendingMonetary = new Promise((res) => { resolveMonetary = res; });
  const pendingSpeeches = new Promise((res) => { resolveSpeeches = res; });
  const fakeFetch = async (url) => {
    callOrder.push(url);
    if (url === MONETARY_URL) {
      await pendingMonetary;
      return { ok: true, status: 200, async text() { return xmlFeed([]); } };
    }
    await pendingSpeeches;
    return { ok: true, status: 200, async text() { return xmlFeed([]); } };
  };

  const resultPromise = run('Q', fakeFetch);
  await Promise.resolve();
  await Promise.resolve();
  t('both feed requests initiated before either resolves', callOrder.length === 2, JSON.stringify(callOrder));

  resolveMonetary();
  resolveSpeeches();
  const result = await resultPromise;
  t('both feeds resolved ok after release', result.feeds.every((s) => s.status === 'ok'));
}

console.log('--- R. RAW FIDELITY ---');
{
  const longTitle = 'A'.repeat(5000) + ' end-of-title-marker';
  const longDescription = 'B'.repeat(5000) + ' end-of-description-marker';
  const feed = xmlFeed([xmlItem({
    title: longTitle,
    link: 'https://www.federalreserve.gov/long',
    guid: 'https://www.federalreserve.gov/long',
    description: longDescription,
  })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  const result = await run('R', fakeFetch);
  const obs = result.observations[0];
  t('long title not truncated', obs?.title === longTitle);
  t('long description not truncated', obs?.summary === longDescription);
  t('no HTML-stripping / cleanText-style mutation on plain text', obs?.title.endsWith('end-of-title-marker'));
}

console.log('--- S. NO ARTICLE-PAGE FETCH ---');
{
  const feed = xmlFeed([xmlItem({ title: 'X', link: 'https://www.federalreserve.gov/x', guid: 'https://www.federalreserve.gov/x' })]);
  const fakeFetch = makeFakeFetch({ [MONETARY_URL]: { body: feed }, [SPEECHES_URL]: { body: xmlFeed([]) } });
  await run('S', fakeFetch);
  t('exactly two feed requests total (no article-page fetch)', fakeFetch.calls.length === 2, JSON.stringify(fakeFetch.calls.map((c) => c.url)));
  t('requests target exactly the two known feed URLs',
    fakeFetch.calls.every((c) => c.url === MONETARY_URL || c.url === SPEECHES_URL));
}

console.log('--- REGRESSION / ISOLATION STATIC CHECK ---');
{
  const source = readFileSync(new URL('../backend/news_sources/federal_reserve.ts', import.meta.url), 'utf8');
  const forbiddenIdentifiers = [
    'news_events', 'scoreArticle', 'dispatchActions', 'Committee', 'SourceRegistry',
    'GDELT', 'gdelt', 'NewsAPI', 'newsapi', 'writeRawNewsObservation', 'SupabaseClient',
  ];
  for (const name of forbiddenIdentifiers) {
    t(`federal_reserve.ts ne référence pas ${name}`, !source.includes(name));
  }
  t('RawNewsObservationInput importé en TYPE ONLY', /import type \{ RawNewsObservationInput \}/.test(source));
  t('aucun appel db.request / persistence', !/\.request\s*\(/.test(source));
}

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
