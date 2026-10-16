/**
 * EVIDENCE-0 — pure structural eligibility of caller-supplied evidence claims.
 *
 * No source authentication, collection, provider selection or admission to a
 * trading decision is possible. Even a structurally coherent claim remains
 * UNVERIFIED until separately reviewed official-source validation exists.
 */
import { parseStrictInstant } from '../shared/temporal_contract.js';

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = 'xau.evidence-manifest.v1' as const;
export const EVIDENCE_MANIFEST_ALGORITHM_VERSION = 'evidence-structural-cutoff-gate-1.0.0' as const;

export type EvidenceKind = 'OFFICIAL_RELEASE' | 'MARKET_PRICE' | 'POSITIONING';
export type EvidenceManifestReason =
  | 'INVALID_KNOWLEDGE_CUTOFF'
  | 'NO_EVIDENCE'
  | 'INVALID_CLAIM_SHAPE'
  | 'INVALID_CLAIM_IDENTITY'
  | 'INVALID_ARTIFACT_HASH'
  | 'INVALID_CLAIM_TIMESTAMP'
  | 'CHRONOLOGY_INVALID'
  | 'PUBLICATION_AFTER_CUTOFF'
  | 'INGESTION_AFTER_CUTOFF'
  | 'SOURCE_ATTESTATION_UNAVAILABLE';

export interface EvidenceClaim {
  readonly kind: EvidenceKind;
  /** Stable within the caller's claimed source authority and artifact. */
  readonly evidenceId: string;
  readonly sourceAuthority: string;
  readonly revision: string;
  /** Caller-supplied content checksum; does not authenticate source. */
  readonly artifactSha256: string;
  /** Effective date of the fact, distinct from publication and first ingest. */
  readonly effectiveAt: string;
  /** Public release timestamp, not collector observation time. */
  readonly publishedAt: string;
  /** Timestamp when this system first ingested this exact revision. */
  readonly firstIngestedAt: string;
  readonly producerVersion: string;
}

export interface EvidenceEligibilityManifest {
  readonly schemaVersion: typeof EVIDENCE_MANIFEST_SCHEMA_VERSION;
  readonly algorithmVersion: typeof EVIDENCE_MANIFEST_ALGORITHM_VERSION;
  readonly mode: 'STRUCTURAL_ONLY';
  readonly structuralStatus: 'COHERENT' | 'REJECTED';
  readonly evidenceState: 'UNVERIFIED';
  readonly authorization: 'NONE';
  readonly knowledgeCutoff: string;
  readonly reasonCodes: readonly EvidenceManifestReason[];
  /** Set only for a completely coherent claimed batch, never signed. */
  readonly claims: readonly EvidenceClaim[];
}

const KINDS: ReadonlySet<string> = new Set([
  'OFFICIAL_RELEASE', 'MARKET_PRICE', 'POSITIONING',
]);
const CLAIM_KEYS = [
  'artifactSha256', 'effectiveAt', 'evidenceId', 'firstIngestedAt',
  'kind', 'producerVersion', 'publishedAt', 'revision', 'sourceAuthority',
] as const;
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const AUTHORITY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/* Preserve EVIDENCE-0's approved-for-review millisecond input precision.
 * Shared TIME-0 compares real instants exactly; greater precision remains
 * disallowed here until this evidence schema is independently reviewed.
 */
function instant(value: unknown): bigint | null {
  return parseStrictInstant(value, 3)?.epochNanoseconds ?? null;
}

function exactShape(value: unknown): value is Record<keyof EvidenceClaim, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === CLAIM_KEYS.length
    && keys.every((key, index) => key === CLAIM_KEYS[index]);
}

function validIdentity(value: Record<keyof EvidenceClaim, unknown>): boolean {
  return KINDS.has(value.kind as string)
    && typeof value.evidenceId === 'string' && ID.test(value.evidenceId)
    && typeof value.sourceAuthority === 'string' && AUTHORITY.test(value.sourceAuthority)
    && typeof value.revision === 'string' && REVISION.test(value.revision)
    && typeof value.producerVersion === 'string' && VERSION.test(value.producerVersion);
}

