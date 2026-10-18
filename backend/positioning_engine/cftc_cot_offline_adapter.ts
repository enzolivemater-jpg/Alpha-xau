/**
 * P2 — OFFLINE adapter from a CFTC Commitments of Traders file already on the
 * operator's disk (Disaggregated, Futures Only, comma-separated text layout)
 * to P-0 positioning evidence tuples. It makes no network call, reads no clock
 * and decides nothing: P-0 still abstains (FRESHNESS_POLICY_NOT_APPROVED,
 * METHODOLOGY_NOT_APPROVED) and positioning stays UNAVAILABLE.
 *
 * CFTC is a candidate source only (positioning contract, Human Gate): this
 * adapter approves nothing. Its column names follow the CFTC disaggregated
 * text layout as published; they are not yet verified against a retained real
 * file in this repository, so an unexpected header is rejected, never guessed.
 *
 * Facts the file does not carry are never invented:
 * - the publication instant is declared by the operator (`publishedAt`);
 *   the adapter only checks it is not before the report date;
 * - the reception instant is declared by the operator (`receivedAt`), as for
 *   market captures, and must not precede the publication;
 * - one file may hold many weekly reports, each published at its own instant:
 *   exactly one report date is converted per call (the only one, or the one
 *   selected), so one declared publication instant never covers several reports;
 * - revisions are not identified in the file: `revision` is null;
 * - Futures Only and Futures-and-Options Combined files share their columns:
 *   the operator declares which one it is (`dataset`), never guessed.
 */

import type { PositioningEvidenceInput } from './evidence_contract.js';
import { isStrictlyAfter, parseStrictTimestamp } from '../shared/strict_timestamp.js';

export const CFTC_COT_ADAPTER_SCHEMA_VERSION = 'xau.positioning-cftc-cot-offline.v1' as const;
export const CFTC_COT_ADAPTER_ALGORITHM_VERSION = 'cftc-cot-disaggregated-offline-adapter-1.3.0' as const;
export const CFTC_SOURCE_AUTHORITY = 'cftc' as const;
/**
 * 1.1.0: the CFTC publishes the disaggregated report as Futures Only and as
 * Futures-and-Options Combined, with the same columns: the file cannot say
 * which it is. The operator declares it; nothing is assumed (1.0.0 labelled
 * every file futures-only).
 */
export const CFTC_COT_DATASETS = {
  FUTURES_ONLY: 'cot_disaggregated_futures_only',
  FUTURES_AND_OPTIONS_COMBINED: 'cot_disaggregated_futures_options_combined',
} as const;
export type CftcCotDataset = keyof typeof CFTC_COT_DATASETS;
/** COMEX gold (100 troy ounces), CFTC contract market code. */
export const CFTC_GOLD_CONTRACT_MARKET_CODE = '088691' as const;

/** Metric code → CFTC column. Positions are in contracts; nothing is derived (no net, no ratio). */
export const CFTC_COT_METRIC_COLUMNS = [
  ['open_interest', 'Open_Interest_All'],
  ['producer_merchant_long', 'Prod_Merc_Positions_Long_All'],
  ['producer_merchant_short', 'Prod_Merc_Positions_Short_All'],
  ['swap_dealer_long', 'Swap_Positions_Long_All'],
  ['swap_dealer_short', 'Swap__Positions_Short_All'],
  ['swap_dealer_spread', 'Swap__Positions_Spread_All'],
  ['managed_money_long', 'M_Money_Positions_Long_All'],
  ['managed_money_short', 'M_Money_Positions_Short_All'],
  ['managed_money_spread', 'M_Money_Positions_Spread_All'],
  ['other_reportable_long', 'Other_Rept_Positions_Long_All'],
  ['other_reportable_short', 'Other_Rept_Positions_Short_All'],
  ['other_reportable_spread', 'Other_Rept_Positions_Spread_All'],
  ['nonreportable_long', 'NonRept_Positions_Long_All'],
  ['nonreportable_short', 'NonRept_Positions_Short_All'],
] as const;
const IDENTITY_COLUMNS = {
  market: 'Market_and_Exchange_Names',
  asOfYymmdd: 'As_of_Date_In_Form_YYMMDD',
  contractCode: 'CFTC_Contract_Market_Code',
} as const;
/**
 * 1.3.0: the report date column. The CFTC variable list for the disaggregated
 * files (HistoricalViewable/CFTC_023168) names it As_of_Date_Form_YYYY-MM-DD;
 * 1.0.0 assumed Report_Date_as_YYYY-MM-DD. Which one the real text file
 * carries is not verified here (no real file in the repository), so either is
 * read; when both are present they must agree on every row.
 */
