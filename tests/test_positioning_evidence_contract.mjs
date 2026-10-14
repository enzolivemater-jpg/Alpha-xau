import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackendModule } from '../scripts/lib/backend_module_loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'backend', 'positioning_engine', 'evidence_contract.ts');
const source = readFileSync(file, 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_POSITIONING_EVIDENCE_CONTRACT.md'), 'utf8');
const mod = await loadBackendModule('positioning_engine/evidence_contract.ts');

const cutoff = '2026-10-01T12:00:00.000Z';
const base = {
  sourceAuthority: 'authority_test',
  datasetCode: 'weekly_positions',
  instrumentCode: 'GC',
  metricCode: 'managed_money_net',
  value: 12345,
  unit: 'CONTRACTS',
  periodEnd: '2026-09-29',
  publishedAt: '2026-09-30T19:30:00.000Z',
  observedAt: '2026-09-30T19:31:00.000Z',
  artifactId: 'sha256:test-artifact',
  revision: null,
};

const ready = mod.buildPositioningEvidenceEnvelope([base], cutoff);
assert.equal(ready.schemaVersion, 'xau.positioning-evidence.v1');
assert.equal(ready.algorithmVersion, 'positioning-evidence-normalizer-1.0.0');
assert.equal(ready.evidenceState, 'EVIDENCE_READY');
assert.equal(ready.positioningState, 'UNAVAILABLE');
assert.deepEqual(ready.reasonCodes, ['METHODOLOGY_NOT_APPROVED']);
assert.equal(ready.observedThrough, base.observedAt);
assert.deepEqual(ready, mod.buildPositioningEvidenceEnvelope([structuredClone(base)], cutoff));

const second = { ...base, metricCode: 'open_interest', value: 450000 };
const sorted = mod.buildPositioningEvidenceEnvelope([second, base], cutoff);
assert.deepEqual(sorted.evidence.map((item) => item.metricCode), ['managed_money_net', 'open_interest']);
assert.deepEqual(sorted.sourceAuthorities, ['authority_test']);

// Order is by code unit, field by field. ICU collation ignores the \u001f key
// separator, so ('a','bc') and ('ab','c') used to tie and fall back to
// publishedAt; the earlier publication must not move the second identity first.
const splitLeft = { ...base, sourceAuthority: 'a', datasetCode: 'bc' };
const splitRight = { ...base, sourceAuthority: 'ab', datasetCode: 'c', publishedAt: '2026-09-30T19:00:00.000Z' };
assert.deepEqual(
  mod.buildPositioningEvidenceEnvelope([splitRight, splitLeft], cutoff).evidence.map((item) => item.sourceAuthority),
  ['a', 'ab'],
);

// The same input yields the same envelope whatever the host locale (Danish
// collation sorts "aa" after "z").
const localeProbe = `
  import { loadBackendModule } from ${JSON.stringify(new URL('../scripts/lib/backend_module_loader.mjs', import.meta.url).href)};
  const mod = await loadBackendModule('positioning_engine/evidence_contract.ts');
  const base = ${JSON.stringify(base)};
  const envelope = mod.buildPositioningEvidenceEnvelope(
    [{ ...base, sourceAuthority: 'cftc' }, { ...base, sourceAuthority: 'aa-bank' }], ${JSON.stringify(cutoff)});
  process.stdout.write(JSON.stringify(envelope));
`;
const envelopes = ['en_US.UTF-8', 'da_DK.UTF-8', 'C'].map((locale) => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', localeProbe], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: locale, LANG: locale },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
});
assert.deepEqual(JSON.parse(envelopes[0]).evidence.map((item) => item.sourceAuthority), ['aa-bank', 'cftc']);
assert.equal(envelopes[1], envelopes[0]);
assert.equal(envelopes[2], envelopes[0]);
assert.doesNotMatch(source, /\.localeCompare\(|Intl\.Collator/);

assert.equal(mod.buildPositioningEvidenceEnvelope([], cutoff).evidenceState, 'ABSTAIN');
assert.ok(mod.buildPositioningEvidenceEnvelope([base], '2026-10-01').reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));
assert.ok(mod.buildPositioningEvidenceEnvelope([base, structuredClone(base)], cutoff).reasonCodes.includes('DUPLICATE_EVIDENCE_KEY'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, value: Number.NaN }], cutoff).reasonCodes.includes('INVALID_EVIDENCE_VALUE'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, periodEnd: '2026-02-30' }], cutoff).reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, observedAt: '2026-10-02T00:00:00.000Z' }], cutoff).reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, extra: true }], cutoff).reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));
// Mirrors CHECK (published_at <= observed_at) of the persistence schema.
const retainedBeforePublication = mod.buildPositioningEvidenceEnvelope(
  [{ ...base, publishedAt: base.observedAt, observedAt: base.publishedAt }], cutoff);
assert.equal(retainedBeforePublication.evidenceState, 'ABSTAIN');
assert.ok(retainedBeforePublication.reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));
assert.deepEqual(retainedBeforePublication.evidence, []);
assert.equal(mod.buildPositioningEvidenceEnvelope(
  [{ ...base, observedAt: base.publishedAt }], cutoff).evidenceState, 'EVIDENCE_READY');
assert.doesNotThrow(() => mod.buildPositioningEvidenceEnvelope([{}], cutoff));
assert.deepEqual(mod.buildPositioningEvidenceEnvelope([{}], cutoff).evidence, []);

assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env/);
assert.match(docs, /NO PROVIDER OR METHODOLOGY APPROVED/);
assert.match(docs, /authorizes no provider call[\s\S]*trading action/i);
console.log('PASS Positioning P-0 normalizes attributable evidence while forbidding unapproved signal inference');
