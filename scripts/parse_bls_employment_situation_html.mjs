#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

import {
  decodeBlsEmploymentSituationHtmlArtifact,
  inspectBlsEmploymentSituationAheEvidence,
  verifyBlsEmploymentSituationHtmlArtifact,
} from './audit_bls_employment_situation_ahe_artifact.mjs';

export const BLS_EMPLOYMENT_HTML_PARSER_VERSION =
  'bls-employment-html-parser-v1';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const TOTAL_NONFARM_ROW_ID = 'ces_table10.r.1.1';
const UNEMPLOYMENT_RATE_ROW_ID = 'cps_empsit_sum.r.2.1.3.1';
const CURRENT_CES_COLUMN_ID = 'ces_table10.h.1.5';
const FIRST_PRIOR_CES_COLUMN_ID = 'ces_table10.h.1.3';
const SECOND_PRIOR_CES_COLUMN_ID = 'ces_table10.h.1.4';
const CURRENT_CPS_COLUMN_ID = 'cps_empsit_sum.h.1.5';

function normalizedText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function nonParsed(kind, reason) {
  return { kind, parserVersion: BLS_EMPLOYMENT_HTML_PARSER_VERSION, reason };
}

function rowCell(document, rowHeaderId, columnHeaderId, expectedLabel) {
  const rowHeader = document.getElementById(rowHeaderId);
  if (!rowHeader || normalizedText(rowHeader.textContent) !== expectedLabel) {
    throw new Error('REQUIRED_TABLE_ROW_MALFORMED');
  }
  const row = rowHeader.closest('tr');
  if (!row) throw new Error('REQUIRED_TABLE_ROW_MALFORMED');
  const cells = [...row.querySelectorAll('td')].filter(cell =>
    (cell.getAttribute('headers') ?? '').split(/\s+/).includes(columnHeaderId));
  if (cells.length !== 1) throw new Error('REQUIRED_TABLE_CELL_AMBIGUOUS');
  const values = [...cells[0].querySelectorAll('.datavalue')];
  if (values.length !== 1) throw new Error('REQUIRED_TABLE_CELL_MALFORMED');
  return normalizedText(values[0].textContent);
}

