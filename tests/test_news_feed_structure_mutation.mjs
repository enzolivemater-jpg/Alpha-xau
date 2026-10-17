/**
 * ECB and Federal Reserve RSS collectors: structural mutation of a feed with a
 * mock fetch (no network). A feed item must only ever carry the fields written
 * inside its own <item>…</item>. A missing </item> used to let the block run on
 * into the next item, so the first item silently took the next item's
 * description and publication date. A feed of unclosed items must not cost
 * quadratic time either. Offline and deterministic: wall-clock ceiling only.
 */
import assert from 'node:assert/strict';

import { collectEcbNews } from '../backend/news_sources/ecb.ts';
import { collectFederalReserveNews } from '../backend/news_sources/federal_reserve.ts';

const COLLECTORS = [
  { name: 'ECB', collect: collectEcbNews, host: 'https://www.ecb.europa.eu/press/pr/date/2026', },
  { name: 'Fed', collect: collectFederalReserveNews, host: 'https://www.federalreserve.gov/newsevents/pressreleases' },
];
const run = (collector, xml) => collector.collect({
  ingestRunId: '00000000-0000-4000-8000-000000000001', observedAt: '2026-10-01T12:00:00.000Z',
  fetchFn: async () => ({ ok: true, status: 200, text: async () => xml }),
});

/** Three items; item 1 deliberately has no pubDate and no description of its own. */
const itemsOf = (host) => [
  { title: 'First statement', guid: `${host}/a`, link: `${host}/a.html`, description: 'About A', pubDate: 'Wed, 30 Sep 2026 13:15:00 GMT' },
  { title: 'Second statement, no date', guid: `${host}/b`, link: `${host}/b.html`, description: null, pubDate: null },
  { title: 'Third statement', guid: `${host}/c`, link: `${host}/c.html`, description: 'About C', pubDate: 'Thu, 01 Oct 2026 09:00:00 GMT' },
];
const itemXml = (item, { close = true, open = true } = {}) => [
  open ? '<item>' : '',
  `<title>${item.title}</title>`,
  `<guid>${item.guid}</guid>`,
  `<link>${item.link}</link>`,
  item.description === null ? '' : `<description>${item.description}</description>`,
  item.pubDate === null ? '' : `<pubDate>${item.pubDate}</pubDate>`,
  close ? '</item>' : '',
].join('');
const feedXml = (parts) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${parts.join('')}</channel></rss>`;

const failures = [];
const note = (label, message) => { if (failures.length < 20) failures.push(`${label}: ${message}`); };

for (const collector of COLLECTORS) {
  const items = itemsOf(collector.host);
  const tupleOf = (o) => JSON.stringify([o.title, o.providerItemId, o.canonicalUrl, o.summary, o.providerPublishedRaw]);
  const expected = new Set(items.map((item) => JSON.stringify([item.title, item.guid, item.link, item.description, item.pubDate])));
  const base = await run(collector, feedXml(items.map((item) => itemXml(item))));
  const accepted = base.observations.filter((o, i, all) => all.findIndex((x) => tupleOf(x) === tupleOf(o)) === i);
  // Each of the two feeds is fetched once and returns the same XML: the unique tuples are the 3 items.
  assert.equal(accepted.length, 3, `${collector.name}: base feed gives three items`);
  for (const o of accepted) assert.ok(expected.has(tupleOf(o)), `${collector.name}: base item matches its own source item`);

  const cases = [];
  for (let i = 0; i < items.length; i += 1) {
    cases.push([`</item> missing on item ${i}`, items.map((item, j) => itemXml(item, { close: j !== i }))]);
    cases.push([`<item> missing on item ${i}`, items.map((item, j) => itemXml(item, { open: j !== i }))]);
    cases.push([`item ${i} duplicated`, [...items.slice(0, i + 1), items[i], ...items.slice(i + 1)].map((item) => itemXml(item))]);
    cases.push([`item ${i} removed`, items.filter((_, j) => j !== i).map((item) => itemXml(item))]);
  }
  cases.push(['every </item> missing', items.map((item) => itemXml(item, { close: false }))]);
  cases.push(['description holds a literal item', items.map((item, j) => itemXml(j === 0
    ? { ...item, description: '<![CDATA[x </item><item><title>Injected</title></item> y]]>' } : item))]);

  for (const [label, parts] of cases) {
    try {
      const result = await run(collector, feedXml(parts));
      for (const o of result.observations) {
        const source = items.find((item) => item.guid === o.providerItemId);
        if (!source) { note(`${collector.name} ${label}`, `observation without a source item: ${tupleOf(o).slice(0, 160)}`); continue; }
        // A field may be lost (null) when an item is cut short, but a value that belongs to
        // another item is cross-item attribution: a wrong publication date or description.
        const fields = [['title', o.title, source.title], ['link', o.canonicalUrl, source.link],
          ['description', o.summary, source.description], ['pubDate', o.providerPublishedRaw, source.pubDate]];
        for (const [field, got, want] of fields) {
          if (got !== null && got !== want) {
            note(`${collector.name} ${label}`, `${source.title}: ${field} = ${JSON.stringify(got)} but its own is ${JSON.stringify(want)}`);
          }
        }
      }
    } catch (error) {
      note(`${collector.name} ${label}`, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error}`);
    }
  }

  // Cost: thousands of unclosed items must not be quadratic.
  const unclosed = '<item><title>x</title>'.repeat(20_000);
  const started = performance.now();
  try { await run(collector, feedXml([unclosed])); } catch { /* a refusal is fine */ }
  const elapsed = performance.now() - started;
  if (elapsed > 3000) note(`${collector.name} unclosed items`, `${Math.round(elapsed)} ms for ${unclosed.length} characters (limit 3000 ms)`);
}

assert.deepEqual(failures, [], `FEED STRUCTURE failures (first ${failures.length}):\n${failures.join('\n')}`);
console.log('PASS ECB/Fed feeds: no observation mixes fields of two items under missing, duplicated or injected item tags; unclosed items stay cheap');
