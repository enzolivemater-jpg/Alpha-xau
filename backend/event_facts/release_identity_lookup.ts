import type {
  StrongIdentityClaimProposal,
  StrongIdentityContext,
} from '../event_engine/deterministic_processor.js';

export const RELEASE_IDENTITY_LOOKUP_VERSION = 'release-identity-active-lookup-v1' as const;

export interface ReleaseIdentityLookupDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export class ReleaseIdentityLookupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReleaseIdentityLookupError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * The strong identity key is SHA-256 of the three fields joined by U+001F, here
 * and in the SQL functions (`chr(31)`). A field containing that separator makes
 * two different triples hash alike, so it is refused at this boundary.
 */
const KEY_SEPARATOR = '\u001f';

function identityField(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && !value.includes(KEY_SEPARATOR);
}

function validateProposal(value: unknown): value is StrongIdentityClaimProposal {
  return isRecord(value)
    && hasExactKeys(value, ['authorityNamespace', 'identityType', 'identityValue'])
    && identityField(value.authorityNamespace)
    && identityField(value.identityType)
    && identityField(value.identityValue);
}

async function strongIdentityKey(proposal: StrongIdentityClaimProposal): Promise<string> {
  const bytes = new TextEncoder().encode([
    proposal.authorityNamespace,
    proposal.identityType,
    proposal.identityValue,
  ].join('\u001f'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function resolveActiveReleaseIdentity(
  db: ReleaseIdentityLookupDb,
  proposal: unknown,
): Promise<StrongIdentityContext> {
  if (!validateProposal(proposal)) {
    throw new ReleaseIdentityLookupError('IDENTITY_PROPOSAL_INVALID', 'Release identity proposal is invalid.');
  }
  const expectedStrongIdentityKey = await strongIdentityKey(proposal);

  let response: unknown;
  try {
    response = await db.request<unknown>(
      'POST',
      '/rpc/fn_event_lookup_active_identity_claims',
      {
        p_authority_namespace: proposal.authorityNamespace,
        p_identity_type: proposal.identityType,
        p_identity_value: proposal.identityValue,
      },
    );
  } catch {
    throw new ReleaseIdentityLookupError('IDENTITY_LOOKUP_UNAVAILABLE', 'Active identity lookup failed.');
  }

  if (!Array.isArray(response)) {
    throw new ReleaseIdentityLookupError('IDENTITY_LOOKUP_MALFORMED', 'Active identity lookup returned a non-array.');
  }
  const rows = response.map(row => {
    if (!isRecord(row) || !hasExactKeys(row, ['cluster_id', 'identity_claim_id', 'strong_identity_key'])
        || typeof row.cluster_id !== 'string' || !UUID.test(row.cluster_id)
        || typeof row.identity_claim_id !== 'string' || !UUID.test(row.identity_claim_id)
        || typeof row.strong_identity_key !== 'string' || !SHA256.test(row.strong_identity_key)
        || row.strong_identity_key !== expectedStrongIdentityKey) {
      throw new ReleaseIdentityLookupError('IDENTITY_LOOKUP_MALFORMED', 'Active identity lookup row is invalid.');
    }
    return row;
  });
  if (rows.length > 1) {
    throw new ReleaseIdentityLookupError(
      'IDENTITY_LOOKUP_COLLISION',
      'More than one active claim exists for the exact release identity.',
    );
  }

  return {
    kind: 'CURATED_STRONG_IDENTITY',
    authorityNamespace: proposal.authorityNamespace,
    identityType: proposal.identityType,
    identityValue: proposal.identityValue,
    candidateClusterIds: rows.length === 0 ? [] : [rows[0].cluster_id as string],
  };
}
