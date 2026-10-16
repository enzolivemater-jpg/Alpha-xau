/**
 * DATA-1 archive replay mutation sweep. Every node of the synthetic archive is
 * replaced by hostile values, removed or given an unknown sibling; the cutoff
 * and the pinned digest are mutated too. For each case, replay -> CHAIN-0 ->
 * OBS-0 -> terminal view must never throw, must stay HOLD/FORBIDDEN, never
 * claim LIVE, and an INVALID replay must expose no market value.
 * Offline and deterministic: no network, clock, database or randomness.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const evidence = await loadBackendModule('market_engine/evidence_archive.ts');
const providers = await loadBackendModule('market_engine/providers.ts');
const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
const obs = await loadBackendModule('observability/offline_receipt.ts');
const view = await loadBackendModule('decision_chain/terminal_view.ts');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/market_evidence_archive_synthetic.json', import.meta.url), 'utf8'));
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const parsers = { fred: providers.parseFredObservations, twelve_data: providers.parseTwelveData };
const CUTOFF = '2026-10-01T14:15:00.000Z';
const FIELDS = ['spot', 'bid', 'ask', 'dxy', 'us10y', 'realYield', 'vix', 'wti'];

const HOSTILE = [
  null, undefined, NaN, Infinity, -Infinity, -0, 0, -1, 1e308, '', ' ', 'x'.repeat(300),
  '__proto__', 'constructor', '\u0000', '2026-02-30T00:00:00Z', '2026-10-01T14:15:00.000500Z',
  `sha256:${'0'.repeat(64)}`, true, [], {}, [null], { value: 1 },
];

function paths(node, prefix = [], out = []) {
  out.push(prefix);
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) paths(node[key], [...prefix, key], out);
  }
  return out;
}
const at = (root, path) => path.reduce((node, key) => node[key], root);

const cases = [];
const addCase = (label, archive, cutoff = CUTOFF, options = {}) => cases.push({ label, archive, cutoff, options });
for (const path of paths(fixture)) {
  const label = path.join('.') || '<root>';
  for (const [index, value] of HOSTILE.entries()) {
    const copy = structuredClone(fixture);
    if (path.length === 0) { addCase(`${label} <- hostile#${index}`, structuredClone(value)); continue; }
    at(copy, path.slice(0, -1))[path.at(-1)] = structuredClone(value);
    addCase(`${label} <- hostile#${index}`, copy);
  }
  if (path.length > 0 && !Array.isArray(at(fixture, path.slice(0, -1)))) {
    const copy = structuredClone(fixture);
    delete at(copy, path.slice(0, -1))[path.at(-1)];
    addCase(`${label} <- deleted`, copy);
  }
  const node = at(fixture, path);
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const copy = structuredClone(fixture);
    at(copy, path).unexpectedKey = true;
    addCase(`${label} <- unknown key`, copy);
    const proto = structuredClone(fixture);
    Object.defineProperty(at(proto, path), '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
    addCase(`${label} <- own __proto__ key`, proto);
  }
}
for (const [index, value] of HOSTILE.entries()) {
  addCase(`cutoff <- hostile#${index}`, structuredClone(fixture), structuredClone(value));
  addCase(`pinnedArchiveDigest <- hostile#${index}`, structuredClone(fixture), CUTOFF, { pinnedArchiveDigest: structuredClone(value) });
}

const failures = [];
const note = (label, message) => { if (failures.length < 20) failures.push(`${label}: ${message}`); };
const tally = { VERIFIED: 0, INCOMPLETE: 0, INVALID: 0 };

for (const { label, archive, cutoff, options } of cases) {
  try {
    const replay = await evidence.replayMarketEvidence(archive, cutoff, { parsers, ...options });
    tally[replay.status] = (tally[replay.status] ?? 0) + 1;
    if (replay.decision !== 'HOLD' || replay.execution !== 'FORBIDDEN') note(label, 'replay left HOLD/FORBIDDEN');
    if (!['VERIFIED', 'INCOMPLETE', 'INVALID'].includes(replay.status)) note(label, `status ${replay.status}`);
    if (!['SIMULATION', 'HISTORICAL_VERIFIED', 'HISTORICAL_UNVERIFIED'].includes(replay.nature)) note(label, `nature ${replay.nature}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(replay.digest)) note(label, 'replay digest malformed');
    if (replay.status !== 'VERIFIED' && replay.reproducible !== false) note(label, 'reproducible without a VERIFIED replay');
    if (replay.status === 'INVALID') {
      if (replay.marketSnapshot.available !== false || FIELDS.some((f) => replay.marketSnapshot[f].value !== null)) {
        note(label, 'an INVALID replay exposes a market value');
      }
    }
    const outcome = bridge.evaluateDecisionChainOnMarketEvidence(golden.input, replay);
    if (outcome.chainState !== undefined && outcome.chainState !== 'HOLD') note(label, 'rejected chain not HOLD');
    let digest = null;
    if (outcome.kind === 'COMPLETED') {
      if (outcome.result.integrity !== 'CONSISTENT') note(label, `integrity ${JSON.stringify(outcome.result.violations)}`);
      const receipt = await obs.buildOfflineAuditReceipt(outcome.result);
      if (receipt.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED') {
        if (receipt.problems.length !== 0) note(label, 'accepted receipt has problems');
        digest = receipt.fingerprint;
      }
    }
    const shown = view.buildTerminalView(outcome, digest, { kind: 'LOCAL_MARKET_ARCHIVE', label: 'mutation' }, '2026-12-31T00:00:00.000Z', replay);
    if (shown.chain.chainState !== 'HOLD' || shown.chain.execution !== 'FORBIDDEN') note(label, 'terminal left HOLD/FORBIDDEN');
    if (shown.simulated !== true) note(label, 'terminal view not labelled simulated');
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.INVALID > 100 && (tally.VERIFIED + tally.INCOMPLETE) > 5, `the sweep exercises valid and invalid replays ${JSON.stringify(tally)}`);
console.log(`PASS market evidence mutation sweep: ${cases.length} hostile archives/cutoffs, never thrown, always HOLD/FORBIDDEN `
  + `(${tally.VERIFIED} verified, ${tally.INCOMPLETE} incomplete, ${tally.INVALID} invalid)`);