export const CFTC_COT_DATE_COLUMNS = ['Report_Date_as_YYYY-MM-DD', 'As_of_Date_Form_YYYY-MM-DD'] as const;
/** Documented field 191: which publication the row belongs to. Read and shown verbatim, never interpreted. */
export const CFTC_COT_DATASET_MARKER_COLUMN = 'FutOnly_or_Combined' as const;

export type CftcCotReasonCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_LAYOUT'
  | 'MALFORMED_CSV'
  | 'MISSING_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'MARKET_NOT_FOUND'
  | 'MULTIPLE_REPORT_DATES'
  | 'REPORT_DATE_NOT_FOUND'
  | 'DUPLICATE_REPORT_ROW'
  | 'INVALID_REPORT_DATE'
  | 'REPORT_DATE_MISMATCH'
  | 'INVALID_POSITION_VALUE'
  | 'PUBLISHED_BEFORE_REPORT_DATE'
  | 'RECEIVED_BEFORE_PUBLISHED';

export interface CftcCotRequest {
  /** The file's text, unchanged. */
  readonly text: string;
  /** `sha256:<hex>` of the file's bytes, computed by the caller. */
  readonly artifactId: string;
  readonly publishedAt: string;
  readonly receivedAt: string;
  /** Default: COMEX gold. */
  readonly contractMarketCode?: string;
  /** Required when the file holds more than one report of that market. */
  readonly reportDate?: string | null;
  /** Which CFTC publication the file is, as the operator downloaded it; required. */
  readonly dataset: CftcCotDataset;
}

export interface CftcCotConversion {
  readonly schemaVersion: typeof CFTC_COT_ADAPTER_SCHEMA_VERSION;
  readonly algorithmVersion: typeof CFTC_COT_ADAPTER_ALGORITHM_VERSION;
  readonly status: 'EXTRACTED' | 'REJECTED';
  readonly reasonCodes: readonly CftcCotReasonCode[];
  /** Plain-text detail of the first rejection (column, row or date), or null. */
  readonly detail: string | null;
  readonly sourceApproval: 'NOT_APPROVED';
  readonly artifactId: string | null;
  readonly dataset: CftcCotDataset | null;
  /** 1.3.0: the date column read, and the file's own FutOnly_or_Combined value for that report (verbatim), or null. */
  readonly dateColumn: string | null;
  readonly fileDatasetMarker: string | null;
  readonly marketName: string | null;
  readonly reportDate: string | null;
  /** Report dates of that market found in the file, in order. */
  readonly availableReportDates: readonly string[];
  readonly evidence: readonly PositioningEvidenceInput[];
}

const ARTIFACT = /^sha256:[0-9a-f]{64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YYMMDD = /^\d{6}$/;
const CONTRACT_CODE = /^[0-9A-Z]{6}$/;
const POSITION = /^\d{1,12}$/;
const MAX_TEXT_LENGTH = 64 * 1024 * 1024;

function isCivilDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * RFC 4180 records: comma separator, double-quoted fields with "" escapes,
 * CRLF or LF line ends, blank lines skipped. null when a quote is unterminated
 * or stray text follows a closing quote.
 */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  const endField = () => { row.push(field); field = ''; fieldStarted = false; };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i += 1;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') return null;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (fieldStarted && field.trim() !== '') return null;
      field = '';
      quoted = true;
      fieldStarted = true;
      i += 1;
    } else if (c === ',') {
      endField();
      i += 1;
    } else if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      fieldStarted = true;
      i += 1;
    }
  }
  if (quoted) return null;
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * 1.2.0: what the bytes are when they are plainly not a comma-separated text
 * (archive, spreadsheet, web page, JSON, another separator), so the operator
 * reads the real problem instead of a list of missing columns. null: try CSV.
 */
