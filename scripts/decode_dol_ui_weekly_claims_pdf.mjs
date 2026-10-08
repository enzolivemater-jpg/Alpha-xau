#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DOL_UI_PDF_DECODER_BOUNDARY_VERSION =
  'dol-ui-pdf-decoder-boundary-v1';

const EXPECTED_ARCHIVE_URL =
  'https://www.dol.gov/sites/dolgov/files/OPA/newsreleases/ui-claims/20261543.pdf';
const MAX_PDF_BYTES = 2_000_000;
const MAX_TEXT_BYTES = 1_000_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireExactManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('DOL_ARTIFACT_MANIFEST_MALFORMED');
  }
  if (manifest.archivedSourceUrl !== EXPECTED_ARCHIVE_URL
      || manifest.sourceUrl !== 'https://www.dol.gov/ui/data.pdf'
      || manifest.artifactPath !== '/ui/data.pdf'
      || manifest.mediaType !== 'application/pdf'
      || manifest.rawArtifactFile !== 'dol_ui_weekly_claims_2026_10_01.pdf'
      || manifest.extractionTool !== 'pdftotext 24.02.0 -layout'
      || manifest.textNormalization !== 'append one final LF to the pdftotext output'
      || !Number.isSafeInteger(manifest.pdfBytes)
      || !/^[0-9a-f]{64}$/.test(manifest.pdfSha256)
      || !Number.isSafeInteger(manifest.normalizedTextBytes)
      || !/^[0-9a-f]{64}$/.test(manifest.normalizedTextSha256)) {
    throw new Error('DOL_ARTIFACT_MANIFEST_MALFORMED');
  }
}

export function verifyDolUiWeeklyClaimsPdfArtifact(pdfBytes, manifest) {
  requireExactManifest(manifest);
  if (!(pdfBytes instanceof Uint8Array)
      || pdfBytes.byteLength === 0
      || pdfBytes.byteLength > MAX_PDF_BYTES
      || Buffer.from(pdfBytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new Error('DOL_PDF_ARTIFACT_MALFORMED');
  }
  if (pdfBytes.byteLength !== manifest.pdfBytes
      || sha256(pdfBytes) !== manifest.pdfSha256) {
    throw new Error('DOL_PDF_ARTIFACT_INTEGRITY_MISMATCH');
  }
  return {
    bytes: pdfBytes.byteLength,
    sha256: manifest.pdfSha256,
    archivedSourceUrl: manifest.archivedSourceUrl,
  };
}

export function normalizeDolPdftotextOutput(decodedText, manifest) {
  requireExactManifest(manifest);
  if (typeof decodedText !== 'string' || Buffer.byteLength(decodedText) > MAX_TEXT_BYTES) {
    throw new Error('DOL_PDF_TEXT_MALFORMED');
  }
  const normalizedText = `${decodedText}\n`;
  if (Buffer.byteLength(normalizedText) !== manifest.normalizedTextBytes
      || sha256(normalizedText) !== manifest.normalizedTextSha256) {
    throw new Error('DOL_PDF_TEXT_INTEGRITY_MISMATCH');
  }
  return normalizedText;
}

export function decodeRetainedDolUiWeeklyClaimsPdf({
  pdfPath,
  manifestPath,
  runDecoder = execFileSync,
}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pdfBytes = readFileSync(pdfPath);
  const artifact = verifyDolUiWeeklyClaimsPdfArtifact(pdfBytes, manifest);
  let decodedText;
  try {
    decodedText = runDecoder(
      'pdftotext',
      ['-layout', pdfPath, '-'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_TEXT_BYTES },
    );
  } catch {
    throw new Error('DOL_PDF_DECODER_UNAVAILABLE_OR_FAILED');
  }
  return {
    boundaryVersion: DOL_UI_PDF_DECODER_BOUNDARY_VERSION,
    artifact,
    normalizedText: normalizeDolPdftotextOutput(decodedText, manifest),
  };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const [pdfPath, manifestPath, mode = '--verify-only'] = process.argv.slice(2);
  if (!pdfPath || !manifestPath || !['--verify-only', '--emit-text'].includes(mode)) {
    console.error('Usage: node scripts/decode_dol_ui_weekly_claims_pdf.mjs <pdf> <manifest.json> [--verify-only|--emit-text]');
    process.exitCode = 2;
  } else {
    try {
      const result = decodeRetainedDolUiWeeklyClaimsPdf({ pdfPath, manifestPath });
      if (mode === '--emit-text') {
        process.stdout.write(result.normalizedText);
      } else {
        console.log(JSON.stringify({
          boundaryVersion: result.boundaryVersion,
          artifact: result.artifact,
          normalizedTextBytes: Buffer.byteLength(result.normalizedText),
          normalizedTextSha256: sha256(result.normalizedText),
          verified: true,
        }, null, 2));
      }
    } catch (error) {
      console.error(`DOL_PDF_VERIFY_FAILED ${error.message}`);
      process.exitCode = 1;
    }
  }
}
