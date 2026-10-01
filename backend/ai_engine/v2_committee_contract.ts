/** C-0: provider/cost/dependency gate for the XAU V2 AI Committee. */

import {
  HORIZON_ALGORITHM_VERSION,
  HORIZON_SCHEMA_VERSION,
  HORIZONS,
  type Horizon,
} from '../horizon_engine/contract.js';

export const COMMITTEE_V2_SCHEMA_VERSION = 'xau.ai-committee-gate.v1' as const;
export const COMMITTEE_V2_ALGORITHM_VERSION = 'ai-committee-dependency-gate-1.0.0' as const;

export type CommitteeGateReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'HORIZON_VERSION_MISMATCH'
  | 'HORIZON_CUTOFF_MISMATCH'
  | 'HORIZON_SET_MISMATCH'
  | 'HORIZON_NOT_READY'
  | 'PROVIDER_NOT_AUTHORIZED'
  | 'COST_NOT_AUTHORIZED'
  | 'COMMITTEE_V2_METHOD_NOT_APPROVED';

export interface CommitteeGateInput {
  readonly horizonSynthesis: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: string;
    readonly knowledgeCutoff: string;
    readonly scenarios: ReadonlyArray<{
      readonly horizon: string;
      readonly status: string;
    }>;
  };
  readonly providerAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
  readonly costAuthorization: 'AUTHORIZED' | 'UNAUTHORIZED';
}

export interface CommitteeV2GateEnvelope {
  readonly schemaVersion: typeof COMMITTEE_V2_SCHEMA_VERSION;
  readonly algorithmVersion: typeof COMMITTEE_V2_ALGORITHM_VERSION;
  readonly state: 'ABSTAIN';
  readonly providerInvocation: 'FORBIDDEN';
  readonly legacyCommitteeOutputAccepted: false;
  readonly reasonCodes: readonly CommitteeGateReasonCode[];
  readonly knowledgeCutoff: string;
  readonly request: null;
  readonly response: null;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function hasExactHorizonSet(scenarios: CommitteeGateInput['horizonSynthesis']['scenarios']): boolean {
  if (scenarios.length !== HORIZONS.length) return false;
  return HORIZONS.every((horizon: Horizon, index) => scenarios[index]?.horizon === horizon);
}

/**
 * C-0 never constructs a provider request. A later C-1 contract must define
 * and prove positive invocation semantics after all Human Gates are closed.
 */
export function buildCommitteeV2Gate(
  input: CommitteeGateInput,
  knowledgeCutoff: string,
): CommitteeV2GateEnvelope {
  const reasons = new Set<CommitteeGateReasonCode>();

  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.horizonSynthesis.schemaVersion !== HORIZON_SCHEMA_VERSION
      || input.horizonSynthesis.algorithmVersion !== HORIZON_ALGORITHM_VERSION) {
    reasons.add('HORIZON_VERSION_MISMATCH');
  }
  if (input.horizonSynthesis.knowledgeCutoff !== knowledgeCutoff) {
    reasons.add('HORIZON_CUTOFF_MISMATCH');
  }
  if (!hasExactHorizonSet(input.horizonSynthesis.scenarios)) {
    reasons.add('HORIZON_SET_MISMATCH');
  }
  if (input.horizonSynthesis.state !== 'READY'
      || input.horizonSynthesis.scenarios.some((scenario) => scenario.status !== 'READY')) {
    reasons.add('HORIZON_NOT_READY');
  }
  if (input.providerAuthorization !== 'AUTHORIZED') reasons.add('PROVIDER_NOT_AUTHORIZED');
  if (input.costAuthorization !== 'AUTHORIZED') reasons.add('COST_NOT_AUTHORIZED');
  reasons.add('COMMITTEE_V2_METHOD_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF',
    'HORIZON_VERSION_MISMATCH',
    'HORIZON_CUTOFF_MISMATCH',
    'HORIZON_SET_MISMATCH',
    'HORIZON_NOT_READY',
    'PROVIDER_NOT_AUTHORIZED',
    'COST_NOT_AUTHORIZED',
    'COMMITTEE_V2_METHOD_NOT_APPROVED',
  ] satisfies readonly CommitteeGateReasonCode[];

  return {
    schemaVersion: COMMITTEE_V2_SCHEMA_VERSION,
    algorithmVersion: COMMITTEE_V2_ALGORITHM_VERSION,
    state: 'ABSTAIN',
    providerInvocation: 'FORBIDDEN',
    legacyCommitteeOutputAccepted: false,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    request: null,
    response: null,
  };
}
