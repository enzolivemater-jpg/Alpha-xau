import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { mapDolUiWeeklyClaimsReleaseToEventFacts } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import { parseDolUiWeeklyClaimsText } from '../backend/event_facts/dol_ui_weekly_claims_text_parser.ts';
import {
  DOL_UI_PDF_DECODER_BOUNDARY_VERSION,
  decodeRetainedDolUiWeeklyClaimsPdf,
  normalizeDolPdftotextOutput,
  verifyDolUiWeeklyClaimsPdfArtifact,
} from '../scripts/decode_dol_ui_weekly_claims_pdf.mjs';

const pdfUrl = new URL('./fixtures/dol_ui_weekly_claims_2026_10_01.pdf', import.meta.url);
const manifestUrl = new URL('./fixtures/dol_ui_weekly_claims_2026_10_01.artifact.json', import.meta.url);
const retainedText = readFileSync(new URL(
  './fixtures/dol_ui_weekly_claims_2026_10_01.pdftotext.txt', import.meta.url,
), 'utf8');
const expectedPayload = JSON.parse(readFileSync(new URL(
  './fixtures/dol_ui_weekly_claims_2026_10_01.json', import.meta.url,
), 'utf8'));
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const pdfBytes = readFileSync(pdfUrl);

assert.equal(DOL_UI_PDF_DECODER_BOUNDARY_VERSION, 'dol-ui-pdf-decoder-boundary-v1');
assert.deepEqual(verifyDolUiWeeklyClaimsPdfArtifact(pdfBytes, manifest), {
  bytes: 538666,
  sha256: 'e33ba5adcf0eb213d1d60ee96b55b9486d9a871250a99e28d6258a424cc0294e',
  archivedSourceUrl: 'https://www.dol.gov/sites/dolgov/files/OPA/newsreleases/ui-claims/20261543.pdf',
});
assert.equal(createHash('sha256').update(pdfBytes).digest('hex'), manifest.pdfSha256);
console.log('PASS retained official archive PDF has the exact frozen bytes and hash');

const decoded = decodeRetainedDolUiWeeklyClaimsPdf({
  pdfPath: pdfUrl,
  manifestPath: manifestUrl,
});
assert.equal(decoded.normalizedText, retainedText);
assert.equal(Buffer.byteLength(decoded.normalizedText), manifest.normalizedTextBytes);
assert.equal(
  createHash('sha256').update(decoded.normalizedText).digest('hex'),
  manifest.normalizedTextSha256,
);
console.log('PASS bounded pdftotext -layout decoding reproduces the retained projection exactly');

const parsed = parseDolUiWeeklyClaimsText(decoded.normalizedText);
assert.equal(parsed.kind, 'PARSED', JSON.stringify(parsed));
assert.deepEqual(parsed.payload, expectedPayload);
assert.equal(mapDolUiWeeklyClaimsReleaseToEventFacts(parsed.payload).kind, 'RESOLVED');
console.log('PASS raw PDF to parser to strict adapter composition is deterministic');

const corrupted = Buffer.from(pdfBytes);
corrupted[256] ^= 0xff;
assert.throws(
  () => verifyDolUiWeeklyClaimsPdfArtifact(corrupted, manifest),
  /DOL_PDF_ARTIFACT_INTEGRITY_MISMATCH/,
);
assert.throws(
  () => verifyDolUiWeeklyClaimsPdfArtifact(Buffer.from('not a pdf'), manifest),
  /DOL_PDF_ARTIFACT_MALFORMED/,
);
assert.throws(
  () => normalizeDolPdftotextOutput('wrong text', manifest),
  /DOL_PDF_TEXT_INTEGRITY_MISMATCH/,
);
assert.throws(
  () => verifyDolUiWeeklyClaimsPdfArtifact(pdfBytes, {
    ...manifest,
    archivedSourceUrl: 'https://example.com/untrusted.pdf',
  }),
  /DOL_ARTIFACT_MANIFEST_MALFORMED/,
);
console.log('PASS corrupted bytes, wrong text, malformed files, and untrusted provenance fail closed');

let decoderCalled = false;
assert.throws(
  () => decodeRetainedDolUiWeeklyClaimsPdf({
    pdfPath: new URL('./fixtures/dol_ui_weekly_claims_2026_10_01.json', import.meta.url),
    manifestPath: manifestUrl,
    runDecoder: () => {
      decoderCalled = true;
      return '';
    },
  }),
  /DOL_PDF_ARTIFACT_MALFORMED/,
);
assert.equal(decoderCalled, false);
console.log('PASS artifact authentication occurs before external decoder invocation');

const source = readFileSync(new URL(
  '../scripts/decode_dol_ui_weekly_claims_pdf.mjs', import.meta.url,
), 'utf8');
assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|XMLHttpRequest/);
assert.doesNotMatch(source, /supabase|postgres|\bsql\s*`/i);
assert.doesNotMatch(source, /Date\.now|new Date|Math\.random|OpenAI|Anthropic|LLM/i);
assert.match(source, /timeout: 15_000/);
assert.match(source, /maxBuffer: MAX_TEXT_BYTES/);
console.log('PASS decoder boundary has no network, database, clock, model, or runtime activation');
