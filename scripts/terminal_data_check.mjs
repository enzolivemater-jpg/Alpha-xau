#!/usr/bin/env node
/**
 * Checks the operator's local data before opening the terminal: the same
 * catalog the terminal builds (market archives and capture logs, CFTC files
 * and their declarations, official release documents), printed in plain
 * words, with no server, no network and no write.
 *
 *   node scripts/terminal_data_check.mjs [--data-root DIR] [--json]
 *
 * Default DIR: ~/.local/share/xau-v2 (as the launcher's --local-data).
 * Exit: 0 every listed source is usable, 1 some source is rejected or
 * missing (each with its reason), 64 usage. Usable never means approved: the
 * terminal stays HOLD / FORBIDDEN whatever this prints.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ARCHIVE_FIELDS, buildLocalView } from './serve_terminal_local.mjs';

export function parseArgs(argv) {
  const options = { dataRoot: path.join(homedir(), '.local', 'share', 'xau-v2'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--data-root' && argv[i + 1]) options.dataRoot = path.resolve(argv[(i += 1)]);
    else return null;
  }
  return options;
}

/** The catalog of a data root, and the problems an operator must fix, in plain words. */
export async function checkData(dataRoot) {
  const catalog = (await buildLocalView({ dataRoot })).catalog();
  const problems = [];
  const lines = [`données locales : ${dataRoot}`];
  const market = catalog.market.filter((m) => m.kind !== 'INPUT_DOCUMENT');
  lines.push(`marché : ${market.length} source(s)`);
  for (const m of market) {
    const v = m.validation;
    // The fields a replay reads that this source never holds (a VERIFIED replay needs all of them).
    const absent = ARCHIVE_FIELDS.filter((f) => !m.fields.includes(f));
    lines.push(`  - ${m.id} : ${m.records} enregistrement(s), champs ${m.fields.join(', ') || 'aucun'} (absents : ${absent.join(', ') || 'aucun'}), `
      + `observé ${m.observed ? `${m.observed.first} → ${m.observed.last}` : '—'}, rejeu ${v ? `${v.status}${v.nature ? `/${v.nature}` : ''}` : '—'}`
      + `${v && v.reasonCodes.length ? ` (${v.reasonCodes.join(', ')})` : ''}${m.problems.length ? ` ; problèmes : ${m.problems.join(', ')}` : ''}`);
    if (m.problems.length || (v && v.status === 'INVALID')) problems.push(`${m.id} : ${m.problems.join(', ') || 'archive rejetée au rejeu'}`);
  }
  const cot = catalog.positioning.filter((p) => p.kind === 'CFTC_FILE');
  // P-0's rule (the terminal offers the same instant as a replay cutoff): known once both published and received.
  const knownFrom = (p) => (Date.parse(p.receivedAt) > Date.parse(p.publishedAt) ? p.receivedAt : p.publishedAt);
  lines.push(`positionnement CFTC : ${cot.length} fichier(s)`);
  for (const p of cot) {
    lines.push(`  - ${p.id} : ${p.status === 'EXTRACTED' ? `lu, rapport du ${p.reportDate}, ${p.metrics} mesures, publié ${p.publishedAt} (base : ${p.publicationBasis ? p.publicationBasis.kind : 'déclaration seule'}), reçu ${p.receivedAt}, connu à partir de ${knownFrom(p)}${p.boundToBytes === false ? ' ; déclaration NON liée aux octets (sans empreinte) : la refaire avec node scripts/cot_declare.mjs' : ''}`
      : `REJETÉ — ${p.reasonCodes.join(', ')} : ${p.detail}`}${p.fileReports ? ` ; le fichier contient ${p.fileReports.count} rapport(s) ${p.fileReports.first} → ${p.fileReports.last}` : ''}`);
    if (p.status !== 'EXTRACTED') problems.push(`${p.id} : ${p.reasonCodes.join(', ')}`);
  }
  for (const e of catalog.events.filter((x) => x.kind === 'OFFICIAL_RELEASES')) {
    const read = e.releases.filter((r) => r.status === 'RESOLVED');
    lines.push(`événements macro ${e.id} : ${read.length} lue(s) sur ${e.releases.length}`);
    for (const r of e.releases.filter((x) => x.status !== 'RESOLVED')) {
      lines.push(`  - ${r.name} : rejetée (${r.reason})`);
      if (e.id === 'official:local') problems.push(`${e.id}/${r.name} : ${r.reason}`);
    }
  }
  for (const note of catalog.notes) {
    lines.push(`note : ${note}`);
    problems.push(`note : ${note}`);
  }
  lines.push(problems.length ? `${problems.length} point(s) à corriger.` : 'toutes les sources listées sont lisibles.');
  lines.push('Lisible ne veut pas dire approuvé : le terminal reste HOLD, exécution interdite.');
  return { catalog, problems, lines };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write('usage: node scripts/terminal_data_check.mjs [--data-root DIR] [--json]\n');
    return 64;
  }
  const result = await checkData(options.dataRoot);
  process.stdout.write(options.json ? `${JSON.stringify({ catalog: result.catalog, problems: result.problems }, null, 2)}\n` : `${result.lines.join('\n')}\n`);
  return result.problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
