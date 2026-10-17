/**
 * Official-release adapters (BLS CPI, BLS Employment Situation, DOL weekly
 * claims, BEA PCE) mutation sweep. Every node of each official fixture is
 * replaced by hostile values, removed or given an unknown sibling. An adapter
 * must never throw, never mutate its input, stay deterministic, and when it
 * does resolve, expose a canonically hashable state whose consensus is still
 * UNKNOWN and which carries no directional or market-impact field.
 * Offline and deterministic: no network, clock, database or randomness.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { mapBeaPceReleaseToEventFacts, resolveBeaPceReleaseIdentity } from '../backend/event_facts/bea_pce_adapter.ts';
import { mapBlsCpiReleaseToEventFacts, resolveBlsCpiReleaseIdentity } from '../backend/event_facts/bls_cpi_adapter.ts';
import { mapBlsEmploymentReleaseToEventFacts, resolveBlsEmploymentReleaseIdentity } from '../backend/event_facts/bls_employment_situation_adapter.ts';
import { mapDolUiWeeklyClaimsReleaseToEventFacts, resolveDolUiClaimsReleaseIdentity } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import { canonicalJson } from '../backend/shared/canonical_json.ts';
import { mutationCases } from './lib/mutation_cases.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ADAPTERS = [
  { name: 'BEA PCE', map: mapBeaPceReleaseToEventFacts, identity: resolveBeaPceReleaseIdentity,
    inputs: ['bea_pce_2026_07.json', 'bea_pce_2026_08.json'] },
  { name: 'BLS CPI', map: mapBlsCpiReleaseToEventFacts, identity: resolveBlsCpiReleaseIdentity,
    inputs: ['bls_cpi_table1_2026_07.json', 'bls_cpi_table1_2026_08.json'] },
  { name: 'BLS employment', map: mapBlsEmploymentReleaseToEventFacts, identity: resolveBlsEmploymentReleaseIdentity,
    inputs: ['bls_employment_situation_2026_07.json', 'bls_employment_situation_2026_08.json'] },
  { name: 'DOL claims', map: mapDolUiWeeklyClaimsReleaseToEventFacts, identity: resolveDolUiClaimsReleaseIdentity,
    inputs: ['dol_ui_weekly_claims_2026_10_01.json'] },
];
const KINDS = new Set(['RESOLVED', 'UNAVAILABLE', 'MALFORMED', 'CONFLICT', 'UNSUPPORTED']);
const DIRECTIONAL = /direction|impact|signal|bullish|bearish|surprise|recommend|score|expected_move/i;

const keysDeep = (node, out = []) => {
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) { out.push(key); keysDeep(node[key], out); }
  }
  return out;
};

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { RESOLVED: 0, refused: 0 };

for (const adapter of ADAPTERS) {
  let resolvedBases = 0;
  for (const file of adapter.inputs) {
    const base = fixture(file);
    const baseKind = adapter.map(base).kind;
    // July 2026 employment has no explicit AHE month-over-month figure: deriving
    // one is forbidden, so it must stay unavailable (completion board, hard stops).
    assert.equal(baseKind, file === 'bls_employment_situation_2026_07.json' ? 'UNAVAILABLE' : 'RESOLVED', `${adapter.name} ${file}`);
    if (baseKind === 'RESOLVED') resolvedBases += 1;
    for (const [mutation, input] of [['<base>', structuredClone(base)], ...mutationCases(base)]) {
      const label = `${adapter.name} ${file} ${mutation}`;
      try {
        const before = structuredClone(input);
        const result = adapter.map(input);
        if (!isDeepStrictEqual(before, input)) note(label, 'input mutated');
        if (!isDeepStrictEqual(adapter.map(input), result)) note(label, 'not deterministic');
        if (result === null || typeof result !== 'object' || !KINDS.has(result.kind)) { note(label, `kind ${result?.kind}`); continue; }
        adapter.identity(input);
        if (result.kind !== 'RESOLVED') { tally.refused += 1; continue; }
        tally.RESOLVED += 1;
        try { canonicalJson(result.canonicalEventState); } catch (error) { note(label, `unhashable state: ${error.message}`); }
        const metrics = result.canonicalEventState.facts.metrics;
        if (!Array.isArray(metrics) || metrics.length === 0) note(label, 'resolved without metrics');
        for (const metric of metrics) {
          if (metric.consensus?.state !== 'UNKNOWN' || metric.consensus?.value !== null) note(label, `consensus fabricated for ${metric.metric_code}`);
          if (typeof metric.actual?.value !== 'string' || !/^-?\d+(\.\d+)?$/.test(metric.actual.value)) note(label, `non-numeric actual ${metric.metric_code}`);
        }
        const offending = keysDeep(result.canonicalEventState).filter((key) => DIRECTIONAL.test(key));
        if (offending.length) note(label, `directional field ${offending.join(',')}`);
      } catch (error) {
        note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
      }
    }
  }
  // Otherwise this adapter's sweep would only ever test refusals.
  assert.ok(resolvedBases >= 1, `${adapter.name}: at least one unmutated fixture resolves`);
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.refused > 500 && tally.RESOLVED > 10, `the sweep exercises both outcomes ${JSON.stringify(tally)}`);
console.log(`PASS official-release adapters mutation sweep: ${tally.RESOLVED + tally.refused} hostile inputs, never thrown, `
  + `${tally.RESOLVED} resolved with UNKNOWN consensus and no directional field, ${tally.refused} refused`);
