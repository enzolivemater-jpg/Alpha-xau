import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';

import { parseBlsCpiArtifacts } from '../backend/event_facts/bls_cpi_artifact_parser.ts';
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';

const header = strToU8(`<!doctype html><html><body>
  <div>Transmission of material in this release is embargoed until<br>
  8:30 a.m. (ET) Friday, September 11, 2026 &nbsp; USDL-26-1496</div>
  <h1>CONSUMER PRICE INDEX - AUGUST 2026</h1>
</body></html>`);
const strings = [
  'Table 1. Consumer Price Index for All Urban Consumers (CPI-U): U.S. city average, by expenditure category, August 2026',
  'Aug. 2025-\nAug. 2026', 'Jul. 2026-\nAug. 2026',
  'All items', 'All items less food and energy',
  'Unadjusted percent change', 'Seasonally adjusted percent change',
];
const sharedXml = `<?xml version="1.0"?><sst>${strings.map(value =>
  `<si><t>${value}</t></si>`).join('')}</sst>`;
const sheetXml = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="B1" t="s"><v>0</v></c></row>
  <row r="4"><c r="G4" t="s"><v>5</v></c><c r="K4" t="s"><v>6</v></c></row>
  <row r="5"><c r="G5" t="s"><v>1</v></c><c r="K5" t="s"><v>2</v></c></row>
  <row r="7"><c r="B7" t="s"><v>3</v></c><c r="G7"><v>3.4</v></c><c r="K7"><v>0.4</v></c></row>
  <row r="27"><c r="B27" t="s"><v>4</v></c><c r="G27"><v>2.4</v></c><c r="K27"><v>0.3</v></c></row>
</sheetData></worksheet>`;
const workbook = zipSync({
  'xl/sharedStrings.xml': strToU8(sharedXml),
  'xl/worksheets/sheet1.xml': strToU8(sheetXml),
}, { level: 6 });
const input = {
  headerBytes: header,
  headerArchivePath: '/news.release/archives/cpi_09112026.htm',
  table1Bytes: workbook,
  table1ArtifactPath: '/cpi/tables/supplemental-files/news-release-table1-202608.xlsx',
};

const parsed = parseBlsCpiArtifacts(input);
assert.equal(parsed.kind, 'PARSED', JSON.stringify(parsed));
assert.equal(parsed.parserVersion, 'bls-cpi-artifact-parser-v1');
assert.equal(parsed.payload.release.releaseId, 'USDL-26-1496');
assert.equal(parsed.payload.release.publicReleaseAtRaw,
  '8:30 a.m. (ET) Friday, September 11, 2026');
assert.deepEqual(parsed.payload.table1.rows, [
  { expenditureCategory: 'All items', unadjustedYoY: 3.4, seasonallyAdjustedMoM: 0.4 },
  { expenditureCategory: 'All items less food and energy', unadjustedYoY: 2.4, seasonallyAdjustedMoM: 0.3 },
]);
const mapped = mapBlsCpiReleaseToEventFacts(parsed.payload);
assert.equal(mapped.kind, 'RESOLVED', JSON.stringify(mapped));
console.log('PASS retained bytes parse into the exact EF-2 projection and adapter output');

assert.deepEqual(parseBlsCpiArtifacts(input), parseBlsCpiArtifacts(input));
assert.equal(parseBlsCpiArtifacts({ ...input, headerArchivePath: '/evil.htm' }).kind, 'UNSUPPORTED');
assert.equal(parseBlsCpiArtifacts({ ...input, headerBytes: new Uint8Array([0xff]) }).kind, 'MALFORMED');
assert.equal(parseBlsCpiArtifacts({ ...input, table1Bytes: strToU8('not a zip') }).kind, 'MALFORMED');
console.log('PASS replay is deterministic and malformed/path-confused artifacts fail closed');

const duplicateId = strToU8(new TextDecoder().decode(header).replace('</body>', 'USDL-26-1496</body>'));
assert.equal(parseBlsCpiArtifacts({ ...input, headerBytes: duplicateId }).kind, 'MALFORMED');
const conflictHeader = strToU8(new TextDecoder().decode(header).replace('AUGUST 2026', 'JULY 2026'));
assert.equal(parseBlsCpiArtifacts({ ...input, headerBytes: conflictHeader }).kind, 'CONFLICT');
const missingCellXml = sheetXml.replace('<c r="K27"><v>0.3</v></c>', '');
const missingCell = zipSync({
  'xl/sharedStrings.xml': strToU8(sharedXml),
  'xl/worksheets/sheet1.xml': strToU8(missingCellXml),
});
assert.equal(parseBlsCpiArtifacts({ ...input, table1Bytes: missingCell }).kind, 'MALFORMED');
console.log('PASS duplicate identity, period conflict, and missing reviewed cell never partially parse');

const duplicateCellXml = sheetXml.replace(
  '<c r="G7"><v>3.4</v></c>',
  '<c r="G7"><v>3.4</v></c><c r="G7"><v>3.4</v></c>',
);
const duplicateCell = zipSync({
  'xl/sharedStrings.xml': strToU8(sharedXml),
  'xl/worksheets/sheet1.xml': strToU8(duplicateCellXml),
});
assert.equal(parseBlsCpiArtifacts({ ...input, table1Bytes: duplicateCell }).kind, 'MALFORMED');
const oversizedXml = zipSync({
  'xl/sharedStrings.xml': new Uint8Array(2 * 1024 * 1024 + 1),
  'xl/worksheets/sheet1.xml': strToU8(sheetXml),
});
assert.equal(parseBlsCpiArtifacts({ ...input, table1Bytes: oversizedXml }).kind, 'MALFORMED');
console.log('PASS duplicate cells and compressed oversized XML fail before projection');

const parserSource = readFileSync(
  new URL('../backend/event_facts/bls_cpi_artifact_parser.ts', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert.doesNotMatch(parserSource, /\bfetch\s*\(|supabase|postgres|process\.env|Date\.|new Date|Math\.random/i);
assert.doesNotMatch(parserSource, /Anthropic|OpenAI|LLM|news_score|market_reaction|price_action/i);
console.log('PASS parser remains pure and independent of runtime, market, AI, and canonical persistence');
