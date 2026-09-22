/**
 * =============================================================================
 * ALPHA-XAU — PR-EI-4 controlled Event Impact shadow orchestrator (V1).
 *
 * Application/DB adapter between the pure deterministic Event Impact processor
 * and the already-live atomic persistence RPC. It handles exactly one caller-
 * supplied Event Version id. It never discovers work, scans a backlog, reads a
 * clock/environment variable, instantiates a Supabase client, or calls an LLM.
 *
 *   explicit event_version id
 *     -> exact Event Version read
 *     -> planDeterministicEventImpact (real PR-EI-3 processor)
 *     -> deterministic domain-separated fingerprints
 *     -> fn_event_impact_create_assessment (single atomic mutation RPC)
 *     -> exact parent/zero-child read-back
 *
 * V1 intentionally accepts only the two zero-interpretation plans the merged
 * processor can emit: INSUFFICIENT_EVIDENCE and UNAVAILABLE. Any future
 * ASSESSED/interpretation-producing processor requires a separately reviewed
 * orchestrator version rather than silently widening this write path.
 * =============================================================================
 */

import {
  EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION,
  planDeterministicEventImpact,
  type EventImpactProcessPlan,
} from './deterministic_processor.js';

export const EVENT_IMPACT_SHADOW_ORCHESTRATOR_VERSION =
  'event-impact-shadow-orchestrator-v1' as const;

export const EVENT_IMPACT_SHADOW_PRODUCER_ACTOR =
  'xau_v2:event_impact_shadow:v1' as const;

export interface EventImpactShadowDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export class EventImpactShadowInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventImpactShadowInvariantError';
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EventImpactShadowInvariantError(
      'MALFORMED_DB_RESPONSE',
      `expected UUID-like ${field}, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new EventImpactShadowInvariantError(
      'MALFORMED_DB_RESPONSE',
      `expected boolean ${field}, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function validateNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new EventImpactShadowInvariantError(
      'MALFORMED_DB_RESPONSE',
      `expected non-negative integer ${field}, got ${JSON.stringify(value)}.`,
    );
  }
  return value as number;
}

