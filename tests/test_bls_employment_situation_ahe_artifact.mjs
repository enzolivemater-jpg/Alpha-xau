import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import {
  BLS_EMPLOYMENT_AHE_ARTIFACT_AUDIT_VERSION,
  auditRetainedBlsEmploymentSituationAheArtifact,
  decodeBlsEmploymentSituationHtmlArtifact,
  inspectBlsEmploymentSituationAheEvidence,
  verifyBlsEmploymentSituationHtmlArtifact,
} from '../scripts/audit_bls_employment_situation_ahe_artifact.mjs';

const artifact = month => new URL(
  `./fixtures/bls_employment_situation_2026_${month}.archive.html.gz`, import.meta.url,
);
const manifestUrl = month => new URL(
  `./fixtures/bls_employment_situation_2026_${month}.artifact.json`, import.meta.url,
);
const loadManifest = month => JSON.parse(readFileSync(manifestUrl(month), 'utf8'));
const loadBytes = month => readFileSync(artifact(month));
const audit = month => auditRetainedBlsEmploymentSituationAheArtifact({
  htmlPath: artifact(month),
  manifestPath: manifestUrl(month),
});

assert.equal(
  BLS_EMPLOYMENT_AHE_ARTIFACT_AUDIT_VERSION,
  'bls-employment-ahe-artifact-audit-v1',
);

for (const [month, compressedBytes, compressedHash, rawHtmlBytes, rawHtmlHash] of [
  ['07', 93_928, 'e0b3e348f9009e41256094b33f684ede691af889be2370d17226b1400f706d2f', 1_066_217, '4602e50c53ccfc789d52ef73191171d9918141516b7734524e70f2b8326024a5'],
  ['08', 93_518, 'fdd5fbf26f27f1c776d8404bd2ca910959d3f48b9cf7e5fec59066896149442a', 1_064_564, '6d83eeecf867f1e8c9a2a5449a4b064896062f4529ad36c4ff2a37e6968b7481'],
]) {
  const compressed = loadBytes(month);
  const manifest = loadManifest(month);
  assert.equal(compressed.byteLength, compressedBytes);
  assert.equal(createHash('sha256').update(compressed).digest('hex'), compressedHash);
  assert.deepEqual(verifyBlsEmploymentSituationHtmlArtifact(compressed, manifest), {
    sourceUrl: manifest.sourceUrl,
    compressedBytes,
    compressedSha256: compressedHash,
    rawHtmlBytes,
    rawHtmlSha256: rawHtmlHash,
    releaseId: month === '07' ? 'USDL-26-1291' : 'USDL-26-1435',
  });
  const decoded = Buffer.from(decodeBlsEmploymentSituationHtmlArtifact(compressed, manifest));
  assert.equal(decoded.byteLength, rawHtmlBytes);
  assert.equal(createHash('sha256').update(decoded).digest('hex'), rawHtmlHash);
  assert.deepEqual(decoded, gunzipSync(compressed));
}
console.log('PASS bounded gzip decoding authenticates exact official archive HTML before parsing');

const july = audit('07');
assert.deepEqual(july.aheLevelValues, ['$36.47', '$37.49', '$37.60', '$37.62']);
assert.deepEqual(july.adjacentPercentRow, {
  rowId: 'ces_table10.r.4.1.4.1',
  parentRowId: 'ces_table10.r.4.1.4',
  parentLabel: 'Index of aggregate weekly hours (2007=100)(3)',
  values: ['0.1', '0.1', '0.0', '0.0'],
});
assert.deepEqual(july.evidence, {
  state: 'UNAVAILABLE',
  value: null,
  reason: 'AHE_MOM_PERCENT_NOT_EXPLICIT_IN_RELEASE',
});
console.log('PASS July adjacent 0.0 belongs to aggregate weekly hours and AHE MoM fails closed');

const august = audit('08');
assert.deepEqual(august.aheLevelValues, ['$36.62', '$37.59', '$37.65', '$37.75']);
assert.deepEqual(august.adjacentPercentRow, {
  rowId: 'ces_table10.r.4.1.4.1',
  parentRowId: 'ces_table10.r.4.1.4',
  parentLabel: 'Index of aggregate weekly hours (2007=100)(3)',
  values: ['-0.1', '0.0', '0.1', '0.3'],
});
assert.deepEqual(august.evidence, {
  state: 'KNOWN',
  value: 0.3,
  reason: 'EXPLICIT_RELEASE_NARRATIVE_PERCENT',
});
console.log('PASS August 0.3 AHE MoM is admitted only from the explicit release narrative');

const corrupted = Buffer.from(loadBytes('07'));
corrupted[512] ^= 0xff;
assert.throws(
  () => verifyBlsEmploymentSituationHtmlArtifact(corrupted, loadManifest('07')),
  /BLS_AHE_HTML_ARTIFACT_INTEGRITY_MISMATCH/,
);
assert.throws(
  () => verifyBlsEmploymentSituationHtmlArtifact(loadBytes('07'), {
    ...loadManifest('07'),
    sourceUrl: 'https://example.com/untrusted.htm',
  }),
  /BLS_AHE_ARTIFACT_MANIFEST_UNTRUSTED/,
);
const alteredHtml = decodeBlsEmploymentSituationHtmlArtifact(
  loadBytes('08'), loadManifest('08'),
).replace('or 0.3 percent', 'or 9.9 percent');
assert.throws(
  () => inspectBlsEmploymentSituationAheEvidence(alteredHtml, loadManifest('08')),
  /BLS_AHE_RELEASE_EVIDENCE_MISMATCH/,
);
console.log('PASS corrupt bytes, untrusted sources, and altered narrative evidence fail closed');

const source = readFileSync(new URL(
  '../scripts/audit_bls_employment_situation_ahe_artifact.mjs', import.meta.url,
), 'utf8');
assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|XMLHttpRequest/);
assert.doesNotMatch(source, /supabase|postgres|\bsql\s*`/i);
assert.doesNotMatch(source, /process\.env|Date\.now|new Date|Math\.random|OpenAI|Anthropic|LLM/i);
console.log('PASS artifact audit has no network, database, environment, clock, model, or runtime activation');
