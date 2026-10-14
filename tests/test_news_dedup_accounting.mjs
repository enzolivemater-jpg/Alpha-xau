// News run accounting: every fetched article ends up in exactly one of
// unique, duplicates or discarded. A title too short for a reliable dedup
// key used to vanish from every counter, so a run could report
// fetched = 50 while duplicates + rejected + scored added up to 48.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const { __internals } = await loadBackendModule('ingest.ts');
const { deduplicate, dedupKeyOf } = __internals;
const registry = { resolve: (domain) => ({ reliability_score: domain === 'reuters.com' ? 90 : 50 }) };
const article = (title, domain = 'example.com', content = null) => ({
  title, domain, content, url: `https://${domain}/${encodeURIComponent(title)}`,
  publishedAt: new Date('2026-10-01T10:00:00Z'), provider: 'gdelt', dedupKey: dedupKeyOf(title),
});

const batch = [
  article('Gold hits record as real yields fall'),
  article('Gold hits record as real yields fall - Reuters', 'reuters.com'),
  article('GOLD HITS RECORD, AS REAL YIELDS FALL!', 'other.com', 'body'),
  article('Fed holds rates steady'),
  article('Gold up'),        // key 'gold up' (7 chars): too short
  article('???'),            // key '' : nothing usable
  article('金价创历史新高'),   // non-Latin: key '' after normalisation
];
const { unique, duplicates, discarded } = deduplicate(batch, registry);
assert.equal(unique.length, 2);
assert.equal(duplicates, 2);
assert.equal(discarded, 3);
assert.equal(unique.length + duplicates + discarded, batch.length, 'every fetched article is accounted for');
assert.equal(unique.find((a) => a.dedupKey.startsWith('gold hits')).domain, 'reuters.com', 'most reliable copy kept');
assert.deepEqual(deduplicate([], registry), { unique: [], duplicates: 0, discarded: 0 });
console.log('PASS deduplicate accounts for every article: unique + duplicates + discarded = fetched');

// The run reports discarded titles as rejected, so fetched = duplicates + rejected + scored.
const source = readFileSync(new URL('../backend/ingest.ts', import.meta.url), 'utf8');
assert.match(source, /const \{ unique, duplicates, discarded \} = deduplicate\(/);
assert.match(source, /const rejected = unique\.length - scored\.length \+ discarded;/);
console.log('PASS the ingestion run counts discarded titles as rejected');
