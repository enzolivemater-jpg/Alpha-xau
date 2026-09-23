/** Controlled GT-4 adapter for exactly one explicit Event Version id. */
import {
  GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION,
  planDeterministicGoldTransmission,
  type GoldTransmissionProcessPlan,
} from './deterministic_processor.js';

export const GOLD_TRANSMISSION_SHADOW_ORCHESTRATOR_VERSION =
  'gold-transmission-shadow-orchestrator-v1' as const;
export const GOLD_TRANSMISSION_SHADOW_PRODUCER_ACTOR =
  'xau_v2:gold_transmission_shadow:v1' as const;

export interface GoldTransmissionShadowDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export class GoldTransmissionShadowInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoldTransmissionShadowInvariantError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function malformed(message: string): never {
  throw new GoldTransmissionShadowInvariantError('MALFORMED_DB_RESPONSE', message);
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) malformed(`invalid ${field}`);
  return value as string;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') malformed(`invalid ${field}`);
  return value as boolean;
}
function count(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) malformed(`invalid ${field}`);
  return value as number;
}

export function canonicalStringifyGoldTransmission(value: unknown): string {
  if (value === undefined) throw new Error('undefined is not canonical JSON');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number is not canonical JSON');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringifyGoldTransmission).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('only plain objects are canonical JSON');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalStringifyGoldTransmission(record[key])}`).join(',')}}`;
  }
  throw new Error(`unsupported canonical JSON type ${typeof value}`);
}

export async function sha256GoldTransmission(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(domain: string, payload: Record<string, unknown>): Promise<string> {
  return sha256GoldTransmission(canonicalStringifyGoldTransmission({ domain, payload }));
}

interface EventVersionRow {
  readonly id: unknown;
  readonly cluster_id: unknown;
  readonly version_number: unknown;
  readonly transition_type: unknown;
  readonly knowledge_cutoff: unknown;
  readonly effective_time: unknown;
  readonly effective_time_precision: unknown;
  readonly canonical_event_state_schema_version: unknown;
  readonly canonical_event_state: unknown;
  readonly official_confirmation_state: unknown;
  readonly source_independence_state: unknown;
  readonly supersedes_version_id: unknown;
  readonly state_fingerprint: unknown;
}
const EVENT_VERSION_SELECT = [
  'id', 'cluster_id', 'version_number', 'transition_type', 'knowledge_cutoff',
  'effective_time', 'effective_time_precision', 'canonical_event_state_schema_version',
  'canonical_event_state', 'official_confirmation_state', 'source_independence_state',
  'supersedes_version_id', 'state_fingerprint',
].join(',');

function mapEventVersion(row: EventVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    versionNumber: row.version_number,
    transitionType: row.transition_type,
    knowledgeCutoff: row.knowledge_cutoff,
    effectiveTime: row.effective_time,
    effectiveTimePrecision: row.effective_time_precision,
    canonicalEventStateSchemaVersion: row.canonical_event_state_schema_version,
    canonicalEventState: row.canonical_event_state,
    officialConfirmationState: row.official_confirmation_state,
    sourceIndependenceState: row.source_independence_state,
    supersedesVersionId: row.supersedes_version_id,
    stateFingerprint: row.state_fingerprint,
  };
}

async function fetchEventVersion(
  db: GoldTransmissionShadowDb,
  requestedId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.request<EventVersionRow[]>(
    'GET',
    `event_versions?id=eq.${encodeURIComponent(requestedId)}&select=${EVENT_VERSION_SELECT}`,
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new GoldTransmissionShadowInvariantError(
      'EVENT_VERSION_ROW_COUNT_INVARIANT', `expected one Event Version, got ${rows.length}`,
    );
  }
  const persistedId = uuid(rows[0].id, 'event_versions.id');
  if (persistedId.toLowerCase() !== requestedId.toLowerCase()) {
    throw new GoldTransmissionShadowInvariantError(
      'EVENT_VERSION_IDENTITY_MISMATCH', 'requested and persisted Event Version ids differ',
    );
  }
  return mapEventVersion(rows[0]);
}

type SupportedPlan = GoldTransmissionProcessPlan & {
  readonly assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
  readonly paths: readonly [];
};

export function assertSupportedGoldTransmissionPlan(
  plan: GoldTransmissionProcessPlan,
  eventVersion: Record<string, unknown>,
): asserts plan is SupportedPlan {
  if ((plan.assessmentStatus !== 'INSUFFICIENT_EVIDENCE'
      && plan.assessmentStatus !== 'UNAVAILABLE') || plan.paths.length !== 0) {
    throw new GoldTransmissionShadowInvariantError(
      'UNSUPPORTED_PROCESSOR_PLAN_SHAPE', 'GT-4 V1 only persists zero-path fail-closed plans',
    );
  }
  if (plan.processorVersion !== GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION
      || plan.algorithmVersion !== GOLD_TRANSMISSION_DETERMINISTIC_PROCESSOR_VERSION
      || plan.producerType !== 'DETERMINISTIC') {
    throw new GoldTransmissionShadowInvariantError(
      'UNSUPPORTED_PROCESSOR_PLAN_SHAPE', 'processor provenance differs from reviewed V1',
    );
  }
  if (plan.eventVersionId !== eventVersion.id
      || plan.knowledgeCutoff !== eventVersion.knowledgeCutoff) {
    throw new GoldTransmissionShadowInvariantError(
      'PROCESSOR_INPUT_IDENTITY_MISMATCH', 'processor changed Event Version identity or cutoff',
    );
  }
}

