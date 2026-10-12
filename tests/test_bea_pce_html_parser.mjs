import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mapBeaPceReleaseToEventFacts } from '../backend/event_facts/bea_pce_adapter.ts';
import {
  BEA_PCE_HTML_PARSER_VERSION,
  decodeBeaPceHtmlArtifact,
  parseAuthenticatedBeaPceHtml,
  parseRetainedBeaPceHtmlArtifact,
} from '../scripts/parse_bea_pce_html.mjs';

const artifactUrl = month => new URL(
  `./fixtures/bea_pce_2026_${month}.archive.html.gz`, import.meta.url,
);
const manifestUrl = month => new URL(
  `./fixtures/bea_pce_2026_${month}.artifact.json`, import.meta.url,
);
const projectionUrl = month => new URL(
  `./fixtures/bea_pce_2026_${month}.json`, import.meta.url,
);
const loadManifest = month => JSON.parse(readFileSync(manifestUrl(month), 'utf8'));
const loadProjection = month => JSON.parse(readFileSync(projectionUrl(month), 'utf8'));
const loadHtml = month => decodeBeaPceHtmlArtifact(
  readFileSync(artifactUrl(month)), loadManifest(month),
);
const parseRetained = month => parseRetainedBeaPceHtmlArtifact({
  htmlPath: artifactUrl(month),
  manifestPath: manifestUrl(month),
});
const sortedMetrics = metrics => [...metrics].sort((left, right) =>
  `${left.seriesLabel}:${left.changeBasis}`.localeCompare(
    `${right.seriesLabel}:${right.changeBasis}`,
  ));
const assertProjection = (actual, expected) => {
  assert.deepEqual(
    { ...actual, summary: { ...actual.summary, metrics: sortedMetrics(actual.summary.metrics) } },
    { ...expected, summary: { ...expected.summary, metrics: sortedMetrics(expected.summary.metrics) } },
  );
};

assert.equal(BEA_PCE_HTML_PARSER_VERSION, 'bea-pce-html-parser-v1');

for (const month of ['07', '08']) {
  const parsed = parseRetained(month);
  assert.equal(parsed.kind, 'PARSED', JSON.stringify(parsed));
  const expected = loadProjection(month);
  assertProjection(parsed.payload, expected);
  assert.equal(parsed.artifact.rawHtmlSha256, expected.release.archiveSha256);
  const mapped = mapBeaPceReleaseToEventFacts(parsed.payload);
  assert.equal(mapped.kind, 'RESOLVED', JSON.stringify(mapped));
  assert.deepEqual(parseRetained(month), parsed);
}
console.log('PASS exact July/August raw BEA HTML reproduces reviewed PCE facts and adapter states');

const changedNarrativeHtml = loadHtml('08').replace(
  'for August increased 0.3 percent</a>',
  'for August increased 0.4 percent</a>',
);
const changedNarrative = parseAuthenticatedBeaPceHtml(
  changedNarrativeHtml, loadManifest('08'),
);
assert.equal(changedNarrative.kind, 'CONFLICT');
assert.equal(changedNarrative.reason, 'PCE_NARRATIVE_TABLE_CONFLICT');

const missingYoyHtml = loadHtml('08').replace(
  'From the same month one year ago,',
  'Missing annual comparison,',
);
const missingYoy = parseAuthenticatedBeaPceHtml(missingYoyHtml, loadManifest('08'));
assert.equal(missingYoy.kind, 'MALFORMED');
assert.equal(missingYoy.reason, 'REQUIRED_RELEASE_PARAGRAPH_AMBIGUOUS');
console.log('PASS narrative/table contradictions and missing required evidence fail closed');

const untrustedManifest = {
  ...loadManifest('08'),
  sourceUrl: 'https://example.com/news/2026/personal-income-and-outlays-august-2026',
};
const untrusted = parseAuthenticatedBeaPceHtml(loadHtml('08'), untrustedManifest);
assert.equal(untrusted.kind, 'MALFORMED');
assert.equal(untrusted.reason, 'BEA_PCE_ARTIFACT_MANIFEST_UNTRUSTED');

const wrongArtifact = parseRetainedBeaPceHtmlArtifact({
  htmlPath: projectionUrl('08'),
  manifestPath: manifestUrl('08'),
});
assert.deepEqual(wrongArtifact, {
  kind: 'MALFORMED',
  parserVersion: BEA_PCE_HTML_PARSER_VERSION,
  reason: 'ARTIFACT_AUTHENTICATION_OR_DECODING_FAILED',
});
console.log('PASS untrusted provenance and unauthenticated artifact bytes fail before parsing');

const source = readFileSync(new URL('../scripts/parse_bea_pce_html.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|XMLHttpRequest/);
assert.doesNotMatch(source, /supabase|postgres|\bsql\s*`/i);
assert.doesNotMatch(source, /process\.env|Date\.now|new Date|Math\.random|OpenAI|Anthropic|LLM/i);
console.log('PASS parser has no network, database, environment, clock, model, or runtime activation');
