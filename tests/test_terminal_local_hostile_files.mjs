/**
 * Local terminal under hostile --input and --archive files. Whatever the files
 * hold (invalid JSON, null, an array, a BOM, 100,000 levels of nesting, a
 * directory, a missing path, binary bytes), the terminal builds a HOLD /
 * FORBIDDEN simulated view and never throws, so the HTTP server never answers
 * 500 with an internal message. Offline: temporary files only, loopback only.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildLocalView, createTerminalServer, GOLDEN_FIXTURE, SYNTHETIC_ARCHIVE, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'xau-terminal-hostile-'));
const golden = readFileSync(GOLDEN_FIXTURE, 'utf8');
const archive = readFileSync(SYNTHETIC_ARCHIVE, 'utf8');
const deep = (n) => '['.repeat(n) + ']'.repeat(n);
const deepObject = (n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
const goldenDoc = JSON.parse(golden);

const FILES = {
  empty: '', blank: ' \n ', nul: '\u0000', text: 'not json', null: 'null', array: '[]', string: '"x"', number: '42', true: 'true',
  object: '{}', bom: `﻿${golden}`, truncated: golden.slice(0, golden.length >> 1), trailingGarbage: `${golden} x`,
  deepArray: deep(100_000), deepObject: deepObject(100_000), binary: Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]),
  onlyCutoff: JSON.stringify({ knowledgeCutoff: golden.knowledgeCutoff }), noInput: JSON.stringify({ knowledgeCutoff: goldenDoc.knowledgeCutoff }),
  badCutoff: JSON.stringify({ ...goldenDoc, knowledgeCutoff: 'tomorrow' }), numberCutoff: JSON.stringify({ ...goldenDoc, knowledgeCutoff: 1727791200000 }),
  nullInput: JSON.stringify({ knowledgeCutoff: goldenDoc.knowledgeCutoff, input: null }),
  protoKey: '{"__proto__":{"polluted":true},"knowledgeCutoff":"2026-10-01T14:15:00.000Z","input":{}}',
  hugeString: JSON.stringify({ knowledgeCutoff: goldenDoc.knowledgeCutoff, input: { marketSnapshot: 'x'.repeat(2_000_000) } }),
};
const paths = {};
for (const [name, content] of Object.entries(FILES)) {
  paths[name] = path.join(dir, `${name}.json`);
  writeFileSync(paths[name], content);
}
paths.directory = path.join(dir, 'a-directory');
mkdirSync(paths.directory);
paths.missing = path.join(dir, 'does-not-exist.json');

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const AT = () => ({ toISOString: () => '2026-12-31T00:00:00.000Z' });
let views = 0;

function checkView(label, view) {
  views += 1;
  if (view === null || typeof view !== 'object') { note(label, 'no view'); return; }
  if (view.simulated !== true) note(label, 'view not labelled simulated');
  if (view.chain.chainState !== 'HOLD' || view.chain.execution !== 'FORBIDDEN') note(label, 'view left HOLD/FORBIDDEN');
  if (view.chain.outcome === 'REJECTED' && view.chain.digest !== null) note(label, 'a rejected input shows a fingerprint');
  if (view.summary.decision !== 'HOLD' || view.summary.execution !== 'FORBIDDEN') note(label, 'summary left HOLD/FORBIDDEN');
  try { JSON.stringify(view); } catch (error) { note(label, `view not serializable: ${error.message}`); }
}

for (const [name, file] of Object.entries(paths)) {
  const label = `--input ${name}`;
  try {
    const view = await (await buildLocalView({ inputFile: file, now: AT }))();
    checkView(label, view);
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error}`);
  }
}
for (const [name, file] of Object.entries(paths)) {
  const label = `--archive ${name}`;
  try {
    const view = await (await buildLocalView({ archiveFile: file, now: AT }))();
    checkView(label, view);
    if (view.marketEvidence !== null && view.marketEvidence.status === 'VERIFIED' && name !== 'array') {
      note(label, 'a hostile archive file replayed as VERIFIED');
    }
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error}`);
  }
}
for (const cutoff of ['', 'tomorrow', '2026-02-30T00:00:00Z', '2026-10-01T14:15:00.000500Z', '0000-01-01T00:00:00Z']) {
  const label = `--archive synthetic --cutoff ${JSON.stringify(cutoff)}`;
  try {
    checkView(label, await (await buildLocalView({ archiveFile: SYNTHETIC_ARCHIVE, cutoff, now: AT }))());
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error}`);
  }
}
for (const digest of ['sha256:' + '0'.repeat(64), 'nope', '', 'sha256:' + 'F'.repeat(64)]) {
  const label = `--archive-digest ${JSON.stringify(digest)}`;
  try {
    const view = await (await buildLocalView({ archiveFile: SYNTHETIC_ARCHIVE, archiveDigest: digest, now: AT }))();
    checkView(label, view);
    if (view.marketEvidence.status === 'VERIFIED') note(label, 'a wrong pinned digest still replayed as VERIFIED');
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 2).join(' | ') : error}`);
  }
}

// Over HTTP: the hostile file never turns into a 500 with an internal message.
const bodyOf = (port, pathname) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});
for (const name of ['text', 'null', 'deepArray', 'binary', 'directory', 'missing', 'hugeString']) {
  const server = await createTerminalServer({ inputFile: paths[name] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { status, body } = await bodyOf(server.address().port, VIEW_PATH);
  await new Promise((resolve) => server.close(resolve));
  if (status !== 200) note(`http --input ${name}`, `status ${status}: ${body.slice(0, 120)}`);
  else if (JSON.parse(body).chain.chainState !== 'HOLD') note(`http --input ${name}`, 'not HOLD');
}

rmSync(dir, { recursive: true, force: true });
assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `HOSTILE FILE failures (first ${failures.length}):\n${failures.join('\n')}`);
console.log(`PASS terminal local: ${views} views from hostile --input/--archive files, every one HOLD / FORBIDDEN, no 500 over HTTP`);
