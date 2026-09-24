/** Pure EF-5B parser for the two retained BLS CPI artifact byte streams. */
import { unzipSync } from 'fflate';

import type { BlsCpiStructuredPayloadV1 } from './bls_cpi_adapter.js';

export const BLS_CPI_ARTIFACT_PARSER_VERSION = 'bls-cpi-artifact-parser-v1' as const;

export interface BlsCpiArtifactParserInput {
  readonly headerBytes: Uint8Array;
  readonly headerArchivePath: string;
  readonly table1Bytes: Uint8Array;
  readonly table1ArtifactPath: string;
}

export type BlsCpiArtifactParserResult =
  | {
      readonly kind: 'PARSED';
      readonly parserVersion: typeof BLS_CPI_ARTIFACT_PARSER_VERSION;
      readonly payload: BlsCpiStructuredPayloadV1;
    }
  | {
      readonly kind: 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED';
      readonly parserVersion: typeof BLS_CPI_ARTIFACT_PARSER_VERSION;
      readonly reason: string;
    };

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_REQUIRED_XML_BYTES = 2 * 1024 * 1024;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const MONTH_ABBREVIATIONS = [
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.',
  'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.',
] as const;

function failed(
  kind: 'MALFORMED' | 'CONFLICT' | 'UNSUPPORTED',
  reason: string,
): BlsCpiArtifactParserResult {
  return { kind, parserVersion: BLS_CPI_ARTIFACT_PARSER_VERSION, reason };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeXmlText(value: string): string | null {
  let invalid = false;
  const decoded = value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity === 'nbsp') return ' ';
    const point = entity.toLowerCase().startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff
        || (point >= 0xd800 && point <= 0xdfff)) {
      invalid = true;
      return '';
    }
    return String.fromCodePoint(point);
  });
  if (invalid || /&(?:#|[a-z])/i.test(decoded)) return null;
  return decoded;
}

function normalizedText(value: string): string | null {
  const decoded = decodeXmlText(value);
  return decoded === null
    ? null
    : decoded.replace(/\s+/g, ' ').replace(/-\s+(?=[A-Z][a-z]{2}\.)/g, '-').trim();
}

function htmlVisibleText(html: string): string | null {
  const withoutExecutable = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Unrelated page chrome may contain named HTML entities. They are only
    // separators here; required evidence is matched from decoded plain text.
    .replace(/&[A-Za-z][A-Za-z0-9]+;/g, ' ');
  return normalizedText(withoutExecutable);
}

function uniqueMatch(text: string, expression: RegExp): string | null {
  const matches = [...text.matchAll(expression)].map(match => match[1]);
  return matches.length === 1 ? matches[0] : null;
}

function parseHeader(bytes: Uint8Array): {
  releaseId: string;
  headerTitle: string;
  publicReleaseAtRaw: string;
} | null {
  const html = decodeUtf8(bytes);
  const text = html === null ? null : htmlVisibleText(html);
  if (text === null) return null;
  const releaseId = uniqueMatch(text, /\b(USDL-\d{2}-\d{4})\b/g);
  const headerTitle = uniqueMatch(
    text,
    /\b(CONSUMER PRICE INDEX - (?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER) \d{4})\b/g,
  );
  const publicReleaseAtRaw = uniqueMatch(
    text,
    /Transmission of material in this release is embargoed until\s+(.+?)\s+USDL-\d{2}-\d{4}\b/g,
  );
  return releaseId !== null && headerTitle !== null && publicReleaseAtRaw !== null
    ? { releaseId, headerTitle, publicReleaseAtRaw }
    : null;
}

function parseAttributes(raw: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let consumed = '';
  for (const match of raw.matchAll(/\s+([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
    if (match.index === undefined) return null;
    consumed += raw.slice(consumed.length, match.index) + match[0];
    if (match[1] in attributes) return null;
    attributes[match[1]] = match[2];
  }
  return raw.slice(consumed.length).trim() === '' ? attributes : null;
}

function sharedStrings(xml: string): string[] | null {
  const values: string[] = [];
  for (const item of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    const parts = [...item[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\s*\/>/g)];
    if (parts.length === 0) return null;
    const normalized = normalizedText(parts.map(part => part[1] ?? '').join(''));
    if (normalized === null) return null;
    values.push(normalized);
  }
  return values.length > 0 ? values : null;
}

type CellValue = string | number;

function worksheetCells(xml: string, strings: readonly string[]): Map<string, CellValue> | null {
  const cells = new Map<string, CellValue>();
  for (const cell of xml.matchAll(/<c\b([^>]*)\s*\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attributes = parseAttributes(cell[1] ?? cell[2]);
    const reference = attributes?.r;
    if (attributes === null || reference === undefined || !/^[A-Z]{1,3}[1-9]\d*$/.test(reference)
        || cells.has(reference)) return null;
    const body = cell[3];
    if (body === undefined) continue;
    const valueMatches = [...body.matchAll(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/g)];
    if (valueMatches.length !== 1) continue;
    const raw = valueMatches[0][1];
    if (attributes.t === 's') {
      if (!/^\d+$/.test(raw)) return null;
      const index = Number(raw);
      if (!Number.isSafeInteger(index) || strings[index] === undefined) return null;
      cells.set(reference, strings[index]);
    } else if (attributes.t === undefined || attributes.t === 'n') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return null;
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return null;
      cells.set(reference, numeric);
    } else {
      return null;
    }
  }
  return cells;
}

function column(reference: string): string {
  return /^[A-Z]+/.exec(reference)?.[0] ?? '';
}

function row(reference: string): number {
  return Number(/\d+$/.exec(reference)?.[0]);
}

function parseTable1(bytes: Uint8Array): Omit<BlsCpiStructuredPayloadV1['table1'], 'artifactPath'> | null {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter(file) {
        if (file.originalSize > MAX_REQUIRED_XML_BYTES) throw new Error('oversized zip entry');
        return file.name === 'xl/sharedStrings.xml' || file.name === 'xl/worksheets/sheet1.xml';
      },
    });
  } catch {
    return null;
  }
  const sharedBytes = archive['xl/sharedStrings.xml'];
  const sheetBytes = archive['xl/worksheets/sheet1.xml'];
  const sharedXml = sharedBytes === undefined ? null : decodeUtf8(sharedBytes);
  const sheetXml = sheetBytes === undefined ? null : decodeUtf8(sheetBytes);
  if (sharedXml === null || sheetXml === null) return null;
  const strings = sharedStrings(sharedXml);
  if (strings === null) return null;
  const cells = worksheetCells(sheetXml, strings);
  if (cells === null) return null;

  const titles = [...cells.entries()].filter(([ref, value]) =>
    row(ref) <= 3 && typeof value === 'string' && value.startsWith('Table 1. Consumer Price Index'));
  if (titles.length !== 1) return null;
  const tableTitle = titles[0][1] as string;
  const titlePeriod = /, (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/.exec(tableTitle);
  if (titlePeriod === null) return null;
  const year = Number(titlePeriod[2]);
  const month = MONTHS.indexOf(titlePeriod[1] as typeof MONTHS[number]) + 1;
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  const expectedYoY = `${MONTH_ABBREVIATIONS[month - 1]} ${year - 1}-${MONTH_ABBREVIATIONS[month - 1]} ${year}`;
  const expectedMoM = `${MONTH_ABBREVIATIONS[previousMonth - 1]} ${previousYear}-${MONTH_ABBREVIATIONS[month - 1]} ${year}`;

  const headers = [...cells.entries()].filter(([ref, value]) => row(ref) <= 6 && typeof value === 'string');
  const yoy = headers.filter(([ref, value]) =>
    value === expectedYoY
    && cells.get(`${column(ref)}4`) === 'Unadjusted percent change');
  const mom = headers.filter(([ref, value]) =>
    value === expectedMoM
    && cells.get(`${column(ref)}4`) === 'Seasonally adjusted percent change');
  if (yoy.length !== 1 || mom.length !== 1) return null;
  const yoyColumn = column(yoy[0][0]);
  const momColumn = column(mom[0][0]);

  const categories = [...cells.entries()].filter(([, value]) =>
    value === 'All items' || value === 'All items less food and energy');
  if (categories.length !== 2) return null;
  const rows = categories.map(([ref, expenditureCategory]) => {
    const rowNumber = row(ref);
    const unadjustedYoY = cells.get(`${yoyColumn}${rowNumber}`);
    const seasonallyAdjustedMoM = cells.get(`${momColumn}${rowNumber}`);
    return typeof unadjustedYoY === 'number' && typeof seasonallyAdjustedMoM === 'number'
      ? { expenditureCategory: expenditureCategory as string, unadjustedYoY, seasonallyAdjustedMoM }
      : null;
  });
  if (rows.some(value => value === null)) return null;
  return {
    tableTitle,
    referencePeriod: { kind: 'MONTH', year, month },
    columns: {
      unadjustedYoY: yoy[0][1] as string,
      seasonallyAdjustedMoM: mom[0][1] as string,
    },
    rows: rows as NonNullable<BlsCpiStructuredPayloadV1['table1']['rows']>,
  };
}

export function parseBlsCpiArtifacts(input: BlsCpiArtifactParserInput): BlsCpiArtifactParserResult {
  if (!(input.headerBytes instanceof Uint8Array) || !(input.table1Bytes instanceof Uint8Array)
      || input.headerBytes.byteLength < 1 || input.headerBytes.byteLength > MAX_ARTIFACT_BYTES
      || input.table1Bytes.byteLength < 1 || input.table1Bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return failed('MALFORMED', 'ARTIFACT_BYTES_INVALID');
  }
  if (!/^\/news\.release\/archives\/cpi_\d{8}\.htm$/.test(input.headerArchivePath)
      || !/^\/cpi\/tables\/supplemental-files\/news-release-table1-\d{6}\.xlsx$/.test(input.table1ArtifactPath)) {
    return failed('UNSUPPORTED', 'ARTIFACT_PATH_UNSUPPORTED');
  }
  const release = parseHeader(input.headerBytes);
  const table1 = parseTable1(input.table1Bytes);
  if (release === null) return failed('MALFORMED', 'RELEASE_HEADER_MALFORMED');
  if (table1 === null) return failed('MALFORMED', 'RELEASE_TABLE1_MALFORMED');

  const titlePeriod = / - ([A-Z]+) (\d{4})$/.exec(release.headerTitle);
  const tablePeriod = table1.referencePeriod;
  if (titlePeriod === null || tablePeriod === null
      || MONTHS[tablePeriod.month - 1].toUpperCase() !== titlePeriod[1]
      || tablePeriod.year !== Number(titlePeriod[2])) {
    return failed('CONFLICT', 'HEADER_TABLE_PERIOD_CONFLICT');
  }
  return {
    kind: 'PARSED',
    parserVersion: BLS_CPI_ARTIFACT_PARSER_VERSION,
    payload: {
      source: {
        authority: 'US_BLS', provider: 'bls',
        sourceCode: 'bls_cpi_release', sourceDomain: 'bls.gov',
      },
      release: {
        releaseFamily: 'US_CPI', releaseStage: 'SINGLE',
        ...release, archivePath: input.headerArchivePath,
      },
      table1: { artifactPath: input.table1ArtifactPath, ...table1 },
    },
  };
}
