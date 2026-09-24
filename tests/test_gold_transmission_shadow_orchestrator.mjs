// Behavioral contract for GT-4 using the real GT-3 processor and a DB port.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const processorSource = readFileSync(path.join(root, 'backend/gold_transmission/deterministic_processor.ts'), 'utf8');
const orchestratorSource = readFileSync(path.join(root, 'backend/gold_transmission/shadow_orchestrator.ts'), 'utf8');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
let mod;
const temp = mkdtempSync(path.join(tmpdir(), 'gold-transmission-shadow-'));
try {
  writeFileSync(path.join(temp, 'deterministic_processor.mjs'), transpile(processorSource));
  const orchestrator = transpile(orchestratorSource).replace(
    /(['"])\.\/deterministic_processor\.js\1/, '$1./deterministic_processor.mjs$1',
  );
  const modulePath = path.join(temp, 'shadow_orchestrator.mjs');
  writeFileSync(modulePath, orchestrator);
  mod = await import(pathToFileURL(modulePath).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;
function test(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const eventId = '11111111-1111-4111-8111-111111111111';
const otherEventId = '22222222-2222-4222-8222-222222222222';
const clusterId = '33333333-3333-4333-8333-333333333333';
const assessmentId = '44444444-4444-4444-8444-444444444444';
const cutoff = '2026-09-22T00:00:00.123456+00:00';

function eventRow(overrides = {}) {
  return {
    id: eventId, cluster_id: clusterId, version_number: 1, transition_type: 'NOVELTY',
    knowledge_cutoff: cutoff, effective_time: null, effective_time_precision: null,
    canonical_event_state_schema_version: 1,
    canonical_event_state: {
      event_type: 'STATISTICAL_RELEASE', subject: 'Official release', detail: null,
    },
    official_confirmation_state: 'OFFICIALLY_CONFIRMED',
    source_independence_state: 'SINGLE_EDITORIAL_ORIGIN', supersedes_version_id: null,
    state_fingerprint: 'a'.repeat(64), ...overrides,
  };
}
function rpcRow(overrides = {}) {
  return { assessment_id: assessmentId, replayed: false, path_count: 0, evidence_count: 0, ...overrides };
}
function assessmentRow(body, overrides = {}) {
  return {
    id: assessmentId, event_version_id: body.p_event_version_id,
    assessment_status: body.p_assessment_status, assessment_reason: body.p_assessment_reason,
    knowledge_cutoff: body.p_knowledge_cutoff, producer_type: body.p_producer_type,
    producer_actor: body.p_producer_actor, algorithm_version: body.p_algorithm_version,
    input_fingerprint: body.p_input_fingerprint, semantic_fingerprint: body.p_semantic_fingerprint,
    idempotency_fingerprint: body.p_idempotency_fingerprint,
    supersedes_assessment_id: body.p_supersedes_assessment_id, ...overrides,
  };
}
function makeDb(options = {}) {
  const calls = [];
  const bodies = [];
  let attempts = 0;
  return {
    calls, bodies,
    db: {
      async request(method, requestPath, body) {
        calls.push({ method, path: requestPath, body });
        if (requestPath.startsWith('event_versions?')) return options.eventRows ?? [eventRow(options.eventOverrides)];
        if (requestPath === 'rpc/fn_gold_transmission_create_assessment') {
          attempts += 1;
          bodies.push(structuredClone(body));
          if (options.failFirst && attempts === 1) throw new Error('synthetic lost response');
          return options.rpcRows ?? [rpcRow({ replayed: options.replayAfterFirst ? attempts > 1 : Boolean(options.replayed) })];
        }
        if (requestPath.startsWith('gold_transmission_assessments?')) {
          return options.assessmentRows ?? [assessmentRow(bodies.at(-1), options.assessmentOverrides)];
        }
        if (requestPath.startsWith('gold_transmission_paths?')) return options.pathRows ?? [];
        throw new Error(`unexpected call ${method} ${requestPath}`);
      },
    },
  };
}
async function expectError(fn, label, code = null) {
  try { await fn(); test(label, false, 'expected error'); }
  catch (error) {
    test(label, code === null || (error instanceof mod.GoldTransmissionShadowInvariantError
      && error.code === code), String(error));
  }
}

test('controlled processor exported', typeof mod.processGoldTransmissionShadowVersion === 'function');
test('typed invariant error exported', typeof mod.GoldTransmissionShadowInvariantError === 'function');
test('canonical serializer exported', typeof mod.canonicalStringifyGoldTransmission === 'function');

{
  const { db, calls, bodies } = makeDb();
  const result = await mod.processGoldTransmissionShadowVersion(db, eventId);
  const body = bodies[0];
  test('happy path processed conservatively', result.kind === 'PROCESSED'
    && result.assessmentStatus === 'INSUFFICIENT_EVIDENCE'
    && result.assessmentReason === 'TYPED_EVENT_FACTS_UNAVAILABLE'
    && result.pathCount === 0 && result.evidenceCount === 0);
  test('exact four-call flow', calls.length === 4
    && calls[0].method === 'GET'
    && calls[1].path === 'rpc/fn_gold_transmission_create_assessment'
    && calls[2].path.startsWith('gold_transmission_assessments?')
    && calls[3].path.startsWith('gold_transmission_paths?'));
  test('explicit Event Version read without wildcard', calls[0].path.includes(`id=eq.${eventId}`)
    && calls[0].path.includes('&select=id,cluster_id,') && !calls[0].path.includes('select=*'));
  test('RPC payload has zero paths and explicit reason', body.p_paths.length === 0
    && body.p_assessment_reason === 'TYPED_EVENT_FACTS_UNAVAILABLE'
    && body.p_supersedes_assessment_id === null);
  test('three distinct SHA-256 fingerprints', new Set([
    body.p_input_fingerprint, body.p_semantic_fingerprint, body.p_idempotency_fingerprint,
  ]).size === 3 && [body.p_input_fingerprint, body.p_semantic_fingerprint,
    body.p_idempotency_fingerprint].every(value => /^[0-9a-f]{64}$/.test(value)));
}

{
  const { db, bodies } = makeDb({ replayAfterFirst: true });
  const first = await mod.processGoldTransmissionShadowVersion(db, eventId);
  const replay = await mod.processGoldTransmissionShadowVersion(db, eventId);
  test('exact second call replays same assessment', !first.assessmentReplayed
    && replay.assessmentReplayed && first.assessmentId === replay.assessmentId);
  test('replay payload is byte-equivalent JSON', JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]));
}

{
  const { db, bodies } = makeDb({ failFirst: true, replayAfterFirst: true });
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, eventId), 'lost response propagates');
  const recovered = await mod.processGoldTransmissionShadowVersion(db, eventId);
  test('lost response retry replays exact intent', recovered.assessmentReplayed
    && JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]));
}