function unsupportedFormat(text: string): string | null {
  if (text.startsWith('PK\u0003\u0004')) return 'archive ZIP (décompresser le fichier texte CFTC)';
  if (text.startsWith('\u00d0\u00cf\u0011\u00e0')) return 'classeur Excel (.xls)';
  if (text.includes('\u0000')) return 'contenu binaire ou UTF-16';
  if (text.includes('\ufffd')) return 'octets invalides en UTF-8 (fichier binaire ?)';
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith('<')) return 'page HTML ou XML';
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (!firstLine.includes(',')) {
    if (firstLine.includes(';')) return 'séparateur point-virgule';
    if (firstLine.includes('\t')) return 'séparateur tabulation';
    return 'aucune virgule dans l\'en-tête';
  }
  return null;
}

/**
 * 1.3.0: what a file's header offers, before any declaration (for checking a
 * real file): format problem, other CFTC layout, required columns missing,
 * date columns and dataset marker column present, report dates of a market.
 * Reads only; converts nothing; never throws.
 */
export function inspectCftcCotFile(text: unknown, contractMarketCode: string = CFTC_GOLD_CONTRACT_MARKET_CODE) {
  const result = { formatProblem: null as string | null, layout: null as string | null, columnCount: 0,
    missingColumns: [] as string[], dateColumns: [] as string[], datasetMarkerColumn: false,
    marketRows: 0, reportDates: [] as string[], datasetMarkers: [] as string[] };
  if (typeof text !== 'string') return { ...result, formatProblem: 'texte absent' };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  result.formatProblem = unsupportedFormat(body);
  if (result.formatProblem !== null) return result;
  const rows = parseCsv(body);
  if (rows === null || rows.length === 0) return { ...result, formatProblem: 'CSV illisible' };
  const header = rows[0].map((name) => name.trim());
  const index = new Map(header.map((name, i) => [name, i] as [string, number]));
  result.columnCount = header.length;
  result.dateColumns = CFTC_COT_DATE_COLUMNS.filter((name) => index.has(name));
  result.datasetMarkerColumn = index.has(CFTC_COT_DATASET_MARKER_COLUMN);
  result.missingColumns = [...Object.values(IDENTITY_COLUMNS), ...CFTC_COT_METRIC_COLUMNS.map(([, column]) => column)]
    .filter((name) => !index.has(name));
  if (result.dateColumns.length === 0) result.missingColumns.push(CFTC_COT_DATE_COLUMNS.join(' ou '));
  result.layout = result.missingColumns.length ? otherCftcLayout(index) : null;
  const code = index.get(IDENTITY_COLUMNS.contractCode);
  if (code === undefined) return result;
  const dates = new Set<string>();
  const markers = new Set<string>();
  for (const row of rows.slice(1)) {
    if ((row[code] ?? '').trim() !== contractMarketCode) continue;
    result.marketRows += 1;
    for (const name of result.dateColumns) dates.add((row[index.get(name) as number] ?? '').trim());
    if (result.datasetMarkerColumn) markers.add((row[index.get(CFTC_COT_DATASET_MARKER_COLUMN) as number] ?? '').trim());
  }
  result.reportDates = [...dates].sort();
  result.datasetMarkers = [...markers].sort();
  return result;
}

