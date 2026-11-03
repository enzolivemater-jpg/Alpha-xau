// Hostile database responses against the real Event shadow orchestrator.
// Invariant: PROCESSED is returned only for the observation that was asked for,
// with an exactly well-formed membership / RPC read-back; at most one assign
// and one version RPC are issued; nothing hostile is accepted silently.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { HOSTILE_VALUES } from './lib/mutation_cases.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(dir, '..', 'backend', 'event_engine', f), 'utf8');
const tr = (s) => ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

let passed = 0; let failed = 0;
const test = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = mkdtempSync(path.join(tmpdir(), 'ev-shadow-mut-'));
let mod;
try {
  writeFileSync(path.join(tmp, 'deterministic_processor.mjs'), tr(read('deterministic_processor.ts')));
  writeFileSync(path.join(tmp, 'shadow_orchestrator.mjs'),
    tr(read('shadow_orchestrator.ts')).replace(/(['"])\.\/deterministic_processor\.js\1/, '$1./deterministic_processor.mjs$1'));
  mod = await import(pathToFileURL(path.join(tmp, 'shadow_orchestrator.mjs')).href);
} finally { rmSync(tmp, { recursive: true, force: true }); }

const { processEventShadowObservation } = mod;
const OBS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLUSTER = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
const DECISION = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0';
const EVID = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';

const rawRow = () => ({
  id: OBS, provider: 'federal_reserve', provider_item_id: 'guid-fed-1', source_code: 'federalreserve',
  source_domain: 'federalreserve.gov',
  canonical_url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260901a.htm',
  title: 'Federal Reserve issues FOMC statement', summary: 'The Committee decided to maintain the target range.',
  content: null, provider_category: 'monetary_policy_press_release', published_at: '2026-09-01T18:00:00.000Z',
  published_date: null, observed_at: '2026-09-01T18:05:00.000Z', ingested_at: '2026-09-01T18:05:03.000Z',
  ingest_quality_state: 'VALID', ingest_quality_reasons: [],
});
const assignRow = () => ({ cluster_id: CLUSTER, decision_id: DECISION, cluster_created_now: true, replayed: false });
const memberRow = () => ({
  decision_id: DECISION, observation_id: OBS, cluster_id: CLUSTER, assigned_at: '2026-09-01T18:05:05.000Z',
  decision_type: 'ASSIGN', editorial_origin_key: 'official:federal_reserve', wire_lineage_key: null,
});
const versionRow = () => ({
  event_version_id: EVID, version_number: 1, transition_type: 'NOVELTY', state_fingerprint: 'f'.repeat(64),
  source_independence_state: 'SINGLE_EDITORIAL_ORIGIN', evidence_count: 1, outcome: 'CREATED', replayed: false,
});

async function run({ raw, assign, member, version }) {
  let assignCount = 0; let versionCount = 0;
  const db = {
    async request(method, p) {
      if (p.startsWith('news_articles?')) return raw ?? [rawRow()];
      if (p === 'rpc/fn_event_assign_observation') { assignCount += 1; return assign ?? [assignRow()]; }
      if (p.startsWith('event_observation_memberships?')) return member ?? [memberRow()];
      if (p === 'rpc/fn_event_create_event_version') { versionCount += 1; return version ?? [versionRow()]; }
      throw new Error(`unexpected ${p}`);
    },
  };
  let result = null; let error = null;
  try { result = await processEventShadowObservation(db, OBS); } catch (e) { error = e; }
  return { result, error, assignCount, versionCount };
}

const base = await run({});
test('baseline PROCESSED', base.result?.kind === 'PROCESSED', JSON.stringify(base.error?.message));

// A row for another observation must never be processed under the requested id.
const other = await run({ raw: [{ ...rawRow(), id: OTHER }] });
test('observation row with another id is refused before any write', other.result === null && other.error?.code === 'OBSERVATION_IDENTITY_MISMATCH' && other.assignCount === 0,
  `kind=${other.result?.kind} assign=${other.assignCount} id=${other.result?.observationId}`);

function sweep(label, field, make, accepted) {
  const bad = []; let cases = 0;
  for (const key of Object.keys(make())) {
    for (const [i, v] of HOSTILE_VALUES.entries()) {
      cases += 1;
      const row = make(); row[key] = structuredClone(v);
      const r = run_(field, [row]);
      bad.push([`${key}#${i}`, r, accepted(key, v)]);
    }
    cases += 1;
    const row = make(); delete row[key];
    bad.push([`${key} deleted`, run_(field, [row]), false]);
  }
  return { cases, bad };
}
const run_ = (field, rows) => run({ [field]: rows });

for (const [label, field, make, okFn] of [
  ['assign RPC row', 'assign', assignRow, (k, v) => JSON.stringify(v) === JSON.stringify(assignRow()[k]) || (typeof v === 'boolean' && (k === 'replayed' || k === 'cluster_created_now'))],
  ['membership row', 'member', memberRow, (k, v) => JSON.stringify(v) === JSON.stringify(memberRow()[k])
    // assigned_at may legitimately be any valid instant (the cutoff is MAX(floor, assigned_at)).
    || (k === 'assigned_at' && v === '2026-10-01T14:15:00.000500Z')],
  ['event version row', 'version', versionRow, (k, v) => JSON.stringify(v) === JSON.stringify(versionRow()[k])
    // state_fingerprint is only checked as a non-empty string by design (never recomputed here).
    || (k === 'evidence_count' && typeof v === 'number' && Number.isFinite(v) && v >= 1)
    || (k === 'state_fingerprint' && typeof v === 'string' && v.trim().length > 0)],
]) {
  const { cases, bad } = sweep(label, field, make, okFn);
  const outcomes = await Promise.all(bad.map(async ([name, p, ok]) => [name, await p, ok]));
  const failures = [];
  for (const [name, r, ok] of outcomes) {
    if (r.assignCount > 1 || r.versionCount > 1) failures.push(`${name} multiple RPC`);
    if (!ok && r.result?.kind === 'PROCESSED') failures.push(`${name} accepted`);
  }
  test(`${label}: ${cases} hostile cases, none accepted, at most one RPC each`, failures.length === 0, failures.slice(0, 5).join('; '));
}

for (const [label, args] of [
  ['assign 0 rows', { assign: [] }], ['assign 2 rows', { assign: [assignRow(), assignRow()] }],
  ['membership 0 rows', { member: [] }], ['membership 2 rows', { member: [memberRow(), memberRow()] }],
  ['version 0 rows', { version: [] }], ['version 2 rows', { version: [versionRow(), versionRow()] }],
]) {
  const r = await run(args);
  test(`${label} refused`, r.result === null && r.error !== null);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
