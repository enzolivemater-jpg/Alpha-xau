/** EF-9 strict application boundary for the EF-8 atomic BLS CPI RPC. */
import type { BlsCpiProducerPlan } from './bls_cpi_producer_planner.js';

export const BLS_CPI_PRODUCTION_WRITER_VERSION = 'bls-cpi-production-writer-v1' as const;

export interface BlsCpiProductionWriterDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface BlsCpiProductionWriterInput {
  readonly observationId: string;
  readonly headerArtifactId: string;
  readonly tableArtifactId: string;
  readonly operationIdempotencyFingerprint: string;
  readonly plan: Extract<BlsCpiProducerPlan, { readonly kind: 'READY' }>;
}

export interface BlsCpiProductionResult {
  readonly kind: 'PERSISTED';
  readonly writerVersion: typeof BLS_CPI_PRODUCTION_WRITER_VERSION;
  readonly clusterId: string;
  readonly decisionId: string;
  readonly identityClaimId: string;
  readonly eventVersionId: string;
  readonly versionOutcome: 'CREATED' | 'NO_MATERIAL_CHANGE';
  readonly operationReplayed: boolean;
}

export class BlsCpiProductionWriterError extends Error {
  readonly code: 'PRODUCTION_INPUT_INVALID' | 'PRODUCTION_RPC_UNAVAILABLE' | 'PRODUCTION_RESPONSE_MALFORMED';
  constructor(code: BlsCpiProductionWriterError['code'], message: string) {
    super(message);
    this.name = 'BlsCpiProductionWriterError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INPUT_KEYS = ['headerArtifactId', 'observationId', 'operationIdempotencyFingerprint', 'plan', 'tableArtifactId'] as const;
const PLAN_KEYS = ['adapterVersion', 'canonicalEventState', 'canonicalEventStateSchemaVersion', 'identity', 'kind', 'parserVersion', 'plannerVersion'] as const;
const IDENTITY_KEYS = ['authorityNamespace', 'candidateClusterIds', 'identityType', 'identityValue'] as const;
const RESPONSE_KEYS = ['cluster_id', 'decision_id', 'event_version_id', 'identity_claim_id', 'operation_replayed', 'version_outcome'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isReadyPlan(value: unknown): value is Extract<BlsCpiProducerPlan, { readonly kind: 'READY' }> {
  if (!isRecord(value) || !hasExactKeys(value, PLAN_KEYS)
      || value.kind !== 'READY'
      || value.plannerVersion !== 'bls-cpi-producer-planner-v1'
      || value.parserVersion !== 'bls-cpi-artifact-parser-v1'
      || value.adapterVersion !== 'bls-cpi-event-facts-adapter-v1'
      || value.canonicalEventStateSchemaVersion !== 2
      || !isJsonValue(value.canonicalEventState)
      || !isRecord(value.identity) || !hasExactKeys(value.identity, IDENTITY_KEYS)) return false;
  const identity = value.identity;
  return identity.authorityNamespace === 'xau_v2:official_release:us_bls:v1'
    && identity.identityType === 'official_release_id:bls_cpi_v1'
    && typeof identity.identityValue === 'string'
    && identity.identityValue.length > 0
    && identity.identityValue.trim() === identity.identityValue
    && Array.isArray(identity.candidateClusterIds)
    && identity.candidateClusterIds.length <= 1
    && identity.candidateClusterIds.every(candidate => typeof candidate === 'string' && UUID.test(candidate));
}

function validateInput(value: unknown): value is BlsCpiProductionWriterInput {
  return isRecord(value)
    && hasExactKeys(value, INPUT_KEYS)
    && typeof value.observationId === 'string' && UUID.test(value.observationId)
    && typeof value.headerArtifactId === 'string' && UUID.test(value.headerArtifactId)
    && typeof value.tableArtifactId === 'string' && UUID.test(value.tableArtifactId)
    && value.headerArtifactId !== value.tableArtifactId
    && typeof value.operationIdempotencyFingerprint === 'string'
    && SHA256.test(value.operationIdempotencyFingerprint)
    && isReadyPlan(value.plan);
}

export async function persistBlsCpiProduction(
  db: BlsCpiProductionWriterDb,
  input: unknown,
): Promise<BlsCpiProductionResult> {
  if (!validateInput(input)) {
    throw new BlsCpiProductionWriterError('PRODUCTION_INPUT_INVALID', 'BLS CPI production input is invalid.');
  }

  let response: unknown;
  try {
    response = await db.request<unknown>('POST', '/rpc/fn_event_fact_produce_bls_cpi', {
      p_observation_id: input.observationId,
      p_header_artifact_id: input.headerArtifactId,
      p_table_artifact_id: input.tableArtifactId,
      p_authority_namespace: input.plan.identity.authorityNamespace,
      p_identity_type: input.plan.identity.identityType,
      p_identity_value: input.plan.identity.identityValue,
      p_canonical_event_state: input.plan.canonicalEventState,
      p_operation_idempotency_fingerprint: input.operationIdempotencyFingerprint,
    });
  } catch {
    throw new BlsCpiProductionWriterError('PRODUCTION_RPC_UNAVAILABLE', 'Atomic BLS CPI production failed.');
  }

  if (!Array.isArray(response) || response.length !== 1 || !isRecord(response[0])
      || !hasExactKeys(response[0], RESPONSE_KEYS)) {
    throw new BlsCpiProductionWriterError('PRODUCTION_RESPONSE_MALFORMED', 'Atomic BLS CPI production returned an invalid response.');
  }
  const row = response[0];
  if (typeof row.cluster_id !== 'string' || !UUID.test(row.cluster_id)
      || typeof row.decision_id !== 'string' || !UUID.test(row.decision_id)
      || typeof row.identity_claim_id !== 'string' || !UUID.test(row.identity_claim_id)
      || typeof row.event_version_id !== 'string' || !UUID.test(row.event_version_id)
      || (row.version_outcome !== 'CREATED' && row.version_outcome !== 'NO_MATERIAL_CHANGE')
      || typeof row.operation_replayed !== 'boolean') {
    throw new BlsCpiProductionWriterError('PRODUCTION_RESPONSE_MALFORMED', 'Atomic BLS CPI production returned an invalid response.');
  }

  return {
    kind: 'PERSISTED',
    writerVersion: BLS_CPI_PRODUCTION_WRITER_VERSION,
    clusterId: row.cluster_id,
    decisionId: row.decision_id,
    identityClaimId: row.identity_claim_id,
    eventVersionId: row.event_version_id,
    versionOutcome: row.version_outcome,
    operationReplayed: row.operation_replayed,
  };
}
