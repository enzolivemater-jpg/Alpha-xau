import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'backend/observability/evidence_manifest.ts'), 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'xau-evidence-0-'));
let build;
try {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(dir, 'manifest.mjs');
  writeFileSync(modulePath, js);
  ({ buildEvidenceEligibilityManifest: build } = await import(pathToFileURL(modulePath).href));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const cutoff = '2026-10-13T15:00:00.000Z';
const good = {
  kind: 'OFFICIAL_RELEASE', evidenceId: 'bls-cpi-2026-09-initial',
  sourceAuthority: 'bls', revision: 'initial',
  artifactSha256: 'a'.repeat(64),
  effectiveAt: '2026-09-30T00:00:00.000Z',
  publishedAt: '2026-10-13T12:30:00.000Z',
  firstIngestedAt: '2026-10-13T12:31:00.000Z',
  producerVersion: 'bls-cpi-fixture-1.0.0',
};
const other = {
  ...good, kind: 'MARKET_PRICE', evidenceId: 'xau-test-price',
  sourceAuthority: 'market-test',
  artifactSha256: 'b'.repeat(64),
  effectiveAt: '2026-10-13T12:32:00.000Z',
  publishedAt: '2026-10-13T12:32:00.000Z',
  firstIngestedAt: '2026-10-13T12:32:01.000Z',
  producerVersion: 'market-test-1.0.0',
};

const initial = [good, other];
const snapshot = structuredClone(initial);
const result = build(initial, cutoff);
assert.deepEqual(initial, snapshot, 'must not mutate caller claims');
assert.equal(result.structuralStatus, 'COHERENT');
assert.equal(result.evidenceState, 'UNVERIFIED');
assert.equal(result.authorization, 'NONE');
assert.deepEqual(result.reasonCodes, ['SOURCE_ATTESTATION_UNAVAILABLE']);
assert.equal(result.claims.length, 2);
assert.deepEqual(result, build([other, good], cutoff), 'input order must not change output');
assert.deepEqual(result, build([good, other, good], cutoff), 'exact duplicate collapse');

const checks = [
  ['no evidence', [], ['NO_EVIDENCE']],
  ['bad cutoff', [good], ['INVALID_KNOWLEDGE_CUTOFF'], '2026-02-30T10:00:00Z'],
  ['extra field', [{ ...good, action: 'BUY' }], ['INVALID_CLAIM_SHAPE']],
  ['missing field', [{ ...good, artifactSha256: undefined }], ['INVALID_ARTIFACT_HASH']],
  ['bad kind', [{ ...good, kind: 'TRADE' }], ['INVALID_CLAIM_IDENTITY']],
  ['bad authority', [{ ...good, sourceAuthority: '../../private' }], ['INVALID_CLAIM_IDENTITY']],
  ['hash not available', [{ ...good, artifactSha256: null }], ['INVALID_ARTIFACT_HASH']],
  ['uppercase hash', [{ ...good, artifactSha256: 'B'.repeat(64) }], ['INVALID_ARTIFACT_HASH']],
  ['publication after cutoff', [{
    ...good, publishedAt: '2026-10-13T15:00:01.000Z',
    firstIngestedAt: '2026-10-13T15:00:02.000Z',
  }], ['PUBLICATION_AFTER_CUTOFF', 'INGESTION_AFTER_CUTOFF']],
  ['late arriving correction', [{
    ...good, firstIngestedAt: '2026-10-13T15:00:01.000Z',
  }], ['INGESTION_AFTER_CUTOFF']],
  ['revision effective after published', [{
    ...good, effectiveAt: '2026-10-14T12:00:00.000Z',
  }], ['CHRONOLOGY_INVALID']],
  ['published after ingestion', [{
    ...good, firstIngestedAt: '2026-10-13T12:29:00.000Z',
  }], ['CHRONOLOGY_INVALID']],
  ['invalid leap day', [{ ...good, publishedAt: '2026-02-29T12:00:00Z' }], ['INVALID_CLAIM_TIMESTAMP']],
  ['nanosecond timestamp rejected', [{
    ...good, publishedAt: '2026-10-13T12:30:00.000000001Z',
  }], ['INVALID_CLAIM_TIMESTAMP']],
  ['divergent reused identity', [
    good, { ...good, artifactSha256: 'f'.repeat(64) },
  ], ['INVALID_CLAIM_IDENTITY']],
];
for (const [name, claims, required, cut = cutoff] of checks) {
  const output = build(claims, cut);
  assert.equal(output.structuralStatus, 'REJECTED', name);
  assert.equal(output.evidenceState, 'UNVERIFIED', name);
  assert.equal(output.authorization, 'NONE', name);
  assert.deepEqual(output.claims, [], `${name}: fail-closed empty batch`);
  for (const reason of required) {
    assert.ok(output.reasonCodes.includes(reason), `${name}: missing ${reason}`);
  }
  assert.ok(output.reasonCodes.includes('SOURCE_ATTESTATION_UNAVAILABLE'));
}

const normalizedOffset = build([{
  ...good,
  publishedAt: '2026-10-13T14:30:00+02:00',
  firstIngestedAt: '2026-10-13T14:31:00+02:00',
}], cutoff);
assert.equal(normalizedOffset.structuralStatus, 'COHERENT', 'compare instants, not zone strings');

// No matter what a caller *claims*, EVIDENCE-0 never certifies source,
// methodology, deployment, risk permission, or execution.
const forgery = build([{ ...good, producerVersion: 'PRODUCTION_APPROVED' }], cutoff);
assert.equal(forgery.evidenceState, 'UNVERIFIED');
assert.equal(forgery.authorization, 'NONE');
assert.doesNotMatch(source, /\bfetch\(|process\.env|Date\.now\(|Math\.random\(|new WebSocket\(/);
console.log(`PASS EVIDENCE-0: ${checks.length} rejection cases + deterministic ordering, no admission`);
