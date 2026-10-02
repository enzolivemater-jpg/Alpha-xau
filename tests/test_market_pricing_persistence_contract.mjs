import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = path.join(ROOT, 'backend', 'market_engine');
const migration = readFileSync(path.join(ROOT, 'database', 'migrations', '20261002085845_market_pricing_history_as_of.sql'), 'utf8');
const indexMigration = readFileSync(path.join(ROOT, 'database', 'migrations', '20261002091342_market_pricing_source_fk_index.sql'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_MARKET_PRICING_PERSISTENCE_CONTRACT.md'), 'utf8');
const board = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_COMPLETION_BOARD.md'), 'utf8');

function transpile(file) {
  return ts.transpileModule(readFileSync(path.join(MARKET, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll(/(['"])\.\/([a-z_]+)\.js\1/g, '$1./$2.mjs$1');
}

const temp = mkdtempSync(path.join(tmpdir(), 'market-pricing-persistence-'));
let mod;
try {
  for (const file of ['as_of_snapshot.ts', 'persisted_as_of.ts']) {
    writeFileSync(path.join(temp, file.replace(/\.ts$/, '.mjs')), transpile(file), 'utf8');
  }
  mod = await import(pathToFileURL(path.join(temp, 'persisted_as_of.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const row = (candidate_id, field, value, observed_at, ingested_at, evidence_revision, source = 'source_a') => ({
  candidate_id, field, value, source, observed_at, ingested_at, evidence_revision,
});
const rows = [
  row('10000000-0000-4000-8000-000000000001', 'spot', '3898.00000000', '2026-10-01T09:55:00Z', '2026-10-01T09:56:00Z', 'r1'),
  row('10000000-0000-4000-8000-000000000002', 'spot', '3900.00000000', '2026-10-01T09:55:00Z', '2026-10-01T10:05:00Z', 'r2'),
  row('10000000-0000-4000-8000-000000000003', 'bid', '3897.8', '2026-10-01T09:55:00Z', '2026-10-01T09:56:00Z', 'r1'),
  row('10000000-0000-4000-8000-000000000004', 'ask', '3898.2', '2026-10-01T09:55:00Z', '2026-10-01T09:56:00Z', 'r1'),
];

const normalized = mod.normalizeMarketPricingAsOfRows(rows);
assert.equal(normalized[0].value, 3898);
assert.equal(normalized[0].observedAt, '2026-10-01T09:55:00.000Z');
assert.equal(normalized[0].evidenceRevision, 'r1');

const before = mod.buildPersistedMarketPricingAsOf(rows, '2026-10-01T10:00:00Z');
assert.equal(before.schemaVersion, 'xau.market-pricing-persistence.v1');
assert.equal(before.algorithmVersion, 'market-pricing-persisted-as-of-adapter-1.0.0');
assert.equal(before.persistence.historyCompleteness, 'COMPLETE_OR_ERROR');
assert.equal(before.persistence.runtimeWiring, 'NOT_ACTIVATED');
assert.equal(before.selection.fields.spot.candidateId, '10000000-0000-4000-8000-000000000001');
assert.equal(before.selection.fields.spot.evidenceRevision, 'r1');

const after = mod.buildPersistedMarketPricingAsOf(rows, '2026-10-01T10:06:00Z');
assert.equal(after.selection.fields.spot.candidateId, '10000000-0000-4000-8000-000000000002');
assert.equal(after.selection.fields.spot.evidenceRevision, 'r2');
assert.deepEqual(after, mod.buildPersistedMarketPricingAsOf([...rows].reverse(), '2026-10-01T10:06:00Z'));

const bad = (mutate) => {
  const copy = structuredClone(rows);
  mutate(copy[0]);
  assert.throws(() => mod.normalizeMarketPricingAsOfRows(copy), /MP2_RPC_ROW_0_/);
};
bad(x => { x.extra = true; });
bad(x => { x.candidate_id = 'not-a-uuid'; });
bad(x => { x.field = 'silver'; });
bad(x => { x.value = 'NaN'; });
bad(x => { x.observed_at = '2026-10-01'; });
bad(x => { x.observed_at = '2026-10-01T10:00:00Z'; x.ingested_at = '2026-10-01T09:59:00Z'; });
bad(x => { x.evidence_revision = ' '; });

for (const token of [
  'CREATE TABLE public.market_pricing_observations',
  'fn_market_pricing_record_observation',
  'fn_market_pricing_candidates_as_of',
  'source_observed_at <= p_knowledge_cutoff',
  'ingested_at <= p_knowledge_cutoff',
  'ENABLE ROW LEVEL SECURITY',
  'COMPLETE_OR_ERROR',
]) assert.ok(`${migration}\n${docs}`.includes(token), `missing MP-2 token: ${token}`);
assert.match(indexMigration, /CREATE INDEX idx_market_pricing_observations_source/);
assert.match(docs, /NOT PRODUCTION-APPLIED \/ NOT RUNTIME-ACTIVATED/);
assert.match(docs, /authorizes no production migration, backfill, runtime wiring/i);
assert.match(board, /MP-2 CI on PG17\.6/);
console.log('PASS Market Pricing MP-2 normalizes complete persisted history into deterministic MP-1 replay');