{
  const { db, calls } = makeDb({ eventRows: [] });
  const result = await mod.processGoldTransmissionShadowVersion(db, eventId);
  test('missing Event Version skips without mutation', result.kind === 'SKIPPED' && calls.length === 1);
}
{
  const { db, calls } = makeDb();
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, 'bad'),
    'invalid caller id rejected', 'INVALID_EVENT_VERSION_ID');
  test('invalid caller id performs no DB call', calls.length === 0);
}
{
  const { db, calls } = makeDb({ eventRows: [eventRow(), eventRow()] });
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, eventId),
    'duplicate Event Version rows rejected', 'EVENT_VERSION_ROW_COUNT_INVARIANT');
  test('duplicate rows rejected before mutation', calls.length === 1);
}
{
  const { db } = makeDb({ eventOverrides: { id: otherEventId } });
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, eventId),
    'Event Version identity mismatch rejected', 'EVENT_VERSION_IDENTITY_MISMATCH');
}

for (const [label, eventOverrides, reason] of [
  ['bad state fingerprint', { state_fingerprint: 'A'.repeat(64) }, 'INVALID_STATE_FINGERPRINT'],
  ['invalid canonical text', { canonical_event_state: {
    event_type: 'STATISTICAL_RELEASE', subject: ' Two spaces ', detail: null,
  } }, 'INVALID_CANONICAL_EVENT_STATE_V1'],
]) {
  const { db, calls } = makeDb({ eventOverrides });
  const result = await mod.processGoldTransmissionShadowVersion(db, eventId);
  test(`${label} abstains`, result.kind === 'ABSTAINED' && result.reason === reason);
  test(`${label} does not mutate`, calls.length === 1);
}

{
  const { db, bodies } = makeDb({
    eventOverrides: { canonical_event_state_schema_version: 3, canonical_event_state: { opaque: true } },
    assessmentOverrides: { assessment_status: 'UNAVAILABLE', assessment_reason: 'UNSUPPORTED_CANONICAL_EVENT_STATE_SCHEMA' },
  });
  const result = await mod.processGoldTransmissionShadowVersion(db, eventId);
  test('future schema persists explicit unavailable', result.kind === 'PROCESSED'
    && result.assessmentStatus === 'UNAVAILABLE'
    && bodies[0].p_paths.length === 0);
}

for (const [label, rpcRows, code] of [
  ['zero RPC rows', [], 'ASSESSMENT_RPC_ROW_COUNT_INVARIANT'],
  ['bad assessment id', [rpcRow({ assessment_id: 'bad' })], 'MALFORMED_DB_RESPONSE'],
  ['bad replay flag', [rpcRow({ replayed: 'false' })], 'MALFORMED_DB_RESPONSE'],
  ['non-zero path count', [rpcRow({ path_count: 1 })], 'ASSESSMENT_RPC_COUNT_MISMATCH'],
  ['non-zero evidence count', [rpcRow({ evidence_count: 1 })], 'ASSESSMENT_RPC_COUNT_MISMATCH'],
]) {
  const { db } = makeDb({ rpcRows });
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, eventId), label, code);
}
{
  const { db } = makeDb({ assessmentOverrides: { producer_actor: 'wrong' } });
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, eventId),
    'read-back mismatch rejected', 'PERSISTED_ASSESSMENT_MISMATCH');
}
{
  const { db } = makeDb({ pathRows: [{ id: otherEventId }] });
  await expectError(() => mod.processGoldTransmissionShadowVersion(db, eventId),
    'unexpected path rejected', 'UNEXPECTED_PERSISTED_PATHS');
}

test('canonical JSON sorts object keys',
  mod.canonicalStringifyGoldTransmission({ z: 1, a: { d: 2, b: 1 } })
  === '{"a":{"b":1,"d":2},"z":1}');
test('known SHA-256 vector', await mod.sha256GoldTransmission('abc')
  === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

const executable = orchestratorSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
test('imports the real processor', /from ['"]\.\/deterministic_processor\.js['"]/.test(orchestratorSource));
test('uses exactly the sole GT mutation RPC',
  (executable.match(/rpc\/fn_gold_transmission_create_assessment/g) ?? []).length === 1);
for (const token of ['@supabase', 'process.env', 'Date.now(', 'new Date(', 'Math.random(',
  'news_events', 'gold_direction_impact', 'expected_move_usd', 'news_score',
  'Anthropic', 'OpenAI', 'Gemini', 'wrangler', 'cron', 'backfill']) {
  test(`static boundary excludes ${token}`, !executable.includes(token));
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
