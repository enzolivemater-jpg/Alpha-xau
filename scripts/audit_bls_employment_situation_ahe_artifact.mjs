#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { JSDOM } from 'jsdom';

export const BLS_EMPLOYMENT_AHE_ARTIFACT_AUDIT_VERSION =
  'bls-employment-ahe-artifact-audit-v1';

const MAX_HTML_BYTES = 2_000_000;
const MAX_COMPRESSED_BYTES = 500_000;
const MANIFEST_KEYS = [
  'compressedArtifactFile', 'compressedBytes', 'compressedSha256',
  'contentEncoding', 'mediaType', 'rawHtmlBytes', 'rawHtmlSha256', 'retrievedAt',
  'sourceUrl',
];
const AHE_ROW_ID = 'ces_table10.r.4.1.2';
const ADJACENT_PERCENT_ROW_ID = 'ces_table10.r.4.1.4.1';
const ADJACENT_PERCENT_PARENT_ID = 'ces_table10.r.4.1.4';

const EXPECTED_ARTIFACTS = Object.freeze({
  'https://www.bls.gov/news.release/archives/empsit_08072026.htm': Object.freeze({
    compressedArtifactFile: 'bls_employment_situation_2026_07.archive.html.gz',
    compressedBytes: 93_928,
    compressedSha256: 'e0b3e348f9009e41256094b33f684ede691af889be2370d17226b1400f706d2f',
    rawHtmlBytes: 1_066_217,
    rawHtmlSha256: '4602e50c53ccfc789d52ef73191171d9918141516b7734524e70f2b8326024a5',
    releaseId: 'USDL-26-1291',
    headerTitle: 'THE EMPLOYMENT SITUATION - JULY 2026',
    aheLevelValues: ['$36.47', '$37.49', '$37.60', '$37.62'],
    adjacentPercentValues: ['0.1', '0.1', '0.0', '0.0'],
    narrative: 'In July, average hourly earnings for all employees on private nonfarm payrolls, at $37.62, were little changed (+2 cents). Over the year, average hourly earnings have increased by 3.2 percent.',
    monthOverMonthPercent: null,
  }),
  'https://www.bls.gov/news.release/archives/empsit_09042026.htm': Object.freeze({
    compressedArtifactFile: 'bls_employment_situation_2026_08.archive.html.gz',
    compressedBytes: 93_518,
    compressedSha256: 'fdd5fbf26f27f1c776d8404bd2ca910959d3f48b9cf7e5fec59066896149442a',
    rawHtmlBytes: 1_064_564,
    rawHtmlSha256: '6d83eeecf867f1e8c9a2a5449a4b064896062f4529ad36c4ff2a37e6968b7481',
    releaseId: 'USDL-26-1435',
    headerTitle: 'THE EMPLOYMENT SITUATION - AUGUST 2026',
    aheLevelValues: ['$36.62', '$37.59', '$37.65', '$37.75'],
    adjacentPercentValues: ['-0.1', '0.0', '0.1', '0.3'],
    narrative: 'In August, average hourly earnings for all employees on private nonfarm payrolls rose by 10 cents, or 0.3 percent, to $37.75. Over the year, average hourly earnings have increased by 3.1 percent.',
    monthOverMonthPercent: 0.3,
  }),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function requireManifest(manifest) {
  if (!hasExactKeys(manifest, MANIFEST_KEYS)
      || manifest.mediaType !== 'text/html'
      || manifest.contentEncoding !== 'gzip'
      || typeof manifest.sourceUrl !== 'string'
      || typeof manifest.compressedArtifactFile !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.retrievedAt)
      || !Number.isSafeInteger(manifest.compressedBytes)
      || !/^[0-9a-f]{64}$/.test(manifest.compressedSha256)
      || !Number.isSafeInteger(manifest.rawHtmlBytes)
      || !/^[0-9a-f]{64}$/.test(manifest.rawHtmlSha256)) {
    throw new Error('BLS_AHE_ARTIFACT_MANIFEST_MALFORMED');
  }
  const expected = EXPECTED_ARTIFACTS[manifest.sourceUrl];
  if (!expected
      || manifest.compressedArtifactFile !== expected.compressedArtifactFile
      || manifest.compressedBytes !== expected.compressedBytes
      || manifest.compressedSha256 !== expected.compressedSha256
      || manifest.rawHtmlBytes !== expected.rawHtmlBytes
      || manifest.rawHtmlSha256 !== expected.rawHtmlSha256) {
    throw new Error('BLS_AHE_ARTIFACT_MANIFEST_UNTRUSTED');
  }
  return expected;
}

export function verifyBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest) {
  const expected = requireManifest(manifest);
  if (!(compressedBytes instanceof Uint8Array)
      || compressedBytes.byteLength === 0
      || compressedBytes.byteLength > MAX_COMPRESSED_BYTES
      || compressedBytes[0] !== 0x1f
      || compressedBytes[1] !== 0x8b) {
    throw new Error('BLS_AHE_HTML_ARTIFACT_MALFORMED');
  }
  if (compressedBytes.byteLength !== manifest.compressedBytes
      || sha256(compressedBytes) !== manifest.compressedSha256) {
    throw new Error('BLS_AHE_HTML_ARTIFACT_INTEGRITY_MISMATCH');
  }
  return {
    sourceUrl: manifest.sourceUrl,
    compressedBytes: compressedBytes.byteLength,
    compressedSha256: manifest.compressedSha256,
    rawHtmlBytes: manifest.rawHtmlBytes,
    rawHtmlSha256: manifest.rawHtmlSha256,
    releaseId: expected.releaseId,
  };
}