interface Fingerprints { readonly input: string; readonly semantic: string; readonly idempotency: string }
async function computeFingerprints(
  eventVersion: Record<string, unknown>,
  plan: GoldTransmissionProcessPlan,
): Promise<Fingerprints> {
  const input = await fingerprint('xau_v2:gold_transmission_input:v1', { eventVersion });
  const semantic = await fingerprint('xau_v2:gold_transmission_semantic:v1', {
    assessmentStatus: plan.assessmentStatus,
    assessmentReason: plan.assessmentReason,
    paths: [...plan.paths],
  });
  const idempotency = await fingerprint('xau_v2:gold_transmission_idempotency:v1', {
    eventVersionId: plan.eventVersionId,
    assessmentStatus: plan.assessmentStatus,
    assessmentReason: plan.assessmentReason,
    knowledgeCutoff: plan.knowledgeCutoff,
    producerType: plan.producerType,
    producerActor: GOLD_TRANSMISSION_SHADOW_PRODUCER_ACTOR,
    algorithmVersion: plan.algorithmVersion,
    inputFingerprint: input,
    semanticFingerprint: semantic,
    paths: [...plan.paths],
    supersedesAssessmentId: null,
  });
  if (![input, semantic, idempotency].every((value) => SHA256_PATTERN.test(value))) {
    throw new GoldTransmissionShadowInvariantError('FINGERPRINT_INVARIANT', 'invalid SHA-256');
  }
  return { input, semantic, idempotency };
}

interface RpcRow {
  readonly assessment_id: unknown;
  readonly replayed: unknown;
  readonly path_count: unknown;
  readonly evidence_count: unknown;
}
interface AssessmentRow {
  readonly id: unknown;
  readonly event_version_id: unknown;
  readonly assessment_status: unknown;
  readonly assessment_reason: unknown;
  readonly knowledge_cutoff: unknown;
  readonly producer_type: unknown;
  readonly producer_actor: unknown;
  readonly algorithm_version: unknown;
  readonly input_fingerprint: unknown;
  readonly semantic_fingerprint: unknown;
  readonly idempotency_fingerprint: unknown;
  readonly supersedes_assessment_id: unknown;
}
const ASSESSMENT_SELECT = [
  'id', 'event_version_id', 'assessment_status', 'assessment_reason', 'knowledge_cutoff',
  'producer_type', 'producer_actor', 'algorithm_version', 'input_fingerprint',
  'semantic_fingerprint', 'idempotency_fingerprint', 'supersedes_assessment_id',
].join(',');

function same(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new GoldTransmissionShadowInvariantError(
      'PERSISTED_ASSESSMENT_MISMATCH', `${field} differs from requested value`,
    );
  }
}

async function verifyReadBack(
  db: GoldTransmissionShadowDb,
  assessmentId: string,
  plan: GoldTransmissionProcessPlan,
  hashes: Fingerprints,
): Promise<void> {
  const rows = await db.request<AssessmentRow[]>('GET',
    `gold_transmission_assessments?id=eq.${encodeURIComponent(assessmentId)}&select=${ASSESSMENT_SELECT}`);
  if (rows.length !== 1) {
    throw new GoldTransmissionShadowInvariantError(
      'ASSESSMENT_READBACK_ROW_COUNT_INVARIANT', `expected one assessment, got ${rows.length}`,
    );
  }
  const row = rows[0];
  same(row.id, assessmentId, 'id');
  same(row.event_version_id, plan.eventVersionId, 'event_version_id');
  same(row.assessment_status, plan.assessmentStatus, 'assessment_status');
  same(row.assessment_reason, plan.assessmentReason, 'assessment_reason');
  same(row.knowledge_cutoff, plan.knowledgeCutoff, 'knowledge_cutoff');
  same(row.producer_type, plan.producerType, 'producer_type');
  same(row.producer_actor, GOLD_TRANSMISSION_SHADOW_PRODUCER_ACTOR, 'producer_actor');
  same(row.algorithm_version, plan.algorithmVersion, 'algorithm_version');
  same(row.input_fingerprint, hashes.input, 'input_fingerprint');
  same(row.semantic_fingerprint, hashes.semantic, 'semantic_fingerprint');
  same(row.idempotency_fingerprint, hashes.idempotency, 'idempotency_fingerprint');
  same(row.supersedes_assessment_id, null, 'supersedes_assessment_id');
  const paths = await db.request<Array<{ readonly id: unknown }>>(
    'GET', `gold_transmission_paths?assessment_id=eq.${encodeURIComponent(assessmentId)}&select=id&limit=1`,
  );
  if (paths.length !== 0) {
    throw new GoldTransmissionShadowInvariantError(
      'UNEXPECTED_PERSISTED_PATHS', 'zero-path plan persisted at least one path',
    );
  }
}

