import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { mapDolUiWeeklyClaimsReleaseToEventFacts } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import {
  DOL_UI_CLAIMS_TEXT_PARSER_VERSION,
  parseDolUiWeeklyClaimsText,
} from '../backend/event_facts/dol_ui_weekly_claims_text_parser.ts';

const textUrl = new URL(
  './fixtures/dol_ui_weekly_claims_2026_10_01.pdftotext.txt', import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL(
  './fixtures/dol_ui_weekly_claims_2026_10_01.artifact.json', import.meta.url,
), 'utf8'));
const expectedPayload = JSON.parse(readFileSync(new URL(
  './fixtures/dol_ui_weekly_claims_2026_10_01.json', import.meta.url,
), 'utf8'));
const retainedText = readFileSync(textUrl, 'utf8');

assert.equal(DOL_UI_CLAIMS_TEXT_PARSER_VERSION, 'dol-ui-claims-text-parser-v1');
assert.equal(Buffer.byteLength(retainedText), manifest.normalizedTextBytes);
assert.equal(
  createHash('sha256').update(retainedText).digest('hex'),
  manifest.normalizedTextSha256,
);
assert.equal(manifest.sourceUrl, 'https://www.dol.gov/ui/data.pdf');
assert.equal(manifest.pdfBytes, 538666);
assert.equal(
  manifest.pdfSha256,
  'e33ba5adcf0eb213d1d60ee96b55b9486d9a871250a99e28d6258a424cc0294e',
);
console.log('PASS retained official text projection and source-PDF provenance are frozen');

const parsed = parseDolUiWeeklyClaimsText(retainedText);
assert.equal(parsed.kind, 'PARSED', JSON.stringify(parsed));
assert.deepEqual(parsed.payload, expectedPayload);
assert.deepEqual(parseDolUiWeeklyClaimsText(retainedText), parsed);
console.log('PASS exact official text deterministically reproduces the reviewed payload');

const mapped = mapDolUiWeeklyClaimsReleaseToEventFacts(parsed.payload);
assert.equal(mapped.kind, 'RESOLVED', JSON.stringify(mapped));
assert.equal(mapped.canonicalEventState.facts.release_family, 'US_JOBLESS_CLAIMS');
assert.deepEqual(
  mapped.canonicalEventState.facts.metrics.map(metric => [
    metric.metric_code, metric.reference_period.date, metric.actual.value,
  ]),
  [
    ['CLAIMS_4WK_AVERAGE', '2026-09-26', '200'],
    ['CONTINUING_CLAIMS', '2026-09-19', '1701'],
    ['INITIAL_CLAIMS', '2026-09-26', '197'],
  ],
);
console.log('PASS parser-to-adapter composition preserves exact canonical facts');

assert.deepEqual(parseDolUiWeeklyClaimsText(null), {
  kind: 'UNAVAILABLE',
  parserVersion: DOL_UI_CLAIMS_TEXT_PARSER_VERSION,
  reason: 'OFFICIAL_TEXT_UNAVAILABLE',
});
assert.deepEqual(parseDolUiWeeklyClaimsText('unrelated release'), {
  kind: 'UNSUPPORTED',
  parserVersion: DOL_UI_CLAIMS_TEXT_PARSER_VERSION,
  reason: 'UNSUPPORTED_OFFICIAL_RELEASE',
});
assert.equal(
  parseDolUiWeeklyClaimsText(retainedText.replace('Release Number: USDL 26-1543-NAT', ''))
    .reason,
  'REQUIRED_OFFICIAL_TEXT_EVIDENCE_MISSING_OR_AMBIGUOUS',
);
assert.equal(
  parseDolUiWeeklyClaimsText(`${retainedText}\n${retainedText}`).reason,
  'REQUIRED_OFFICIAL_TEXT_EVIDENCE_MISSING_OR_AMBIGUOUS',
);
assert.equal(
  parseDolUiWeeklyClaimsText(retainedText.replace('197,000, a decrease', '19,70,00, a decrease'))
    .reason,
  'CLAIMS_VALUE_MALFORMED',
);
assert.equal(
  parseDolUiWeeklyClaimsText(`${'x'.repeat(1_000_001)} UNEMPLOYMENT INSURANCE WEEKLY CLAIMS`)
    .reason,
  'OFFICIAL_TEXT_MALFORMED',
);
assert.equal(
  parseDolUiWeeklyClaimsText(retainedText.replaceAll('September 19', 'September 12'))
    .reason,
  'OFFICIAL_PERIOD_CONFLICT',
);
assert.equal(
  parseDolUiWeeklyClaimsText(retainedText.replace('Thursday, October 1, 2026', 'Thursday, October 2, 2026'))
    .reason,
  'PUBLICATION_DATE_MALFORMED',
);
console.log('PASS missing, unsupported, ambiguous, malformed, and oversized text fail closed');

const source = readFileSync(new URL(
  '../backend/event_facts/dol_ui_weekly_claims_text_parser.ts', import.meta.url,
), 'utf8');
const executable = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
assert.doesNotMatch(executable, /\bfetch\s*\(|XMLHttpRequest|node:https|node:http/);
assert.doesNotMatch(executable, /supabase|postgres|\bsql\s*`/i);
assert.doesNotMatch(executable, /process\.env|Math\.random|crypto\.random|Date\.now|new Date/);
assert.doesNotMatch(executable, /OpenAI|Anthropic|LLM|gold_direction|price_action/i);
console.log('PASS parser has no network, database, clock, environment, model, or market side effect');
