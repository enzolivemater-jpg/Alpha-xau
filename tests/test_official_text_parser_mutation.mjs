/**
 * DOL weekly-claims text parser: structural mutation and adversarial-cost sweep.
 * The retained official text is truncated at many offsets, has each line removed,
 * duplicated or replaced, and receives hostile characters; the parser must
 * never throw, stay deterministic, and either reproduce a payload that the
 * adapter still resolves or refuse with a named result. Adversarial inputs that
 * repeat a long matching prefix without its suffix must not make it quadratic.
 * Offline and deterministic: no network, clock, database or randomness; the cost
 * bound is a generous wall-clock ceiling, not a benchmark.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { mapDolUiWeeklyClaimsReleaseToEventFacts } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import { parseDolUiWeeklyClaimsText } from '../backend/event_facts/dol_ui_weekly_claims_text_parser.ts';

const retained = readFileSync(new URL('./fixtures/dol_ui_weekly_claims_2026_10_01.pdftotext.txt', import.meta.url), 'utf8');
const KINDS = new Set(['PARSED', 'UNAVAILABLE', 'MALFORMED', 'UNSUPPORTED', 'CONFLICT']);
const base = parseDolUiWeeklyClaimsText(retained);
assert.equal(base.kind, 'PARSED');

const lines = retained.split('\n');
const cases = [];
for (let cut = 0; cut < retained.length; cut += Math.max(1, Math.floor(retained.length / 400))) {
  cases.push([`prefix ${cut}`, retained.slice(0, cut)]);
  cases.push([`suffix ${cut}`, retained.slice(cut)]);
}
for (let i = 0; i < lines.length; i += 1) {
  cases.push([`line ${i} removed`, lines.filter((_, j) => j !== i).join('\n')]);
  cases.push([`line ${i} duplicated`, [...lines.slice(0, i + 1), lines[i], ...lines.slice(i + 1)].join('\n')]);
  cases.push([`line ${i} garbled`, lines.map((l, j) => (j === i ? l.replace(/\d/g, '9') : l)).join('\n')]);
  cases.push([`line ${i} blanked`, lines.map((l, j) => (j === i ? '' : l)).join('\n')]);
}
for (const [name, injected] of [['nul', '\u0000'], ['rtl', '‮'], ['bom', '﻿'], ['nbsp', ' '], ['lone surrogate', '\ud800'], ['crlf', '\r\n']]) {
  for (const at of [0, Math.floor(retained.length / 3), Math.floor(retained.length / 2), retained.length]) {
    cases.push([`${name} @${at}`, retained.slice(0, at) + injected + retained.slice(at)]);
  }
}
for (const value of [undefined, null, NaN, 0, 1, true, {}, [], ['x'], () => 1, Symbol('x'), 10n, '', ' ', 'x'.repeat(1_000_001)]) {
  cases.push([`non-text ${typeof value}`, value]);
}

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { PARSED: 0, refused: 0 };
for (const [label, input] of cases) {
  try {
    const out = parseDolUiWeeklyClaimsText(input);
    if (!isDeepStrictEqual(parseDolUiWeeklyClaimsText(input), out)) note(label, 'not deterministic');
    if (out === null || typeof out !== 'object' || !KINDS.has(out.kind)) { note(label, `kind ${out?.kind}`); continue; }
    if (out.kind !== 'PARSED') { tally.refused += 1; continue; }
    tally.PARSED += 1;
    // A parsed payload is only ever one the adapter can judge; it must not throw there either.
    const mapped = mapDolUiWeeklyClaimsReleaseToEventFacts(out.payload);
    // Rewriting digits changes values consistently with the sentence grammar: value integrity is the
    // job of the manifest's SHA-256 check that runs BEFORE this parser, not of the parser. Every
    // structural mutation (cut, removed, blanked, duplicated, injected) must instead keep the payload
    // identical or be refused, never silently attribute another sentence's figures.
    if (!label.endsWith('garbled') && mapped.kind === 'RESOLVED' && !isDeepStrictEqual(out.payload, base.payload)) {
      note(label, `a modified text resolved to a different payload: ${JSON.stringify(out.payload.summary ?? out.payload).slice(0, 700)}`);
    }
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

// Adversarial cost: the lazy `.*?` regexes must not be quadratic on a repeated
// prefix with no closing sentence. Real input is a few kilobytes.
const initialPrefix = 'In the week ending September 26, the advance figure for seasonally adjusted initial claims was 197,000, ';
const continuingPrefix = 'The advance number for seasonally adjusted insured unemployment during the week ending September 19 was 1,701,000, ';
for (const [name, unit] of [['initial', initialPrefix], ['continuing', continuingPrefix]]) {
  const hostile = `UNEMPLOYMENT INSURANCE WEEKLY CLAIMS ${unit.repeat(Math.floor(900_000 / unit.length))}`;
  const started = performance.now();
  const out = parseDolUiWeeklyClaimsText(hostile);
  const elapsed = performance.now() - started;
  assert.ok(KINDS.has(out.kind) && out.kind !== 'PARSED', `${name}: hostile text must not parse`);
  assert.ok(elapsed < 3000, `${name}: ${Math.round(elapsed)} ms on ${hostile.length} characters (limit 3000 ms)`);
}

assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.refused > 100 && tally.PARSED >= 1, `the sweep exercises both outcomes ${JSON.stringify(tally)}`);
console.log(`PASS DOL claims text parser: ${cases.length} structural mutations never thrown or ambiguous `
  + `(${tally.PARSED} parsed, ${tally.refused} refused); repeated-prefix inputs stay linear enough`);
