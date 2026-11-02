// Hostile database responses against the real Event Impact shadow orchestrator.
// Invariant: PROCESSED is returned only when the read-back is exactly what the
// orchestrator sent; every other outcome is a typed refusal / abstention / skip
// or a thrown error, and no second mutation is ever issued.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { HOSTILE_VALUES } from './lib/mutation_cases.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(dir, '..', 'backend', 'event_impact', f), 'utf8');
const tr = (s) => ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

let passed = 0; let failed = 0;
const test = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = mkdtempSync(path.join(tmpdir(), 'ei-shadow-mut-'));
let mod;
try {
  writeFileSync(path.join(tmp, 'deterministic_processor.mjs'), tr(read('deterministic_processor.ts')));
  writeFileSync(path.join(tmp, 'shadow_orchestrator.mjs'),
    tr(read('shadow_orchestrator.ts')).replace(/(['"])\.\/deterministic_processor\.js\1/, '$1./deterministic_processor.mjs$1'));
  mod = await import(pathToFileURL(path.join(tmp, 'shadow_orchestrator.mjs')).href);
} finally { rmSync(tmp, { recursive: true, force: true }); }

const { processEventImpactShadowVersion } = mod;
const VID = '11111111-1111-4111-8111-111111111111';
const AID = '44444444-4444-4444-8444-444444444444';
const CUTOFF = '2026-09-22T00:00:00.123456+00:00';
const versionRow = () => ({
  id: VID, cluster_id: '33333333-3333-4333-8333-333333333333', version_number: 1, transition_type: 'NOVELTY',
  knowledge_cutoff: CUTOFF, effective_time: null, effective_time_precision: null,
  canonical_event_state_schema_version: 1,
  canonical_event_state: { event_type: 'MONETARY_POLICY_COMMUNICATION', subject: 'FOMC statement', detail: 'x' },
  official_confirmation_state: 'OFFICIALLY_CONFIRMED', source_independence_state: 'SINGLE_EDITORIAL_ORIGIN',
  supersedes_version_id: null, state_fingerprint: 'a'.repeat(64),
});
const rpcRow = () => ({ assessment_id: AID, replayed: false, interpretation_count: 0 });
const assessmentRow = (b) => ({
  id: AID, event_version_id: b.p_event_version_id, assessment_status: b.p_assessment_status,
  knowledge_cutoff: b.p_knowledge_cutoff, producer_type: b.p_producer_type, producer_actor: b.p_producer_actor,
  algorithm_version: b.p_algorithm_version, input_fingerprint: b.p_input_fingerprint,
  semantic_fingerprint: b.p_semantic_fingerprint, idempotency_fingerprint: b.p_idempotency_fingerprint,
  supersedes_assessment_id: b.p_supersedes_assessment_id,
});

async function run({ version, rpc, assessmentMut, children }) {
  const calls = []; let rpcCount = 0; let last = null;
  const db = {
    async request(method, p, body) {
      calls.push(p);
      if (p.startsWith('event_versions?')) return version ?? [versionRow()];
      if (p === 'rpc/fn_event_impact_create_assessment') { rpcCount += 1; last = structuredClone(body); return rpc ?? [rpcRow()]; }
      if (p.startsWith('event_impact_assessments?')) { const r = assessmentRow(last); assessmentMut?.(r); return [r]; }
      if (p.startsWith('event_impact_interpretations?')) return children ?? [];
      throw new Error(`unexpected ${p}`);
    },
  };
  let result = null; let error = null;
  try { result = await processEventImpactShadowVersion(db, VID); } catch (e) { error = e; }
  return { result, error, rpcCount, last };
}

const base = await run({});
test('baseline PROCESSED', base.result?.kind === 'PROCESSED', JSON.stringify(base.error?.message));

// Read-back row: every field replaced by every hostile value.
let cases = 0; let bad = [];
for (const field of Object.keys(assessmentRow(base.last))) {
  for (const [i, v] of HOSTILE_VALUES.entries()) {
    cases += 1;
    const r = await run({ assessmentMut: (row) => { row[field] = structuredClone(v); } });
    const same = JSON.stringify(v) === JSON.stringify(assessmentRow(base.last)[field]) && v !== undefined;
    if (r.rpcCount !== 1) bad.push(`${field}#${i} rpcCount=${r.rpcCount}`);
    if (!same && r.result?.kind === 'PROCESSED') bad.push(`${field}#${i} accepted`);
  }
  cases += 1;
  const r = await run({ assessmentMut: (row) => { delete row[field]; } });
  if (r.result?.kind === 'PROCESSED') bad.push(`${field} deleted accepted`);
}
test(`read-back row: ${cases} hostile cases, none accepted, one RPC each`, bad.length === 0, bad.slice(0, 5).join('; '));

// RPC row and non-array responses.
bad = []; cases = 0;
for (const field of Object.keys(rpcRow())) {
  for (const [i, v] of HOSTILE_VALUES.entries()) {
    cases += 1;
    const row = rpcRow(); row[field] = structuredClone(v);
    const r = await run({ rpc: [row] });
    const ok = field === 'assessment_id' ? v === AID : field === 'replayed' ? typeof v === 'boolean' : v === 0;
    if (!ok && r.result?.kind === 'PROCESSED') bad.push(`rpc.${field}#${i}`);
  }
}
for (const [i, v] of [[], [rpcRow(), rpcRow()]].entries()) {
  cases += 1;
  const r = await run({ rpc: v });
  if (r.result?.kind === 'PROCESSED') bad.push(`rpc rows#${i}`);
}
test(`RPC response: ${cases} hostile cases, none accepted`, bad.length === 0, bad.slice(0, 5).join('; '));

// Children present, event version row mutated.
const child = await run({ children: [{ id: AID }] });
test('persisted child refused', child.result === null && child.error?.code === 'UNEXPECTED_PERSISTED_INTERPRETATIONS');

bad = []; cases = 0;
for (const field of Object.keys(versionRow())) {
  for (const [i, v] of HOSTILE_VALUES.entries()) {
    cases += 1;
    const row = versionRow(); row[field] = structuredClone(v);
    const r = await run({ version: [row] });
    // Nothing may be written under another identity, and nothing hostile may be hashed into a PROCESSED result.
    if (r.rpcCount > 1) bad.push(`${field}#${i} multiple RPC`);
    if (r.last && r.last.p_event_version_id !== VID) bad.push(`${field}#${i} wrote under ${r.last.p_event_version_id}`);
    if (r.result?.kind === 'PROCESSED' && r.result.knowledgeCutoff !== row.knowledge_cutoff) bad.push(`${field}#${i} cutoff drift`);
  }
}
test(`event version row: ${cases} hostile cases, identity and cutoff preserved`, bad.length === 0, bad.slice(0, 5).join('; '));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
