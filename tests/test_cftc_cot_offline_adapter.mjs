// P2 — CFTC Commitments of Traders OFFLINE adapter. A file already on disk
// becomes P-0 evidence tuples for one report of one market; publication and
// reception instants are declared, never guessed; any doubt rejects the whole
// file. The fixture is synthetic (its market names say so): no CFTC data is in
// the repository and no network call is made. P-0 and CHAIN-0 still abstain.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const cot = await loadBackendModule('positioning_engine/cftc_cot_offline_adapter.ts');
const p0 = await loadBackendModule('positioning_engine/evidence_contract.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const bytes = readFileSync(new URL('./fixtures/cftc_cot_disaggregated_synthetic.csv', import.meta.url));
const text = bytes.toString('utf8');
const artifactId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const PUBLISHED = '2026-10-02T19:30:00.000Z';
const RECEIVED = '2026-10-02T19:45:00.000Z';
const base = { text, artifactId, publishedAt: PUBLISHED, receivedAt: RECEIVED, dataset: 'FUTURES_ONLY' };

assert.equal(cot.CFTC_COT_ADAPTER_SCHEMA_VERSION, 'xau.positioning-cftc-cot-offline.v1');
assert.equal(cot.CFTC_COT_ADAPTER_ALGORITHM_VERSION, 'cftc-cot-disaggregated-offline-adapter-1.3.0');

// --- CSV reader: quotes, escaped quotes, CRLF; unterminated or stray quotes are refused.
assert.deepEqual(cot.parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
assert.equal(cot.parseCsv('a,"b\n'), null);
assert.equal(cot.parseCsv('a,"b"x\n'), null);
console.log('PASS the CSV reader handles quoted commas and escapes, and refuses broken quoting');

// --- One report of COMEX gold: 14 tuples, all CONTRACTS, all P-0 valid; nothing derived.
const two = cot.convertCftcCotReport(base);
assert.equal(two.status, 'REJECTED');
assert.deepEqual(two.reasonCodes, ['MULTIPLE_REPORT_DATES']);
assert.deepEqual(two.availableReportDates, ['2026-09-22', '2026-09-29']);
const ok = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29' });
assert.equal(ok.status, 'EXTRACTED', ok.detail);
assert.equal(ok.sourceApproval, 'NOT_APPROVED');
assert.equal(ok.marketName, 'SYNTHETIC GOLD FIXTURE, NOT CFTC DATA');
assert.equal(ok.evidence.length, cot.CFTC_COT_METRIC_COLUMNS.length);
const byMetric = Object.fromEntries(ok.evidence.map((e) => [e.metricCode, e]));
assert.equal(byMetric.open_interest.value, 510000);
assert.equal(byMetric.managed_money_long.value, 201000);
assert.equal(byMetric.managed_money_short.value, 41000);
assert.equal(byMetric.swap_dealer_short.value, 151000);
assert.ok(!Object.keys(byMetric).some((m) => /net|ratio|percent/.test(m)), 'no derived metric');
for (const e of ok.evidence) {
  assert.deepEqual([e.sourceAuthority, e.datasetCode, e.instrumentCode, e.unit, e.periodEnd, e.publishedAt, e.observedAt, e.artifactId, e.revision],
    ['cftc', 'cot_disaggregated_futures_only', 'CFTC:088691', 'CONTRACTS', '2026-09-29', PUBLISHED, RECEIVED, artifactId, null]);
}
const envelope = p0.buildPositioningEvidenceEnvelope(ok.evidence, '2026-10-03T00:00:00.000Z');
assert.equal(envelope.evidence.length, 14, 'every tuple passes the P-0 shape');
assert.deepEqual(envelope.reasonCodes, ['FRESHNESS_POLICY_NOT_APPROVED', 'METHODOLOGY_NOT_APPROVED']);
assert.equal(envelope.positioningState, 'UNAVAILABLE');
const early = p0.buildPositioningEvidenceEnvelope(ok.evidence, '2026-10-02T19:40:00.000Z');
assert.ok(early.reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'), 'received after the cutoff is not known at it');
// The dataset is the operator's declaration (both CFTC files share their columns); none declared is refused.
const combined = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', dataset: 'FUTURES_AND_OPTIONS_COMBINED' });
assert.equal(combined.status, 'EXTRACTED');
assert.equal(combined.dataset, 'FUTURES_AND_OPTIONS_COMBINED');
assert.ok(combined.evidence.every((e) => e.datasetCode === 'cot_disaggregated_futures_options_combined'));
assert.equal(ok.dataset, 'FUTURES_ONLY');
for (const dataset of [undefined, null, '', 'futures-only', 'LEGACY']) {
  const r = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', dataset });
  assert.deepEqual([r.status, r.reasonCodes], ['REJECTED', ['INVALID_REQUEST']], String(dataset));
}
// Other market and a single-report selection are independent.
const silver = cot.convertCftcCotReport({ ...base, contractMarketCode: '084691' });
assert.equal(silver.status, 'EXTRACTED');
assert.equal(silver.reportDate, '2026-09-29');
// Deterministic.
assert.deepEqual(cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29' }), ok);
console.log('PASS one gold report becomes 14 raw CONTRACTS tuples that P-0 keeps and abstains on (no derived metric)');

// --- CHAIN-0 with these tuples: HOLD / FORBIDDEN, positioning abstains.
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const input = { ...structuredClone(golden.input), positioningEvidence: ok.evidence };
const outcome = chain.evaluateDecisionChain(input, golden.knowledgeCutoff);
assert.equal(outcome.kind, 'COMPLETED');
assert.equal(outcome.result.chainState, 'HOLD');
assert.equal(outcome.result.execution, 'FORBIDDEN');
assert.equal(outcome.result.trace.find((t) => t.stage === 'POSITIONING').state, 'ABSTAIN');
console.log('PASS CHAIN-0 on CFTC-layout evidence stays HOLD / FORBIDDEN with POSITIONING abstaining');

// --- Fail-closed: each defect rejects the whole conversion with its own reason.
const lines = text.split('\r\n');
const withLine = (i, f) => lines.map((l, j) => (j === i ? f(l) : l)).join('\r\n');
const cases = [
  ['no artifact digest', { artifactId: 'abc' }, 'INVALID_REQUEST'],
  ['implicit-zone publication', { publishedAt: '2026-10-02T19:30:00' }, 'INVALID_REQUEST'],
  ['received before published', { receivedAt: '2026-10-02T19:00:00.000Z' }, 'RECEIVED_BEFORE_PUBLISHED'],
  ['published before the report date', { publishedAt: '2026-09-28T23:59:59.000Z', receivedAt: '2026-09-29T00:10:00.000Z' }, 'PUBLISHED_BEFORE_REPORT_DATE'],
  ['unknown report date', { reportDate: '2026-09-15' }, 'REPORT_DATE_NOT_FOUND'],
  ['impossible report date asked', { reportDate: '2026-02-30' }, 'INVALID_REQUEST'],
  ['other market', { contractMarketCode: '999999' }, 'MARKET_NOT_FOUND'],
  ['renamed column', { text: text.replace('M_Money_Positions_Short_All', 'MM_Short') }, 'MISSING_COLUMN'],
  ['duplicate column', { text: text.replace('CFTC_Market_Code', 'Open_Interest_All') }, 'DUPLICATE_COLUMN'],
  ['unterminated quote', { text: text.replace('"SYNTHETIC SILVER', 'SYNTHETIC SILVER"x') }, 'MALFORMED_CSV'],
  ['short row', { text: withLine(2, (l) => l.replace(/,21000$/, '')) }, 'MALFORMED_CSV'],
  ['decimal position', { text: withLine(2, (l) => l.replace(',201000,', ',201000.5,')) }, 'INVALID_POSITION_VALUE'],
  ['negative position', { text: withLine(2, (l) => l.replace(',201000,', ',-201000,')) }, 'INVALID_POSITION_VALUE'],
  ['empty position', { text: withLine(2, (l) => l.replace(',201000,', ',,')) }, 'INVALID_POSITION_VALUE'],
  ['YYMMDD disagrees', { text: withLine(2, (l) => l.replace(',260929,', ',260928,')) }, 'REPORT_DATE_MISMATCH'],
  ['impossible date in file', { text: withLine(2, (l) => l.replace('260929,2026-09-29', '260931,2026-09-31')) }, 'INVALID_REPORT_DATE'],
  ['duplicate report row', { text: `${text}${lines[2]}\r\n` }, 'DUPLICATE_REPORT_ROW'],
  ['empty file', { text: '' }, 'INVALID_REQUEST'],
];
for (const [name, change, reason] of cases) {
  const result = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', ...change });
  assert.equal(result.status, 'REJECTED', name);
  assert.deepEqual(result.reasonCodes, [reason], `${name}: ${result.detail}`);
  assert.equal(result.evidence.length, 0, name);
  assert.equal(result.sourceApproval, 'NOT_APPROVED');
}
assert.equal(cot.convertCftcCotReport(null).status, 'REJECTED');
// A BOM is tolerated; nothing else changes.
assert.equal(cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', text: `﻿${text}` }).status, 'EXTRACTED');
console.log(`PASS ${cases.length} defects each reject the whole conversion with their own reason, never a partial set`);

// --- 1.2.0: unknown formats are named, never read as a list of missing columns.
const asRead = (bytes) => Buffer.from(bytes).toString('utf8'); // as the server decodes a file
const headerOf = (cols) => `${cols.join(',')}\r\n"GOLD - COMMODITY EXCHANGE INC.",260929,2026-09-29,088691${',1'.repeat(cols.length - 4)}\r\n`;
const formats = [
  ['ZIP archive', asRead([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), 'UNSUPPORTED_FORMAT', /archive ZIP/],
  ['Excel .xls (OLE2)', asRead([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]), 'UNSUPPORTED_FORMAT', /binaire|UTF-8/],
  ['UTF-16 text', asRead(Buffer.from(`\ufeff${text}`, 'utf16le')), 'UNSUPPORTED_FORMAT', /binaire|UTF-8/],
  ['HTML page', '<!DOCTYPE html><html><body>COT</body></html>', 'UNSUPPORTED_FORMAT', /HTML/],
  ['JSON', '{"report":[]}', 'UNSUPPORTED_FORMAT', /JSON/],
  ['semicolons', text.replace(/,/g, ';'), 'UNSUPPORTED_FORMAT', /point-virgule/],
  ['tabs', text.replace(/,/g, '\t'), 'UNSUPPORTED_FORMAT', /tabulation/],
  ['legacy COT', headerOf(['Market_and_Exchange_Names', 'As_of_Date_In_Form_YYMMDD', 'Report_Date_as_YYYY-MM-DD', 'CFTC_Contract_Market_Code',
    'Open_Interest_All', 'NonComm_Positions_Long_All', 'NonComm_Positions_Short_All']), 'UNSUPPORTED_LAYOUT', /legacy/],
  ['TFF', headerOf(['Market_and_Exchange_Names', 'As_of_Date_In_Form_YYMMDD', 'Report_Date_as_YYYY-MM-DD', 'CFTC_Contract_Market_Code',
    'Open_Interest_All', 'Dealer_Positions_Long_All', 'Lev_Money_Positions_Long_All']), 'UNSUPPORTED_LAYOUT', /TFF/],
  ['unknown CFTC report', headerOf(['Market_and_Exchange_Names', 'As_of_Date_In_Form_YYMMDD', 'Report_Date_as_YYYY-MM-DD',
    'CFTC_Contract_Market_Code', 'Open_Interest_All']), 'UNSUPPORTED_LAYOUT', /type inconnu/],
];
for (const [name, body, reason, detail] of formats) {
  const r = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', text: body });
  assert.deepEqual([r.status, r.reasonCodes], ['REJECTED', [reason]], `${name}: ${r.reasonCodes} ${r.detail}`);
  assert.match(r.detail, detail, name);
  assert.equal(r.evidence.length, 0, name);
}
// Extra columns, as in the real CFTC files, are fine.
const wider = text.split('\r\n').map((l, i) => (l ? `${l},${i === 0 ? 'Conc_Gross_LE_4_TDR_Long_All' : '12.5'}` : l)).join('\r\n');
assert.equal(cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', text: wider }).status, 'EXTRACTED');
console.log(`PASS ${formats.length} unknown formats and CFTC layouts are rejected with their own named reason; extra columns accepted`);

// --- 1.3.0: a file laid out exactly as the CFTC variable list (191 fields, date column As_of_Date_Form_YYYY-MM-DD,
// FutOnly_or_Combined) converts. The layout is the official documentation; the values are synthetic.
const official = readFileSync(new URL('./fixtures/cftc_disaggregated_variables_official.txt', import.meta.url), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'));
assert.equal(official.length, 191);
const officialRow = (date, code, marker) => official.map((name, i) => {
  if (name === 'Market_and_Exchange_Names') return '"SYNTHETIC GOLD FIXTURE, NOT CFTC DATA"';
  if (name === 'As_of_Date_In_Form_YYMMDD') return date.slice(2).replace(/-/g, '');
  if (name === 'As_of_Date_Form_YYYY-MM-DD') return date;
  if (name === 'CFTC_Contract_Market_Code') return code;
  if (name === 'FutOnly_or_Combined') return marker;
  if (name === 'Contract_Units') return '"(CONTRACTS OF 100 TROY OUNCES)"';
  if (/^(Pct_|Conc_)/.test(name)) return '12.3';
  if (/Code/.test(name)) return 'X1';
  return String(1000 + i);
}).join(',');
const officialText = `${official.join(',')}\r\n${officialRow('2026-09-29', '088691', 'FutOnly')}\r\n${officialRow('2026-09-29', '084691', 'FutOnly')}\r\n`;
const doc = cot.convertCftcCotReport({ ...base, text: officialText });
assert.equal(doc.status, 'EXTRACTED', doc.detail);
assert.equal(doc.dateColumn, 'As_of_Date_Form_YYYY-MM-DD');
assert.equal(doc.fileDatasetMarker, 'FutOnly', 'shown verbatim, never interpreted');
assert.equal(doc.reportDate, '2026-09-29');
assert.equal(doc.evidence.find((e) => e.metricCode === 'managed_money_long').value, 1000 + official.indexOf('M_Money_Positions_Long_All'));
assert.equal(doc.evidence.find((e) => e.metricCode === 'swap_dealer_short').value, 1000 + official.indexOf('Swap__Positions_Short_All'));
// The marker never decides: a declaration that says otherwise is still the operator's (shown side by side).
assert.equal(cot.convertCftcCotReport({ ...base, text: officialText, dataset: 'FUTURES_AND_OPTIONS_COMBINED' }).status, 'EXTRACTED');
// Both date columns: must agree on every row of the market.
const both = (d1, d2) => `${text.split('\r\n')[0]},As_of_Date_Form_YYYY-MM-DD\r\n${text.split('\r\n').slice(1).filter(Boolean)
  .map((l) => `${l},${l.includes('088691') && l.includes('2026-09-29') ? d2 : d1}`).join('\r\n')}\r\n`;
const agree = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', text: text.split('\r\n').map((l, i) => (!l ? l
  : i === 0 ? `${l},As_of_Date_Form_YYYY-MM-DD` : `${l},${l.split(',').find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c))}`)).join('\r\n') });
assert.equal(agree.status, 'EXTRACTED', agree.detail);
assert.equal(agree.dateColumn, 'Report_Date_as_YYYY-MM-DD + As_of_Date_Form_YYYY-MM-DD');
const disagree = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', text: both('2026-09-22', '2026-09-30') });
assert.deepEqual([disagree.status, disagree.reasonCodes], ['REJECTED', ['REPORT_DATE_MISMATCH']]);
const noDate = cot.convertCftcCotReport({ ...base, reportDate: '2026-09-29', text: text.replace('Report_Date_as_YYYY-MM-DD', 'Report_Date') });
assert.deepEqual(noDate.reasonCodes, ['MISSING_COLUMN']);
assert.match(noDate.detail, /Report_Date_as_YYYY-MM-DD ou As_of_Date_Form_YYYY-MM-DD/);
// Inspection of a file before any declaration: what it offers, nothing converted.
const seen = cot.inspectCftcCotFile(officialText);
assert.deepEqual([seen.formatProblem, seen.layout, seen.columnCount, seen.missingColumns, seen.dateColumns, seen.datasetMarkerColumn,
  seen.marketRows, seen.reportDates, seen.datasetMarkers],
[null, null, 191, [], ['As_of_Date_Form_YYYY-MM-DD'], true, 1, ['2026-09-29'], ['FutOnly']]);
assert.deepEqual(cot.inspectCftcCotFile(text).reportDates, ['2026-09-22', '2026-09-29']);
assert.match(cot.inspectCftcCotFile('PK\u0003\u0004x').formatProblem, /ZIP/);
assert.match(cot.inspectCftcCotFile(formats[7][1]).layout, /legacy/);
console.log('PASS 1.3.0: the official 191-field layout converts (documented date column, verbatim FutOnly_or_Combined); date columns must agree; inspection');

// --- Static: the adapter has no network, clock or file access.
const source = readFileSync(new URL('../backend/positioning_engine/cftc_cot_offline_adapter.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bfetch\(|node:|Date\.now|new Date\(\)|process\.|import\(/);
console.log('PASS the adapter is pure: no network, clock, process or file access');
