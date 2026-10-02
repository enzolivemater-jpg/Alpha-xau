import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'backend', 'positioning_engine');
const migration = readFileSync(path.join(ROOT, 'database', 'migrations', '20261002092118_positioning_evidence_history_as_of.sql'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_POSITIONING_PERSISTENCE_CONTRACT.md'), 'utf8');
const board = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_COMPLETION_BOARD.md'), 'utf8');

function transpile(file) {
  return ts.transpileModule(readFileSync(path.join(ENGINE, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll(/(['"])\.\/([a-z_]+)\.js\1/g, '$1./$2.mjs$1');
}

const temp = mkdtempSync(path.join(tmpdir(), 'positioning-persistence-'));
let mod;
try {
  for (const file of ['evidence_contract.ts', 'persisted_evidence.ts']) {
    writeFileSync(path.join(temp, file.replace(/\.ts$/, '.mjs')), transpile(file), 'utf8');
  }
  mod = await import(pathToFileURL(path.join(temp, 'persisted_evidence.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const row = (evidence_id, metric_code, value, observed_at, revision = null) => ({
  evidence_id,
  source_authority: 'authority_test',
  dataset_code: 'weekly_positions',
  instrument_code: 'GC',
  metric_code,
  value,
  unit: 'CONTRACTS',
  period_end: '2026-09-29',
  published_at: '2026-09-30T19:30:00Z',
  observed_at,
  artifact_id: `sha256:${evidence_id}`,
  revision,
});
const rows = [
  row('30000000-0000-4000-8000-000000000001', 'managed_money_net', '12345.000', '2026-09-30T19:31:00Z'),
  row('30000000-0000-4000-8000-000000000002', 'managed_money_net', '12350.000', '2026-10-01T12:05:00Z', 'r2'),
  row('30000000-0000-4000-8000-000000000003', 'open_interest', '450000', '2026-09-30T19:31:00Z'),
];

const normalized = mod.normalizePositioningEvidenceRows(rows);
assert.equal(normalized[0].value, 12345);
assert.equal(normalized[0].publishedAt, '2026-09-30T19:30:00.000Z');
assert.equal(normalized[0].observedAt, '2026-09-30T19:31:00.000Z');
assert.equal(normalized[0].revision, null);

const before = mod.buildPersistedPositioningEvidence(rows.slice(0, 1), '2026-10-01T12:00:00Z');
assert.equal(before.schemaVersion, 'xau.positioning-persistence.v1');
assert.equal(before.algorithmVersion, 'positioning-persisted-evidence-adapter-1.0.0');
assert.equal(before.persistence.historyCompleteness, 'COMPLETE_OR_ERROR');
assert.equal(before.persistence.runtimeWiring, 'NOT_ACTIVATED');
assert.equal(before.persistence.providerApproval, 'NONE');
assert.equal(before.evidence.evidenceState, 'EVIDENCE_READY');
assert.equal(before.evidence.positioningState, 'UNAVAILABLE');
assert.deepEqual(before.evidence.reasonCodes, ['METHODOLOGY_NOT_APPROVED']);

const afterRows = [rows[2], rows[1], rows[0]];
const after = mod.buildPersistedPositioningEvidence(afterRows, '2026-10-01T12:06:00Z');
assert.equal(after.evidence.evidence.length, 3);
assert.equal(after.evidence.positioningState, 'UNAVAILABLE');
assert.deepEqual(after, mod.buildPersistedPositioningEvidence([...afterRows].reverse(), '2026-10-01T12:06:00Z'));

const bad = (mutate, pattern = /P1_RPC_ROW_0_/) => {
  const copy = [structuredClone(rows[0])];
  mutate(copy[0]);
  assert.throws(() => mod.normalizePositioningEvidenceRows(copy), pattern);
};
bad(x => { x.extra = true; });
bad(x => { x.evidence_id = 'bad'; });
bad(x => { x.value = 'NaN'; });
bad(x => { x.period_end = '2026-02-30'; });
bad(x => { x.published_at = '2026-09-30'; });
bad(x => { x.published_at = '2026-02-30T19:30:00Z'; });
bad(x => { x.observed_at = '2026-09-30T19:00:00Z'; });
bad(x => { x.artifact_id = ' '; });
bad(x => { x.revision = 'bad revision'; });

for (const token of [
  'CREATE TABLE public.positioning_evidence_observations',
  'fn_positioning_evidence_record', 'fn_positioning_evidence_as_of',
  'published_at <= p_knowledge_cutoff', 'observed_at <= p_knowledge_cutoff',
  'ENABLE ROW LEVEL SECURITY', 'COMPLETE_OR_ERROR',
]) assert.ok(`${migration}\n${docs}`.includes(token), `missing P-1 token: ${token}`);
assert.match(docs, /NO PROVIDER OR METHODOLOGY APPROVED/);
assert.match(docs, /authorizes no provider selection[\s\S]*trade/i);
assert.match(board, /P-1 CI on PG17\.6 plus hosted staging PG17\.11/);
console.log('PASS Positioning P-1 persists replayable evidence while keeping methodology unavailable');
