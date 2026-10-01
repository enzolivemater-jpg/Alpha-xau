/** PMR-0: provider-independent evidence/risk gate before Portfolio Manager. */

import {
  COMMITTEE_V2_ALGORITHM_VERSION,
  COMMITTEE_V2_SCHEMA_VERSION,
} from '../ai_engine/v2_committee_contract.js';

export const PRE_PM_SCHEMA_VERSION = 'xau.pre-pm-evidence-risk.v1' as const;
export const PRE_PM_ALGORITHM_VERSION = 'pre-pm-dependency-gate-1.0.0' as const;

export type PrePmReasonCode =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'COMMITTEE_VERSION_MISMATCH'
  | 'COMMITTEE_CUTOFF_MISMATCH'
  | 'COMMITTEE_NOT_READY'
  | 'COMMITTEE_PROVIDER_NOT_COMPLETED'
  | 'EVIDENCE_GRAPH_UNAVAILABLE'
  | 'PRE_PM_METHOD_NOT_APPROVED';

export interface PrePmContractInput {
  readonly committee: {
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly state: string;
    readonly providerInvocation: string;
    readonly knowledgeCutoff: string;
  };
  readonly evidenceGraph: {
    readonly schemaVersion: string | null;
    readonly complete: boolean;
    readonly nodeCount: number;
  };
}

export interface PrePmEnvelope {
  readonly schemaVersion: typeof PRE_PM_SCHEMA_VERSION;
  readonly algorithmVersion: typeof PRE_PM_ALGORITHM_VERSION;
  readonly state: 'ABSTAIN';
  readonly portfolioManagerEligibility: 'BLOCKED';
  readonly evidenceAcceptance: 'UNAVAILABLE';
  readonly riskVerdict: null;
  readonly confidence: null;
  readonly reasonCodes: readonly PrePmReasonCode[];
  readonly knowledgeCutoff: string;
  readonly portfolioManagerInput: null;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** PMR-0 never constructs Portfolio Manager input or an inferred risk verdict. */
export function buildPrePmEvidenceRiskGate(
  input: PrePmContractInput,
  knowledgeCutoff: string,
): PrePmEnvelope {
  const reasons = new Set<PrePmReasonCode>();
  if (!TIMESTAMP.test(knowledgeCutoff) || !Number.isFinite(Date.parse(knowledgeCutoff))) {
    reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  }
  if (input.committee.schemaVersion !== COMMITTEE_V2_SCHEMA_VERSION
      || input.committee.algorithmVersion !== COMMITTEE_V2_ALGORITHM_VERSION) {
    reasons.add('COMMITTEE_VERSION_MISMATCH');
  }
  if (input.committee.knowledgeCutoff !== knowledgeCutoff) {
    reasons.add('COMMITTEE_CUTOFF_MISMATCH');
  }
  if (input.committee.state !== 'READY') reasons.add('COMMITTEE_NOT_READY');
  if (input.committee.providerInvocation !== 'COMPLETED') {
    reasons.add('COMMITTEE_PROVIDER_NOT_COMPLETED');
  }
  if (input.evidenceGraph.schemaVersion === null
      || !input.evidenceGraph.complete
      || !Number.isSafeInteger(input.evidenceGraph.nodeCount)
      || input.evidenceGraph.nodeCount <= 0) {
    reasons.add('EVIDENCE_GRAPH_UNAVAILABLE');
  }
  reasons.add('PRE_PM_METHOD_NOT_APPROVED');

  const ordered = [
    'INVALID_KNOWLEDGE_CUTOFF',
    'COMMITTEE_VERSION_MISMATCH',
    'COMMITTEE_CUTOFF_MISMATCH',
    'COMMITTEE_NOT_READY',
    'COMMITTEE_PROVIDER_NOT_COMPLETED',
    'EVIDENCE_GRAPH_UNAVAILABLE',
    'PRE_PM_METHOD_NOT_APPROVED',
  ] satisfies readonly PrePmReasonCode[];

  return {
    schemaVersion: PRE_PM_SCHEMA_VERSION,
    algorithmVersion: PRE_PM_ALGORITHM_VERSION,
    state: 'ABSTAIN',
    portfolioManagerEligibility: 'BLOCKED',
    evidenceAcceptance: 'UNAVAILABLE',
    riskVerdict: null,
    confidence: null,
    reasonCodes: ordered.filter((reason) => reasons.has(reason)),
    knowledgeCutoff,
    portfolioManagerInput: null,
  };
}