/** The CFTC report a header belongs to, when it is a CFTC header but not the disaggregated one. */
/** The format problem of a file's text, for listing a file before any conversion (null: looks like CSV text). */
export function cftcCotFormatProblem(text: unknown): string | null {
  if (typeof text !== 'string') return 'texte absent';
  return unsupportedFormat(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function otherCftcLayout(index: Map<string, number>): string | null {
  if (!index.has('Market_and_Exchange_Names') || !index.has('CFTC_Contract_Market_Code')) return null;
  if (index.has('NonComm_Positions_Long_All')) return 'legacy (Commitments of Traders classique)';
  if (index.has('Dealer_Positions_Long_All') || index.has('Lev_Money_Positions_Long_All')) return 'Traders in Financial Futures (TFF)';
  if (!index.has('M_Money_Positions_Long_All')) return 'de type inconnu';
  return null;
}

const reject = (
  reasons: readonly CftcCotReasonCode[], detail: string, partial: Partial<CftcCotConversion> = {},
): CftcCotConversion => ({
  schemaVersion: CFTC_COT_ADAPTER_SCHEMA_VERSION,
  algorithmVersion: CFTC_COT_ADAPTER_ALGORITHM_VERSION,
  status: 'REJECTED',
  reasonCodes: [...reasons],
  detail,
  sourceApproval: 'NOT_APPROVED',
  artifactId: null,
  dataset: null,
  dateColumn: null,
  fileDatasetMarker: null,
  marketName: null,
  reportDate: null,
  availableReportDates: [],
  evidence: [],
  ...partial,
});

/** Converts one weekly report of one market; any doubt rejects the whole conversion. */
export function convertCftcCotReport(request: CftcCotRequest): CftcCotConversion {
  if (typeof request !== 'object' || request === null) return reject(['INVALID_REQUEST'], 'requête absente');
  const { text, artifactId, publishedAt, receivedAt } = request;
  const contractCode = request.contractMarketCode ?? CFTC_GOLD_CONTRACT_MARKET_CODE;
  const selected = request.reportDate ?? null;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LENGTH) return reject(['INVALID_REQUEST'], 'texte du fichier absent ou trop grand');
  if (typeof artifactId !== 'string' || !ARTIFACT.test(artifactId)) return reject(['INVALID_REQUEST'], 'artifactId doit être sha256:<64 hex>');
  if (typeof contractCode !== 'string' || !CONTRACT_CODE.test(contractCode)) return reject(['INVALID_REQUEST'], 'code de marché CFTC invalide');
  const dataset = request.dataset;
  if (typeof dataset !== 'string' || !Object.hasOwn(CFTC_COT_DATASETS, dataset)) {
    return reject(['INVALID_REQUEST'], 'jeu de données à déclarer : FUTURES_ONLY ou FUTURES_AND_OPTIONS_COMBINED');
  }
  if (selected !== null && (typeof selected !== 'string' || !isCivilDate(selected))) return reject(['INVALID_REQUEST'], 'date de rapport demandée invalide');
  const publishedMs = typeof publishedAt === 'string' ? parseStrictTimestamp(publishedAt) : null;
  const receivedMs = typeof receivedAt === 'string' ? parseStrictTimestamp(receivedAt) : null;
  if (publishedMs === null || receivedMs === null) return reject(['INVALID_REQUEST'], 'publishedAt et receivedAt doivent être des instants explicites');
  if (isStrictlyAfter(publishedAt, receivedAt)) return reject(['RECEIVED_BEFORE_PUBLISHED'], 'réception déclarée avant la publication déclarée');

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const format = unsupportedFormat(body);
  if (format !== null) return reject(['UNSUPPORTED_FORMAT'], `format non pris en charge : ${format} (texte CSV CFTC attendu)`);
  const rows = parseCsv(body);
  if (rows === null || rows.length === 0) return reject(['MALFORMED_CSV'], 'CSV illisible : guillemets incohérents ou fichier vide');
  const header = rows[0].map((name) => name.trim());
  const index = new Map<string, number>();
  for (const [i, name] of header.entries()) {
    if (index.has(name)) return reject(['DUPLICATE_COLUMN'], `colonne en double : ${name}`);
    index.set(name, i);
  }
  const dateColumns = CFTC_COT_DATE_COLUMNS.filter((name) => index.has(name));
  const needed = [...Object.values(IDENTITY_COLUMNS), ...CFTC_COT_METRIC_COLUMNS.map(([, column]) => column)];
  const missing = [...needed.filter((name) => !index.has(name)),
    ...(dateColumns.length === 0 ? [CFTC_COT_DATE_COLUMNS.join(' ou ')] : [])];
  if (missing.length) {
    // A CFTC file of another report (legacy, financial futures) is named as such, not as a list of columns.
    const layout = otherCftcLayout(index);
    if (layout !== null) return reject(['UNSUPPORTED_LAYOUT'], `rapport CFTC ${layout} : seul le rapport désagrégé (disaggregated) est pris en charge`);
    return reject(['MISSING_COLUMN'], `colonne(s) absente(s) : ${missing.join(', ')}`);
  }
  const cell = (row: string[], name: string): string => (row[index.get(name) as number] ?? '').trim();

  const marketRows = [];
  for (const [n, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) return reject(['MALFORMED_CSV'], `ligne ${n + 2} : ${row.length} champs au lieu de ${header.length}`);
    if (cell(row, IDENTITY_COLUMNS.contractCode) === contractCode) marketRows.push({ row, line: n + 2 });
  }
  if (marketRows.length === 0) return reject(['MARKET_NOT_FOUND'], `aucune ligne pour le marché ${contractCode}`);

  const byDate = new Map<string, { row: string[]; line: number }>();
  for (const entry of marketRows) {
    const date = cell(entry.row, dateColumns[0]);
    if (dateColumns.some((name) => cell(entry.row, name) !== date)) {
      return reject(['REPORT_DATE_MISMATCH'], `ligne ${entry.line} : ${dateColumns.map((name) => `${name}=${cell(entry.row, name)}`).join(' ≠ ')}`);
    }
    const yymmdd = cell(entry.row, IDENTITY_COLUMNS.asOfYymmdd);
    if (!isCivilDate(date)) return reject(['INVALID_REPORT_DATE'], `ligne ${entry.line} : date de rapport « ${date} »`);
    if (!YYMMDD.test(yymmdd) || `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}` !== yymmdd) {
      return reject(['REPORT_DATE_MISMATCH'], `ligne ${entry.line} : ${date} ≠ ${yymmdd}`);
    }
    if (byDate.has(date)) return reject(['DUPLICATE_REPORT_ROW'], `deux lignes du marché ${contractCode} au ${date}`);
    byDate.set(date, entry);
  }
  const availableReportDates = [...byDate.keys()].sort();
  let reportDate: string;
  if (selected !== null) {
    if (!byDate.has(selected)) return reject(['REPORT_DATE_NOT_FOUND'], `rapport du ${selected} absent`, { availableReportDates });
    reportDate = selected;
  } else if (availableReportDates.length === 1) {
    reportDate = availableReportDates[0];
  } else {
    return reject(['MULTIPLE_REPORT_DATES'], `${availableReportDates.length} rapports : choisir la date (chacun a sa propre publication)`, { availableReportDates });
  }
  // A report as of a date cannot have been published before that date began (UTC).
  if (publishedMs < Date.parse(`${reportDate}T00:00:00.000Z`)) {
    return reject(['PUBLISHED_BEFORE_REPORT_DATE'], `publication déclarée avant le ${reportDate}`, { availableReportDates });
  }

  const { row } = byDate.get(reportDate) as { row: string[] };
  const evidence: PositioningEvidenceInput[] = [];
  for (const [metricCode, column] of CFTC_COT_METRIC_COLUMNS) {
    const raw = cell(row, column);
    if (!POSITION.test(raw)) return reject(['INVALID_POSITION_VALUE'], `${column} = « ${raw} » (entier de contrats attendu)`, { availableReportDates });
    evidence.push({
      sourceAuthority: CFTC_SOURCE_AUTHORITY,
      datasetCode: CFTC_COT_DATASETS[dataset],
      instrumentCode: `CFTC:${contractCode}`,
      metricCode,
      value: Number(raw),
      unit: 'CONTRACTS',
      periodEnd: reportDate,
      publishedAt,
      observedAt: receivedAt,
      artifactId,
      revision: null,
    });
  }
  return {
    schemaVersion: CFTC_COT_ADAPTER_SCHEMA_VERSION,
    algorithmVersion: CFTC_COT_ADAPTER_ALGORITHM_VERSION,
    status: 'EXTRACTED',
    reasonCodes: [],
    detail: null,
    sourceApproval: 'NOT_APPROVED',
    artifactId,
    dataset,
    dateColumn: dateColumns.join(' + '),
    fileDatasetMarker: index.has(CFTC_COT_DATASET_MARKER_COLUMN) ? cell(row, CFTC_COT_DATASET_MARKER_COLUMN) || null : null,
    marketName: cell(row, IDENTITY_COLUMNS.market),
    reportDate,
    availableReportDates,
    evidence,
  };
}
