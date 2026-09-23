// Behavioral contract for GT-5 using the real batch, GT-4, GT-3 and run lock.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = {
  processor: readFileSync(path.join(root, 'backend/gold_transmission/deterministic_processor.ts'), 'utf8'),
  orchestrator: readFileSync(path.join(root, 'backend/gold_transmission/shadow_orchestrator.ts'), 'utf8'),
  batch: readFileSync(path.join(root, 'backend/gold_transmission/shadow_batch.ts'), 'utf8'),
  lock: readFileSync(path.join(root, 'backend/shared/run_lock.ts'), 'utf8'),
};
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

let mod;
const temp = mkdtempSync(path.join(tmpdir(), 'gold-transmission-batch-'));
try {
  writeFileSync(path.join(temp, 'deterministic_processor.mjs'), transpile(sources.processor));
  writeFileSync(path.join(temp, 'shadow_orchestrator.mjs'), transpile(sources.orchestrator)
    .replace(/(['"])\.\/deterministic_processor\.js\1/, '$1./deterministic_processor.mjs$1'));
  writeFileSync(path.join(temp, 'run_lock.mjs'), transpile(sources.lock));
  writeFileSync(path.join(temp, 'shadow_batch.mjs'), transpile(sources.batch)
    .replace(/(['"])\.\/shadow_orchestrator\.js\1/, '$1./shadow_orchestrator.mjs$1')
    .replace(/(['"])\.\.\/shared\/run_lock\.js\1/, '$1./run_lock.mjs$1'));
  mod = await import(pathToFileURL(path.join(temp, 'shadow_batch.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;
function test(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  OK  ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function expectError(fn, name, predicate) {
  try { await fn(); test(name, false, 'expected rejection'); }
  catch (error) { test(name, predicate(error), String(error)); }
}

const EV1 = '11111111-1111-4111-8111-111111111111';
const EV2 = '22222222-2222-4222-8222-222222222222';
const EV3 = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLUSTER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUTOFF = '2026-09-22T00:00:00.123456+00:00';
const ASSESSMENTS = new Map([
  [EV1, 'c1111111-1111-4111-8111-111111111111'],
  [EV2, 'c2222222-2222-4222-8222-222222222222'],
  [EV3, 'c3333333-3333-4333-8333-333333333333'],
]);

function extractEq(requestPath, column) {
  const match = requestPath.match(new RegExp(`${column}=eq\\.([^&]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
function eventRow(id, overrides = {}) {
  return {
    id, cluster_id: CLUSTER, version_number: 1, transition_type: 'NOVELTY',
    knowledge_cutoff: CUTOFF, effective_time: null, effective_time_precision: null,
    canonical_event_state_schema_version: 1,
    canonical_event_state: {
      event_type: 'STATISTICAL_RELEASE', subject: 'Official release', detail: null,
    },
    official_confirmation_state: 'OFFICIALLY_CONFIRMED',
    source_independence_state: 'SINGLE_EDITORIAL_ORIGIN',
    supersedes_version_id: null, state_fingerprint: 'a'.repeat(64), ...overrides,
  };
}
function makeDb(options = {}) {
  const calls = [];
  const releases = [];
  const bodies = new Map();
  const persisted = new Set();
  const db = {
    async request(method, requestPath, body) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === 'rpc/fn_reclaim_stale_runs') return [{ reclaimed: 0 }];
      if (requestPath === 'ingestion_runs?select=id' && method === 'POST') {
        if (options.busy) throw new Error('PostgREST 409 code=23505 duplicate key');
        return [{ id: RUN }];
      }
      if (requestPath.startsWith('event_versions?')) {
        const id = extractEq(requestPath, 'id');
        if (id === UNKNOWN) return [];
        return [eventRow(id, options.invalidId === id ? { state_fingerprint: 'A'.repeat(64) } : {})];
      }
      if (requestPath === 'rpc/fn_gold_transmission_create_assessment') {
        const id = body.p_event_version_id;
        if (options.failId === id) {
          throw new Error('synthetic ?apiKey=VERY_SECRET Authorization: Bearer TOP_SECRET');
        }
        const assessmentId = ASSESSMENTS.get(id);
        const replayed = persisted.has(id);
        persisted.add(id);
        bodies.set(assessmentId, structuredClone(body));
        return [{ assessment_id: assessmentId, replayed, path_count: 0, evidence_count: 0 }];
      }
      if (requestPath.startsWith('gold_transmission_assessments?')) {
        const id = extractEq(requestPath, 'id');
        const saved = bodies.get(id);
        return [{
          id, event_version_id: saved.p_event_version_id,
          assessment_status: saved.p_assessment_status,
          assessment_reason: saved.p_assessment_reason,
          knowledge_cutoff: saved.p_knowledge_cutoff,
          producer_type: saved.p_producer_type,
          producer_actor: saved.p_producer_actor,
          algorithm_version: saved.p_algorithm_version,
          input_fingerprint: saved.p_input_fingerprint,
          semantic_fingerprint: saved.p_semantic_fingerprint,
          idempotency_fingerprint: saved.p_idempotency_fingerprint,
          supersedes_assessment_id: saved.p_supersedes_assessment_id,
        }];
      }
      if (requestPath.startsWith('gold_transmission_paths?')) return [];
      if (requestPath.startsWith('ingestion_runs?id=eq.') && method === 'PATCH') {
        if (options.releaseFails) throw new Error('release token=RELEASE_SECRET');
        releases.push(structuredClone(body));
        return [];
      }
      throw new Error(`unexpected DB call ${method} ${requestPath}`);
    },
  };
  return { db, calls, releases };
}

test('real batch module loads', typeof mod.runGoldTransmissionShadowBatch === 'function');
test('batch version exposed', mod.GOLD_TRANSMISSION_SHADOW_BATCH_VERSION === 'gold-transmission-shadow-batch-v1');
test('max batch is 25', mod.MAX_GOLD_TRANSMISSION_SHADOW_BATCH_SIZE === 25);

for (const [name, ids, code] of [
  ['empty list', [], 'EMPTY_EVENT_VERSION_LIST'],
  ['malformed UUID', ['bad'], 'MALFORMED_EVENT_VERSION_ID'],
  ['duplicate UUID', [EV1, EV1.toUpperCase()], 'DUPLICATE_EVENT_VERSION_ID'],
]) {
  const { db, calls } = makeDb();
  await expectError(() => mod.runGoldTransmissionShadowBatch(db, ids), name,
    error => error instanceof mod.GoldTransmissionShadowBatchInvariantError && error.code === code);
  test(`${name} has no DB call`, calls.length === 0);
}
{
  const ids = Array.from({ length: 26 }, (_, i) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const { db, calls } = makeDb();
  await expectError(() => mod.runGoldTransmissionShadowBatch(db, ids), 'size cap enforced',
    error => error.code === 'BATCH_SIZE_EXCEEDED');
  test('oversized list has no DB call', calls.length === 0);
}
{
  const { db, calls } = makeDb();
  await expectError(() => mod.runGoldTransmissionShadowBatch(db, [EV1], 'automatic'),
    'unsupported trigger rejected', error => error.code === 'UNSUPPORTED_TRIGGER_TYPE');
  test('unsupported trigger has no DB call', calls.length === 0);
}
{
  const { db, calls, releases } = makeDb({ busy: true });
  await expectError(() => mod.runGoldTransmissionShadowBatch(db, [EV1]), 'busy lock surfaced',
    error => error instanceof mod.GoldTransmissionShadowBatchBusyError);
  test('busy lock reads no Event Version', !calls.some(call => call.path.startsWith('event_versions?')));
  test('busy lock is not released by non-owner', releases.length === 0);
}

{
  const { db, calls, releases } = makeDb();
  const first = await mod.runGoldTransmissionShadowBatch(db, [EV1, EV2]);
  test('happy path success', first.status === 'success' && first.engine === 'gold_transmission_shadow');
  test('two conservative assessments created', first.processed === 2
    && first.assessmentsCreated === 2 && first.assessmentsReplayed === 0
    && first.insufficientEvidence === 2 && first.unavailable === 0);
  test('batch remains zero-path', first.pathCount === 0 && first.evidenceCount === 0
    && first.items.every(item => item.kind !== 'PROCESSED'
      || (item.pathCount === 0 && item.evidenceCount === 0)));
  test('caller order preserved', first.items[0].eventVersionId === EV1
    && first.items[1].eventVersionId === EV2);
  const relevant = calls.filter(call => call.path.startsWith('event_versions?')
    || call.path === 'rpc/fn_gold_transmission_create_assessment');
  test('strict sequential flow', relevant.length === 4
    && relevant[0].path.startsWith('event_versions?')
    && relevant[1].path === 'rpc/fn_gold_transmission_create_assessment'
    && relevant[2].path.startsWith('event_versions?')
    && relevant[3].path === 'rpc/fn_gold_transmission_create_assessment');
  test('lock engine and release counters exact', calls.find(call => call.path === 'ingestion_runs?select=id').body[0].engine === 'gold_transmission_shadow'
    && releases[0].persisted_count === 2 && releases[0].duplicate_count === 0
    && releases[0].providers.gold_transmission_shadow.path_count === 0);

  const replay = await mod.runGoldTransmissionShadowBatch(db, [EV1, EV2]);
  test('exact replay detected', replay.assessmentsCreated === 0 && replay.assessmentsReplayed === 2);
  test('replay keeps assessment ids', replay.items[0].assessmentId === first.items[0].assessmentId
    && replay.items[1].assessmentId === first.items[1].assessmentId);
}

{
  const { db } = makeDb({ invalidId: EV1 });
  const report = await mod.runGoldTransmissionShadowBatch(db, [EV1, UNKNOWN, EV2]);
  test('abstained and skipped are explicit non-failures', report.status === 'success'
    && report.abstained === 1 && report.skipped === 1 && report.processed === 1);
}
{
  const { db, releases } = makeDb({ failId: EV1 });
  const report = await mod.runGoldTransmissionShadowBatch(db, [EV1, EV2]);
  const item = report.items.find(candidate => candidate.kind === 'FAILED');
  test('item failure is isolated', report.status === 'partial' && report.failed === 1 && report.processed === 1);
  test('secret is redacted from item', item.safeErrorMessage.includes('[REDACTED]')
    && !item.safeErrorMessage.includes('VERY_SECRET') && !item.safeErrorMessage.includes('TOP_SECRET'));
  test('secret is redacted from lock release', JSON.stringify(releases[0]).includes('[REDACTED]')
    && !JSON.stringify(releases[0]).includes('VERY_SECRET'));
}
{
  const { db } = makeDb({ releaseFails: true });
  await expectError(() => mod.runGoldTransmissionShadowBatch(db, [EV3]),
    'release failure is surfaced and redacted', error =>
      error.code === 'GOLD_TRANSMISSION_SHADOW_LOCK_RELEASE_FAILED'
      && String(error).includes('[REDACTED]') && !String(error).includes('RELEASE_SECRET'));
}

const executable = sources.batch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
test('imports real GT-4', /from ['"]\.\/shadow_orchestrator\.js['"]/.test(sources.batch));
test('imports shared lock', /from ['"]\.\.\/shared\/run_lock\.js['"]/.test(sources.batch));
test('never calls GT RPC directly', !executable.includes('rpc/fn_gold_transmission_create_assessment'));
test('contains no discovery query', !/candidate_discovery|select=\*|order=|limit=/.test(executable));
test('contains no parallel item processing', !/Promise\.(all|allSettled)\s*\(/.test(executable));
for (const token of ['@supabase', 'process.env', 'news_events', 'gold_direction_impact',
  'expected_move_usd', 'news_score', 'Anthropic', 'OpenAI', 'Gemini', 'worker.ts',
  'wrangler', 'cron(']) {
  test(`static boundary excludes ${token}`, !executable.includes(token));
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