/** Canonical JSON for fingerprint inputs: sorted object keys, array order kept. */
export function canonicalStringifyEventImpact(value: unknown): string {
  if (value === undefined) {
    throw new Error('canonicalStringifyEventImpact: undefined is not allowed.');
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalStringifyEventImpact: only finite numbers are allowed.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringifyEventImpact(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonicalStringifyEventImpact: only plain objects are allowed.');
    }
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringifyEventImpact(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalStringifyEventImpact: unsupported type ${typeof value}.`);
}

export async function sha256EventImpact(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function domainFingerprint(domain: string, payload: Record<string, unknown>): Promise<string> {
  return sha256EventImpact(canonicalStringifyEventImpact({ domain, payload }));
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
  'id',
  'cluster_id',
  'version_number',
  'transition_type',
  'knowledge_cutoff',
  'effective_time',
  'effective_time_precision',
  'canonical_event_state_schema_version',
  'canonical_event_state',
  'official_confirmation_state',
  'source_independence_state',
  'supersedes_version_id',
  'state_fingerprint',
].join(',');

function mapEventVersionRow(row: EventVersionRow): Record<string, unknown> {
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
  db: EventImpactShadowDb,
  requestedId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.request<EventVersionRow[]>(
    'GET',
    `event_versions?id=eq.${encodeURIComponent(requestedId)}&select=${EVENT_VERSION_SELECT}`,
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new EventImpactShadowInvariantError(
      'EVENT_VERSION_ROW_COUNT_INVARIANT',
      `expected exactly one event_versions row for id=${requestedId}, got ${rows.length}.`,
    );
  }

  const persistedId = validateUuid(rows[0].id, 'event_versions.id');
  if (persistedId.toLowerCase() !== requestedId.toLowerCase()) {
    throw new EventImpactShadowInvariantError(
      'EVENT_VERSION_IDENTITY_MISMATCH',
      `persisted event_versions.id=${persistedId} does not match requested id=${requestedId}.`,
    );
  }
  return mapEventVersionRow(rows[0]);
}

type SupportedEventImpactPlan = EventImpactProcessPlan & {
  readonly assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
  readonly interpretations: readonly [];
};

/** Fail closed if a later processor silently widens the PR-EI-4 write path. */
export function assertSupportedEventImpactPlan(
  plan: EventImpactProcessPlan,
  eventVersion: Record<string, unknown>,
): asserts plan is SupportedEventImpactPlan {
  const supportedStatus = plan.assessmentStatus === 'INSUFFICIENT_EVIDENCE'
    || plan.assessmentStatus === 'UNAVAILABLE';
  if (!supportedStatus || plan.interpretations.length !== 0) {
    throw new EventImpactShadowInvariantError(
      'UNSUPPORTED_PROCESSOR_PLAN_SHAPE',
      `PR-EI-4 V1 only persists INSUFFICIENT_EVIDENCE/UNAVAILABLE plans with zero interpretations; got status=${plan.assessmentStatus}, interpretations=${plan.interpretations.length}.`,
    );
  }
  if (
    plan.processorVersion !== EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION
    || plan.algorithmVersion !== EVENT_IMPACT_DETERMINISTIC_PROCESSOR_VERSION
    || plan.producerType !== 'DETERMINISTIC'
  ) {
    throw new EventImpactShadowInvariantError(
      'UNSUPPORTED_PROCESSOR_PLAN_SHAPE',
      'processor provenance does not match the reviewed deterministic V1 contract.',
    );
  }
  if (plan.eventVersionId !== eventVersion.id || plan.knowledgeCutoff !== eventVersion.knowledgeCutoff) {
    throw new EventImpactShadowInvariantError(
      'PROCESSOR_INPUT_IDENTITY_MISMATCH',
      'processor plan did not preserve the selected Event Version id and knowledge cutoff exactly.',
    );
  }
}

interface Fingerprints {
  readonly input: string;
  readonly semantic: string;
  readonly idempotency: string;
}

async function computeFingerprints(
  eventVersion: Record<string, unknown>,
  plan: EventImpactProcessPlan,
): Promise<Fingerprints> {
  const input = await domainFingerprint('xau_v2:event_impact_input:v1', { eventVersion });
  const semantic = await domainFingerprint('xau_v2:event_impact_semantic:v1', {
    assessmentStatus: plan.assessmentStatus,
    assessmentReason: plan.assessmentReason,
    interpretations: [...plan.interpretations],
  });
  const idempotency = await domainFingerprint('xau_v2:event_impact_idempotency:v1', {
    eventVersionId: plan.eventVersionId,
    assessmentStatus: plan.assessmentStatus,
    knowledgeCutoff: plan.knowledgeCutoff,
    producerType: plan.producerType,
    producerActor: EVENT_IMPACT_SHADOW_PRODUCER_ACTOR,
    algorithmVersion: plan.algorithmVersion,
    inputFingerprint: input,
    semanticFingerprint: semantic,
    interpretations: [...plan.interpretations],
    supersedesAssessmentId: null,
  });
  if (!SHA256_PATTERN.test(input)
      || !SHA256_PATTERN.test(semantic)
      || !SHA256_PATTERN.test(idempotency)) {
    throw new EventImpactShadowInvariantError(
      'FINGERPRINT_INVARIANT',
      'computed fingerprints must be lowercase SHA-256 hex.',
    );
  }
  return { input, semantic, idempotency };
}

interface AssessmentRpcRow {
  readonly assessment_id: unknown;
  readonly replayed: unknown;
  readonly interpretation_count: unknown;
}

interface AssessmentRow {
  readonly id: unknown;
  readonly event_version_id: unknown;
  readonly assessment_status: unknown;
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
  'id',
  'event_version_id',
  'assessment_status',
  'knowledge_cutoff',
  'producer_type',
  'producer_actor',
  'algorithm_version',
  'input_fingerprint',
  'semantic_fingerprint',
  'idempotency_fingerprint',
  'supersedes_assessment_id',
].join(',');

function assertPersistedField(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new EventImpactShadowInvariantError(
      'PERSISTED_ASSESSMENT_MISMATCH',
      `persisted ${field}=${JSON.stringify(actual)} does not match expected ${JSON.stringify(expected)}.`,
    );
  }
}

async function verifyPersistenceReadBack(
  db: EventImpactShadowDb,
  assessmentId: string,
  plan: EventImpactProcessPlan,
  fingerprints: Fingerprints,
): Promise<void> {
  const rows = await db.request<AssessmentRow[]>(
    'GET',
    `event_impact_assessments?id=eq.${encodeURIComponent(assessmentId)}&select=${ASSESSMENT_SELECT}`,
  );
  if (rows.length !== 1) {
    throw new EventImpactShadowInvariantError(
      'ASSESSMENT_READBACK_ROW_COUNT_INVARIANT',
      `expected exactly one persisted assessment id=${assessmentId}, got ${rows.length}.`,
    );
  }
  const row = rows[0];
  assertPersistedField(row.id, assessmentId, 'id');
  assertPersistedField(row.event_version_id, plan.eventVersionId, 'event_version_id');
  assertPersistedField(row.assessment_status, plan.assessmentStatus, 'assessment_status');
  assertPersistedField(row.knowledge_cutoff, plan.knowledgeCutoff, 'knowledge_cutoff');
  assertPersistedField(row.producer_type, plan.producerType, 'producer_type');
  assertPersistedField(row.producer_actor, EVENT_IMPACT_SHADOW_PRODUCER_ACTOR, 'producer_actor');
  assertPersistedField(row.algorithm_version, plan.algorithmVersion, 'algorithm_version');
  assertPersistedField(row.input_fingerprint, fingerprints.input, 'input_fingerprint');
  assertPersistedField(row.semantic_fingerprint, fingerprints.semantic, 'semantic_fingerprint');
  assertPersistedField(row.idempotency_fingerprint, fingerprints.idempotency, 'idempotency_fingerprint');
  assertPersistedField(row.supersedes_assessment_id, null, 'supersedes_assessment_id');

  const childRows = await db.request<Array<{ readonly id: unknown }>>(
    'GET',
    `event_impact_interpretations?assessment_id=eq.${encodeURIComponent(assessmentId)}&select=id&limit=1`,
  );
  if (childRows.length !== 0) {
    throw new EventImpactShadowInvariantError(
      'UNEXPECTED_PERSISTED_INTERPRETATIONS',
      `zero-interpretation plan persisted at least one child for assessment id=${assessmentId}.`,
    );
  }
}

interface PersistenceOutcome {
  readonly assessmentId: string;
  readonly replayed: boolean;
  readonly interpretationCount: number;
  readonly fingerprints: Fingerprints;
}

async function persistPlan(
  db: EventImpactShadowDb,
  eventVersion: Record<string, unknown>,
  plan: EventImpactProcessPlan,
): Promise<PersistenceOutcome> {
  const fingerprints = await computeFingerprints(eventVersion, plan);
  const rows = await db.request<AssessmentRpcRow[]>(
    'POST',
    'rpc/fn_event_impact_create_assessment',
    {
      p_event_version_id: plan.eventVersionId,
      p_assessment_status: plan.assessmentStatus,
      p_knowledge_cutoff: plan.knowledgeCutoff,
      p_producer_type: plan.producerType,
      p_producer_actor: EVENT_IMPACT_SHADOW_PRODUCER_ACTOR,
      p_algorithm_version: plan.algorithmVersion,
      p_input_fingerprint: fingerprints.input,
      p_semantic_fingerprint: fingerprints.semantic,
      p_idempotency_fingerprint: fingerprints.idempotency,
      p_interpretations: [...plan.interpretations],
      p_supersedes_assessment_id: null,
    },
  );
  if (rows.length !== 1) {
    throw new EventImpactShadowInvariantError(
      'ASSESSMENT_RPC_ROW_COUNT_INVARIANT',
      `fn_event_impact_create_assessment returned ${rows.length} row(s), expected exactly one.`,
    );
  }

  const assessmentId = validateUuid(rows[0].assessment_id, 'assessment_id');
  const replayed = validateBoolean(rows[0].replayed, 'replayed');
  const interpretationCount = validateNonNegativeInteger(
    rows[0].interpretation_count,
    'interpretation_count',
  );
  if (interpretationCount !== plan.interpretations.length) {
    throw new EventImpactShadowInvariantError(
      'ASSESSMENT_RPC_COUNT_MISMATCH',
      `RPC interpretation_count=${interpretationCount}, expected ${plan.interpretations.length}.`,
    );
  }

  await verifyPersistenceReadBack(db, assessmentId, plan, fingerprints);
  return { assessmentId, replayed, interpretationCount, fingerprints };
}

export interface EventImpactShadowProcessedResult {
  readonly kind: 'PROCESSED';
  readonly eventVersionId: string;
  readonly assessmentId: string;
  readonly processorVersion: string;
  readonly orchestratorVersion: string;
  readonly assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
  readonly assessmentReason: string;
  readonly assessmentReplayed: boolean;
  readonly interpretationCount: 0;
  readonly knowledgeCutoff: string;
  readonly inputFingerprint: string;
  readonly semanticFingerprint: string;
  readonly idempotencyFingerprint: string;
}

export interface EventImpactShadowAbstainedResult {
  readonly kind: 'ABSTAINED';
  readonly requestedEventVersionId: string;
  readonly eventVersionId: string | null;
  readonly processorVersion: string;
  readonly abstention: string;
  readonly reason: string;
}

export interface EventImpactShadowSkippedResult {
  readonly kind: 'SKIPPED';
  readonly eventVersionId: string;
  readonly reason: 'EVENT_VERSION_NOT_FOUND';
}

export type EventImpactShadowResult =
  | EventImpactShadowProcessedResult
  | EventImpactShadowAbstainedResult
  | EventImpactShadowSkippedResult;

/** Process exactly one explicit Event Version. No discovery or implicit retry. */
export async function processEventImpactShadowVersion(
  db: EventImpactShadowDb,
  eventVersionId: string,
): Promise<EventImpactShadowResult> {
  if (typeof eventVersionId !== 'string' || !UUID_PATTERN.test(eventVersionId)) {
    throw new EventImpactShadowInvariantError(
      'INVALID_EVENT_VERSION_ID',
      `eventVersionId must be a UUID-like string, got ${JSON.stringify(eventVersionId)}.`,
    );
  }

  const eventVersion = await fetchEventVersion(db, eventVersionId);
  if (eventVersion === null) {
    return { kind: 'SKIPPED', eventVersionId, reason: 'EVENT_VERSION_NOT_FOUND' };
  }

  const plan = planDeterministicEventImpact({ eventVersion });
  if (plan.kind === 'ABSTAIN') {
    return {
      kind: 'ABSTAINED',
      requestedEventVersionId: eventVersionId,
      eventVersionId: plan.eventVersionId,
      processorVersion: plan.processorVersion,
      abstention: plan.abstention,
      reason: plan.reason,
    };
  }

  assertSupportedEventImpactPlan(plan, eventVersion);
  const persisted = await persistPlan(db, eventVersion, plan);

  return {
    kind: 'PROCESSED',
    eventVersionId: plan.eventVersionId,
    assessmentId: persisted.assessmentId,
    processorVersion: plan.processorVersion,
    orchestratorVersion: EVENT_IMPACT_SHADOW_ORCHESTRATOR_VERSION,
    assessmentStatus: plan.assessmentStatus,
    assessmentReason: plan.assessmentReason,
    assessmentReplayed: persisted.replayed,
    interpretationCount: 0,
    knowledgeCutoff: plan.knowledgeCutoff,
    inputFingerprint: persisted.fingerprints.input,
    semanticFingerprint: persisted.fingerprints.semantic,
    idempotencyFingerprint: persisted.fingerprints.idempotency,
  };
}
