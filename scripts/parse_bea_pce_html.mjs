#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { JSDOM } from 'jsdom';

export const BEA_PCE_HTML_PARSER_VERSION = 'bea-pce-html-parser-v1';

const MAX_COMPRESSED_BYTES = 100_000;
const MAX_HTML_BYTES = 200_000;
const MANIFEST_KEYS = [
  'compressedArtifactFile', 'compressedBytes', 'compressedSha256',
  'contentEncoding', 'mediaType', 'rawHtmlBytes', 'rawHtmlSha256', 'retrievedAt',
  'sourceUrl',
];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const EXPECTED_ARTIFACTS = Object.freeze({
  'https://www.bea.gov/news/2026/personal-income-and-outlays-july-2026': Object.freeze({
    compressedArtifactFile: 'bea_pce_2026_07.archive.html.gz',
    compressedBytes: 10_926,
    compressedSha256: '56b12a6599905151d07e3764ec206284207a5785698db2bafda156449aa30398',
    rawHtmlBytes: 53_457,
    rawHtmlSha256: '6dbc1950e4a7b06691c4cf7206623cd0231fd94d565fc6a0eaf954ddedec65ec',
    releaseNumberRaw: 'BEA 26–39',
    headerTitle: 'Personal Income and Outlays, July 2026',
    publicReleaseAtRaw: 'EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Wednesday, August 26, 2026',
  }),
  'https://www.bea.gov/news/2026/personal-income-and-outlays-august-2026': Object.freeze({
    compressedArtifactFile: 'bea_pce_2026_08.archive.html.gz',
    compressedBytes: 10_574,
    compressedSha256: 'db355998c31bf698ec3cc9db736bd0b644b1cbff4898bf519b836eb71f58a837',
    rawHtmlBytes: 52_287,
    rawHtmlSha256: '6c207be356d7a4a0023086bfed2c1ea3d6dc33c43be8496a39207d0fd2e2f329',
    releaseNumberRaw: 'BEA 26–43',
    headerTitle: 'Personal Income and Outlays, August 2026',
    publicReleaseAtRaw: 'EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Wednesday, September 30, 2026',
  }),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedText(value) {
  return value.replace(/\s+/g, ' ').trim();
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
    throw new Error('BEA_PCE_ARTIFACT_MANIFEST_MALFORMED');
  }
  const expected = EXPECTED_ARTIFACTS[manifest.sourceUrl];
  if (!expected
      || manifest.compressedArtifactFile !== expected.compressedArtifactFile
      || manifest.compressedBytes !== expected.compressedBytes
      || manifest.compressedSha256 !== expected.compressedSha256
      || manifest.rawHtmlBytes !== expected.rawHtmlBytes
      || manifest.rawHtmlSha256 !== expected.rawHtmlSha256) {
    throw new Error('BEA_PCE_ARTIFACT_MANIFEST_UNTRUSTED');
  }
  return expected;
}

export function verifyBeaPceHtmlArtifact(compressedBytes, manifest) {
  const expected = requireManifest(manifest);
  if (!(compressedBytes instanceof Uint8Array)
      || compressedBytes.byteLength === 0
      || compressedBytes.byteLength > MAX_COMPRESSED_BYTES
      || compressedBytes[0] !== 0x1f
      || compressedBytes[1] !== 0x8b) {
    throw new Error('BEA_PCE_HTML_ARTIFACT_MALFORMED');
  }
  if (compressedBytes.byteLength !== manifest.compressedBytes
      || sha256(compressedBytes) !== manifest.compressedSha256) {
    throw new Error('BEA_PCE_HTML_ARTIFACT_INTEGRITY_MISMATCH');
  }
  return {
    sourceUrl: manifest.sourceUrl,
    compressedBytes: compressedBytes.byteLength,
    compressedSha256: manifest.compressedSha256,
    rawHtmlBytes: manifest.rawHtmlBytes,
    rawHtmlSha256: manifest.rawHtmlSha256,
    releaseNumberRaw: expected.releaseNumberRaw,
  };
}

export function decodeBeaPceHtmlArtifact(compressedBytes, manifest) {
  verifyBeaPceHtmlArtifact(compressedBytes, manifest);
  let htmlBytes;
  try {
    htmlBytes = gunzipSync(compressedBytes, { maxOutputLength: MAX_HTML_BYTES });
  } catch {
    throw new Error('BEA_PCE_HTML_DECODE_FAILED');
  }
  if (htmlBytes.byteLength !== manifest.rawHtmlBytes
      || sha256(htmlBytes) !== manifest.rawHtmlSha256
      || !/<!doctype html>/i.test(Buffer.from(htmlBytes.subarray(0, 200)).toString('utf8'))) {
    throw new Error('BEA_PCE_DECODED_HTML_INTEGRITY_MISMATCH');
  }
  return htmlBytes.toString('utf8');
}

function parseOneDecimal(value, direction = 'increased') {
  if (!/^\d+\.\d$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return direction === 'decreased' ? -parsed : parsed;
}

function releaseParagraph(body, prefix) {
  const matches = [...body.querySelectorAll('p')]
    .map(node => normalizedText(node.textContent))
    .filter(text => text.startsWith(prefix));
  if (matches.length !== 1) throw new Error('REQUIRED_RELEASE_PARAGRAPH_AMBIGUOUS');
  return matches[0];
}

function parseNarrativeMetrics(body, monthName) {
  const momText = releaseParagraph(body, 'From the preceding month,');
  const yoyText = releaseParagraph(body, 'From the same month one year ago,');
  const mom = new RegExp(
    `^From the preceding month, the PCE price index for ${monthName} (increased|decreased) (\\d+\\.\\d) percent\\. `
      + 'Excluding food and energy, the PCE price index (?:also )?(increased|decreased) (\\d+\\.\\d) percent\\.$',
  ).exec(momText);
  const yoy = new RegExp(
    `^From the same month one year ago, the PCE price index for ${monthName} (increased|decreased) (\\d+\\.\\d) percent\\. `
      + 'Excluding food and energy, the PCE price index (increased|decreased) (\\d+\\.\\d) percent from one year ago\\.$',
  ).exec(yoyText);
  if (!mom || !yoy) throw new Error('PCE_NARRATIVE_MALFORMED');
  const values = {
    headlineMom: parseOneDecimal(mom[2], mom[1]),
    coreMom: parseOneDecimal(mom[4], mom[3]),
    headlineYoy: parseOneDecimal(yoy[2], yoy[1]),
    coreYoy: parseOneDecimal(yoy[4], yoy[3]),
  };
  if (Object.values(values).some(value => value === null)) {
    throw new Error('PCE_NARRATIVE_MALFORMED');
  }
  return values;
}

function currentMonthTableValues(body, monthName) {
  const tables = [...body.querySelectorAll('table')].filter(table =>
    normalizedText(table.querySelector('thead')?.textContent ?? '')
      .startsWith('Personal Income and Related Measures'),
  );
  if (tables.length !== 1) throw new Error('PCE_SUMMARY_TABLE_AMBIGUOUS');
  const rows = [...tables[0].querySelectorAll('tbody tr')];
  const header = rows.shift();
  const headerCells = [...(header?.querySelectorAll('td') ?? [])]
    .map(cell => normalizedText(cell.textContent));
  if (headerCells.length !== 3 || headerCells[2] !== monthName) {
    throw new Error('PCE_SUMMARY_TABLE_PERIOD_CONFLICT');
  }
  const valueFor = label => {
    const matches = rows.filter(row =>
      normalizedText(row.querySelector('td')?.textContent ?? '') === label);
    if (matches.length !== 1) throw new Error('PCE_SUMMARY_TABLE_ROW_AMBIGUOUS');
    const cells = [...matches[0].querySelectorAll('td')];
    if (cells.length !== 3) throw new Error('PCE_SUMMARY_TABLE_ROW_MALFORMED');
    const value = parseOneDecimal(normalizedText(cells[2].textContent));
    if (value === null) throw new Error('PCE_SUMMARY_TABLE_VALUE_MALFORMED');
    return value;
  };
  return {
    headlineMom: valueFor('PCE price index'),
    coreMom: valueFor('PCE price index excluding food and energy'),
  };
}

function parseProjection(html, manifest) {
  const expected = requireManifest(manifest);
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const title = normalizedText(document.querySelector('#home h1')?.textContent ?? '');
  const releaseDate = normalizedText(
    document.querySelector('#home .field--name-field-release-date')?.textContent ?? '',
  );
  const releaseNumber = normalizedText(
    document.querySelector('#home .release-embargo .col-md-2')?.textContent ?? '',
  );
  if (title !== expected.headerTitle
      || releaseDate !== expected.publicReleaseAtRaw
      || releaseNumber !== expected.releaseNumberRaw) {
    throw new Error('BEA_RELEASE_HEADER_CONFLICT');
  }
  const titleMatch = /^Personal Income and Outlays, ([A-Z][a-z]+) (\d{4})$/.exec(title);
  const month = titleMatch ? MONTHS.indexOf(titleMatch[1]) + 1 : 0;
  const year = titleMatch ? Number(titleMatch[2]) : NaN;
  if (month === 0 || !Number.isSafeInteger(year)) throw new Error('BEA_RELEASE_TITLE_MALFORMED');

  const body = document.querySelector('#home .release-body .field--name-body');
  if (!body) throw new Error('BEA_RELEASE_BODY_MISSING');
  const narrative = parseNarrativeMetrics(body, MONTHS[month - 1]);
  const table = currentMonthTableValues(body, MONTHS[month - 1]);
  if (narrative.headlineMom !== table.headlineMom || narrative.coreMom !== table.coreMom) {
    throw new Error('PCE_NARRATIVE_TABLE_CONFLICT');
  }
  const archiveUrl = new URL(manifest.sourceUrl);
  if (archiveUrl.origin !== 'https://www.bea.gov') throw new Error('BEA_ARCHIVE_URL_MALFORMED');

  return {
    source: {
      authority: 'US_BEA',
      provider: 'bea',
      sourceCode: 'bea_personal_income_outlays_release',
      sourceDomain: 'bea.gov',
    },
    release: {
      releaseFamily: 'US_PCE',
      releaseStage: 'SINGLE',
      releaseNumberRaw: releaseNumber,
      headerTitle: title,
      publicReleaseAtRaw: releaseDate,
      archivePath: archiveUrl.pathname,
      archiveSha256: manifest.rawHtmlSha256,
    },
    summary: {
      referencePeriod: { kind: 'MONTH', year, month },
      metrics: [
        { seriesLabel: 'PCE price index', changeBasis: 'PRECEDING_MONTH', valuePercent: narrative.headlineMom },
        { seriesLabel: 'PCE price index excluding food and energy', changeBasis: 'PRECEDING_MONTH', valuePercent: narrative.coreMom },
        { seriesLabel: 'PCE price index', changeBasis: 'SAME_MONTH_YEAR_AGO', valuePercent: narrative.headlineYoy },
        { seriesLabel: 'PCE price index excluding food and energy', changeBasis: 'SAME_MONTH_YEAR_AGO', valuePercent: narrative.coreYoy },
      ],
    },
  };
}

function nonParsed(kind, reason) {
  return { kind, parserVersion: BEA_PCE_HTML_PARSER_VERSION, reason };
}

export function parseAuthenticatedBeaPceHtml(html, manifest) {
  try {
    return {
      kind: 'PARSED',
      parserVersion: BEA_PCE_HTML_PARSER_VERSION,
      payload: parseProjection(html, manifest),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_PARSE_ERROR';
    const conflicts = new Set([
      'BEA_RELEASE_HEADER_CONFLICT', 'PCE_NARRATIVE_TABLE_CONFLICT',
      'PCE_SUMMARY_TABLE_PERIOD_CONFLICT',
    ]);
    return nonParsed(conflicts.has(reason) ? 'CONFLICT' : 'MALFORMED', reason);
  }
}

export function parseRetainedBeaPceHtmlArtifact({ htmlPath, manifestPath }) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const compressedBytes = readFileSync(htmlPath);
    const artifact = verifyBeaPceHtmlArtifact(compressedBytes, manifest);
    const html = decodeBeaPceHtmlArtifact(compressedBytes, manifest);
    const parsed = parseAuthenticatedBeaPceHtml(html, manifest);
    return parsed.kind === 'PARSED' ? { ...parsed, artifact } : parsed;
  } catch {
    return nonParsed('MALFORMED', 'ARTIFACT_AUTHENTICATION_OR_DECODING_FAILED');
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const [htmlPath, manifestPath] = process.argv.slice(2);
  if (!htmlPath || !manifestPath) {
    console.error('Usage: node scripts/parse_bea_pce_html.mjs <archive.html.gz> <manifest.json>');
    process.exitCode = 2;
  } else {
    const result = parseRetainedBeaPceHtmlArtifact({ htmlPath, manifestPath });
    console.log(JSON.stringify(result, null, 2));
    if (result.kind !== 'PARSED') process.exitCode = 1;
  }
}
