/**
 * CHAIN-0 / OBS-0 / rehearsal mutation sweep. Every node of the golden input is
 * replaced by hostile values, removed, or given an unknown sibling key. For each
 * mutated input the offline stack must (a) never throw, (b) stay HOLD with
 * execution FORBIDDEN, (c) report a COMPLETED chain only when its own integrity
 * check is CONSISTENT, (d) never accept an OBS-0 receipt with problems, and
 * (e) never surface a trade ticket or an actionable packet.
 * Offline and deterministic: no network, clock, database or randomness.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const chain = await loadBackendModule('decision_chain/dry_run.ts');
const obs = await loadBackendModule('observability/offline_receipt.ts');
const unified = await loadBackendModule('observability/unified_rehearsal.ts');
const golden = JSON.parse(readFileSync(new URL('./fixtures/decision_chain_dry_run_baseline.json', import.meta.url), 'utf8'));
const readAt = '2026-12-31T00:00:00.000Z';

const HOSTILE = [
  null, undefined, NaN, Infinity, -Infinity, -0, 0, -1, 1e308, Number.MAX_SAFE_INTEGER + 2,
  '', ' ', 'x'.repeat(300), '__proto__', 'constructor', '\u0000', '2026-02-30T00:00:00Z',
  '2026-10-01T14:15:00.000500Z', true, false, [], {}, [null], { value: 1 },
];

/** Every [path] of the document, containers included. */
function paths(node, prefix = [], out = []) {
  out.push(prefix);
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) paths(node[key], [...prefix, key], out);
  }
  return out;
}
const at = (root, path) => path.reduce((node, key) => node[key], root);
function withMutation(path, mutate) {
  const copy = structuredClone(golden.input);
  if (path.length === 0) return mutate(copy, null, copy);
  const parent = at(copy, path.slice(0, -1));
  const key = path.at(-1);
  const replaced = mutate(parent, key, copy);
  return replaced === undefined ? copy : replaced;
}

const cases = [];
for (const path of paths(golden.input)) {
  const label = path.join('.') || '<root>';
  for (const [index, value] of HOSTILE.entries()) {
    cases.push([`${label} <- hostile#${index}`, path.length === 0
      ? structuredClone(value)
      : withMutation(path, (parent, key, copy) => { parent[key] = structuredClone(value); return copy; })]);
  }
  if (path.length > 0 && !Array.isArray(at(golden.input, path.slice(0, -1)))) {
    cases.push([`${label} <- deleted`, withMutation(path, (parent, key, copy) => { delete parent[key]; return copy; })]);
  }
  const node = at(golden.input, path);
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    cases.push([`${label} <- unknown key`, withMutation(path, (parent, key, copy) => {
      const target = path.length === 0 ? copy : parent[key];
      target.unexpectedKey = true;
      return path.length === 0 ? copy : copy;
    })]);
    cases.push([`${label} <- own __proto__ key`, withMutation(path, (parent, key, copy) => {
      const target = path.length === 0 ? copy : parent[key];
      Object.defineProperty(target, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
      return copy;
    })]);
  }
}

const failures = [];
const note = (label, message) => { if (failures.length < 20) failures.push(`${label}: ${message}`); };
const tally = { completed: 0, rejected: 0, receiptAccepted: 0, receiptRefused: 0 };

for (const [label, input] of cases) {
  try {
    const outcome = chain.evaluateDecisionChain(input, golden.knowledgeCutoff);
    if (outcome.chainState !== undefined && (outcome.chainState !== 'HOLD' || outcome.execution !== 'FORBIDDEN')) {
      note(label, 'rejected outcome left HOLD/FORBIDDEN');
    }
    if (outcome.kind === 'COMPLETED') {
      tally.completed += 1;
      const { result } = outcome;
      if (result.chainState !== 'HOLD' || result.execution !== 'FORBIDDEN') note(label, 'completed chain left HOLD/FORBIDDEN');
      if (result.integrity !== 'CONSISTENT') note(label, `integrity ${JSON.stringify(result.violations)}`);
      if (result.stages.commandCenter.tradeTicket !== null || result.stages.action.order !== null) note(label, 'ticket or order present');
      const receipt = await obs.buildOfflineAuditReceipt(result);
      if (receipt.verification === 'STRUCTURALLY_VALID_HOLD_UNVERIFIED') {
        tally.receiptAccepted += 1;
        if (receipt.problems.length !== 0 || !/^sha256:[0-9a-f]{64}$/.test(receipt.fingerprint ?? '')) note(label, 'accepted receipt is malformed');
      } else {
        tally.receiptRefused += 1;
        if (receipt.fingerprint !== null) note(label, 'refused receipt carries a fingerprint');
      }
    } else {
      tally.rejected += 1;
    }
    const rehearsal = await unified.runUnifiedOfflineRehearsal({
      chainInput: input, knowledgeCutoff: golden.knowledgeCutoff, evidenceClaims: [],
      origin: { kind: 'LOCAL_SCENARIO', label: 'mutation' }, generatedAt: readAt,
    });
    if (rehearsal.decision !== 'HOLD' || rehearsal.execution !== 'FORBIDDEN') note(label, 'rehearsal left HOLD/FORBIDDEN');
    if (rehearsal.advisory.tradeTicket !== null) note(label, 'advisory trade ticket');
    if (rehearsal.transport.packet !== null && rehearsal.transport.packet.actionability !== 'NONE') note(label, 'actionable packet');
    if (rehearsal.outcome !== 'COMPLETED' && rehearsal.receipt !== null) note(label, 'receipt minted for a rejected input');
    if (rehearsal.terminal.chain.chainState !== 'HOLD' || rehearsal.terminal.chain.execution !== 'FORBIDDEN') note(label, 'terminal left HOLD/FORBIDDEN');
  } catch (error) {
    note(label, `THREW ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
  }
}

// Regression: a non-finite market value is echoed by the abstaining MP-0 gate, so the
// result cannot be canonically serialized. OBS-0 must refuse the receipt, not throw.
{
  const input = structuredClone(golden.input);
  input.marketSnapshot.vix.value = NaN;
  const outcome = chain.evaluateDecisionChain(input, golden.knowledgeCutoff);
  assert.equal(outcome.kind, 'COMPLETED');
  const receipt = await obs.buildOfflineAuditReceipt(outcome.result);
  assert.equal(receipt.verification, 'REJECTED');
  assert.deepEqual(receipt.problems, ['STAGE_INTEGRITY_INVALID']);
  assert.equal(receipt.fingerprint, null);
}

assert.equal(({}).polluted, undefined, 'no prototype pollution');
assert.deepEqual(failures, [], `MUTATION failures (first ${failures.length}):\n${failures.join('\n')}`);
assert.ok(tally.completed > 100 && tally.rejected > 100, `the sweep exercises both outcomes ${JSON.stringify(tally)}`);
console.log(`PASS CHAIN mutation sweep: ${cases.length} hostile inputs, never thrown, always HOLD/FORBIDDEN `
  + `(${tally.completed} completed, ${tally.rejected} rejected; ${tally.receiptAccepted} receipts accepted, ${tally.receiptRefused} refused)`);