const ORDER: readonly EvidenceManifestReason[] = [
  'INVALID_KNOWLEDGE_CUTOFF', 'NO_EVIDENCE', 'INVALID_CLAIM_SHAPE',
  'INVALID_CLAIM_IDENTITY', 'INVALID_ARTIFACT_HASH', 'INVALID_CLAIM_TIMESTAMP',
  'CHRONOLOGY_INVALID', 'PUBLICATION_AFTER_CUTOFF',
  'INGESTION_AFTER_CUTOFF', 'SOURCE_ATTESTATION_UNAVAILABLE',
];

function compareClaim(a: EvidenceClaim, b: EvidenceClaim): number {
  const key = (v: EvidenceClaim) => [
    v.kind, v.sourceAuthority, v.evidenceId, v.revision, v.artifactSha256,
    v.effectiveAt, v.publishedAt, v.firstIngestedAt, v.producerVersion,
  ].join('\u001f');
  const left = key(a);
  const right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A structurally coherent batch is still UNVERIFIED / authorization NONE.
 * Missing, future, divergent, or malformed claims reject the *entire* batch.
 * Identical duplicates collapse deterministically; divergent ID reuse rejects.
 */
export function buildEvidenceEligibilityManifest(
  input: readonly unknown[],
  requestedCutoff: string,
): EvidenceEligibilityManifest {
  const reasons = new Set<EvidenceManifestReason>();
  // Echoed into the manifest: a non-string (NaN, undefined...) from a JavaScript
  // caller is an invalid cutoff reported with an empty echo, never an unhashable value.
  const knowledgeCutoff: string = typeof requestedCutoff === 'string' ? requestedCutoff : '';
  const cutoff = instant(knowledgeCutoff);
  if (cutoff === null) reasons.add('INVALID_KNOWLEDGE_CUTOFF');
  if (!Array.isArray(input) || input.length === 0) reasons.add('NO_EVIDENCE');

  const seen = new Map<string, string>();
  const candidates: EvidenceClaim[] = [];
  for (const claim of Array.isArray(input) ? input : []) {
    if (!exactShape(claim)) {
      reasons.add('INVALID_CLAIM_SHAPE');
      continue;
    }
    if (!validIdentity(claim)) {
      reasons.add('INVALID_CLAIM_IDENTITY');
      continue;
    }
    if (typeof claim.artifactSha256 !== 'string' || !SHA256.test(claim.artifactSha256)) {
      reasons.add('INVALID_ARTIFACT_HASH');
      continue;
    }
    const effective = instant(claim.effectiveAt);
    const published = instant(claim.publishedAt);
    const ingested = instant(claim.firstIngestedAt);
    if (effective === null || published === null || ingested === null) {
      reasons.add('INVALID_CLAIM_TIMESTAMP');
      continue;
    }
    if (effective > published || published > ingested) reasons.add('CHRONOLOGY_INVALID');
    if (cutoff !== null && published > cutoff) reasons.add('PUBLICATION_AFTER_CUTOFF');
    if (cutoff !== null && ingested > cutoff) reasons.add('INGESTION_AFTER_CUTOFF');

    const typed = claim as unknown as EvidenceClaim;
    const key = [typed.kind, typed.sourceAuthority, typed.evidenceId, typed.revision].join('\u001f');
    const encoded = JSON.stringify(CLAIM_KEYS.map((k) => claim[k]));
    const previous = seen.get(key);
    if (previous !== undefined && previous !== encoded) {
      reasons.add('INVALID_CLAIM_IDENTITY');
    } else if (previous === undefined) {
      seen.set(key, encoded);
      candidates.push({ ...typed });
    }
  }

  // Provenance is supplied by the caller; a checksum/claimed timestamp is not
  // official source identity verification or an authorization to trade.
  reasons.add('SOURCE_ATTESTATION_UNAVAILABLE');
  const hasStructuralFailure = ORDER.some((reason) =>
    reason !== 'SOURCE_ATTESTATION_UNAVAILABLE' && reasons.has(reason));

  return {
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    algorithmVersion: EVIDENCE_MANIFEST_ALGORITHM_VERSION,
    mode: 'STRUCTURAL_ONLY',
    structuralStatus: hasStructuralFailure ? 'REJECTED' : 'COHERENT',
    evidenceState: 'UNVERIFIED',
    authorization: 'NONE',
    knowledgeCutoff,
    reasonCodes: ORDER.filter((code) => reasons.has(code)),
    claims: hasStructuralFailure ? [] : candidates.sort(compareClaim),
  };
}
