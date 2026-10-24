#!/usr/bin/env node
/**
 * Declares a CFTC Commitments of Traders file already on disk so the local
 * terminal can offer it (--data-root DIR, file in DIR/positioning/).
 *
 *   node scripts/cot_declare.mjs FILE --dataset futures-only|futures-and-options
 *        --published-at ISO --received-at ISO [--report-date YYYY-MM-DD] [--contract 088691] [--source-url https://…]
 *        [--publication-basis explicit|schedule-inferred --publication-reference https://www.cftc.gov/…]
 *   node scripts/cot_declare.mjs FILE --inspect [--contract 088691]
 *
 * --inspect reads a file (a real CFTC download, say) and prints what its header
 * offers — format, CFTC layout, missing columns, date column(s), the
 * FutOnly_or_Combined values, report dates of the market — and writes nothing.
 * A declaration records the file's sha256 (artifactId): the terminal refuses
 * it if the bytes change afterwards.
 *
 * The declaration states what the file cannot prove: which CFTC publication it
 * is, when the CFTC published it and when the operator received it. The file
 * is converted first with the same adapter as the terminal; only a file that
 * converts is declared. `<name>.declaration.json` is written next to it,
 * create-only (an existing declaration is never replaced). No network, no
 * clock: every instant is given. Declaring approves nothing: CFTC stays a
 * candidate source and positioning stays UNAVAILABLE.
 * Exit: 0 declared, 1 file rejected or declaration present, 64 usage.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBackendModule } from './lib/backend_module_loader.mjs';
import { isCftcReleaseInstant } from './lib/cftc_release_instant.mjs';

const DATASETS = { 'futures-only': 'FUTURES_ONLY', 'futures-and-options': 'FUTURES_AND_OPTIONS_COMBINED' };

export function parseArgs(argv) {
  const [file, ...rest] = argv;
  if (!file || file.startsWith('--')) return null;
  const options = { file: path.resolve(file), dataset: null, publishedAt: null, receivedAt: null, reportDate: null, contract: null,
    sourceUrl: null, inspect: false, publicationBasis: null, publicationReference: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === '--inspect') { options.inspect = true; i -= 1; continue; }
    if (value === undefined) return null;
    if (flag === '--dataset' && Object.hasOwn(DATASETS, value)) options.dataset = DATASETS[value];
    else if (flag === '--published-at') options.publishedAt = value;
    else if (flag === '--received-at') options.receivedAt = value;
    else if (flag === '--report-date') options.reportDate = value;
    else if (flag === '--contract' && /^[0-9A-Z]{6}$/.test(value)) options.contract = value;
    else if (flag === '--source-url' && /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%\/-]*)?$/.test(value)) options.sourceUrl = value;
    else if (flag === '--publication-basis' && (value === 'explicit' || value === 'schedule-inferred')) {
      options.publicationBasis = value === 'explicit' ? 'EXPLICIT_OFFICIAL_MAPPING' : 'OFFICIAL_SCHEDULE_INFERRED';
    } else if (flag === '--publication-reference' && /^https:\/\/(www\.)?cftc\.gov\/[A-Za-z0-9._~%\/-]*$/.test(value)) options.publicationReference = value;
    else return null;
  }
  if (options.inspect) return options.dataset || options.publishedAt || options.receivedAt ? null : options;
  // A basis names its official reference; one without the other says nothing.
  if ((options.publicationBasis === null) !== (options.publicationReference === null)) return null;
  return options.dataset && options.publishedAt && options.receivedAt ? options : null;
}

/** The declaration file of a CFTC file: same directory, extension replaced. */
export const declarationPathOf = (file) => path.join(path.dirname(file), `${path.basename(file).replace(/\.[^.]*$/, '')}.declaration.json`);

