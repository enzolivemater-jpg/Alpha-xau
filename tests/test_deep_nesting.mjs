/**
 * Deeply nested hostile input. A recursive validator, serializer or hasher
 * overflows the stack on an array or object nested far enough: that surfaces as
 * a RangeError that no typed refusal catches. Every offline entry point that
 * accepts untrusted structure is fed nesting from 2,000 to 300,000 levels, built
 * iteratively. An entry point may refuse in its own way or accept, but a stack
 * overflow (or any TypeError) must never escape. Offline and deterministic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mapBeaPceReleaseToEventFacts } from '../backend/event_facts/bea_pce_adapter.ts';
import { mapBlsCpiReleaseToEventFacts } from '../backend/event_facts/bls_cpi_adapter.ts';
import { mapBlsEmploymentReleaseToEventFacts } from '../backend/event_facts/bls_employment_situation_adapter.ts';
import { mapDolUiWeeklyClaimsReleaseToEventFacts } from '../backend/event_facts/dol_ui_weekly_claims_adapter.ts';
import { persistBlsCpiProduction } from '../backend/event_facts/bls_cpi_production_writer.ts';
import { planDeterministicEventImpact } from '../backend/event_impact/deterministic_processor.ts';
import { planDeterministicGoldTransmission } from '../backend/gold_transmission/deterministic_processor.ts';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const unified = await loadBackendModule('observability/unified_rehearsal.ts');
const evidence = await loadBackendModule('market_engine/evidence_archive.ts');
const capture = await loadBackendModule('market_engine/evidence_capture.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const ui = await loadBackendModule('advisory_ui/contract.ts');
const transport = await loadBackendModule('advisory_ui/transport_contract.ts');
const manifest = await loadBackendModule('observability/evidence_manifest.ts');
const positioning = await loadBackendModule('positioning_engine/evidence_contract.ts');
const persistedPositioning = await loadBackendModule('positioning_engine/persisted_evidence.ts');
const persistedMarket = await loadBackendModule('market_engine/persisted_as_of.ts');
const asOf = await loadBackendModule('market_engine/as_of_snapshot.ts');
const canonical = await loadBackendModule('shared/canonical_json.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const archiveFixture = JSON.parse(readFileSync(new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url), 'utf8'));
const cpiFixture = JSON.parse(readFileSync(new URL('./fixtures/bls_cpi_table1_2026_08.json', import.meta.url), 'utf8'));

const nestedArray = (depth) => { let v = []; for (let i = 0; i < depth; i += 1) v = [v]; return v; };
const nestedObject = (depth) => { let v = {}; for (let i = 0; i < depth; i += 1) v = { a: v }; return v; };
const DEPTHS = [2_000, 50_000, 300_000];
const SHAPES = [['array', nestedArray], ['object', nestedObject]];

const failures = [];
const note = (label, message) => { if (failures.length < 30) failures.push(`${label}: ${message}`); };
let calls = 0;
const readAt = '2026-12-31T00:00:00.000Z';
const noDb = { async request() { throw new Error('no database'); } };
const eventVersion = (state) => ({
  id: '11111111-1111-4111-8111-111111111111', clusterId: '22222222-2222-4222-8222-222222222222', versionNumber: 1,
  transitionType: 'NOVELTY', knowledgeCutoff: '2026-09-22T00:00:00.123456Z', effectiveTime: null, effectiveTimePrecision: null,
  canonicalEventStateSchemaVersion: 2, canonicalEventState: state, officialConfirmationState: 'OFFICIALLY_CONFIRMED',
  sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN', supersedesVersionId: null, stateFingerprint: 'a'.repeat(64),
});
const cpiState = mapBlsCpiReleaseToEventFacts(cpiFixture).canonicalEventState;
const production = (state) => ({
  observationId: '10000000-0000-4000-8000-000000000001', headerArtifactId: '20000000-0000-4000-8000-000000000001',
  tableArtifactId: '30000000-0000-4000-8000-000000000001', operationIdempotencyFingerprint: 'a'.repeat(64),
  plan: { kind: 'READY', plannerVersion: 'bls-cpi-producer-planner-v1', parserVersion: 'bls-cpi-artifact-parser-v1',
    adapterVersion: 'bls-cpi-event-facts-adapter-v1', canonicalEventStateSchemaVersion: 2, canonicalEventState: state,
    identity: { authorityNamespace: 'xau_v2:official_release:us_bls:v1', identityType: 'official_release_id:bls_cpi_v1',
      identityValue: '{"release_id":"USDL-26-1496"}', candidateClusterIds: [] } },
});

/** Each target receives the hostile value `deep` and a label; it may do anything but overflow. */
const TARGETS = [
  ['chain.evaluate positioningEvidence', (deep) => chain.evaluateDecisionChain({ ...golden.input, positioningEvidence: [deep] }, golden.knowledgeCutoff)],
  ['chain.evaluate whole input', (deep) => chain.evaluateDecisionChain(deep, golden.knowledgeCutoff)],
  ['rehearsal chainInput', (deep) => unified.runUnifiedOfflineRehearsal({ chainInput: deep, knowledgeCutoff: golden.knowledgeCutoff,
    evidenceClaims: [], origin: { kind: 'LOCAL_SCENARIO', label: 'deep' }, generatedAt: readAt })],
  ['rehearsal evidenceClaims', (deep) => unified.runUnifiedOfflineRehearsal({ chainInput: golden.input, knowledgeCutoff: golden.knowledgeCutoff,
    evidenceClaims: [deep], origin: { kind: 'LOCAL_SCENARIO', label: 'deep' }, generatedAt: readAt })],
  ['rehearsal whole envelope', (deep) => unified.runUnifiedOfflineRehearsal(deep)],
  ['replay archive', (deep) => evidence.replayMarketEvidence(deep, '2026-10-01T14:15:00.000Z')],
  ['replay archive.records', (deep) => evidence.replayMarketEvidence({ ...archiveFixture, records: [deep] }, '2026-10-01T14:15:00.000Z')],
  ['replay archive.rawPayloads', (deep) => evidence.replayMarketEvidence({ ...archiveFixture, rawPayloads: { a: deep } }, '2026-10-01T14:15:00.000Z')],
  ['capture append archive', (deep) => capture.appendProviderCapture(deep, { provider: 'fred', symbol: 'US10Y', sourceRecordId: 'DGS10', body: '{}', ingestedAt: '2026-10-01T06:00:00.000Z' },
    { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData })],
  ['capture merge', (deep) => capture.mergeCaptureArchives([deep], { archiveId: 'm', parsers: { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData } })],
  ['advisory ui claims', (deep) => ui.buildInstitutionalAdvisoryUi(deep, golden.knowledgeCutoff)],
  ['advisory ui claims.alerts', (deep) => ui.buildInstitutionalAdvisoryUi({ commandCenter: deep, alerts: deep, acceptance: deep }, golden.knowledgeCutoff)],
  ['transport encode', (deep) => transport.encodeOfflineAdvisoryPacket(deep, golden.knowledgeCutoff)],
  ['evidence manifest', (deep) => manifest.buildEvidenceEligibilityManifest([deep], golden.knowledgeCutoff)],
  ['positioning envelope', (deep) => positioning.buildPositioningEvidenceEnvelope([deep], golden.knowledgeCutoff)],
  ['persisted positioning rows', (deep) => persistedPositioning.buildPersistedPositioningEvidence([deep], golden.knowledgeCutoff)],
  ['persisted market rows', (deep) => persistedMarket.buildPersistedMarketPricingAsOf([deep], golden.knowledgeCutoff)],
  ['as-of candidates', (deep) => asOf.selectMarketPricingAsOf([deep], golden.knowledgeCutoff)],
  ['bea adapter', (deep) => mapBeaPceReleaseToEventFacts(deep)],
  ['bls cpi adapter', (deep) => mapBlsCpiReleaseToEventFacts(deep)],
  ['bls employment adapter', (deep) => mapBlsEmploymentReleaseToEventFacts(deep)],
  ['dol claims adapter', (deep) => mapDolUiWeeklyClaimsReleaseToEventFacts(deep)],
  ['event impact state', (deep) => planDeterministicEventImpact({ eventVersion: eventVersion({ ...cpiState, facts: deep }) })],
  ['gold transmission state', (deep) => planDeterministicGoldTransmission({ eventVersion: eventVersion({ ...cpiState, facts: deep }) })],
  ['event impact whole version', (deep) => planDeterministicEventImpact({ eventVersion: deep })],
  ['cpi writer state', (deep) => persistBlsCpiProduction(noDb, production({ ...cpiState, facts: deep }))],
  ['canonicalJson', (deep) => canonical.canonicalJson(deep)],
];

