/** EF-7 bounded, non-mutating BLS CPI producer planner. */
import type {
  BlsCpiAdapterResult,
  BlsCpiCanonicalEventStateV2,
  BlsCpiStructuredPayloadV1,
  ReleaseIdentityProposal,
} from './bls_cpi_adapter.js';
import type {
  BlsCpiArtifactParserInput,
  BlsCpiArtifactParserResult,
} from './bls_cpi_artifact_parser.js';
import type { StrongIdentityContext } from '../event_engine/deterministic_processor.js';

export const BLS_CPI_PRODUCER_PLANNER_VERSION = 'bls-cpi-producer-planner-v1' as const;

export interface BlsCpiProducerPlannerDependencies {
  readonly parse: (input: BlsCpiArtifactParserInput) => BlsCpiArtifactParserResult;
  readonly adapt: (payload: BlsCpiStructuredPayloadV1) => BlsCpiAdapterResult;
  readonly lookupIdentity: (proposal: ReleaseIdentityProposal) => Promise<StrongIdentityContext>;
}

export type BlsCpiProducerPlan =
  | {
      readonly kind: 'READY';
      readonly plannerVersion: typeof BLS_CPI_PRODUCER_PLANNER_VERSION;
      readonly parserVersion: 'bls-cpi-artifact-parser-v1';
      readonly adapterVersion: 'bls-cpi-event-facts-adapter-v1';
      readonly canonicalEventStateSchemaVersion: 2;
      readonly canonicalEventState: BlsCpiCanonicalEventStateV2;
      readonly identity: {
        readonly authorityNamespace: 'xau_v2:official_release:us_bls:v1';
        readonly identityType: 'official_release_id:bls_cpi_v1';
        readonly identityValue: string;
        readonly candidateClusterIds: readonly string[];
      };
    }
  | {
      readonly kind: 'BLOCKED';
      readonly plannerVersion: typeof BLS_CPI_PRODUCER_PLANNER_VERSION;
      readonly stage: 'PARSER' | 'ADAPTER' | 'IDENTITY_LOOKUP';
      readonly reason: string;
    };

export async function planBlsCpiProduction(
  dependencies: BlsCpiProducerPlannerDependencies,
  input: BlsCpiArtifactParserInput,
): Promise<BlsCpiProducerPlan> {
  const parsed = dependencies.parse(input);
  if (parsed.kind !== 'PARSED') {
    return {
      kind: 'BLOCKED', plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
      stage: 'PARSER', reason: `${parsed.kind}:${parsed.reason}`,
    };
  }

  const adapted = dependencies.adapt(parsed.payload);
  if (adapted.kind !== 'RESOLVED') {
    return {
      kind: 'BLOCKED', plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
      stage: 'ADAPTER', reason: `${adapted.kind}:${adapted.reason}`,
    };
  }

  try {
    const identity = await dependencies.lookupIdentity(adapted.releaseIdentity);
    if (identity.kind !== 'CURATED_STRONG_IDENTITY') {
      return {
        kind: 'BLOCKED', plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
        stage: 'IDENTITY_LOOKUP', reason: 'IDENTITY_LOOKUP_MALFORMED',
      };
    }
    return {
      kind: 'READY',
      plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
      parserVersion: parsed.parserVersion,
      adapterVersion: adapted.adapterVersion,
      canonicalEventStateSchemaVersion: adapted.canonicalEventStateSchemaVersion,
      canonicalEventState: adapted.canonicalEventState,
      identity: {
        authorityNamespace: adapted.releaseIdentity.authorityNamespace,
        identityType: adapted.releaseIdentity.identityType,
        identityValue: adapted.releaseIdentity.identityValue,
        candidateClusterIds: identity.candidateClusterIds,
      },
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : null;
    const reason = typeof code === 'string' && /^IDENTITY_[A-Z_]+$/.test(code)
      ? code : 'IDENTITY_LOOKUP_UNEXPECTED';
    return {
      kind: 'BLOCKED', plannerVersion: BLS_CPI_PRODUCER_PLANNER_VERSION,
      stage: 'IDENTITY_LOOKUP', reason,
    };
  }
}
