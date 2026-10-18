// DATA-TO-TERMINAL — scripts/cot_declare.mjs writes the declaration that lets
// the terminal offer a CFTC file (--data-root). It converts the file first with
// the terminal's adapter and declares only a file that converts, create-only;
// it approves nothing. Files here are synthetic (the repository's fixture).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationPathOf, declare, parseArgs } from '../scripts/cot_declare.mjs';
import { buildLocalView } from '../scripts/serve_terminal_local.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/cot_declare.mjs', import.meta.url));
const ROOT = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-cot-declare-'));
mkdirSync(path.join(ROOT, 'positioning'));
const file = path.join(ROOT, 'positioning', 'gold.csv');
copyFileSync(new URL('./fixtures/cftc_cot_disaggregated_synthetic.csv', import.meta.url), file);
const args = ['--dataset', 'futures-only', '--published-at', '2026-09-25T19:30:00.000Z', '--received-at', '2026-09-25T19:45:00.000Z'];

assert.equal(parseArgs([file]), null, 'dataset and both instants are required');
assert.equal(parseArgs([file, '--dataset', 'legacy', ...args.slice(2)]), null);
assert.equal(parseArgs([file, ...args]).dataset, 'FUTURES_ONLY');
assert.equal(declarationPathOf('/x/y/gold.csv'), '/x/y/gold.declaration.json');

// Two reports in the file: refused, the dates listed, nothing written.
let out = spawnSync(process.execPath, [SCRIPT, file, ...args], { encoding: 'utf8' });
assert.equal(out.status, 1);
assert.match(out.stderr, /MULTIPLE_REPORT_DATES.*rapports présents : 2026-09-22, 2026-09-29/);
assert.equal(existsSync(declarationPathOf(file)), false);
// One report chosen: declared, with the converted report date; the terminal then reads it.
out = spawnSync(process.execPath, [SCRIPT, file, ...args, '--report-date', '2026-09-22'], { encoding: 'utf8' });
assert.equal(out.status, 0, out.stderr);
assert.match(out.stdout, /déclaré : gold\.declaration\.json — rapport du 2026-09-22, 14 mesures, futures seuls ; source non approuvée/);
assert.deepEqual(JSON.parse(readFileSync(declarationPathOf(file), 'utf8')), { schemaVersion: 'xau.cftc-cot-declaration.v1',
  dataset: 'FUTURES_ONLY', publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z', reportDate: '2026-09-22' });
const entry = (await buildLocalView({ dataRoot: ROOT })).catalog().positioning.find((p) => p.id === 'cot:gold.csv');
assert.deepEqual([entry.status, entry.metrics, entry.reportDate, entry.sourceApproval], ['EXTRACTED', 14, '2026-09-22', 'NOT_APPROVED']);
// Never replaced.
const before = readFileSync(declarationPathOf(file), 'utf8');
out = spawnSync(process.execPath, [SCRIPT, file, ...args, '--report-date', '2026-09-22'], { encoding: 'utf8' });
assert.equal(out.status, 1);
assert.match(out.stderr, /existe déjà/);
assert.equal(readFileSync(declarationPathOf(file), 'utf8'), before);
// Unknown formats: refused with their named reason, nothing written.
for (const [name, body, reason] of [['f.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), /UNSUPPORTED_FORMAT.*ZIP/],
  ['legacy.txt', 'Market_and_Exchange_Names,As_of_Date_In_Form_YYMMDD,Report_Date_as_YYYY-MM-DD,CFTC_Contract_Market_Code,NonComm_Positions_Long_All\r\nX,260922,2026-09-22,088691,1\r\n', /UNSUPPORTED_LAYOUT.*legacy/]]) {
  const target = path.join(ROOT, 'positioning', name);
  writeFileSync(target, body);
  const r = await declare({ ...parseArgs([target, ...args]) });
  assert.equal(r.ok, false, name);
  assert.match(r.message, reason, name);
  assert.equal(existsSync(declarationPathOf(target)), false, name);
}
assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 64);
const source = readFileSync(SCRIPT, 'utf8');
assert.doesNotMatch(source, /\bfetch\(|https?:\/\/|Date\.now\(|new Date\(\)/, 'no network, no clock');
console.log('PASS cot_declare: converts first, declares only a file that converts (create-only), names unknown formats, approves nothing');