export async function declare(options) {
  // A basis names the CFTC's 3:30 p.m. ET release: an instant it contradicts is not declared (the terminal would refuse it).
  if (options.publicationBasis && !isCftcReleaseInstant(options.publishedAt)) {
    return { ok: false, message: `--published-at ${options.publishedAt} n'est pas 15 h 30 heure de l'Est : il contredit la base de publication citée ; rien n'est déclaré` };
  }
  const adapter = await loadBackendModule('positioning_engine/cftc_cot_offline_adapter.ts');
  let bytes;
  try {
    bytes = readFileSync(options.file);
  } catch (error) {
    return { ok: false, message: `fichier illisible : ${error.code ?? error.message}` };
  }
  const conversion = adapter.convertCftcCotReport({
    text: bytes.toString('utf8'), artifactId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    publishedAt: options.publishedAt, receivedAt: options.receivedAt, reportDate: options.reportDate, dataset: options.dataset,
    ...(options.contract !== null ? { contractMarketCode: options.contract } : {}),
  });
  if (conversion.status !== 'EXTRACTED') {
    const dates = conversion.availableReportDates.length ? ` ; rapports présents : ${conversion.availableReportDates.join(', ')}` : '';
    return { ok: false, message: `fichier rejeté, rien n'est déclaré : ${conversion.reasonCodes.join(', ')} — ${conversion.detail}${dates}` };
  }
  const declaration = {
    schemaVersion: 'xau.cftc-cot-declaration.v1',
    // The exact bytes declared: a later change of the file voids this declaration in the terminal.
    artifactId: conversion.artifactId,
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    ...(options.publicationBasis ? { publicationBasis: { kind: options.publicationBasis, reference: options.publicationReference } } : {}),
    dataset: options.dataset,
    publishedAt: options.publishedAt,
    receivedAt: options.receivedAt,
    // The report converted, so the terminal reads the same one even if the file holds several.
    reportDate: conversion.reportDate,
    ...(options.contract !== null ? { contractMarketCode: options.contract } : {}),
  };
  const target = declarationPathOf(options.file);
  try {
    writeFileSync(target, `${JSON.stringify(declaration, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    return { ok: false, message: `déclaration non écrite (${error.code === 'EEXIST' ? 'elle existe déjà ; la retirer d\'abord si elle est fausse' : error.code ?? error.message}) : ${target}` };
  }
  return { ok: true, target, conversion,
    message: `déclaré : ${path.basename(target)} — rapport du ${conversion.reportDate}, ${conversion.evidence.length} mesures, `
      + `${options.dataset === 'FUTURES_ONLY' ? 'futures seuls' : 'futures et options'} ; source non approuvée, positionnement UNAVAILABLE` };
}

/** What a file offers, before any declaration; writes nothing. */
export async function inspect(options) {
  const adapter = await loadBackendModule('positioning_engine/cftc_cot_offline_adapter.ts');
  let bytes;
  try {
    bytes = readFileSync(options.file);
  } catch (error) {
    return { ok: false, message: `fichier illisible : ${error.code ?? error.message}` };
  }
  const r = adapter.inspectCftcCotFile(bytes.toString('utf8'), options.contract ?? undefined);
  const lines = [
    `fichier : ${path.basename(options.file)} · sha256:${createHash('sha256').update(bytes).digest('hex')} · ${bytes.length} octets`,
    `format : ${r.formatProblem ?? 'texte CSV'}${r.layout ? ` · rapport CFTC ${r.layout}` : ''} · ${r.columnCount} colonnes`,
    `colonnes requises absentes : ${r.missingColumns.length ? r.missingColumns.join(', ') : 'aucune'}`,
    `colonne(s) date : ${r.dateColumns.join(' + ') || 'aucune'} · FutOnly_or_Combined : ${r.datasetMarkerColumn ? `présente (${r.datasetMarkers.join(', ') || 'vide'})` : 'absente'}`,
    `marché ${options.contract ?? '088691'} : ${r.marketRows} ligne(s) · rapports : ${r.reportDates.join(', ') || 'aucun'}`,
  ];
  const ok = r.formatProblem === null && r.missingColumns.length === 0 && r.marketRows > 0;
  return { ok, inspection: r, message: `${lines.join('\n')}\n${ok ? 'compatible avec l\'adaptateur : déclarer un rapport (--report-date) avec ses instants officiels'
    : 'non compatible en l\'état : rien à déclarer'}` };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write('usage: node scripts/cot_declare.mjs FILE --dataset futures-only|futures-and-options'
      + ' --published-at ISO --received-at ISO [--report-date YYYY-MM-DD] [--contract 088691] [--source-url https://…]'
      + ' [--publication-basis explicit|schedule-inferred --publication-reference https://www.cftc.gov/…]\n'
      + '       node scripts/cot_declare.mjs FILE --inspect [--contract 088691]\n');
    return 64;
  }
  const result = options.inspect ? await inspect(options) : await declare(options);
  (result.ok ? process.stdout : process.stderr).write(`cot_declare : ${result.message}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
