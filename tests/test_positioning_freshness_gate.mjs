// B5 (options 1 + 4): no positioning freshness policy is approved for any
// dataset, so P-0 never declares positioning evidence ready. It abstains with
// FRESHNESS_POLICY_NOT_APPROVED (P-0 v2), CHAIN-0 carries that abstention, and
// the terminal says "fraîcheur non évaluée — aucun seuil approuvé" instead of
// presenting the evidence as ready. No threshold, validity period or financial
// policy is defined here: the age shown is a fact, not a judgement.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';
import { VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const p0 = await loadBackendModule('positioning_engine/evidence_contract.ts');
const chain = await loadBackendModule('decision_chain/dry_run.ts');
const tv = await loadBackendModule('decision_chain/terminal_view.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const evidence = golden.input.positioningEvidence;
const REFERENCE = golden.knowledgeCutoff; // 2026-10-01T14:15:00.000Z
const PLUS_ONE_YEAR = '2027-10-01T14:15:00.000Z';

// --- P-0 v2: explicit new version; valid evidence abstains for want of an approved policy.
assert.equal(p0.POSITIONING_SCHEMA_VERSION, 'xau.positioning-evidence.v2');
assert.equal(p0.POSITIONING_ALGORITHM_VERSION, 'positioning-evidence-normalizer-2.0.0');
for (const cutoff of [REFERENCE, PLUS_ONE_YEAR, evidence[0].observedAt]) {
  const envelope = p0.buildPositioningEvidenceEnvelope(evidence, cutoff);
  assert.equal(envelope.evidenceState, 'ABSTAIN', cutoff);
  assert.deepEqual(envelope.reasonCodes, ['FRESHNESS_POLICY_NOT_APPROVED', 'METHODOLOGY_NOT_APPROVED'], cutoff);
  assert.equal(envelope.positioningState, 'UNAVAILABLE');
  assert.equal(envelope.evidence.length, 1, 'the evidence itself is kept and shown, not discarded');
}
// Future, invalid and absent evidence keep their own reasons; the policy gate adds itself only to valid evidence.
const future = p0.buildPositioningEvidenceEnvelope(evidence, '2026-09-30T19:30:59.999Z');
assert.ok(future.reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'));
assert.equal(future.evidenceState, 'ABSTAIN');
const invalid = p0.buildPositioningEvidenceEnvelope([{ ...evidence[0], publishedAt: '2026-09-31T19:30:00Z' }], REFERENCE);
assert.deepEqual(invalid.reasonCodes, ['INVALID_EVIDENCE_SHAPE', 'METHODOLOGY_NOT_APPROVED']);
const absent = p0.buildPositioningEvidenceEnvelope([], REFERENCE);
assert.deepEqual(absent.reasonCodes, ['NO_POSITIONING_EVIDENCE', 'METHODOLOGY_NOT_APPROVED']);
const badCutoff = p0.buildPositioningEvidenceEnvelope(evidence, '2026-10-01');
assert.ok(badCutoff.reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF') && badCutoff.evidenceState === 'ABSTAIN');
// No input of any shape yields EVIDENCE_READY.
for (const inputs of [evidence, [...evidence, { ...evidence[0], metricCode: 'open_interest' }], [], null, [{}]]) {
  for (const cutoff of [REFERENCE, PLUS_ONE_YEAR, '1970-01-01T00:00:00Z']) {
    assert.notEqual(p0.buildPositioningEvidenceEnvelope(inputs, cutoff).evidenceState, 'EVIDENCE_READY');
  }
}
console.log('PASS P-0 v2 abstains with FRESHNESS_POLICY_NOT_APPROVED at the reference cutoff and +1 year; never EVIDENCE_READY');

// --- CHAIN-0: positioning abstains, Regime abstains on it, everything stays HOLD / FORBIDDEN.
const stateOf = (result, stage) => result.trace.find((entry) => entry.stage === stage);
for (const cutoff of [REFERENCE, PLUS_ONE_YEAR]) {
  const input = structuredClone(golden.input);
  for (const key of ['eventImpact', 'goldTransmission']) input[key].knowledgeCutoff = cutoff;
  const outcome = chain.evaluateDecisionChain(input, cutoff);
  assert.equal(outcome.kind, 'COMPLETED', cutoff);
  const { result } = outcome;
  assert.equal(result.integrity, 'CONSISTENT', cutoff);
  assert.equal(stateOf(result, 'POSITIONING').state, 'ABSTAIN', cutoff);
  assert.ok(stateOf(result, 'POSITIONING').reasonCodes.includes('FRESHNESS_POLICY_NOT_APPROVED'), cutoff);
  assert.equal(stateOf(result, 'REGIME').state, 'ABSTAIN', cutoff);
  assert.ok(stateOf(result, 'REGIME').reasonCodes.includes('POSITIONING_EVIDENCE_ABSTAINED'), cutoff);
  assert.equal(result.chainState, 'HOLD');
  assert.equal(result.execution, 'FORBIDDEN');
  assert.equal(stateOf(result, 'ACTION').state, 'ABSTAIN');
}
console.log('PASS CHAIN-0 carries the abstention: POSITIONING and REGIME abstain, HOLD / FORBIDDEN');

// --- Terminal view: freshness NOT_EVALUATED with the plain reason and the factual age; never "ready".
const AT = '2026-10-18T00:00:00.000Z';
const viewAt = (cutoff) => {
  const input = structuredClone(golden.input);
  for (const key of ['eventImpact', 'goldTransmission']) input[key].knowledgeCutoff = cutoff;
  return tv.buildTerminalView(chain.evaluateDecisionChain(input, cutoff), null, { kind: 'GOLDEN_FIXTURE', label: 'golden' }, AT);
};
for (const [cutoff, ageSeconds] of [[REFERENCE, 67500], [PLUS_ONE_YEAR, 31603500]]) {
  const view = viewAt(cutoff);
  assert.equal(view.positioning.evidenceState, 'ABSTAIN', cutoff);
  assert.deepEqual(view.positioning.freshness, {
    status: 'NOT_EVALUATED', reason: 'FRESHNESS_POLICY_NOT_APPROVED',
    plain: 'fraîcheur non évaluée — aucun seuil approuvé',
    latestPublishedAt: evidence[0].publishedAt, publishedAgeSecondsAtCutoff: ageSeconds,
  }, cutoff);
  const stage = view.stages.find((s) => s.stage === 'POSITIONING');
  const reason = stage.reasons.find((r) => r.code === 'FRESHNESS_POLICY_NOT_APPROVED');
  assert.ok(reason && reason.category === 'BUSINESS_DECISION' && /aucun seuil de fraîcheur/i.test(reason.plain), cutoff);
}
const empty = tv.buildTerminalView(chain.evaluateDecisionChain({ ...structuredClone(golden.input), positioningEvidence: [] }, REFERENCE),
  null, { kind: 'GOLDEN_FIXTURE', label: 'golden' }, AT);
assert.deepEqual(empty.positioning.freshness, { status: 'NO_EVIDENCE', reason: null, plain: 'aucune preuve de positionnement',
  latestPublishedAt: null, publishedAgeSecondsAtCutoff: null });
console.log('PASS the view reports freshness NOT_EVALUATED, the plain reason and the factual publication age');

// --- Terminal rendering: the label replaces any "ready" wording; an EVIDENCE_READY claim is refused.
const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../frontend/js/dashboard.js', import.meta.url), 'utf8');
const render = async (body) => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:4173/' });
  dom.window.fetch = (url) => (String(url) === VIEW_PATH
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) })
    : Promise.reject(new Error(`unexpected fetch ${url}`)));
  dom.window.ALPHA_XAU_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ANALYSIS_INTERVAL_MS: 1e6, V2_VIEW_URL: VIEW_PATH };
  const script = dom.window.document.createElement('script');
  script.textContent = js;
  dom.window.document.body.appendChild(script);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return dom;
};
const reference = viewAt(REFERENCE);
let dom = await render(reference);
let d = dom.window.document;
assert.equal(d.getElementById('v2-positioning').textContent, 'ABSTAIN · 1 preuve(s) · signal UNAVAILABLE');
assert.equal(d.getElementById('v2-positioning-freshness').textContent,
  'fraîcheur non évaluée — aucun seuil approuvé · publiée 18 h avant le cutoff');
assert.doesNotMatch(d.getElementById('v2-sec-market')?.textContent ?? d.body.textContent, /EVIDENCE_READY|\bprête?s?\b/i);
dom.window.close();
for (const [name, mutate] of [
  ['evidence declared ready', (v) => { v.positioning.evidenceState = 'EVIDENCE_READY'; }],
  ['freshness declared evaluated', (v) => { v.positioning.freshness.status = 'FRESH'; }],
  ['freshness missing on evidence', (v) => { delete v.positioning.freshness; }],
]) {
  const body = structuredClone(reference);
  mutate(body);
  dom = await render(body);
  d = dom.window.document;
  assert.equal(d.getElementById('v2-status').getAttribute('data-state'), 'rejected', name);
  dom.window.close();
}
console.log('PASS the terminal shows "fraîcheur non évaluée — aucun seuil approuvé" and refuses any ready claim');