export function decodeBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest) {
  verifyBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest);
  let htmlBytes;
  try {
    htmlBytes = gunzipSync(compressedBytes, { maxOutputLength: MAX_HTML_BYTES });
  } catch {
    throw new Error('BLS_AHE_HTML_DECODE_FAILED');
  }
  if (htmlBytes.byteLength !== manifest.rawHtmlBytes
      || sha256(htmlBytes) !== manifest.rawHtmlSha256
      || !/<!doctype html>/i.test(
        Buffer.from(htmlBytes.subarray(0, 200)).toString('utf8'),
      )) {
    throw new Error('BLS_AHE_DECODED_HTML_INTEGRITY_MISMATCH');
  }
  return htmlBytes.toString('utf8');
}

function normalizedText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function rowValues(document, rowHeaderId) {
  const rowHeader = document.getElementById(rowHeaderId);
  if (!rowHeader) throw new Error('BLS_AHE_EXPECTED_TABLE_ROW_MISSING');
  const row = rowHeader.closest('tr');
  if (!row) throw new Error('BLS_AHE_EXPECTED_TABLE_ROW_MALFORMED');
  return [...row.querySelectorAll('.datavalue')].map(cell => normalizedText(cell.textContent));
}

export function inspectBlsEmploymentSituationAheEvidence(html, manifest, parseHtml = value => new JSDOM(value)) {
  const expected = requireManifest(manifest);
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('BLS_AHE_HTML_ARTIFACT_MALFORMED');
  }
  const dom = parseHtml(html);
  const { document } = dom.window;
  const bodyText = normalizedText(document.body?.textContent ?? '');
  if (!bodyText.includes(expected.releaseId)
      || !bodyText.includes(expected.headerTitle)
      || !bodyText.includes(expected.narrative)) {
    throw new Error('BLS_AHE_RELEASE_EVIDENCE_MISMATCH');
  }

  const aheLevelValues = rowValues(document, AHE_ROW_ID);
  const adjacentPercentValues = rowValues(document, ADJACENT_PERCENT_ROW_ID);
  if (JSON.stringify(aheLevelValues) !== JSON.stringify(expected.aheLevelValues)
      || JSON.stringify(adjacentPercentValues) !== JSON.stringify(expected.adjacentPercentValues)) {
    throw new Error('BLS_AHE_RELEASE_EVIDENCE_MISMATCH');
  }

  const percentHeader = document.getElementById(ADJACENT_PERCENT_ROW_ID);
  const parentHeader = document.getElementById(ADJACENT_PERCENT_PARENT_ID);
  const percentAncestors = (percentHeader?.getAttribute('headers') ?? '').split(/\s+/);
  const ahePercentRows = [...document.querySelectorAll('th')].filter(header =>
    normalizedText(header.textContent) === 'Over-the-month percent change'
    && (header.getAttribute('headers') ?? '').split(/\s+/).includes(AHE_ROW_ID));
  if (normalizedText(percentHeader?.textContent ?? '') !== 'Over-the-month percent change'
      || !percentAncestors.includes(ADJACENT_PERCENT_PARENT_ID)
      || percentAncestors.includes(AHE_ROW_ID)
      || normalizedText(parentHeader?.textContent ?? '')
        !== 'Index of aggregate weekly hours (2007=100)(3)'
      || ahePercentRows.length !== 0) {
    throw new Error('BLS_AHE_TABLE_HIERARCHY_CONFLICT');
  }

  const evidence = expected.monthOverMonthPercent === null
    ? {
      state: 'UNAVAILABLE',
      value: null,
      reason: 'AHE_MOM_PERCENT_NOT_EXPLICIT_IN_RELEASE',
    }
    : {
      state: 'KNOWN',
      value: expected.monthOverMonthPercent,
      reason: 'EXPLICIT_RELEASE_NARRATIVE_PERCENT',
    };

  return {
    auditVersion: BLS_EMPLOYMENT_AHE_ARTIFACT_AUDIT_VERSION,
    releaseId: expected.releaseId,
    headerTitle: expected.headerTitle,
    aheLevelValues,
    adjacentPercentRow: {
      rowId: ADJACENT_PERCENT_ROW_ID,
      parentRowId: ADJACENT_PERCENT_PARENT_ID,
      parentLabel: normalizedText(parentHeader.textContent),
      values: adjacentPercentValues,
    },
    evidence,
  };
}

export function auditRetainedBlsEmploymentSituationAheArtifact({
  htmlPath,
  manifestPath,
  parseHtml,
}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const compressedBytes = readFileSync(htmlPath);
  const artifact = verifyBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest);
  const html = decodeBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest);
  const inspection = inspectBlsEmploymentSituationAheEvidence(
    html, manifest, parseHtml,
  );
  return { artifact, ...inspection };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const [htmlPath, manifestPath] = process.argv.slice(2);
  if (!htmlPath || !manifestPath) {
    console.error('Usage: node scripts/audit_bls_employment_situation_ahe_artifact.mjs <archive.html.gz> <manifest.json>');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(auditRetainedBlsEmploymentSituationAheArtifact({
        htmlPath,
        manifestPath,
      }), null, 2));
    } catch (error) {
      console.error(`BLS_AHE_ARTIFACT_AUDIT_FAILED ${error.message}`);
      process.exitCode = 1;
    }
  }
}
