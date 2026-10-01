import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'backend', 'positioning_engine', 'evidence_contract.ts');
const source = readFileSync(file, 'utf8');
const docs = readFileSync(path.join(ROOT, 'docs', 'XAU_V2_POSITIONING_EVIDENCE_CONTRACT.md'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = mkdtempSync(path.join(tmpdir(), 'positioning-contract-'));
let mod;
try {
  mkdirSync(temp, { recursive: true });
  writeFileSync(path.join(temp, 'contract.mjs'), output, 'utf8');
  mod = await import(pathToFileURL(path.join(temp, 'contract.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

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

assert.equal(mod.buildPositioningEvidenceEnvelope([], cutoff).evidenceState, 'ABSTAIN');
assert.ok(mod.buildPositioningEvidenceEnvelope([base], '2026-10-01').reasonCodes.includes('INVALID_KNOWLEDGE_CUTOFF'));
assert.ok(mod.buildPositioningEvidenceEnvelope([base, structuredClone(base)], cutoff).reasonCodes.includes('DUPLICATE_EVIDENCE_KEY'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, value: Number.NaN }], cutoff).reasonCodes.includes('INVALID_EVIDENCE_VALUE'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, periodEnd: '2026-02-30' }], cutoff).reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, observedAt: '2026-10-02T00:00:00.000Z' }], cutoff).reasonCodes.includes('EVIDENCE_AFTER_KNOWLEDGE_CUTOFF'));
assert.ok(mod.buildPositioningEvidenceEnvelope([{ ...base, extra: true }], cutoff).reasonCodes.includes('INVALID_EVIDENCE_SHAPE'));
assert.doesNotThrow(() => mod.buildPositioningEvidenceEnvelope([{}], cutoff));
assert.deepEqual(mod.buildPositioningEvidenceEnvelope([{}], cutoff).evidence, []);

assert.doesNotMatch(source, /Date\.now\(|new Date\(\)|fetch\(|SUPABASE_|ANTHROPIC_|OPENAI_|process\.env/);
assert.match(docs, /NO PROVIDER OR METHODOLOGY APPROVED/);
assert.match(docs, /authorizes no provider call[\s\S]*trading action/i);
console.log('PASS Positioning P-0 normalizes attributable evidence while forbidding unapproved signal inference');
