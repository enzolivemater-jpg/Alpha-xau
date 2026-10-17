#!/usr/bin/env node
/**
 * Local DATA-2 capture log: archives provider responses that are already on
 * disk, and replays the archive at a cutoff. It makes no network request and
 * reads no clock: every time is given explicitly.
 *
 *   init    --archive log.json --id ID --created-at ISO --statement TEXT
 *           [--class SYNTHETIC_FIXTURE | --class CAPTURED --attest-captured]
 *   append  --archive log.json --provider fred|twelve_data --symbol SYM
 *           --series ID --body response.json --ingested-at ISO
 *   replay  --archive log.json --cutoff ISO [--digest sha256:...]
 *
 * `--class CAPTURED` states that every body appended was received from the
 * provider by the operator, unmodified; it requires `--attest-captured`. The
 * script cannot check that claim, which is why a replay of a CAPTURED log is
 * HISTORICAL_VERIFIED only when its bytes re-read to the recorded values and
 * its coverage is complete. `--ingested-at` is the time the body was
 * received, never the file's modification time.
 */

import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBackendModule } from './lib/backend_module_loader.mjs';

const FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) return null;
    if (flag === '--attest-captured') { options.attestCaptured = true; continue; }
    const value = rest[i + 1];
    if (value === undefined) return null;
    options[flag.slice(2)] = value;
    i += 1;
  }
  return options;
}

/**
 * Writes through a temporary file so a failed write never leaves half an
 * archive. The bytes are flushed to disk before the rename, so a crash cannot
 * leave a renamed but empty log that looks like a completed capture.
 */
function writeArchive(file, archive) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(archive, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * Exclusive writer lock. `init` and `append` read, change and rewrite the whole
 * log, so two concurrent writers would silently drop one capture. The lock is
 * a sibling file created with O_EXCL; a second writer fails fast instead of
 * waiting. A crashed run leaves the lock behind on purpose: it is removed by
 * the operator after checking the log, never by this script.
 */
function acquireArchiveLock(file) {
  const lock = `${file}.lock`;
  try {
    closeSync(openSync(lock, 'wx'));
  } catch (error) {
    return {
      error: error.code === 'EEXIST'
        ? `${lock} exists: another writer is active, or a crashed run left it; check the log, then remove the lock`
        : `cannot lock ${file}: ${error.message}`,
    };
  }
  return { release: () => { try { unlinkSync(lock); } catch { /* already gone */ } } };
}

/** Commands that rewrite the log hold the writer lock for their whole run. */
export async function run(argv) {
  const o = parse(argv);
  if (o && o.archive && (o.command === 'init' || o.command === 'append')) {
    const lock = acquireArchiveLock(path.resolve(o.archive));
    if (lock.error) {
      process.stderr.write(`${lock.error}\n`);
      return 1;
    }
    try {
      return await execute(argv);
    } finally {
      lock.release();
    }
  }
  return execute(argv);
}

async function execute(argv) {
  const o = parse(argv);
  const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const fail = (message) => { process.stderr.write(`${message}\n`); return 1; };
  if (!o || !o.archive) return fail('usage: see the header of scripts/market_evidence_capture.mjs');
  const cap = await loadBackendModule('market_engine/evidence_capture.ts');
  const ev = await loadBackendModule('market_engine/evidence_archive.ts');
  const providers = await loadBackendModule('market_engine/providers.ts');
  const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
  const file = path.resolve(o.archive);

  if (o.command === 'init') {
    if (existsSync(file)) return fail(`refusing to overwrite ${file}`);
    const cls = o.class ?? 'SYNTHETIC_FIXTURE';
    if (cls === 'CAPTURED' && !o.attestCaptured) return fail('--class CAPTURED requires --attest-captured');
    if (cls !== 'CAPTURED' && cls !== 'SYNTHETIC_FIXTURE') return fail('--class must be SYNTHETIC_FIXTURE or CAPTURED');
    if (!o.id || !o['created-at'] || !o.statement) return fail('init needs --id, --created-at and --statement');
    const archive = cap.createEvidenceArchive({
      archiveId: o.id, provenanceClass: cls, createdAt: o['created-at'], fields: FIELDS, statement: o.statement,
    });
    writeArchive(file, archive);
    out({ created: file, provenanceClass: cls });
    return 0;
  }

  let archive;
  try {
    archive = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${file}: ${error.message}`);
  }

  if (o.command === 'append') {
    if (!o.provider || !o.symbol || !o.series || !o.body || !o['ingested-at']) {
      return fail('append needs --provider, --symbol, --series, --body and --ingested-at');
    }
    const body = readFileSync(path.resolve(o.body), 'utf8');
    const result = await cap.appendProviderCapture(archive, {
      provider: o.provider, symbol: o.symbol, sourceRecordId: o.series, body, ingestedAt: o['ingested-at'],
    }, parsers);
    if (result.outcome === 'APPENDED') writeArchive(file, result.archive);
    out({ ...result, archive: undefined });
    return result.outcome === 'REJECTED' ? 1 : 0;
  }

  if (o.command === 'replay') {
    if (!o.cutoff) return fail('replay needs --cutoff');
    const replay = await ev.replayMarketEvidence(archive, o.cutoff,
      // `--digest ""` is still a pin: it must fail the replay, not switch the pin off.
      { parsers, ...(o.digest !== undefined ? { pinnedArchiveDigest: o.digest } : {}) });
    out({
      status: replay.status, nature: replay.nature, reproducible: replay.reproducible,
      archiveDigest: replay.archive.digest, replayDigest: replay.digest, reasonCodes: replay.reasonCodes,
      decision: replay.decision, execution: replay.execution, marketSnapshot: replay.marketSnapshot,
    });
    return replay.status === 'INVALID' ? 1 : 0;
  }
  return fail(`unknown command ${o.command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await run(process.argv.slice(2));
