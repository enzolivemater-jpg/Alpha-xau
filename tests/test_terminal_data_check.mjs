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
assert.match(text, /cot:gold\.csv : lu, rapport du 2026-09-22, 14 mesures, publié 2026-09-25T19:30:00\.000Z \(base : déclaration seule\), reçu 2026-09-25T19:45:00\.000Z, connu à partir de 2026-09-25T19:45:00\.000Z ; déclaration NON liée aux octets \(sans empreinte\) : la refaire avec node scripts\/cot_declare\.mjs ; le fichier contient 2 rapport\(s\)/);
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

// DATA-3 continuity in terminal:check-data: per field and per series, never "continuous", never a problem by itself.
{
  const { continuityLines, durationText } = await import('../scripts/terminal_data_check.mjs');
  assert.deepEqual([durationText(0.454), durationText(59), durationText(60), durationText(3 * 86_400), durationText(4 * 86_400 + 2 * 3600 + 5)],
    ['0.454 s', '59 s', '1 min', '3 j', '4 j 2 h 5 s']);
  const g = await checkData(good);
  const entry = g.catalog.market.find((m) => m.id === 'log:evidence:log-a');
  const lines = continuityLines(entry.continuity);
  assert.match(lines[0], /^    continuité, fenêtre déclarée 2026-10-01T06:00:00\.000Z → 2026-10-01T06:00:00\.000Z : aucun trou détecté ; continuité NON démontrée/);
  assert.match(lines[1], /^    · us10y \[couvert\] : 1 série\(s\), observé 2026-09-30T00:00:00\.000Z → 2026-09-30T00:00:00\.000Z \(1 instant\(s\)\) ; aucun écart entre observations ; lacunes : aucune détectée → AUCUNE LACUNE DÉTECTÉE — continuité NON démontrée$/);
  for (const l of g.lines) assert.doesNotMatch(l, /continuité démontrée/i);
  assert.ok(g.lines.includes(lines[1]), 'printed under its source');
  assert.deepEqual(g.problems, [], 'continuity findings are reported, not counted as problems');
  // Holes, gaps and not-evaluated fields, from a hand-made summary: every line names its status.
  const report = {
    continuity: 'NOT_ATTESTED', outcome: 'GAPS_DETECTED', window: { from: 'A', to: 'B', basis: 'DECLARED_COVERAGE' },
    fields: [
      { field: 'spot', declared: true, series: ['s'], observationTimes: 2, observed: { first: 'a', last: 'b' }, observationGaps: 1, largestGapSeconds: 3600,
        missingWeekdays: 0, missingSaturdaysSundays: 0, holes: [{ from: 'x', to: 'y', durationSeconds: 120, basis: 'RUNTIME_FRESHNESS_RULE' }], status: 'HOLES_DETECTED' },
      { field: 'dxy', declared: true, series: ['d'], observationTimes: 1, observed: { first: 'a', last: 'a' }, observationGaps: 0, largestGapSeconds: null,
        missingWeekdays: 0, missingSaturdaysSundays: 0, holes: null, status: 'NOT_EVALUATED' },
      { field: 'wti', declared: true, series: [], observationTimes: 0, observed: null, observationGaps: 0, largestGapSeconds: null,
        missingWeekdays: 0, missingSaturdaysSundays: 0, holes: [{ from: 'A', to: 'B', durationSeconds: 60, basis: 'NO_SERIES' }], status: 'NO_SERIES' },
    ],
    series: [{ series: 's', field: 'spot', observationGaps: [{ from: 'a', to: 'b', durationSeconds: 3600 }], duplicates: 1, lateObservations: 0 }],
  };
  const out = continuityLines(report);
  assert.match(out[0], /écarts ou lacunes détectés ; continuité NON démontrée/);
  assert.match(out[1], /spot \[couvert\].*1 écart\(s\) entre observations, le plus long 1 h ; lacunes : x → y \(2 min\) → LACUNES DÉTECTÉES$/);
  assert.match(out[2], /série s : écarts a → b \(1 h\) ; 1 doublon\(s\)$/);
  assert.match(out[3], /dxy \[couvert\].*lacunes non évaluées → NON ÉVALUÉ — aucune règle de fraîcheur approuvée$/);
  assert.match(out[4], /wti \[couvert\] : 0 série\(s\) ; aucun écart entre observations ; lacunes : A → B \(1 min, aucune série\) → AUCUNE SÉRIE$/);
  assert.deepEqual(continuityLines({ continuity: 'NOT_ATTESTED', outcome: 'NOT_EVALUATED', reason: 'NO_RECORD' }),
    ['    continuité : NON ÉVALUÉE (NO_RECORD) — continuité NON démontrée']);
  // Weekday and weekend dates missing between daily observations are counted; closure stays NOT_EVALUATED.
  const daily = continuityLines({ ...report, fields: [{ ...report.fields[0], missingWeekdays: 1, missingSaturdaysSundays: 2, holes: [], status: 'NO_HOLE_DETECTED' }], series: [] });
  assert.match(daily[1], /dates manquantes : 1 en semaine, 2 samedi\/dimanche ; fermeture ou jour férié NON ÉVALUÉ\) ; lacunes : aucune détectée → AUCUNE LACUNE DÉTECTÉE — continuité NON démontrée$/);
}
console.log('PASS terminal:check-data prints the DATA-3 continuity per field and per series; no hole found is never continuity demonstrated');
