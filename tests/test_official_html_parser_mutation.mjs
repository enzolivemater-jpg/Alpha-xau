/**
 * BLS Employment Situation HTML parser: bounded structural mutation check on the
 * retained, authenticated August 2026 archive page. The lines that carry the
 * narrative payroll figure, the unemployment rate and average hourly earnings
 * are removed or duplicated, the page is cut in half, and non-pages are fed.
 * The parser must never throw and must either reproduce the reviewed payload or
 * refuse; it may never resolve other figures after a purely structural change
 * (value integrity belongs to the manifest hash check that runs before it).
 *
 * Deliberately small: jsdom retains roughly 90 MB per parsed 1 MB page in this
 * environment even after window.close() (measured: four closed raw JSDOM
 * instances kept ~370 MB after a forced GC), so an exhaustive sweep of this
 * parser would exhaust the heap. This parser is an operator script, not a
 * long-running service. Offline and deterministic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { mapBlsEmploymentReleaseToEventFacts } from '../backend/event_facts/bls_employment_situation_adapter.ts';
import { decodeBlsEmploymentSituationHtmlArtifact } from '../scripts/audit_bls_employment_situation_ahe_artifact.mjs';
import { parseAuthenticatedBlsEmploymentSituationHtml } from '../scripts/parse_bls_employment_situation_html.mjs';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/bls_employment_situation_2026_08.artifact.json', import.meta.url), 'utf8'));
const html = decodeBlsEmploymentSituationHtmlArtifact(
  readFileSync(new URL('./fixtures/bls_employment_situation_2026_08.archive.html.gz', import.meta.url)), manifest);
const KINDS = new Set(['PARSED', 'MALFORMED', 'CONFLICT', 'UNSUPPORTED', 'UNAVAILABLE']);

const base = parseAuthenticatedBlsEmploymentSituationHtml(html, manifest);
assert.equal(base.kind, 'PARSED');
const lines = html.split('\n');
const anchors = [
  /Total nonfarm payroll employment (?:increased|rose|changed little)/,
  /unemployment rate/i,
  /average hourly earnings/i,
];
const picked = anchors.map((pattern) => lines.findIndex((line) => pattern.test(line)));
assert.ok(picked.every((i) => i >= 0), `the page carries each anchor line (${picked})`);

// Built lazily: one mutated page alive at a time.
const cases = [];
for (const i of picked) {
  cases.push([`line ${i} removed`, () => lines.filter((_, j) => j !== i).join('\n')]);
  cases.push([`line ${i} duplicated`, () => [...lines.slice(0, i + 1), lines[i], ...lines.slice(i + 1)].join('\n')]);
}
cases.push(['cut in half', () => html.slice(0, Math.floor(html.length / 2))]);
for (const value of [undefined, null, '', 0, {}, '<html></html>', '\u0000']) {
  cases.push([`non-page ${typeof value} ${String(value).slice(0, 10)}`, () => value]);
}

const failures = [];
const tally = { PARSED: 0, refused: 0 };
for (const [label, build] of cases) {
  try {
    const out = parseAuthenticatedBlsEmploymentSituationHtml(build(), manifest);
    if (out === null || typeof out !== 'object' || !KINDS.has(out.kind)) { failures.push(`${label}: kind ${out?.kind}`); continue; }
    if (out.kind !== 'PARSED') { tally.refused += 1; continue; }
    tally.PARSED += 1;
    mapBlsEmploymentReleaseToEventFacts(out.payload);
    if (!isDeepStrictEqual(out.payload, base.payload)) failures.push(`${label}: other figures resolved ${JSON.stringify(out.payload.summary).slice(0, 400)}`);
  } catch (error) {
    failures.push(`${label}: THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

assert.deepEqual(failures, [], `MUTATION failures:\n${failures.join('\n')}`);
assert.ok(tally.refused >= 5, `the check exercises refusals ${JSON.stringify(tally)}`);
console.log(`PASS BLS employment HTML parser: ${cases.length} bounded structural mutations never thrown nor resolved to other figures `
  + `(${tally.PARSED} parsed to the reviewed payload, ${tally.refused} refused)`);