interface PersistenceOutcome {
  readonly assessmentId: string;
  readonly replayed: boolean;
  readonly hashes: Fingerprints;
}
async function persist(
  db: GoldTransmissionShadowDb,
  eventVersion: Record<string, unknown>,
  plan: GoldTransmissionProcessPlan,
): Promise<PersistenceOutcome> {
  const hashes = await computeFingerprints(eventVersion, plan);
  const rows = await db.request<RpcRow[]>('POST', 'rpc/fn_gold_transmission_create_assessment', {
    p_event_version_id: plan.eventVersionId,
    p_assessment_status: plan.assessmentStatus,
    p_assessment_reason: plan.assessmentReason,
    p_knowledge_cutoff: plan.knowledgeCutoff,
    p_producer_type: plan.producerType,
    p_producer_actor: GOLD_TRANSMISSION_SHADOW_PRODUCER_ACTOR,
    p_algorithm_version: plan.algorithmVersion,
    p_input_fingerprint: hashes.input,
    p_semantic_fingerprint: hashes.semantic,
    p_idempotency_fingerprint: hashes.idempotency,
    p_paths: [...plan.paths],
    p_supersedes_assessment_id: null,
  });
  if (rows.length !== 1) {
    throw new GoldTransmissionShadowInvariantError(
      'ASSESSMENT_RPC_ROW_COUNT_INVARIANT', `RPC returned ${rows.length} rows`,
    );
  }
  const assessmentId = uuid(rows[0].assessment_id, 'assessment_id');
  const replayed = bool(rows[0].replayed, 'replayed');
  if (count(rows[0].path_count, 'path_count') !== 0
      || count(rows[0].evidence_count, 'evidence_count') !== 0) {
    throw new GoldTransmissionShadowInvariantError(
      'ASSESSMENT_RPC_COUNT_MISMATCH', 'zero-path plan returned non-zero child counts',
    );
  }
  await verifyReadBack(db, assessmentId, plan, hashes);
  return { assessmentId, replayed, hashes };
}

export type GoldTransmissionShadowResult =
  | {
    readonly kind: 'PROCESSED';
    readonly eventVersionId: string;
    readonly assessmentId: string;
    readonly processorVersion: string;
    readonly orchestratorVersion: string;
    readonly assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
    readonly assessmentReason: string;
    readonly assessmentReplayed: boolean;
    readonly pathCount: 0;
    readonly evidenceCount: 0;
    readonly knowledgeCutoff: string;
    readonly inputFingerprint: string;
    readonly semanticFingerprint: string;
    readonly idempotencyFingerprint: string;
  }
  | {
    readonly kind: 'ABSTAINED';
    readonly requestedEventVersionId: string;
    readonly eventVersionId: string | null;
    readonly processorVersion: string;
    readonly abstention: string;
    readonly reason: string;
  }
  | { readonly kind: 'SKIPPED'; readonly eventVersionId: string; readonly reason: 'EVENT_VERSION_NOT_FOUND' };

export async function processGoldTransmissionShadowVersion(
  db: GoldTransmissionShadowDb,
  eventVersionId: string,
): Promise<GoldTransmissionShadowResult> {
  if (typeof eventVersionId !== 'string' || !UUID_PATTERN.test(eventVersionId)) {
    throw new GoldTransmissionShadowInvariantError(
      'INVALID_EVENT_VERSION_ID', 'eventVersionId must be UUID-like',
    );
  }
  const eventVersion = await fetchEventVersion(db, eventVersionId);
  if (eventVersion === null) {
    return { kind: 'SKIPPED', eventVersionId, reason: 'EVENT_VERSION_NOT_FOUND' };
  }
  const plan = planDeterministicGoldTransmission({ eventVersion });
  if (plan.kind === 'ABSTAIN') {
    return {
      kind: 'ABSTAINED', requestedEventVersionId: eventVersionId,
      eventVersionId: plan.eventVersionId, processorVersion: plan.processorVersion,
      abstention: plan.abstention, reason: plan.reason,
    };
  }
  assertSupportedGoldTransmissionPlan(plan, eventVersion);
  const saved = await persist(db, eventVersion, plan);
  return {
    kind: 'PROCESSED', eventVersionId: plan.eventVersionId,
    assessmentId: saved.assessmentId, processorVersion: plan.processorVersion,
    orchestratorVersion: GOLD_TRANSMISSION_SHADOW_ORCHESTRATOR_VERSION,
    assessmentStatus: plan.assessmentStatus, assessmentReason: plan.assessmentReason,
    assessmentReplayed: saved.replayed, pathCount: 0, evidenceCount: 0,
    knowledgeCutoff: plan.knowledgeCutoff, inputFingerprint: saved.hashes.input,
    semanticFingerprint: saved.hashes.semantic, idempotencyFingerprint: saved.hashes.idempotency,
  };
}