for (const [name, run] of TARGETS) {
  for (const [shape, build] of SHAPES) {
    for (const depth of DEPTHS) {
      const label = `${name} ${shape} depth ${depth}`;
      calls += 1;
      try {
        await run(build(depth));
      } catch (error) {
        const kind = error && error.name;
        if (kind === 'RangeError') note(label, `STACK OVERFLOW ${String(error.message).slice(0, 60)}`);
        else if (kind === 'TypeError' && !/^canonicalJson: /.test(error.message)) note(label, `TypeError ${String(error.message).slice(0, 80)}`);
      }
    }
  }
}
// JSON text, which the transport inspector and the provider parsers read themselves.
for (const depth of DEPTHS) {
  for (const [shape, text] of [['array', '['.repeat(depth) + ']'.repeat(depth)], ['object', '{"a":'.repeat(depth) + '{}' + '}'.repeat(depth)]]) {
    for (const [name, run] of [
      ['transport inspect', (raw) => transport.inspectOfflineAdvisoryPacket(raw)],
      ['parseFred', (raw) => providers.parseFred(raw, 'US10Y')],
      ['parseFredObservations', (raw) => providers.parseFredObservations(raw, 'US10Y')],
      ['parseTwelveData', (raw) => providers.parseTwelveData(raw, 'XAUUSD')],
    ]) {
      const label = `${name} text ${shape} depth ${depth}`;
      calls += 1;
      try { run(text); } catch (error) {
        if (error && (error.name === 'RangeError' || error.name === 'TypeError')) note(label, `${error.name} ${String(error.message).slice(0, 80)}`);
      }
    }
  }
}

// canonicalJson refuses at one fixed depth, with its own typed error, whatever the host stack size.
assert.doesNotThrow(() => canonical.canonicalJson(nestedArray(256)), 'depth 257 including the root level is still accepted');
assert.throws(() => canonical.canonicalJson(nestedArray(300)), (e) => e instanceof TypeError && /nesting too deep/.test(e.message));
const circular = { a: 1 }; circular.self = circular;
assert.throws(() => canonical.canonicalJson(circular), (e) => e instanceof TypeError && /nesting too deep/.test(e.message), 'a circular structure is refused, not a stack overflow');
const circularArray = []; circularArray.push(circularArray);
assert.throws(() => canonical.canonicalJson(circularArray), (e) => e instanceof TypeError);
// A realistic structure (the full golden chain result) is nowhere near the bound.
const goldenResult = chain.evaluateDecisionChain(golden.input, golden.knowledgeCutoff).result;
assert.doesNotThrow(() => canonical.canonicalJson(goldenResult));

assert.deepEqual(failures, [], `DEEP NESTING failures (first ${failures.length}):\n${failures.join('\n')}`);
console.log(`PASS deep nesting: ${calls} calls with 2,000 to 300,000 levels, no stack overflow or TypeError escapes`);
