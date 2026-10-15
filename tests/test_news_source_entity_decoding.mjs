// Entity decoding of the four official news collectors (ECB, Federal
// Reserve, US Treasury, OFAC). Each module keeps a private decoder
// (decodeXmlEntities or decodeHtmlEntities); the verbatim function is extracted, transpiled and
// exercised here, then one collector is driven end to end.
//
// A numeric entity is decoded only when it names a Unicode scalar value.
// Otherwise it stays literal: String.fromCodePoint would throw on
// &#1114112;, and NUL (&#0;) or a lone surrogate (&#55296;) would produce
// text that PostgreSQL rejects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const SOURCES = [
  ['ecb', 'decodeXmlEntities'], ['federal_reserve', 'decodeXmlEntities'],
  ['us_treasury', 'decodeHtmlEntities'], ['ofac', 'decodeHtmlEntities'],
];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const CASES = [
  ['caf&#233;', 'café'],
  ['amp &#x26; done', 'amp & done'],
  ['&amp;lt;', '&lt;'],
  ['max &#1114111;', 'max \u{10FFFF}'],
  ['beyond &#1114112;', 'beyond &#1114112;'],
  ['huge &#99999999999;', 'huge &#99999999999;'],
  ['high &#55296;', 'high &#55296;'],
  ['low &#xDFFF;', 'low &#xDFFF;'],
  ['nul &#0;', 'nul &#0;'],
  ['hexnul &#x0;', 'hexnul &#x0;'],
];

for (const [name, fn] of SOURCES) {
  const source = readFileSync(new URL(`../backend/news_sources/${name}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(extractFunction(source, fn), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const decode = new Function(`${js}; return ${fn};`)();
  for (const [raw, expected] of CASES) {
    let decoded;
    assert.doesNotThrow(() => { decoded = decode(raw); }, `${name}: ${raw}`);
    assert.equal(decoded, expected, `${name}: ${raw}`);
    assert.ok(decoded.isWellFormed() && !decoded.includes('\u0000'), `${name}: ${raw}`);
  }
}
console.log(`PASS ${SOURCES.length} official collectors decode only Unicode scalar values, never throw`);

// End to end: an ECB item with such entities is accepted with literal text,
// and neighbouring items are unaffected.
const { collectEcbNews } = await import('../backend/news_sources/ecb.ts');
const PRESS_URL = 'https://www.ecb.europa.eu/rss/press.html';
const STATPRESS_URL = 'https://www.ecb.europa.eu/rss/statpress.html';
const item = (n, title) => `<item><title>${title}</title><link>https://www.ecb.europa.eu/e${n}</link>`
  + `<guid>https://www.ecb.europa.eu/e${n}</guid><pubDate>Tue, 01 Sep 2026 18:00:00 +0200</pubDate></item>`;
const feed = (items) => `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>ECB</title>`
  + `<link>https://www.ecb.europa.eu/</link><description>t</description>${items.join('')}</channel></rss>`;
const bodies = {
  [PRESS_URL]: feed([item(1, 'Rates &#55296; decision'), item(2, 'Huge &#1114112; ok'), item(3, 'Plain item')]),
  [STATPRESS_URL]: feed([item(4, 'Stat item')]),
};
const result = await collectEcbNews({
  fetchFn: async (url) => ({ ok: true, status: 200, async text() { return bodies[url]; } }),
  ingestRunId: '11111111-1111-4111-8111-111111111111',
  observedAt: '2026-09-02T18:05:00Z',
});
const titles = Object.fromEntries(result.observations.map((o) => [o.canonicalUrl, o.title]));
assert.equal(titles['https://www.ecb.europa.eu/e1'], 'Rates &#55296; decision');
assert.equal(titles['https://www.ecb.europa.eu/e2'], 'Huge &#1114112; ok');
assert.equal(titles['https://www.ecb.europa.eu/e3'], 'Plain item');
assert.ok(result.observations.every((o) => o.title.isWellFormed()));
console.log('PASS ECB collector keeps invalid numeric entities literal and the batch intact');
