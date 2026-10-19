// scripts/terminal_data_check.mjs prints, without a server, what the terminal
// will offer from a local data root and what must be fixed (each rejected
// source with its reason); exit 1 when something is rejected or missing.
// Data written by this test is synthetic (repository fixtures).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkData, parseArgs } from '../scripts/terminal_data_check.mjs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { REPOSITORY_OFFICIAL_RELEASES, SYNTHETIC_ARCHIVE } from '../scripts/serve_terminal_local.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/terminal_data_check.mjs', import.meta.url));
const root = () => mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'xau-check-'));
const COT = new URL('./fixtures/cftc_cot_disaggregated_synthetic.csv', import.meta.url);
// A DATA-2 capture log (what --captures and the merge expect), written in the provider's format by this test.
const cap = await loadBackendModule('market_engine/evidence_capture.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const PARSERS = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
let log = cap.createEvidenceArchive({ archiveId: 'log-a', provenanceClass: 'SYNTHETIC_FIXTURE', createdAt: '2026-10-01T06:00:00Z',
  fields: ['us10y'], statement: 'journal de test synthétique' });
const body = JSON.stringify({ realtime_start: '2026-10-01', realtime_end: '2026-10-01', observation_start: '2026-09-29', units: 'lin', file_type: 'json',
  observations: [{ realtime_start: '2026-10-01', realtime_end: '2026-10-01', date: '2026-09-30', value: '4.10' }] });
log = (await cap.appendProviderCapture(log, { provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10', body, ingestedAt: '2026-10-01T06:00:00Z' }, PARSERS)).archive;

// A clean root: one archive log, one declared CFTC file, one official document.
const good = root();
mkdirSync(path.join(good, 'evidence', 'log-a'), { recursive: true });
writeFileSync(path.join(good, 'evidence', 'log-a', 'archive.json'), JSON.stringify(log));
mkdirSync(path.join(good, 'positioning'));
copyFileSync(COT, path.join(good, 'positioning', 'gold.csv'));
writeFileSync(path.join(good, 'positioning', 'gold.declaration.json'), JSON.stringify({ schemaVersion: 'xau.cftc-cot-declaration.v1',
  dataset: 'FUTURES_ONLY', publishedAt: '2026-09-25T19:30:00.000Z', receivedAt: '2026-09-25T19:45:00.000Z', reportDate: '2026-09-22' }));
mkdirSync(path.join(good, 'official'));
copyFileSync(REPOSITORY_OFFICIAL_RELEASES[3], path.join(good, 'official', 'cpi.json'));
let r = await checkData(good);
assert.deepEqual(r.problems, []);
const text = r.lines.join('\n');
assert.match(text, /log:evidence:log-a : 1 enregistrement\(s\), champs us10y \(absents : spot, bid, ask, dxy, realYield, vix, wti\)/);
// A hand-written DATA-1 archive is not a capture log: the merge refuses it, and the check says so.
const notLog = root();
mkdirSync(path.join(notLog, 'evidence', 'hand-written'), { recursive: true });
copyFileSync(SYNTHETIC_ARCHIVE, path.join(notLog, 'evidence', 'hand-written', 'archive.json'));
assert.ok((await checkData(notLog)).problems.some((p) => /^merged:evidence : RECORD_NOT_REPRODUCED/.test(p)));
// A capture directory whose archive.json is missing (raw files only) is named, never dropped silently.
const noArchive = root();
mkdirSync(path.join(noArchive, 'evidence', 'log-a'), { recursive: true });
writeFileSync(path.join(noArchive, 'evidence', 'log-a', 'archive.json'), JSON.stringify(log));
mkdirSync(path.join(noArchive, 'evidence', 'raw-only'));
writeFileSync(path.join(noArchive, 'evidence', 'raw-only', 'fred.json'), body);
const missing = await checkData(noArchive);
assert.deepEqual(missing.problems, ['note : CAPTURE_LOG_WITHOUT_ARCHIVE:evidence/raw-only', 'note : POSITIONING_DIR_ABSENT']);
assert.ok(missing.lines.some((l) => /^  - merged:evidence : 1 enregistrement/.test(l)), 'the other log is still merged');
assert.match(text, /cot:gold\.csv : lu, rapport du 2026-09-22, 14 mesures, publié 2026-09-25T19:30:00\.000Z \(base : déclaration seule\), reçu 2026-09-25T19:45:00\.000Z, connu à partir de 2026-09-25T19:45:00\.000Z ; le fichier contient 2 rapport\(s\)/);
assert.match(text, /événements macro official:local : 1 lue\(s\) sur 1/);
assert.match(text, /Lisible ne veut pas dire approuvé : le terminal reste HOLD/);
let cli = spawnSync(process.execPath, [SCRIPT, '--data-root', good], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /toutes les sources listées sont lisibles/);

// A root with problems: each one named; exit 1.
const bad = root();
mkdirSync(path.join(bad, 'evidence', 'broken'), { recursive: true });
writeFileSync(path.join(bad, 'evidence', 'broken', 'archive.json'), '{nope');
mkdirSync(path.join(bad, 'positioning'));
copyFileSync(COT, path.join(bad, 'positioning', 'undeclared.csv'));
mkdirSync(path.join(bad, 'official'));
writeFileSync(path.join(bad, 'official', 'other.json'), JSON.stringify({ source: { sourceCode: 'unknown' } }));
r = await checkData(bad);
for (const expected of [/log:evidence:broken : SOURCE_UNREADABLE/, /cot:undeclared\.csv : DECLARATION_MISSING/, /official:local\/other\.json : UNSUPPORTED_RELEASE_SOURCE/]) {
  assert.ok(r.problems.some((p) => expected.test(p)), `${expected} in ${r.problems}`);
}
cli = spawnSync(process.execPath, [SCRIPT, '--data-root', bad, '--json'], { encoding: 'utf8' });
assert.equal(cli.status, 1);
assert.ok(JSON.parse(cli.stdout).problems.length >= 3);
// An empty root: the missing directories are the problems.
r = await checkData(root());
assert.deepEqual(r.problems, ['note : EVIDENCE_DIR_ABSENT', 'note : POSITIONING_DIR_ABSENT']);
assert.equal(parseArgs(['--bogus']), null);
assert.equal(spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' }).status, 64);
console.log('PASS terminal_data_check: lists usable sources, names each problem (exit 1), never claims approval');
