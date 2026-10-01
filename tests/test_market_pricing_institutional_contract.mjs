import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = path.join(ROOT, 'backend', 'market_engine');
const source = readFileSync(path.join(MARKET, 'institutional_snapshot.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_MARKET_PRICING_CONTRACT.md'), 'utf8');

function transpile(file) {
  return ts.transpileModule(readFileSync(path.join(MARKET, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll(/(['"])\.\/([a-z_]+)\.js\1/g, '$1./$2.mjs$1');
}

const temp = mkdtempSync(path.join(tmpdir(), 'market-pricing-contract-'));
let mod;
try {
  mkdirSync(temp, { recursive: true });
  for (const file of ['types.ts', 'institutional_snapshot.ts']) {
    writeFileSync(path.join(temp, file.replace(/\.ts$/, '.mjs')), transpile(file), 'utf8');
  }
  mod = await import(pathToFileURL(path.join(temp, 'institutional_snapshot.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const live = (value, observedAt, sourceName = 'test-source') => ({
  value, status: 'LIVE', observedAt, ageSeconds: 60, source: sourceName,
});
const unavailable = { value: null, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null };
const at = '2026-10-01T08:00:00.000Z';
const snapshot = {
  available: true,
  reason: null,
  spot: live(3900, '2026-10-01T07:59:00.000Z', 'twelve_data'),
  bid: live(3899.8, '2026-10-01T07:59:00.000Z', 'twelve_data'),
  ask: live(3900.2, '2026-10-01T07:59:00.000Z', 'twelve_data'),
  dxy: unavailable,
  us10y: live(4.1, '2026-10-01T00:00:00.000Z', 'fred'),
  realYield: live(1.7, '2026-10-01T00:00:00.000Z', 'fred'),
  vix: live(17.2, '2026-10-01T00:00:00.000Z', 'fred'),
  wti: live(66.4, '2026-10-01T00:00:00.000Z', 'fred'),
  capturedAt: '2026-10-01T07:59:00.000Z',
};

const first = mod.buildInstitutionalMarketPricingSnapshot(snapshot, at);
const second = mod.buildInstitutionalMarketPricingSnapshot(structuredClone(snapshot), at);
assert.deepEqual(first, second);
assert.equal(first.schemaVersion, 'xau.market-pricing-snapshot.v1');
assert.equal(first.algorithmVersion, 'market-pricing-envelope-1.0.0');
assert.equal(first.state, 'DEGRADED');
assert.deepEqual(first.reasonCodes, ['OPTIONAL_FIELD_UNAVAILABLE', 'HISTORICAL_REPLAY_UNAVAILABLE']);
assert.equal(first.fields.spot.role, 'REQUIRED');
assert.equal(first.fields.us10y.role, 'OPTIONAL');
assert.equal(first.fields.spot.source, 'twelve_data');
assert.equal(first.observedThrough, '2026-10-01T07:59:00.000Z');
assert.deepEqual(first.replay, {
  mode: 'LATEST_ONLY', reproducible: false, reason: 'INGESTION_CUTOFF_NOT_AVAILABLE',
});

const staleMacro = structuredClone(snapshot);
staleMacro.us10y.status = 'STALE';
assert.deepEqual(
  mod.buildInstitutionalMarketPricingSnapshot(staleMacro, at).reasonCodes,
  ['OPTIONAL_FIELD_UNAVAILABLE', 'OPTIONAL_FIELD_STALE', 'HISTORICAL_REPLAY_UNAVAILABLE'],
);

const noSpot = structuredClone(snapshot);
noSpot.available = false;
noSpot.spot = unavailable;
noSpot.capturedAt = null;
assert.equal(mod.buildInstitutionalMarketPricingSnapshot(noSpot, at).state, 'ABSTAIN');

const future = structuredClone(snapshot);
future.spot.observedAt = '2026-10-01T08:01:00.000Z';
future.capturedAt = future.spot.observedAt;
assert.ok(mod.buildInstitutionalMarketPricingSnapshot(future, at).reasonCodes.includes('OBSERVATION_AFTER_KNOWLEDGE_CUTOFF'));

const inverted = structuredClone(snapshot);
inverted.bid.value = 3901;
assert.ok(mod.buildInstitutionalMarketPricingSnapshot(inverted, at).reasonCodes.includes('BOOK_INVERTED'));

const drift = structuredClone(snapshot);
drift.capturedAt = '2026-10-01T07:58:00.000Z';
assert.ok(mod.buildInstitutionalMarketPricingSnapshot(drift, at).reasonCodes.includes('CAPTURED_AT_MISMATCH'));

const malformed = structuredClone(snapshot);
malformed.vix = { value: 0, status: 'UNAVAILABLE', observedAt: null, ageSeconds: null, source: null };
assert.ok(mod.buildInstitutionalMarketPricingSnapshot(malformed, at).reasonCodes.includes('INVALID_FIELD_CONTRACT'));
assert.ok(mod.buildInstitutionalMarketPricingSnapshot(snapshot, '2026-10-01').reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));

assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env/);
assert.match(docs, /CONTRACT_CI_PROVEN — NOT RUNTIME-ACTIVATED/);
assert.match(docs, /INGESTION_CUTOFF_NOT_AVAILABLE/);
assert.match(docs, /authorizes no runtime,\s+provider, schema, migration, deployment, schedule, broker or trading action/i);
console.log('PASS Market Pricing V1 freezes deterministic provenance, cutoff, degradation, abstention, and replay limits');

