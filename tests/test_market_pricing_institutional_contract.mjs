import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = path.join(ROOT, 'backend', 'market_engine');
const source = readFileSync(path.join(MARKET, 'institutional_snapshot.ts'), 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_MARKET_PRICING_CONTRACT.md'), 'utf8');

const mod = await loadBackendModule('market_engine/institutional_snapshot.ts');

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

// A field status outside LIVE/STALE/UNAVAILABLE is not read as live.
for (const status of ['BOGUS', 'live', undefined]) {
  const unknownStatus = structuredClone(snapshot);
  unknownStatus.spot.status = status;
  const envelope = mod.buildInstitutionalMarketPricingSnapshot(unknownStatus, at);
  assert.equal(envelope.state, 'ABSTAIN', String(status));
  assert.ok(envelope.reasonCodes.includes('INVALID_FIELD_CONTRACT'), String(status));
}

assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env/);
assert.match(docs, /CONTRACT_CI_PROVEN — NOT RUNTIME-ACTIVATED/);
assert.match(docs, /INGESTION_CUTOFF_NOT_AVAILABLE/);
assert.match(docs, /authorizes no runtime,\s+provider, schema, migration, deployment, schedule, broker or trading action/i);
console.log('PASS Market Pricing V1 freezes deterministic provenance, cutoff, degradation, abstention, and replay limits');


// --- Engine qualification (Agent C): replay -> MP-1 -> MP-0 -> CHAIN-0 at exact edges, on synthetic evidence only.
{
  const ev = await loadBackendModule('market_engine/evidence_archive.ts');
  const bridge = await loadBackendModule('decision_chain/market_evidence_chain.ts');
  const { SYMBOL_RULES } = await loadBackendModule('market_engine/validate.ts');
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'market_evidence_archive_synthetic.json'), 'utf8'));
  const golden = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'decision_chain_dry_run_baseline.json'), 'utf8'));
  const archive = { ...structuredClone(fixture), coverage: { ...fixture.coverage, to: '2026-10-08T00:00:00.000Z' } };
  const run = async (a, at) => {
    const r = await ev.replayMarketEvidence(a, at);
    const o = bridge.evaluateDecisionChainOnMarketEvidence(structuredClone(golden.input), r);
    assert.equal(o.kind, 'COMPLETED', at);
    const res = o.result;
    // On every path: HOLD, execution forbidden, ACTION abstains, MP-0 never claims a historical replay.
    assert.deepEqual([res.chainState, res.execution, res.trace.find((t) => t.stage === 'ACTION').state], ['HOLD', 'FORBIDDEN', 'ABSTAIN'], at);
    assert.deepEqual(res.stages.marketPricing.replay, { mode: 'LATEST_ONLY', reproducible: false, reason: 'INGESTION_CUTOFF_NOT_AVAILABLE' }, at);
    assert.ok(res.stages.marketPricing.reasonCodes.includes('HISTORICAL_REPLAY_UNAVAILABLE'), at);
    return { r, mp0: res.stages.marketPricing, res };
  };
  // Spot observed 2026-10-01T14:16:00Z; the XAUUSD rule: LIVE up to 360 s, usable up to 3 days.
  const spotObserved = Date.parse('2026-10-01T14:16:00Z');
  const at = (seconds, ms = 0) => new Date(spotObserved + seconds * 1000 + ms).toISOString();
  const live = SYMBOL_RULES.XAUUSD.liveMaxAgeS;
  const stale = SYMBOL_RULES.XAUUSD.staleMaxAgeS;
  let x = await run(archive, at(live));
  assert.deepEqual([x.mp0.state, x.mp0.fields.spot.status, x.mp0.reasonCodes.includes('SPOT_NOT_LIVE')], ['DEGRADED', 'LIVE', false]);
  x = await run(archive, at(live + 1));
  assert.deepEqual([x.mp0.state, x.mp0.fields.spot.status, x.mp0.reasonCodes.includes('SPOT_NOT_LIVE')], ['DEGRADED', 'STALE', true]);
  x = await run(archive, at(stale));
  assert.deepEqual([x.mp0.state, x.mp0.fields.spot.status, x.r.observations.spot.freshnessProof], ['DEGRADED', 'STALE', 'FRESH']);
  x = await run(archive, at(stale + 1));
  assert.deepEqual([x.mp0.state, x.mp0.fields.spot.value, x.r.observations.spot.freshnessProof], ['ABSTAIN', null, 'STALE']);
  assert.ok(x.mp0.reasonCodes.includes('SOURCE_SNAPSHOT_UNAVAILABLE'));
  assert.equal(x.res.stages.regime.evidenceState, 'ABSTAIN', 'an abstaining MP-0 makes the regime abstain');
  // Current contract (anomaly A-C2, À DÉCIDER): ages are whole seconds, so up to 999 ms past the threshold the spot is still served.
  x = await run(archive, at(stale, 999));
  assert.deepEqual([x.r.observations.spot.ageSecondsAtCutoff, x.mp0.fields.spot.status, x.r.observations.spot.freshnessProof], [stale, 'STALE', 'FRESH']);
  // A correction reaches MP-0 from its ingestion instant only (WTI corrected, ingested 2026-10-02T06:00:00Z).
  const before = await run(archive, '2026-10-02T05:59:59.999Z');
  const after = await run(archive, '2026-10-02T06:00:00.000Z');
  assert.notEqual(before.mp0.fields.wti.value, after.mp0.fields.wti.value);
  assert.equal(before.r.observations.wti.supersedes, null);
  assert.equal(after.r.observations.wti.supersedes, before.r.observations.wti.evidenceId);
  assert.deepEqual(before.r.audit.correctedAfterCutoff, ['wti'], 'the later correction is reported, not used');
  // Provenance errors reject the archive: MP-0 abstains and carries no value at all.
  for (const [name, mutate] of [
    ['unit', (a) => { a.records[0].unit = 'PERCENT'; }],
    ['raw payload digest without bytes', (a) => { a.records[0].rawPayloadDigest = `sha256:${'a'.repeat(64)}`; a.rawPayloads[a.records[0].rawPayloadDigest] = { parser: 'twelve_data', symbol: 'XAUUSD', body: '{}' }; }],
    ['chronology', (a) => { a.records[0].ingestedAt = '2026-09-01T00:00:00.000Z'; }],
  ]) {
    const a = structuredClone(archive);
    mutate(a);
    const y = await run(a, '2026-10-01T14:20:00.000Z');
    assert.equal(y.r.status, 'INVALID', name);
    assert.equal(y.mp0.state, 'ABSTAIN', name);
    assert.ok(Object.values(y.mp0.fields).every((f) => f.value === null), `${name}: no value reaches MP-0`);
  }
}
console.log('PASS engine qualification: replay -> MP-1 -> MP-0 -> chain at exact freshness edges, revisions, provenance errors; HOLD and LATEST_ONLY everywhere');