function parseIntegerThousands(value) {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePersonCountAsThousands(value) {
  if (!/^[+-]?\d{1,3}(?:,\d{3})+$/.test(value)) return null;
  const parsed = Number(value.replaceAll(',', ''));
  if (!Number.isSafeInteger(parsed) || parsed % 1_000 !== 0) return null;
  return parsed / 1_000;
}

function parseOneDecimal(value) {
  if (!/^[+-]?\d+\.\d$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function periodForMonthName(monthName, referencePeriod) {
  const month = MONTHS.indexOf(monthName) + 1;
  if (month === 0) return null;
  return {
    kind: 'MONTH',
    year: month < referencePeriod.month ? referencePeriod.year : referencePeriod.year - 1,
    month,
  };
}

function uniqueMatches(text, pattern, map) {
  const values = [...text.matchAll(pattern)].map(map);
  return [...new Set(values)];
}

function parseReleaseProjection(html, manifest) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const ahe = inspectBlsEmploymentSituationAheEvidence(
    html, manifest, () => dom,
  );

  const titleMatch = /^THE EMPLOYMENT SITUATION - ([A-Z]+) (\d{4})$/
    .exec(ahe.headerTitle);
  if (!titleMatch) throw new Error('RELEASE_TITLE_MALFORMED');
  const referenceMonth = MONTHS.findIndex(month => month.toUpperCase() === titleMatch[1]) + 1;
  const referenceYear = Number(titleMatch[2]);
  if (referenceMonth === 0 || !Number.isSafeInteger(referenceYear)) {
    throw new Error('RELEASE_TITLE_MALFORMED');
  }
  const referencePeriod = { kind: 'MONTH', year: referenceYear, month: referenceMonth };
  const referenceMonthName = MONTHS[referenceMonth - 1];

  const lead = document.querySelector('div.normalnews > pre');
  const leadText = normalizedText(lead?.textContent ?? '');
  const releaseNarrative = leadText.split('_____________')[0];
  const releaseTimePattern = new RegExp(
    `Transmission of material in this news release is embargoed until ${ahe.releaseId} `
      + '(8:30 a\\.m\\. \\(ET\\) Friday, [A-Z][a-z]+ \\d{1,2}, \\d{4}) Technical information:',
  );
  const releaseTimeMatch = releaseTimePattern.exec(leadText);
  if (!releaseTimeMatch) throw new Error('RELEASE_TIME_MALFORMED');

  const currentPayroll = parseIntegerThousands(rowCell(
    document, TOTAL_NONFARM_ROW_ID, CURRENT_CES_COLUMN_ID, 'Total nonfarm',
  ));
  const firstRevised = parseIntegerThousands(rowCell(
    document, TOTAL_NONFARM_ROW_ID, FIRST_PRIOR_CES_COLUMN_ID, 'Total nonfarm',
  ));
  const secondRevised = parseIntegerThousands(rowCell(
    document, TOTAL_NONFARM_ROW_ID, SECOND_PRIOR_CES_COLUMN_ID, 'Total nonfarm',
  ));
  const unemploymentRate = parseOneDecimal(rowCell(
    document, UNEMPLOYMENT_RATE_ROW_ID, CURRENT_CPS_COLUMN_ID, 'Unemployment rate',
  ));
  if ([currentPayroll, firstRevised, secondRevised].some(value => value === null)
      || unemploymentRate === null) {
    throw new Error('REQUIRED_TABLE_VALUE_MALFORMED');
  }

  const increasePattern = new RegExp(
    `Total nonfarm payroll employment (?:increased|rose) by ([0-9][0-9,]*) in ${referenceMonthName}`,
    'g',
  );
  const littleChangePattern = new RegExp(
    `Total nonfarm payroll employment changed little in ${referenceMonthName} \\(([+-][0-9,]*)\\)`,
    'g',
  );
  const narrativePayrolls = [
    ...uniqueMatches(releaseNarrative, increasePattern,
      match => parsePersonCountAsThousands(match[1])),
    ...uniqueMatches(releaseNarrative, littleChangePattern,
      match => parsePersonCountAsThousands(match[1])),
  ].filter(value => value !== null);
  if (narrativePayrolls.length !== 1 || narrativePayrolls[0] !== currentPayroll) {
    throw new Error('PAYROLL_NARRATIVE_TABLE_CONFLICT');
  }

  const unemploymentValues = uniqueMatches(
    releaseNarrative,
    /unemployment rate(?: was (?:unchanged|little changed) at |, at | \()(\d+\.\d) percent/gi,
    match => parseOneDecimal(match[1]),
  ).filter(value => value !== null);
  if (unemploymentValues.length !== 1 || unemploymentValues[0] !== unemploymentRate) {
    throw new Error('UNEMPLOYMENT_NARRATIVE_TABLE_CONFLICT');
  }

  const revisions = /The change in total nonfarm payroll employment for ([A-Z][a-z]+) was revised (?:up|down) by [0-9,]+, from ([+-][0-9,]+) to ([+-][0-9,]+), and the change for ([A-Z][a-z]+) was revised (?:up|down) by [0-9,]+, from ([+-][0-9,]+) to ([+-][0-9,]+)\./
    .exec(releaseNarrative);
  if (!revisions) throw new Error('PAYROLL_REVISIONS_MALFORMED');
  const revisionPeriods = [
    periodForMonthName(revisions[1], referencePeriod),
    periodForMonthName(revisions[4], referencePeriod),
  ];
  const revisionValues = [
    [parsePersonCountAsThousands(revisions[2]), parsePersonCountAsThousands(revisions[3])],
    [parsePersonCountAsThousands(revisions[5]), parsePersonCountAsThousands(revisions[6])],
  ];
  if (revisionPeriods.some(period => period === null)
      || revisionValues.flat().some(value => value === null)
      || revisionValues[0][1] !== firstRevised
      || revisionValues[1][1] !== secondRevised) {
    throw new Error('PAYROLL_REVISIONS_TABLE_CONFLICT');
  }

  const archiveUrl = new URL(manifest.sourceUrl);
  if (archiveUrl.origin !== 'https://www.bls.gov') {
    throw new Error('ARCHIVE_URL_MALFORMED');
  }
  return {
    source: {
      authority: 'US_BLS',
      provider: 'bls',
      sourceCode: 'bls_employment_situation_release',
      sourceDomain: 'bls.gov',
    },
    release: {
      releaseFamily: 'US_NFP',
      releaseStage: 'SINGLE',
      releaseId: ahe.releaseId,
      headerTitle: ahe.headerTitle,
      publicReleaseAtRaw: releaseTimeMatch[1],
      archivePath: archiveUrl.pathname,
    },
    summary: {
      artifactPath: archiveUrl.pathname,
      referencePeriod,
      payroll: {
        seriesId: 'CES0000000001',
        currentChangeThousands: currentPayroll,
        priorRevisions: revisionPeriods.map((period, index) => ({
          referencePeriod: period,
          priorChangeThousands: revisionValues[index][0],
          revisedChangeThousands: revisionValues[index][1],
        })),
      },
      unemploymentRate: {
        seriesId: 'LNS14000000',
        levelPercent: unemploymentRate,
      },
      averageHourlyEarningsMom: ahe.evidence.state === 'KNOWN'
        ? {
          seriesId: 'CES0500000003',
          monthOverMonthPercent: ahe.evidence.value,
        }
        : null,
    },
  };
}

export function parseAuthenticatedBlsEmploymentSituationHtml(html, manifest) {
  try {
    return {
      kind: 'PARSED',
      parserVersion: BLS_EMPLOYMENT_HTML_PARSER_VERSION,
      payload: parseReleaseProjection(html, manifest),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_PARSE_ERROR';
    const conflictReasons = new Set([
      'PAYROLL_NARRATIVE_TABLE_CONFLICT',
      'UNEMPLOYMENT_NARRATIVE_TABLE_CONFLICT',
      'PAYROLL_REVISIONS_TABLE_CONFLICT',
    ]);
    return nonParsed(conflictReasons.has(reason) ? 'CONFLICT' : 'MALFORMED', reason);
  }
}

export function parseRetainedBlsEmploymentSituationHtmlArtifact({
  htmlPath,
  manifestPath,
}) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const compressedBytes = readFileSync(htmlPath);
    const artifact = verifyBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest);
    const html = decodeBlsEmploymentSituationHtmlArtifact(compressedBytes, manifest);
    const parsed = parseAuthenticatedBlsEmploymentSituationHtml(html, manifest);
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
    console.error('Usage: node scripts/parse_bls_employment_situation_html.mjs <archive.html.gz> <manifest.json>');
    process.exitCode = 2;
  } else {
    const result = parseRetainedBlsEmploymentSituationHtmlArtifact({
      htmlPath,
      manifestPath,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.kind !== 'PARSED') process.exitCode = 1;
  }
}
