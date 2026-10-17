/**
 * Event Impact and Gold Transmission deterministic processors, mutation sweep.
 * Each processor is fed a CES V2 event version built from an official adapter
 * fixture, with every node replaced by hostile values, removed or given an
 * unknown sibling. A processor must never throw, never mutate its input, stay
 * deterministic, and may only PROCESS to INSUFFICIENT_EVIDENCE / UNAVAILABLE
 * with zero interpretations / zero transmission paths (no positive method is
 * approved), or ABSTAIN. Offline and deterministic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { mapBeaPceReleaseToEventFacts } from '../backend/event_facts/bea_pce_adapter.ts';
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';
import { mapBlsEmploymentReleaseToEventFacts } from '../backend/event_facts/bls_employment_situation_adapter.ts';
import { mapDolUiWeeklyClaimsReleaseToEventFacts } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import { planDeterministicEventImpact } from '../backend/event_impact/deterministic_processor.ts';
import { planDeterministicGoldTransmission } from '../backend/gold_transmission/deterministic_processor.ts';
import { mutationCases } from './lib/mutation_cases.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const SOURCES = [
  ['CPI', mapBlsCpiReleaseToEventFacts, 'bls_cpi_table1_2026_08.json'],
  ['NFP', mapBlsEmploymentReleaseToEventFacts, 'bls_employment_situation_2026_08.json'],
  ['claims', mapDolUiWeeklyClaimsReleaseToEventFacts, 'dol_ui_weekly_claims_2026_10_01.json'],
  ['PCE', mapBeaPceReleaseToEventFacts, 'bea_pce_2026_08.json'],
];
const eventVersion = (mapped) => ({
  id: '11111111-1111-4111-8111-111111111111', clusterId: '22222222-2222-4222-8222-222222222222',
  versionNumber: 1, transitionType: 'NOVELTY', knowledgeCutoff: '2026-09-22T00:00:00.123456Z',
  effectiveTime: null, effectiveTimePrecision: null,
  canonicalEventStateSchemaVersion: mapped.canonicalEventStateSchemaVersion,
  canonicalEventState: mapped.canonicalEventState,
  officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
  supersedesVersionId: null, stateFingerprint: 'a'.repeat(64),
});

const PLANNERS = [
  ['EI', planDeterministicEventImpact, (out) => out.interpretations],
  ['GT', planDeterministicGoldTransmission, (out) => out.paths],
];
const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { PROCESS: 0, ABSTAIN: 0 };

for (const [source, map, file] of SOURCES) {
  const mapped = map(fixture(file));
  assert.equal(mapped.kind, 'RESOLVED', source);
  const base = eventVersion(mapped);
  for (const [name, plan, positives] of PLANNERS) {
    assert.equal(plan({ eventVersion: structuredClone(base) }).kind, 'PROCESS', `${name} ${source} base`);
    for (const [mutation, version] of [['<base>', structuredClone(base)], ...mutationCases(base)]) {
      const label = `${name} ${source} ${mutation}`;
      try {
        const input = { eventVersion: version };
        const before = structuredClone(input);
        const out = plan(input);
        if (!isDeepStrictEqual(before, input)) note(label, 'input mutated');
        if (!isDeepStrictEqual(plan(input), out)) note(label, 'not deterministic');
        if (out === null || typeof out !== 'object' || (out.kind !== 'PROCESS' && out.kind !== 'ABSTAIN')) { note(label, `kind ${out?.kind}`); continue; }
        tally[out.kind] += 1;
        if (out.kind === 'PROCESS') {
          if (!['INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'].includes(out.assessmentStatus)) note(label, `status ${out.assessmentStatus}`);
          if (positives(out).length !== 0) note(label, 'positive interpretation or transmission path produced');
        }
      } catch (error) {
        note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
      }
    }
  }
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.PROCESS > 20 && tally.ABSTAIN > 500, `the sweep exercises both outcomes ${JSON.stringify(tally)}`);
console.log(`PASS EI/GT mutation sweep: ${tally.PROCESS + tally.ABSTAIN} hostile event versions, never thrown, `
  + `${tally.PROCESS} processed with zero interpretations/paths, ${tally.ABSTAIN} abstained`);
