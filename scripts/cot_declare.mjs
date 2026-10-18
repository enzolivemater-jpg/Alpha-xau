#!/usr/bin/env node
/**
 * Declares a CFTC Commitments of Traders file already on disk so the local
 * terminal can offer it (--data-root DIR, file in DIR/positioning/).
 *
 *   node scripts/cot_declare.mjs FILE --dataset futures-only|futures-and-options
 *        --published-at ISO --received-at ISO [--report-date YYYY-MM-DD] [--contract 088691]
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

const DATASETS = { 'futures-only': 'FUTURES_ONLY', 'futures-and-options': 'FUTURES_AND_OPTIONS_COMBINED' };

export function parseArgs(argv) {
  const [file, ...rest] = argv;
  if (!file || file.startsWith('--')) return null;
  const options = { file: path.resolve(file), dataset: null, publishedAt: null, receivedAt: null, reportDate: null, contract: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) return null;
    if (flag === '--dataset' && Object.hasOwn(DATASETS, value)) options.dataset = DATASETS[value];
    else if (flag === '--published-at') options.publishedAt = value;
    else if (flag === '--received-at') options.receivedAt = value;
    else if (flag === '--report-date') options.reportDate = value;
    else if (flag === '--contract') options.contract = value;
    else return null;
  }
  return options.dataset && options.publishedAt && options.receivedAt ? options : null;
}

/** The declaration file of a CFTC file: same directory, extension replaced. */
export const declarationPathOf = (file) => path.join(path.dirname(file), `${path.basename(file).replace(/\.[^.]*$/, '')}.declaration.json`);

export async function declare(options) {
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
    ...(options.contract ? { contractMarketCode: options.contract } : {}),
  });
  if (conversion.status !== 'EXTRACTED') {
    const dates = conversion.availableReportDates.length ? ` ; rapports présents : ${conversion.availableReportDates.join(', ')}` : '';
    return { ok: false, message: `fichier rejeté, rien n'est déclaré : ${conversion.reasonCodes.join(', ')} — ${conversion.detail}${dates}` };
  }
  const declaration = {
    schemaVersion: 'xau.cftc-cot-declaration.v1',
    dataset: options.dataset,
    publishedAt: options.publishedAt,
    receivedAt: options.receivedAt,
    // The report converted, so the terminal reads the same one even if the file holds several.
    reportDate: conversion.reportDate,
    ...(options.contract ? { contractMarketCode: options.contract } : {}),
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write('usage: node scripts/cot_declare.mjs FILE --dataset futures-only|futures-and-options'
      + ' --published-at ISO --received-at ISO [--report-date YYYY-MM-DD] [--contract 088691]\n');
    return 64;
  }
  const result = await declare(options);
  (result.ok ? process.stdout : process.stderr).write(`cot_declare : ${result.message}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
