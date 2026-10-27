/**
 * RC-0: one offline systems-level smoke across DATA-4E/4F/4G and
 * CHAIN-0 / OBS-0 / terminal / advisory. No external I/O, DB or broker.
 * Synthetic successful receipts NEVER authorize real market decisions.
 *
 * B1 (last block): the macro branch end to end at one cutoff, from the four
 * committed official-release fixtures through Event Facts, EI / GT, EIA-0,
 * CHAIN-0, OBS-0 and the terminal. This test composes the modules itself;
 * no runtime does (EIA-0 is not wired), so it proves the contracts fit, not
 * an automatic integration.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { buildLocalView } from '../scripts/serve_terminal_local.mjs';

const [schedule, replay, readiness, unified] = await Promise.all([
  loadBackendModule('market_engine/capture_schedule.ts'),
  loadBackendModule('market_engine/offline_capture_replay.ts'),
  loadBackendModule('market_engine/collector_readiness.ts'),
  loadBackendModule('observability/unified_rehearsal.ts'),
]);
const policy = {
  schemaVersion: 'xau.capture-schedule-policy.v1',
  planId: 'rc0-offline-only',
  windowStart: '2026-10-15T00:00:00.000Z',
  windowEnd: '2026-10-16T00:00:00.000Z',
  requestBudgets: {fred: 1, twelve_data: 1},
  series: [
    {provider:'fred',symbol:'US10Y',sourceRecordId:'DGS10',windows:[
      {slotId:'fred-dgs10',earliestAt:'2026-10-15T08:00:00.000Z',
       deadlineAt:'2026-10-15T08:10:00.000Z'},
    ]},
    {provider:'twelve_data',symbol:'XAUUSD',sourceRecordId:'XAU/USD',windows:[
      {slotId:'twelve-xau',earliestAt:'2026-10-15T09:00:00.000Z',
       deadlineAt:'2026-10-15T09:10:00.000Z'},
    ]},
  ],
};
const compiled = schedule.compileCaptureSchedule(policy);
const planFingerprint = await readiness.fingerprintCaptureSchedule(policy);
assert.equal(compiled.plannedRequests, 2);
assert.equal(compiled.authorization, 'OFFLINE_ONLY');
assert.equal(compiled.calendarCompleteness, 'NOT_PROVEN');
assert.match(planFingerprint, /^sha256:[a-f0-9]{64}$/);

const cutoff = '2026-10-16T00:00:00.000Z';
const fakeDigest = 'sha256:' + 'f'.repeat(64);
const attempts = [
  {slotId:'fred-dgs10',attempt:1,at:'2026-10-15T08:02:00.000Z',
   outcome:'CAPTURED',rawPayloadDigest:fakeDigest,failureCode:null},
  {slotId:'twelve-xau',attempt:1,at:'2026-10-15T09:01:00.000Z',
   outcome:'RETRYABLE_FAILURE',rawPayloadDigest:null,failureCode:'TIMEOUT'},
  {slotId:'twelve-xau',attempt:2,at:'2026-10-15T09:03:00.000Z',
   outcome:'CAPTURED',rawPayloadDigest:fakeDigest,failureCode:null},
];
const retry = {
  maxAttemptsPerSlot: 2, minimumRetryDelayMs: 60_000,
  maxProviderAttempts: {fred: 1, twelve_data: 2},
};
const simulated = replay.replayOfflineCaptureAttempts(policy, attempts, cutoff, retry);
assert.equal(simulated.status, 'SIMULATED');
assert.equal(simulated.audit.status, 'ATTEMPTS_RECORDED');
assert.equal(simulated.simulationOnly, true);
assert.equal(simulated.providerAuthenticity, 'NOT_PROVEN');
assert.equal(simulated.archiveCoverage, 'NOT_ESTABLISHED');
assert.equal(simulated.decision, 'HOLD');
assert.equal(simulated.execution, 'FORBIDDEN');
assert.deepEqual(replay.replayOfflineCaptureAttempts(
  policy, [...attempts].reverse(), cutoff, retry), simulated);

const review = {
  schemaVersion: readiness.COLLECTOR_READINESS_SCHEMA_VERSION,
  planId: policy.planId, planFingerprint,
  gates: readiness.REQUIRED_COLLECTOR_GATES.map(gate_id => ({
    gate_id, status:'PENDING', evidence_reference:null, evidence_digest:null,
    reviewer:null, reviewed_at_utc:null, expiry_or_review_due:null,
    scope:null, version:null, rejection_reasons:[],
  })),
};
const result = await readiness.evaluateCollectorReadinessForSchedule(policy, review, cutoff);
assert.equal(result.status, 'INCOMPLETE');
assert.equal(result.unapprovedGates.length, readiness.REQUIRED_COLLECTOR_GATES.length);
assert.equal(result.execution, 'FORBIDDEN');
await assert.rejects(() => readiness.evaluateCollectorReadinessForSchedule(
  {...policy, series: [{...policy.series[0], windows: [{...policy.series[0].windows[0],
    deadlineAt:'2026-10-15T08:11:00.000Z'}]}, policy.series[1]]},
  review, cutoff,
), /COLLECTOR_READINESS_PLAN_MISMATCH/);

const golden = JSON.parse(readFileSync(new URL(
  './fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const generatedAt = '2026-10-14T12:00:00.000Z';
const unifiedResult = await unified.runUnifiedOfflineRehearsal({
  chainInput: golden.input, knowledgeCutoff: golden.knowledgeCutoff,
  evidenceClaims: [], origin: {kind:'GOLDEN_FIXTURE',label:'rc0-golden'},
  generatedAt,
});
assert.equal(unifiedResult.outcome, 'COMPLETED');
assert.equal(unifiedResult.terminal.stages.length, 12);
assert.equal(unifiedResult.receipt.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.equal(unifiedResult.receipt.fingerprint, unifiedResult.terminal.chain.digest);
assert.equal(unifiedResult.terminal.chain.execution, 'FORBIDDEN');
assert.equal(unifiedResult.advisory.tradeTicket, null);
assert.equal(unifiedResult.transport.packet?.actionability, 'NONE');
assert.equal(unifiedResult.provenance, 'UNVERIFIED');

const localView = await buildLocalView({now: () => ({toISOString: () => generatedAt})});
const terminal = await localView();
assert.equal(terminal.chain.chainState, 'HOLD');
assert.equal(terminal.chain.execution, 'FORBIDDEN');
assert.equal(terminal.chain.digest, unifiedResult.receipt.fingerprint,
  'one accepted OBS-0 digest, regardless of presentation entrypoint');
assert.equal(terminal.simulated, true);
assert.equal(terminal.origin.kind, 'GOLDEN_FIXTURE');
console.log('PASS RC-0: DATA-4E/F/G + CHAIN-0/OBS-0/terminal/advisory agree on HOLD with no live authority');

// Every non-archive terminal scenario, through both independent entrypoints:
// the local terminal and the unified rehearsal must accept the same OBS-0
// receipt (or none) and expose the identical terminal view; nothing actionable.
const { TERMINAL_SCENARIOS } = await import('../scripts/lib/terminal_scenarios.mjs');
const readAt = '2026-12-31T00:00:00.000Z'; // not before any scenario cutoff (golden + 7 days)
const scenarioView = await buildLocalView({now: () => ({toISOString: () => readAt})});
const outcomes = {COMPLETED: 0, REJECTED: 0};
let refusedReceipts = 0;
for (const scenario of TERMINAL_SCENARIOS.filter((item) => item.build)) {
  const document = scenario.build(golden);
  const envelope = {
    chainInput: document.input, knowledgeCutoff: document.knowledgeCutoff, evidenceClaims: [],
    origin: {kind: 'LOCAL_SCENARIO', label: scenario.id}, generatedAt: readAt,
  };
  const rehearsal = await unified.runUnifiedOfflineRehearsal(envelope);
  const shown = await scenarioView(scenario.id);
  assert.deepEqual(shown, rehearsal.terminal, `${scenario.id}: terminal and rehearsal present the same view`);
  assert.deepEqual(await unified.runUnifiedOfflineRehearsal(envelope), rehearsal, `${scenario.id}: replay is deterministic`);
  assert.equal(rehearsal.decision, 'HOLD', scenario.id);
  assert.equal(rehearsal.execution, 'FORBIDDEN', scenario.id);
  assert.equal(rehearsal.authorization, 'NONE', scenario.id);
  assert.equal(shown.chain.chainState, 'HOLD', scenario.id);
  assert.equal(shown.chain.execution, 'FORBIDDEN', scenario.id);
  assert.equal(shown.simulated, true, scenario.id);
  assert.equal(rehearsal.advisory.tradeTicket, null, scenario.id);
  assert.ok(rehearsal.transport.packet === null || rehearsal.transport.packet.actionability === 'NONE', scenario.id);
  outcomes[rehearsal.outcome] += 1;
  if (rehearsal.outcome === 'COMPLETED') {
    const accepted = rehearsal.receipt.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED';
    assert.equal(accepted, scenario.id !== 'everything-granted',
      `${scenario.id}: ${rehearsal.receipt.verification} ${JSON.stringify(rehearsal.receipt.problems)}`);
    if (!accepted) {
      // Spoofed grants make the chain emit runtime ids and acceptance evidence: OBS-0 refuses the receipt.
      assert.ok(rehearsal.receipt.problems.includes('UNSAFE_OUTPUT_PRESENT'), scenario.id);
      assert.equal(rehearsal.receipt.fingerprint, null, scenario.id);
      refusedReceipts += 1;
    }
    assert.equal(shown.chain.digest ?? null, accepted ? rehearsal.receipt.fingerprint : null,
      `${scenario.id}: only an accepted OBS-0 receipt supplies a fingerprint`);
  } else {
    assert.equal(rehearsal.receipt, null, `${scenario.id}: a rejected input mints no receipt`);
    assert.equal(shown.chain.digest ?? null, null, `${scenario.id}: and shows no fingerprint`);
    assert.equal(rehearsal.advisory.tradeTicket, null, scenario.id);
  }
}
assert.ok(outcomes.COMPLETED >= 4 && outcomes.REJECTED >= 1, `scenarios exercise both outcomes ${JSON.stringify(outcomes)}`);
assert.equal(refusedReceipts, 1, 'exactly the spoofed-grants scenario loses its receipt');
console.log(`PASS RC-0: ${outcomes.COMPLETED + outcomes.REJECTED} terminal scenarios agree across terminal and rehearsal `
  + `(${outcomes.COMPLETED - refusedReceipts} accepted receipts, ${refusedReceipts} receipt refused, ${outcomes.REJECTED} input rejected)`);

// --- B1: official macro fixtures -> Event Facts -> EI / GT -> EIA-0 -> CHAIN-0 -> OBS-0 -> terminal.
// Provenance of every input, kept apart on purpose:
// - the four release documents are committed fixtures parsed from official BLS / DOL / BEA artifacts;
// - each event version's knowledgeCutoff is the adapter's `publishedAt` (B3), cross-checked against a
//   hand conversion of the fixture's `publicReleaseAtRaw`, and admitted only through
//   `admitEventVersionAtOfficialRelease`, so a version known before its release is refused;
// - the event set, ids, cluster ids and fingerprints are chosen by this test, not by a runtime;
// - marketSnapshot, positioning, evidence graph and authorizations stay the SYNTHETIC golden fixture;
//   only the EI / GT summaries are replaced. No real market archive is used (none is committed).
const [cpiAdapter, nfpAdapter, claimsAdapter, pceAdapter, ei, gt, eia, chain, obs, releaseInstant] = await Promise.all([
  loadBackendModule('event_facts/bls_cpi_adapter.ts'),
  loadBackendModule('event_facts/bls_employment_situation_adapter.ts'),
  loadBackendModule('event_facts/dol_ui_weekly_claims_adapter.ts'),
  loadBackendModule('event_facts/bea_pce_adapter.ts'),
  loadBackendModule('event_impact/deterministic_processor.ts'),
  loadBackendModule('gold_transmission/deterministic_processor.ts'),
  loadBackendModule('event_aggregation/contract.ts'),
  loadBackendModule('decision_chain/dry_run.ts'),
  loadBackendModule('observability/offline_receipt.ts'),
  loadBackendModule('event_facts/official_release_instant.ts'),
]);
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const OFFICIAL_RELEASES = [
  { name: 'CPI', map: cpiAdapter.mapBlsCpiReleaseToEventFacts, file: 'bls_cpi_table1_2026_08.json',
    raw: '8:30 a.m. (ET) Friday, September 11, 2026', releasedAt: '2026-09-11T12:30:00.000Z' },
  { name: 'NFP', map: nfpAdapter.mapBlsEmploymentReleaseToEventFacts, file: 'bls_employment_situation_2026_08.json',
    raw: '8:30 a.m. (ET) Friday, September 4, 2026', releasedAt: '2026-09-04T12:30:00.000Z' },
  { name: 'CLAIMS', map: claimsAdapter.mapDolUiWeeklyClaimsReleaseToEventFacts, file: 'dol_ui_weekly_claims_2026_10_01.json',
    raw: '8:30 A.M. (Eastern) Thursday, October 1, 2026', releasedAt: '2026-10-01T12:30:00.000Z' },
  { name: 'PCE', map: pceAdapter.mapBeaPceReleaseToEventFacts, file: 'bea_pce_2026_08.json',
    raw: 'EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Wednesday, September 30, 2026', releasedAt: '2026-09-30T12:30:00.000Z' },
];
const macroCutoff = golden.knowledgeCutoff; // 2026-10-01T14:15:00.000Z, after the four releases
const goldenDigest = await chain.computeDecisionChainDigest(chain.evaluateDecisionChain(golden.input, macroCutoff).result);
assert.equal(goldenDigest, 'sha256:919b602e2f1ad8df2dc8f3acbe2a4237d5914640210bb8b1f4102e8635ae149c');

const eventVersions = OFFICIAL_RELEASES.map((release, index) => {
  const document = fixture(release.file);
  assert.equal(document.release.publicReleaseAtRaw, release.raw, `${release.name}: hand-converted instant matches the fixture`);
  const before = JSON.stringify(document);
  const mapped = release.map(document);
  assert.equal(mapped.kind, 'RESOLVED', release.name);
  assert.equal(mapped.canonicalEventStateSchemaVersion, 2, release.name);
  assert.deepEqual(release.map(fixture(release.file)), mapped, `${release.name}: adapter is deterministic`);
  assert.equal(JSON.stringify(document), before, `${release.name}: adapter does not mutate its input`);
  assert.equal(mapped.publishedAt, release.releasedAt, `${release.name}: adapter instant equals the hand conversion`);
  const admitted = releaseInstant.admitEventVersionAtOfficialRelease(mapped, mapped.publishedAt);
  assert.equal(admitted.kind, 'ADMITTED', release.name);
  const earlier = mapped.publishedAt.replace('12:30:00.000Z', '12:29:59.999999999Z');
  assert.equal(releaseInstant.admitEventVersionAtOfficialRelease(mapped, earlier).reason, 'KNOWN_BEFORE_OFFICIAL_RELEASE', release.name);
  const n = index + 1;
  return {
    id: `${String(n).repeat(8)}-1111-4111-8111-111111111111`, clusterId: `${String(n).repeat(8)}-2222-4222-8222-222222222222`,
    versionNumber: 1, transitionType: 'NOVELTY', knowledgeCutoff: admitted.publishedAt,
    effectiveTime: null, effectiveTimePrecision: null,
    canonicalEventStateSchemaVersion: mapped.canonicalEventStateSchemaVersion,
    canonicalEventState: mapped.canonicalEventState,
    officialConfirmationState: 'OFFICIALLY_CONFIRMED', sourceIndependenceState: 'SINGLE_EDITORIAL_ORIGIN',
    supersedesVersionId: null, stateFingerprint: 'a'.repeat(64),
  };
});
const impactPlans = eventVersions.map((eventVersion) => ei.planDeterministicEventImpact({ eventVersion }));
const transmissionPlans = eventVersions.map((eventVersion) => gt.planDeterministicGoldTransmission({ eventVersion }));
OFFICIAL_RELEASES.forEach(({ name }, index) => {
  const impact = impactPlans[index];
  const transmission = transmissionPlans[index];
  assert.equal(impact.kind, 'PROCESS', name);
  assert.equal(impact.assessmentStatus, 'INSUFFICIENT_EVIDENCE', name);
  assert.deepEqual(impact.interpretations, [], `${name}: no Event Impact interpretation`);
  assert.equal(transmission.kind, 'PROCESS', name);
  assert.equal(transmission.assessmentReason, 'CONSENSUS_FACTS_UNAVAILABLE', name);
  assert.deepEqual(transmission.paths, [], `${name}: no Gold Transmission path`);
});

const aggregate = (cutoff, impacts = impactPlans, transmissions = transmissionPlans) => ({
  impact: eia.aggregateEventPlans('EVENT_IMPACT', impacts, cutoff),
  transmission: eia.aggregateEventPlans('GOLD_TRANSMISSION', transmissions, cutoff),
});
const sortedIds = eventVersions.map((version) => version.id).sort();
const atCutoff = aggregate(macroCutoff);
for (const [kind, envelope] of Object.entries(atCutoff)) {
  assert.equal(envelope.summary.status, 'INSUFFICIENT_EVIDENCE', kind);
  assert.equal(envelope.summary.knowledgeCutoff, macroCutoff, kind);
  assert.deepEqual(envelope.reasonCodes, ['ALL_EVENTS_INSUFFICIENT'], kind);
  assert.deepEqual(envelope.eventVersionIds, sortedIds, kind);
  assert.equal(envelope.counts.admitted, 4, kind);
  assert.equal(envelope.counts.excludedAfterCutoff, 0, kind);
}
assert.deepEqual(atCutoff.impact.summary, golden.input.eventImpact, 'official-derived EI summary equals the golden one');
assert.deepEqual(atCutoff.transmission.summary, golden.input.goldTransmission, 'official-derived GT summary equals the golden one');
assert.deepEqual(aggregate(macroCutoff, [...impactPlans].reverse(), [...transmissionPlans].reverse()), atCutoff, 'order-independent');

// Events released after the cutoff are excluded, exactly at the release instant.
const claimsAt = OFFICIAL_RELEASES[2].releasedAt;
const justBefore = aggregate('2026-10-01T12:29:59.999999999Z').impact;
assert.equal(justBefore.counts.admitted, 3);
assert.equal(justBefore.counts.excludedAfterCutoff, 1);
assert.ok(!justBefore.eventVersionIds.includes(eventVersions[2].id), 'claims not knowable 1 ns before release');
assert.ok(justBefore.reasonCodes.includes('EVENT_PLAN_AFTER_KNOWLEDGE_CUTOFF'));
assert.equal(aggregate(claimsAt).impact.counts.admitted, 4, 'claims knowable at its release instant');
const mid = aggregate('2026-09-20T00:00:00.000Z').impact;
assert.deepEqual(mid.eventVersionIds, [eventVersions[0].id, eventVersions[1].id].sort(), 'only CPI and NFP by 20 Sept');
assert.equal(mid.summary.status, 'INSUFFICIENT_EVIDENCE');
const beforeAll = aggregate('2026-09-01T00:00:00.000Z');
for (const envelope of Object.values(beforeAll)) {
  assert.equal(envelope.summary.status, 'UNAVAILABLE');
  assert.ok(envelope.reasonCodes.includes('NO_EVENT_PLANS'));
}

// CHAIN-0 -> OBS-0 -> terminal through the canonical rehearsal entrypoint.
const macroInput = { ...structuredClone(golden.input), eventImpact: atCutoff.impact.summary, goldTransmission: atCutoff.transmission.summary };
const macroEnvelope = {
  chainInput: macroInput, knowledgeCutoff: macroCutoff, evidenceClaims: [],
  origin: { kind: 'LOCAL_SCENARIO', label: 'rc0-official-macro-fixtures' }, generatedAt,
};
const macro = await unified.runUnifiedOfflineRehearsal(macroEnvelope);
assert.deepEqual(await unified.runUnifiedOfflineRehearsal(structuredClone(macroEnvelope)), macro, 'deterministic');
assert.equal(macro.outcome, 'COMPLETED');
assert.equal(macro.decision, 'HOLD');
assert.equal(macro.execution, 'FORBIDDEN');
assert.equal(macro.authorization, 'NONE');
assert.equal(macro.provenance, 'UNVERIFIED');
assert.equal(macro.receipt.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.deepEqual(macro.receipt.problems, []);
assert.equal(macro.receipt.fingerprint, unifiedResult.receipt.fingerprint, 'same chain as the golden one, same receipt');
assert.equal(macro.terminal.chain.digest, macro.receipt.fingerprint, 'terminal fingerprint only from the accepted receipt');
assert.equal(macro.terminal.chain.chainState, 'HOLD');
assert.equal(macro.terminal.chain.execution, 'FORBIDDEN');
assert.equal(macro.terminal.simulated, true);
assert.deepEqual(macro.terminal.origin, { kind: 'LOCAL_SCENARIO', label: 'rc0-official-macro-fixtures' });
assert.equal(macro.terminal.stages.length, 12);
assert.equal(macro.terminal.summary.decision, 'HOLD');
assert.equal(macro.terminal.summary.execution, 'FORBIDDEN');
assert.equal(macro.advisory.tradeTicket, null);
assert.equal(macro.transport.packet?.actionability, 'NONE');
const macroChain = chain.evaluateDecisionChain(macroInput, macroCutoff);
assert.equal(macroChain.result.integrity, 'CONSISTENT');
assert.equal(await chain.computeDecisionChainDigest(macroChain.result), goldenDigest);
assert.ok(macroChain.result.trace.every((stage) => stage.knowledgeCutoff === macroCutoff), 'one cutoff across the 12 stages');
const horizon = (result) => result.trace.find((stage) => stage.stage === 'HORIZON_SYNTHESIS');
assert.ok(!horizon(macroChain.result).reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));
assert.ok(horizon(macroChain.result).reasonCodes.includes('EVENT_IMPACT_INSUFFICIENT'));
assert.ok(horizon(macroChain.result).reasonCodes.includes('GOLD_TRANSMISSION_INSUFFICIENT'));
assert.equal(macroChain.result.trace.find((stage) => stage.stage === 'ACTION').state, 'ABSTAIN');

// Negative cases: each stays HOLD / FORBIDDEN, and nothing upstream can lift it.
const holds = (outcome, label) => {
  assert.equal(outcome.kind, 'COMPLETED', label);
  assert.equal(outcome.result.chainState, 'HOLD', label);
  assert.equal(outcome.result.execution, 'FORBIDDEN', label);
  assert.equal(outcome.result.trace.find((stage) => stage.stage === 'ACTION').state, 'ABSTAIN', label);
  return outcome.result;
};
// (a) Summaries aggregated at an earlier cutoff than the chain: drift is reported.
const drift = holds(chain.evaluateDecisionChain({ ...macroInput, eventImpact: mid.summary }, macroCutoff), 'cutoff drift');
assert.ok(horizon(drift).reasonCodes.includes('UPSTREAM_CUTOFF_MISMATCH'));
// (b) A corrupted official document does not resolve, so it contributes no event.
const corrupted = fixture(OFFICIAL_RELEASES[0].file);
corrupted.release.releaseId = '';
assert.notEqual(OFFICIAL_RELEASES[0].map(corrupted).kind, 'RESOLVED', 'corrupted CPI document is refused');
// (c) One bad event among the four makes the whole summary UNAVAILABLE: an unsupported event state
// yields an UNAVAILABLE plan, a malformed event version makes the processor abstain.
for (const [label, version, reason] of [
  ['unsupported state', { ...eventVersions[0], canonicalEventStateSchemaVersion: 3 }, 'EVENT_PLAN_UNAVAILABLE'],
  ['malformed version', { ...eventVersions[0], id: 'not-a-uuid' }, 'EVENT_PLAN_ABSTAINED'],
]) {
  const bad = aggregate(macroCutoff, [ei.planDeterministicEventImpact({ eventVersion: version }), ...impactPlans.slice(1)]).impact;
  assert.equal(bad.summary.status, 'UNAVAILABLE', label);
  assert.ok(bad.reasonCodes.includes(reason), `${label}: ${bad.reasonCodes}`);
  holds(chain.evaluateDecisionChain({ ...macroInput, eventImpact: bad.summary }, macroCutoff), label);
}
// (d) The same event version twice, or a plan of the other kind, is refused.
assert.ok(aggregate(macroCutoff, [...impactPlans, impactPlans[0]]).impact.reasonCodes.includes('DUPLICATE_EVENT_VERSION'));
assert.ok(eia.aggregateEventPlans('EVENT_IMPACT', transmissionPlans, macroCutoff).reasonCodes.includes('EVENT_PLAN_VERSION_MISMATCH'));
// (e) A forged ASSESSED summary at the right cutoff still ends in abstention and HOLD.
const forged = holds(chain.evaluateDecisionChain({ ...macroInput,
  eventImpact: { ...atCutoff.impact.summary, status: 'ASSESSED' },
  goldTransmission: { ...atCutoff.transmission.summary, status: 'ASSESSED' } }, macroCutoff), 'forged ASSESSED');
assert.equal(horizon(forged).state, 'ABSTAIN');
// (f) An order injected into the completed chain: OBS-0 refuses the receipt, no fingerprint.
const tampered = structuredClone(macroChain.result);
tampered.stages.action.order = { side: 'BUY' };
const refused = await obs.buildOfflineAuditReceipt(tampered);
assert.notEqual(refused.verification, 'STRUCTURALLY_VALID_HOLD_UNVERIFIED');
assert.ok(refused.problems.includes('UNSAFE_OUTPUT_PRESENT'));
assert.equal(unified.fingerprintFromAcceptedReceipt(refused), null);
// (g) B3: a CPI published on 11 September cannot enter the chain with a 1 September cutoff.
const cpiMapped = OFFICIAL_RELEASES[0].map(fixture(OFFICIAL_RELEASES[0].file));
assert.deepEqual(releaseInstant.admitEventVersionAtOfficialRelease(cpiMapped, '2026-09-01T00:00:00.000Z'),
  { kind: 'REFUSED', reason: 'KNOWN_BEFORE_OFFICIAL_RELEASE', publishedAt: '2026-09-11T12:30:00.000Z' });
console.log('PASS RC-0 B1: 4 official macro fixtures -> Event Facts -> EI/GT -> EIA-0 -> CHAIN-0 -> OBS-0 -> terminal at one cutoff '
  + '(golden digest, 1 ns future-event exclusion, 7 negative cases incl. B3 back-dating, HOLD/FORBIDDEN; non-market inputs synthetic)');

// --- B3 (EIA-0 v2): the same macro branch, with release evidence taken from the adapters' `publishedAt`.
// The exclusion happens inside the aggregation; CHAIN-0 is unchanged and receives the v2 summary as-is.
// EIA-0 (v1 or v2) is still not wired into any runtime: this test composes it.
const eia2 = await loadBackendModule('event_aggregation/release_gate_contract.ts');
const releaseEvidence = OFFICIAL_RELEASES.map((release, index) => ({
  eventVersionId: eventVersions[index].id,
  publishedAt: release.map(fixture(release.file)).publishedAt,
}));
const v2At = (impacts, transmissions, evidence = releaseEvidence) => ({
  impact: eia2.aggregateEventPlansWithOfficialRelease('EVENT_IMPACT', impacts, evidence, macroCutoff),
  transmission: eia2.aggregateEventPlansWithOfficialRelease('GOLD_TRANSMISSION', transmissions, evidence, macroCutoff),
});
const withEvidence = v2At(impactPlans, transmissionPlans);
assert.deepEqual(withEvidence.impact.summary, atCutoff.impact.summary, 'v2 summary equals v1 with valid evidence');
assert.deepEqual(withEvidence.transmission.summary, atCutoff.transmission.summary);
assert.equal(withEvidence.impact.counts.admitted, 4);
const v2Chain = chain.evaluateDecisionChain({ ...macroInput, eventImpact: withEvidence.impact.summary,
  goldTransmission: withEvidence.transmission.summary }, macroCutoff);
assert.equal(await chain.computeDecisionChainDigest(holds(v2Chain, 'v2 chain')), goldenDigest);
// A CPI version back-dated to 1 September: v1 admits it, v2 excludes it during aggregation.
const backDated = { ...eventVersions[0], knowledgeCutoff: '2026-09-01T00:00:00.000Z' };
const backImpacts = [ei.planDeterministicEventImpact({ eventVersion: backDated }), ...impactPlans.slice(1)];
const backTransmissions = [gt.planDeterministicGoldTransmission({ eventVersion: backDated }), ...transmissionPlans.slice(1)];
assert.ok(aggregate(macroCutoff, backImpacts).impact.eventVersionIds.includes(backDated.id), 'v1 admits the back-dated CPI');
const excluded = v2At(backImpacts, backTransmissions);
for (const envelope of Object.values(excluded)) {
  assert.ok(!envelope.eventVersionIds.includes(backDated.id), 'v2 excludes it');
  assert.equal(envelope.counts.excludedBeforeOfficialRelease, 1);
  assert.ok(envelope.reasonCodes.includes('EVENT_PLAN_BEFORE_OFFICIAL_RELEASE'));
  assert.equal(envelope.summary.status, 'INSUFFICIENT_EVIDENCE');
}
holds(chain.evaluateDecisionChain({ ...macroInput, eventImpact: excluded.impact.summary,
  goldTransmission: excluded.transmission.summary }, macroCutoff), 'back-dated CPI excluded');
// Evidence required but absent for one event: fail-closed, UNAVAILABLE, HOLD.
const missing = v2At(impactPlans, transmissionPlans, releaseEvidence.slice(1));
assert.equal(missing.impact.summary.status, 'UNAVAILABLE');
assert.ok(missing.impact.reasonCodes.includes('RELEASE_INSTANT_MISSING'));
holds(chain.evaluateDecisionChain({ ...macroInput, eventImpact: missing.impact.summary,
  goldTransmission: missing.transmission.summary }, macroCutoff), 'missing release evidence');
console.log('PASS RC-0 B3: EIA-0 v2 with adapter release instants keeps the golden digest, excludes a back-dated CPI '
  + 'during aggregation and fails closed without evidence (HOLD/FORBIDDEN)');
