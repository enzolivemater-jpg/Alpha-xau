/**
 * BLS CPI Table 1 workbook parser: structural mutation of the worksheet and
 * shared-strings XML. A cell's value must only come from inside its own
 * <c>…</c>, and a shared string's index must not shift. A missing </c> used to
 * let a cell run on into the next one and take its value (the YoY cell of
 * "All items" read an unrelated neighbouring column), and thousands of unclosed
 * cells cost quadratic time. The result must be the reviewed table or a
 * refusal, never other figures. Offline and deterministic: wall-clock ceiling only.
 */
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';

import { parseBlsCpiArtifacts } from '../backend/event_facts/bls_cpi_artifact_parser.ts';

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
const sharedXml = `<?xml version="1.0"?><sst>${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`;
// Column H carries an unrelated figure between the two reviewed columns: the trap for a runaway cell.
const sheetXml = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="B1" t="s"><v>0</v></c></row>
  <row r="4"><c r="G4" t="s"><v>5</v></c><c r="K4" t="s"><v>6</v></c></row>
  <row r="5"><c r="G5" t="s"><v>1</v></c><c r="K5" t="s"><v>2</v></c></row>
  <row r="7"><c r="B7" t="s"><v>3</v></c><c r="G7"><v>3.4</v></c><c r="H7"><v>1.1</v></c><c r="K7"><v>0.4</v></c></row>
  <row r="27"><c r="B27" t="s"><v>4</v></c><c r="G27"><v>2.4</v></c><c r="H27"><v>9.9</v></c><c r="K27"><v>0.3</v></c></row>
</sheetData></worksheet>`;
const workbook = (sheet, shared = sharedXml) => zipSync({
  'xl/sharedStrings.xml': strToU8(shared), 'xl/worksheets/sheet1.xml': strToU8(sheet),
}, { level: 6 });
const parse = (sheet, shared) => parseBlsCpiArtifacts({
  headerBytes: header, headerArchivePath: '/news.release/archives/cpi_09112026.htm',
  table1Bytes: workbook(sheet, shared), table1ArtifactPath: '/cpi/tables/supplemental-files/news-release-table1-202608.xlsx',
});

const base = parse(sheetXml);
assert.equal(base.kind, 'PARSED', JSON.stringify(base));
const baseRows = JSON.stringify(base.payload.table1.rows);

const failures = [];
const note = (label, message) => { if (failures.length < 20) failures.push(`${label}: ${message}`); };
const tally = { reviewed: 0, refused: 0 };
function check(label, sheet, shared) {
  let out;
  try { out = parse(sheet, shared); } catch (error) { note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error}`); return; }
  if (out.kind !== 'PARSED') { tally.refused += 1; return; }
  if (JSON.stringify(out.payload.table1.rows) === baseRows) { tally.reviewed += 1; return; }
  note(label, `PARSED other figures: ${JSON.stringify(out.payload.table1.rows)}`);
}

// Worksheet cells: closing tag removed, opener removed, value removed (opener left open), duplicated.
for (const cell of sheetXml.match(/<c r="[A-Z]+\d+"[^>]*>.*?<\/c>/g)) {
  const reference = /r="([A-Z]+\d+)"/.exec(cell)[1];
  const opener = /^<c [^>]*>/.exec(cell)[0];
  check(`cell ${reference}: </c> removed`, sheetXml.replace(cell, cell.replace('</c>', '')));
  check(`cell ${reference}: opener removed`, sheetXml.replace(cell, cell.replace(opener, '')));
  check(`cell ${reference}: value removed, opener left open`, sheetXml.replace(cell, opener));
  check(`cell ${reference}: duplicated`, sheetXml.replace(cell, cell + cell));
  check(`cell ${reference}: self-closed`, sheetXml.replace(cell, opener.replace('>', '/>')));
}
// Shared strings: closing tag removed, empty item inserted (shifts every later index), stray close.
for (let i = 0; i < strings.length; i += 1) {
  const item = `<si><t>${strings[i]}</t></si>`;
  check(`shared string ${i}: </si> removed`, sheetXml, sharedXml.replace(item, item.replace('</si>', '')));
  check(`shared string ${i}: </t> removed`, sheetXml, sharedXml.replace(item, item.replace('</t>', '')));
  check(`shared string ${i}: empty <si/> before it`, sheetXml, sharedXml.replace(item, `<si/>${item}`));
  check(`shared string ${i}: empty <si></si> before it`, sheetXml, sharedXml.replace(item, `<si></si>${item}`));
  check(`shared string ${i}: duplicated`, sheetXml, sharedXml.replace(item, item + item));
}
check('whole sheet cut in half', sheetXml.slice(0, sheetXml.length >> 1));

// Cost: a 1.5 MB part made of unclosed cells / items must not be quadratic.
const MB = 1_500_000;
for (const [name, build] of [
  ['unclosed cells', () => [sheetXml.replace('</sheetData>', `${'<c r="A1">'.repeat(MB / 10)}</sheetData>`), undefined]],
  ['unclosed shared strings', () => [sheetXml, sharedXml.replace('</sst>', `${'<si><t>x</t>'.repeat(MB / 12)}</sst>`)]],
  ['unclosed value tags', () => [sheetXml.replace('</sheetData>', `<c r="A1">${'<v>1'.repeat(MB / 4)}</c></sheetData>`), undefined]],
]) {
  const [sheet, shared] = build();
  const started = performance.now();
  parse(sheet, shared);
  const elapsed = performance.now() - started;
  if (elapsed > 3000) note(`cost ${name}`, `${Math.round(elapsed)} ms (limit 3000 ms)`);
}

// Cost of the HTML header: unterminated comments / scripts / styles (the header is capped at 10 MB).
for (const [name, noise] of [['comments', '<!--'], ['scripts', '<script>'], ['styles', '<style>'], ['tags without >', '<div ']]) {
  const hostileHeader = strToU8(new TextDecoder().decode(header).replace('<body>', `<body>${noise.repeat(Math.floor(1_500_000 / noise.length))}`));
  const started = performance.now();
  parseBlsCpiArtifacts({
    headerBytes: hostileHeader, headerArchivePath: '/news.release/archives/cpi_09112026.htm',
    table1Bytes: workbook(sheetXml), table1ArtifactPath: '/cpi/tables/supplemental-files/news-release-table1-202608.xlsx',
  });
  const elapsed = performance.now() - started;
  if (elapsed > 3000) note(`header cost unterminated ${name}`, `${Math.round(elapsed)} ms (limit 3000 ms)`);
}

assert.deepEqual(failures, [], `CPI STRUCTURE failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.refused > 10 && tally.reviewed >= 1, JSON.stringify(tally));
console.log(`PASS BLS CPI workbook: structural mutations give the reviewed table or a refusal, never other figures `
  + `(${tally.reviewed} reviewed, ${tally.refused} refused); unclosed cells and items stay cheap`);
