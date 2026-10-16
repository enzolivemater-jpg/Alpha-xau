/**
 * Advisory UI (UI-0), offline transport (TR-0) and evidence manifest
 * (EVIDENCE-0) under hostile input.
 *  1. Whatever claims or cutoff the writer receives, the view is the fixed
 *     non-actionable HOLD/ABSTAIN shape and the encoded packet is accepted by
 *     the inspector as STRUCTURALLY_VALID_UNVERIFIED with actionability NONE.
 *  2. The inspector never throws on a mutated packet, a corrupted string or a
 *     non-string, and an accepted packet is always the canonical safe one.
 *  3. The evidence manifest never throws, never authorizes and keeps source
 *     attestation unavailable.
 * Offline and deterministic: no network, clock, database or randomness.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { HOSTILE_VALUES, mutationCases } from './lib/mutation_cases.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const ui = await loadBackendModule('advisory_ui/contract.ts');
const transport = await loadBackendModule('advisory_ui/transport_contract.ts');
const manifest = await loadBackendModule('observability/evidence_manifest.ts');
const canonical = await loadBackendModule('shared/canonical_json.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));

const outcome = chain.evaluateDecisionChain(golden.input, golden.knowledgeCutoff);
assert.equal(outcome.kind, 'COMPLETED');
const cutoff = golden.knowledgeCutoff;
const claims = { commandCenter: outcome.result.stages.commandCenter, alerts: outcome.result.stages.alert, acceptance: outcome.result.stages.acceptance };
const honest = ui.buildInstitutionalAdvisoryUi(claims, cutoff);
assert.deepEqual(honest.reasonCodes, ['SOURCE_ATTESTATION_NOT_AVAILABLE', 'UI_RUNTIME_NOT_AUTHORIZED'], 'honest claims are accepted by UI-0');
const honestPacket = transport.encodeOfflineAdvisoryPacket(claims, cutoff);
assert.equal(transport.inspectOfflineAdvisoryPacket(honestPacket).status, 'STRUCTURALLY_VALID_UNVERIFIED');

const failures = [];
const note = (label, message) => { if (failures.length < 25) failures.push(`${label}: ${message}`); };
const tally = { roundTrips: 0, inspectedRejected: 0, inspectedAccepted: 0, manifests: 0 };

const SAFE_VIEW_FIELDS = {
  mode: 'OFFLINE_CONTRACT_ONLY', provenance: 'UNVERIFIED', deployment: 'NOT_CONNECTED', systemState: 'HOLD',
  decision: 'ABSTAIN', execution: 'FORBIDDEN', scenarioTreeStatus: 'UNAVAILABLE', recommendation: null,
  tradeTicket: null, positionSize: null, alertDelivery: 'SUPPRESSED', alertPayload: null, productionReadiness: 'HOLD',
};
function checkView(label, view) {
  for (const [key, expected] of Object.entries(SAFE_VIEW_FIELDS)) {
    if (view[key] !== expected) note(label, `view.${key} = ${String(view[key])}`);
  }
  if (!view.horizons.every((h) => h.state === 'UNAVAILABLE' && h.direction === 'UNAVAILABLE' && h.confidence === null && h.target === null)) {
    note(label, 'a horizon is not UNAVAILABLE');
  }
}

// 1. Writer + inspector round trip for hostile claims and cutoffs.
const writerCases = [
  ...mutationCases(claims).map(([label, mutated]) => [`claims ${label}`, mutated, cutoff]),
  ...HOSTILE_VALUES.map((value, i) => [`cutoff hostile#${i}`, claims, structuredClone(value)]),
];
for (const [label, mutatedClaims, usedCutoff] of writerCases) {
  try {
    const view = ui.buildInstitutionalAdvisoryUi(mutatedClaims, usedCutoff);
    checkView(label, view);
    const packet = transport.encodeOfflineAdvisoryPacket(mutatedClaims, usedCutoff);
    const inspected = transport.inspectOfflineAdvisoryPacket(packet);
    if (inspected.status !== 'STRUCTURALLY_VALID_UNVERIFIED') { note(label, `own packet refused: ${inspected.reason}`); continue; }
    if (inspected.packet.actionability !== 'NONE' || inspected.packet.origin !== 'UNVERIFIED') note(label, 'packet carries authority');
    tally.roundTrips += 1;
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

// 2. Inspector on mutated packets and corrupted strings.
const parsedPacket = JSON.parse(honestPacket);
const inspectCases = [
  ...mutationCases(parsedPacket).map(([label, mutated]) => [`packet ${label}`, JSON.stringify(mutated)]),
  ...HOSTILE_VALUES.map((value, i) => [`raw hostile#${i}`, structuredClone(value)]),
];
for (let cut = 0; cut < honestPacket.length; cut += 17) inspectCases.push([`truncated ${cut}`, honestPacket.slice(0, cut)]);
for (let at = 0; at < honestPacket.length; at += 23) {
  inspectCases.push([`space @${at}`, `${honestPacket.slice(0, at)} ${honestPacket.slice(at)}`]);
  inspectCases.push([`flip @${at}`, honestPacket.slice(0, at) + (honestPacket[at] === 'a' ? 'b' : 'a') + honestPacket.slice(at + 1)]);
}
inspectCases.push(['duplicate key', honestPacket.replace('{', '{"actionability":"FULL",')]);
inspectCases.push(['oversize chars', `${honestPacket}${' '.repeat(transport.ADVISORY_TRANSPORT_MAX_BYTES)}`]);
inspectCases.push(['oversize bytes', 'é'.repeat(9000)]);
for (const [label, raw] of inspectCases) {
  try {
    const out = transport.inspectOfflineAdvisoryPacket(raw);
    if (out.status === 'REJECTED') { tally.inspectedRejected += 1; if (out.packet !== null) note(label, 'rejected with a packet'); continue; }
    tally.inspectedAccepted += 1;
    if (raw !== honestPacket && JSON.stringify(out.packet) !== raw) note(label, 'accepted a non-canonical string');
    if (out.packet.actionability !== 'NONE' || out.packet.origin !== 'UNVERIFIED' || out.packet.transport !== 'NOT_CONNECTED') note(label, 'accepted packet carries authority');
    checkView(label, out.packet.advisory);
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

// 3. Evidence manifest.
const claim = {
  kind: 'OFFICIAL_RELEASE', evidenceId: 'bls-cpi-2026-08', sourceAuthority: 'us-bls', revision: 'r1',
  artifactSha256: 'a'.repeat(64), effectiveAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-09-11T12:30:00.000Z',
  firstIngestedAt: '2026-09-11T12:31:00.000Z', producerVersion: 'producer-1.0.0',
};
const baseManifest = manifest.buildEvidenceEligibilityManifest([claim], cutoff);
assert.equal(baseManifest.structuralStatus, 'COHERENT');
const manifestCases = [
  ...mutationCases([claim]).map(([label, mutated]) => [`claims ${label}`, mutated, cutoff]),
  ...HOSTILE_VALUES.map((value, i) => [`input hostile#${i}`, structuredClone(value), cutoff]),
  ...HOSTILE_VALUES.map((value, i) => [`cutoff hostile#${i}`, [claim], structuredClone(value)]),
];
for (const [label, input, usedCutoff] of manifestCases) {
  try {
    const out = manifest.buildEvidenceEligibilityManifest(input, usedCutoff);
    tally.manifests += 1;
    if (out.authorization !== 'NONE' || out.evidenceState !== 'UNVERIFIED' || out.mode !== 'STRUCTURAL_ONLY') note(label, 'manifest carries authority');
    if (!out.reasonCodes.includes('SOURCE_ATTESTATION_UNAVAILABLE')) note(label, 'source attestation claimed');
    if (out.structuralStatus === 'REJECTED' && out.claims.length !== 0) note(label, 'a rejected batch exposes claims');
    try { canonical.canonicalJson(out); } catch (error) { note(label, `unhashable manifest: ${error.message}`); }
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.roundTrips > 1000 && tally.inspectedRejected > 500 && tally.inspectedAccepted >= 1 && tally.manifests > 200, JSON.stringify(tally));
console.log(`PASS advisory surface: ${tally.roundTrips} writer round trips non-actionable, ${tally.inspectedRejected + tally.inspectedAccepted} inspected packets `
  + `(${tally.inspectedAccepted} accepted, all canonical and safe), ${tally.manifests} evidence manifests never authorizing`);
