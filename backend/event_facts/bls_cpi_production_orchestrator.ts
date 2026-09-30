/** EF-10 one-shot composition of EF-7 planning and EF-9 atomic persistence. */
import type { BlsCpiArtifactParserInput } from './bls_cpi_artifact_parser.js';
import type {
  BlsCpiProducerPlan,
  BlsCpiProducerPlannerDependencies,
} from './bls_cpi_producer_planner.js';
import type {
  BlsCpiProductionResult,
  BlsCpiProductionWriterDb,
  BlsCpiProductionWriterInput,
} from './bls_cpi_production_writer.js';

export const BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION = 'bls-cpi-production-orchestrator-v1' as const;

export interface BlsCpiProductionOrchestratorDependencies extends BlsCpiProducerPlannerDependencies {
  readonly db: BlsCpiProductionWriterDb;
  readonly plan: (
    dependencies: BlsCpiProducerPlannerDependencies,
    input: BlsCpiArtifactParserInput,
  ) => Promise<BlsCpiProducerPlan>;
  readonly persist: (
    db: BlsCpiProductionWriterDb,
    input: BlsCpiProductionWriterInput,
  ) => Promise<BlsCpiProductionResult>;
}

export interface BlsCpiProductionOrchestratorInput {
  readonly artifacts: BlsCpiArtifactParserInput;
  readonly observationId: string;
  readonly headerArtifactId: string;
  readonly tableArtifactId: string;
  readonly operationIdempotencyFingerprint: string;
}

export type BlsCpiProductionOrchestratorResult =
  | {
      readonly kind: 'PERSISTED';
      readonly orchestratorVersion: typeof BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION;
      readonly plannerVersion: 'bls-cpi-producer-planner-v1';
      readonly writerVersion: 'bls-cpi-production-writer-v1';
      readonly clusterId: string;
      readonly decisionId: string;
      readonly identityClaimId: string;
      readonly eventVersionId: string;
      readonly versionOutcome: 'CREATED' | 'NO_MATERIAL_CHANGE';
      readonly operationReplayed: boolean;
    }
  | {
      readonly kind: 'BLOCKED';
      readonly orchestratorVersion: typeof BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION;
      readonly stage: 'PARSER' | 'ADAPTER' | 'IDENTITY_LOOKUP' | 'PLANNING' | 'PERSISTENCE';
      readonly reason: string;
    };

export async function runBlsCpiProductionOnce(
  dependencies: BlsCpiProductionOrchestratorDependencies,
  input: BlsCpiProductionOrchestratorInput,
): Promise<BlsCpiProductionOrchestratorResult> {
  let plan;
  try {
    plan = await dependencies.plan(dependencies, input.artifacts);
  } catch {
    return {
      kind: 'BLOCKED',
      orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
      stage: 'PLANNING',
      reason: 'PLANNING_UNEXPECTED',
    };
  }
  if (plan.kind === 'BLOCKED') {
    return {
      kind: 'BLOCKED',
      orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
      stage: plan.stage,
      reason: plan.reason,
    };
  }

  try {
    const persisted = await dependencies.persist(dependencies.db, {
      observationId: input.observationId,
      headerArtifactId: input.headerArtifactId,
      tableArtifactId: input.tableArtifactId,
      operationIdempotencyFingerprint: input.operationIdempotencyFingerprint,
      plan,
    });
    return {
      kind: 'PERSISTED',
      orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
      plannerVersion: plan.plannerVersion,
      writerVersion: persisted.writerVersion,
      clusterId: persisted.clusterId,
      decisionId: persisted.decisionId,
      identityClaimId: persisted.identityClaimId,
      eventVersionId: persisted.eventVersionId,
      versionOutcome: persisted.versionOutcome,
      operationReplayed: persisted.operationReplayed,
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code : null;
    const reason = code === 'PRODUCTION_INPUT_INVALID'
      || code === 'PRODUCTION_RPC_UNAVAILABLE'
      || code === 'PRODUCTION_RESPONSE_MALFORMED'
      ? code : 'PRODUCTION_UNEXPECTED';
    return {
      kind: 'BLOCKED',
      orchestratorVersion: BLS_CPI_PRODUCTION_ORCHESTRATOR_VERSION,
      stage: 'PERSISTENCE',
      reason,
    };
  }
}
