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
export const CFTC_COT_ADAPTER_ALGORITHM_VERSION = 'cftc-cot-disaggregated-offline-adapter-1.1.0' as const;
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
  reportDate: 'Report_Date_as_YYYY-MM-DD',
  asOfYymmdd: 'As_of_Date_In_Form_YYMMDD',
  contractCode: 'CFTC_Contract_Market_Code',
} as const;

export type CftcCotReasonCode =
  | 'INVALID_REQUEST'
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

  const rows = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (rows === null || rows.length === 0) return reject(['MALFORMED_CSV'], 'CSV illisible (guillemet non fermé ou fichier vide)');
  const header = rows[0].map((name) => name.trim());
  const index = new Map<string, number>();
  for (const [i, name] of header.entries()) {
    if (index.has(name)) return reject(['DUPLICATE_COLUMN'], `colonne en double : ${name}`);
    index.set(name, i);
  }
  const needed = [...Object.values(IDENTITY_COLUMNS), ...CFTC_COT_METRIC_COLUMNS.map(([, column]) => column)];
  const missing = needed.filter((name) => !index.has(name));
  if (missing.length) return reject(['MISSING_COLUMN'], `colonne(s) absente(s) : ${missing.join(', ')}`);
  const cell = (row: string[], name: string): string => (row[index.get(name) as number] ?? '').trim();

  const marketRows = [];
  for (const [n, row] of rows.slice(1).entries()) {
    if (row.length !== header.length) return reject(['MALFORMED_CSV'], `ligne ${n + 2} : ${row.length} champs au lieu de ${header.length}`);
    if (cell(row, IDENTITY_COLUMNS.contractCode) === contractCode) marketRows.push({ row, line: n + 2 });
  }
  if (marketRows.length === 0) return reject(['MARKET_NOT_FOUND'], `aucune ligne pour le marché ${contractCode}`);

  const byDate = new Map<string, { row: string[]; line: number }>();
  for (const entry of marketRows) {
    const date = cell(entry.row, IDENTITY_COLUMNS.reportDate);
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
    marketName: cell(row, IDENTITY_COLUMNS.market),
    reportDate,
    availableReportDates,
    evidence,
  };
}
