/**
 * =============================================================================
 *  ALPHA-XAU — backend/event_engine/shadow_orchestrator.ts
 *
 *  OPS-023 PR5 — Shadow Event Orchestration Adapter (V1).
 *
 *  APPLICATION/DB ADAPTER between the pure PR4 deterministic processor
 *  (backend/event_engine/deterministic_processor.ts, imported and consumed
 *  here, never reimplemented) and the already-live OPS-023 RPCs. Unlike the
 *  processor, this module IS allowed to perform DB requests — but ONLY
 *  through an INJECTED structural port (EventShadowDb), never a Supabase
 *  HTTP client instantiated here, never environment variables read here.
 *  A future runtime adapter supplies the real DB client; this module never
 *  imports backend/ingest.ts.
 *
 *  SCOPE: exactly ONE persisted official RAW observation at a time.
 *
 *    news_articles RAW observation
 *      -> deterministic_processor.planEventProcessing()
 *      -> fn_event_assign_observation()
 *      -> persisted membership assigned_at
 *      -> fn_event_create_event_version()
 *      -> result
 *
 *  SHADOW EVENT STATE ONLY. Never touches news_events, notifications,
 *  Committee, Gold analytics, frontend, worker, cron, or deployment.
 *
 *  STRONG IDENTITY IS OUT OF PR5 V1 (deliberate) : this orchestrator ALWAYS
 *  calls the processor with strongIdentity = { kind: 'NONE' } and
 *  clusterContext = null — never a caller-supplied strong identity.
 *  fn_event_assert_identity_claim is NEVER called here. Reason: a PR4 plan
 *  with zero strong-identity candidates proposes CREATE_NEW_CLUSTER plus a
 *  strongIdentityClaimProposal ; executing cluster creation/membership and
 *  then a SEPARATE identity RPC would not be one transaction across two
 *  PostgREST calls — if the identity assertion failed after cluster
 *  creation, append-only shadow state would be partially committed. This
 *  orchestrator refuses to introduce that failure mode silently: if the
 *  processor unexpectedly returns a non-null strongIdentityClaimProposal,
 *  it fails closed BEFORE any DB mutation (UNSUPPORTED_STRONG_IDENTITY_PLAN).
 *
 *  PR5 V1 PLAN SHAPE — FAIL CLOSED : with strongIdentity=NONE and
 *  clusterContext=null, the ONLY mutation-capable PR4 plan this adapter
 *  accepts is exactly: kind=PROCESS, clusterDisposition=CREATE_NEW_CLUSTER,
 *  resolvedClusterId=null, provisionalClusterKey!=null,
 *  strongIdentityClaimProposal=null, versionDisposition=CREATE_VERSION,
 *  transition=NOVELTY, previousEventVersionId=null. If PR4 semantics later
 *  change and any of these assumptions differ, this adapter fails closed
 *  BEFORE any write (UNSUPPORTED_PROCESSOR_PLAN_SHAPE) — it never silently
 *  begins supporting ASSIGN_EXISTING/CONFIRMATION/CORRECTION here; those
 *  paths require explicit context-loading semantics, added only in a later
 *  PR after shadow/replay proof.
 *
 *  DETERMINISTIC FINGERPRINTS : every fingerprint is computed locally via
 *  a stable canonical JSON serializer (object keys sorted lexicographically,
 *  arrays order-preserved, undefined/non-finite numbers rejected) fed to
 *  the global Web Crypto SHA-256 (crypto.subtle.digest) — no random values,
 *  no current clock. Every payload is explicitly domain-separated (a
 *  top-level "domain" discriminator string, distinct per fingerprint kind)
 *  so no two different fingerprint purposes can ever collide on the same
 *  canonical bytes. The SAME persisted observation + the SAME orchestrator
 *  version always produce the EXACT SAME fingerprints on every retry — a
 *  material intent change always produces a different one.
 *
 *  TEMPORAL INTEGRITY (frozen PR3 contract) : PR4 returns only
 *  knowledgeCutoffFloor = MAX(observedAt, ingestedAt). This adapter fetches
 *  the PERSISTED membership assigned_at (never a locally-computed guess)
 *  and derives the final Event Version knowledge_cutoff as
 *  MAX(knowledgeCutoffFloor, assigned_at) using only parsed SUPPLIED
 *  timestamps — never publishedAt/publishedDate/Date.now()/new Date()
 *  current clock.
 *
 *  RETRY / LOST-RESPONSE RECOVERY : because every fingerprint is a pure
 *  function of (observation, plan) with no randomness/clock, a retry after
 *  a fully-committed first execution replays both RPCs (replayed=true,
 *  same cluster_id/decision_id/event_version_id) at no cost. A retry after
 *  the assignment committed but the Event Version RPC was never reached
 *  (HTTP response lost) supplies the SAME idempotency fingerprint to
 *  fn_event_assign_observation, receives the persisted cluster/decision via
 *  replay, and proceeds to create the Event Version normally — this
 *  application NEVER intentionally requests a second cluster for the same
 *  observation.
 *
 *  NO RUNTIME WIRING YET : this PR does not modify backend/worker.ts,
 *  backend/shared/run_lock.ts, or wrangler.toml. No cron, no fetch route,
 *  no deployment — first prove this mutation adapter contract in isolation.
 * =============================================================================
 */

import {
  planEventProcessing,
  type PersistedRawObservation,
  type ProcessPlan,
  type IngestQualityState,
} from './deterministic_processor.js';

export const OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION = 'ops023-event-shadow-orchestrator-v1';
export const OPS023_EVENT_SHADOW_DECISION_ACTOR = 'xau_v2:event_shadow:v1';

const MEMBERSHIP_METHOD = 'DETERMINISTIC_OFFICIAL_FOUNDING_V1';
const MEMBERSHIP_CONFIDENCE = 1;

// ---------------------------------------------------------------------------
// Injected structural DB port. Never a Supabase HTTP client instantiated
// here, never an environment variable read here.
// ---------------------------------------------------------------------------

export interface EventShadowDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Typed invariant error. Every DB/invariant failure throws this — never
// silently returned as an abstention/skip result.
// ---------------------------------------------------------------------------

export class EventShadowInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventShadowInvariantError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON serializer + SHA-256 fingerprint helper (exported for
// direct testing). Object keys sorted lexicographically, arrays preserve
// order, null/booleans/strings preserved exactly, only finite numbers
// allowed, undefined rejected everywhere (top-level, object value, array
// item).
// ---------------------------------------------------------------------------

export function canonicalStringify(value: unknown): string {
  if (value === undefined) {
    throw new Error('canonicalStringify: undefined is not allowed.');
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalStringify: only finite numbers are allowed.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalStringify: unsupported value type "${typeof value}".`);
}

export async function sha256Hex(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Every fingerprint is domain-separated: a top-level "domain" string
 * distinct per fingerprint purpose, nested "payload" object — never a raw
 * concatenation with an ambiguous delimiter, never two different
 * fingerprint kinds able to collide on the same canonical bytes.
 */
async function domainFingerprint(domain: string, payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalStringify({ domain, payload }));
}

// ---------------------------------------------------------------------------
// RAW observation fetch + snake_case -> PR4 camelCase mapping.
// ---------------------------------------------------------------------------

interface NewsArticleRow {
  readonly id: string;
  readonly provider: string;
  readonly provider_item_id: string | null;
  readonly source_code: string;
  readonly source_domain: string | null;
  readonly canonical_url: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly content: string | null;
  readonly provider_category: string | null;
  readonly published_at: string | null;
  readonly published_date: string | null;
  readonly observed_at: string;
  readonly ingested_at: string;
  readonly ingest_quality_state: IngestQualityState;
  readonly ingest_quality_reasons: readonly string[];
}

const NEWS_ARTICLES_SELECT = [
  'id', 'provider', 'provider_item_id', 'source_code', 'source_domain', 'canonical_url',
  'title', 'summary', 'content', 'provider_category', 'published_at', 'published_date',
  'observed_at', 'ingested_at', 'ingest_quality_state', 'ingest_quality_reasons',
].join(',');

function mapRowToObservation(row: NewsArticleRow): PersistedRawObservation {
  return {
    id: row.id,
    provider: row.provider,
    providerItemId: row.provider_item_id,
    sourceCode: row.source_code,
    sourceDomain: row.source_domain,
    canonicalUrl: row.canonical_url,
    title: row.title,
    summary: row.summary,
    content: row.content,
    providerCategory: row.provider_category,
    publishedAt: row.published_at,
    publishedDate: row.published_date,
    observedAt: row.observed_at,
    ingestedAt: row.ingested_at,
    ingestQualityState: row.ingest_quality_state,
    ingestQualityReasons: row.ingest_quality_reasons,
  };
}

async function fetchObservation(db: EventShadowDb, observationId: string): Promise<PersistedRawObservation | null> {
  const rows = await db.request<NewsArticleRow[]>(
    'GET',
    `news_articles?id=eq.${encodeURIComponent(observationId)}&select=${NEWS_ARTICLES_SELECT}`,
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new EventShadowInvariantError(
      'OBSERVATION_ROW_COUNT_INVARIANT',
      `expected at most 1 news_articles row for id=${observationId}, got ${rows.length}.`,
    );
  }
  return mapRowToObservation(rows[0]);
}

// ---------------------------------------------------------------------------
// Fail-closed PR5 V1 plan-shape guard — runs BEFORE any DB mutation.
// ---------------------------------------------------------------------------

/**
 * Exported so this fail-closed guard can be exercised directly with a
 * synthetic plan shape in tests — the REAL processor, called the way this
 * orchestrator calls it (strongIdentity=NONE, clusterContext=null), can
 * never organically produce a non-conforming plan, so this is the only way
 * to behaviorally prove the guard itself without replacing PR4 with a fake.
 */
export function assertSupportedPlanShape(plan: ProcessPlan): void {
  if (plan.strongIdentityClaimProposal !== null) {
    throw new EventShadowInvariantError(
      'UNSUPPORTED_STRONG_IDENTITY_PLAN',
      'processor plan unexpectedly carries a non-null strongIdentityClaimProposal; PR5 V1 never supplies a curated strong identity and refuses to execute a partial (non-atomic) identity assertion.',
    );
  }
  if (
    plan.clusterDisposition !== 'CREATE_NEW_CLUSTER'
    || plan.resolvedClusterId !== null
    || plan.provisionalClusterKey === null
    || plan.versionDisposition !== 'CREATE_VERSION'
    || plan.transition !== 'NOVELTY'
    || plan.previousEventVersionId !== null
  ) {
    throw new EventShadowInvariantError(
      'UNSUPPORTED_PROCESSOR_PLAN_SHAPE',
      `processor plan does not match the only PR5 V1 supported shape (CREATE_NEW_CLUSTER + CREATE_VERSION + NOVELTY, no resolved cluster, no predecessor) — got clusterDisposition=${plan.clusterDisposition} resolvedClusterId=${String(plan.resolvedClusterId)} versionDisposition=${plan.versionDisposition} transition=${String(plan.transition)} previousEventVersionId=${String(plan.previousEventVersionId)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// RAW evidence digest — an audit digest of the immutable RAW fields PR4
// actually consumed. NOT a strong identity, NOT a cluster identity, NOT
// semantic Event Version state.
// ---------------------------------------------------------------------------

async function computeRawEvidenceDigest(observation: PersistedRawObservation): Promise<string> {
  return domainFingerprint('xau_v2:event_raw_evidence:v1', {
    observationId: observation.id,
    provider: observation.provider,
    providerItemId: observation.providerItemId,
    sourceCode: observation.sourceCode,
    sourceDomain: observation.sourceDomain,
    canonicalUrl: observation.canonicalUrl,
    title: observation.title,
    summary: observation.summary,
    content: observation.content,
    providerCategory: observation.providerCategory,
    publishedAt: observation.publishedAt,
    publishedDate: observation.publishedDate,
    observedAt: observation.observedAt,
    ingestedAt: observation.ingestedAt,
    ingestQualityState: observation.ingestQualityState,
    ingestQualityReasons: [...observation.ingestQualityReasons],
  });
}

/** Deterministic, non-secret textual evidence marker based on the
 *  already-verified official source tuple — never a secret, never random. */
function buildLineageEvidenceMarker(observation: PersistedRawObservation): string {
  return `xau_v2:event_shadow:verified_official_source:${observation.sourceCode}:${observation.sourceDomain ?? 'null'}`;
}

// ---------------------------------------------------------------------------
// Membership fingerprints.
// ---------------------------------------------------------------------------

async function computeMembershipSemanticFingerprint(
  observation: PersistedRawObservation,
  plan: ProcessPlan,
): Promise<string> {
  return domainFingerprint('xau_v2:event_membership_semantic:v1', {
    observationId: observation.id,
    membershipMethod: MEMBERSHIP_METHOD,
    provisionalClusterKey: plan.provisionalClusterKey,
    clusterCategory: plan.clusterCategory,
    lineage: {
      editorialOriginKey: plan.lineage.editorialOriginKey,
      wireLineageKey: plan.lineage.wireLineageKey,
      lineageResolutionMethod: plan.lineage.lineageResolutionMethod,
      lineageResolutionConfidence: plan.lineage.lineageResolutionConfidence,
    },
  });
}

async function computeMembershipIdempotencyFingerprint(
  observation: PersistedRawObservation,
  plan: ProcessPlan,
  evidenceDigest: string,
  lineageEvidence: string,
  semanticStateFingerprint: string,
): Promise<string> {
  return domainFingerprint('xau_v2:event_membership_idempotency:v1', {
    observationId: observation.id,
    mode: 'CREATE_AND_ASSIGN',
    clusterKey: plan.provisionalClusterKey,
    clusterCategory: plan.clusterCategory,
    clusterRegion: null,
    clusterAlgorithmVersion: plan.processorVersion,
    membershipMethod: MEMBERSHIP_METHOD,
    membershipConfidence: MEMBERSHIP_CONFIDENCE,
    evidenceDigest,
    editorialOriginKey: plan.lineage.editorialOriginKey,
    wireLineageKey: plan.lineage.wireLineageKey,
    lineageResolutionMethod: plan.lineage.lineageResolutionMethod,
    lineageResolutionConfidence: plan.lineage.lineageResolutionConfidence,
    lineageEvidence,
    membershipAlgorithmVersion: OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION,
    decisionActor: OPS023_EVENT_SHADOW_DECISION_ACTOR,
    semanticStateFingerprint,
  });
}

// ---------------------------------------------------------------------------
// RPC response validation helpers — never guess a missing/malformed field.
// ---------------------------------------------------------------------------

const UUID_LIKE_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function validateUuidLikeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_LIKE_PATTERN.test(value)) {
    throw new EventShadowInvariantError(
      'MALFORMED_RPC_RESPONSE',
      `expected a UUID-like string for "${field}", got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new EventShadowInvariantError(
      'MALFORMED_RPC_RESPONSE',
      `expected a boolean for "${field}", got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function validateFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EventShadowInvariantError(
      'MALFORMED_RPC_RESPONSE',
      `expected a finite number for "${field}", got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EventShadowInvariantError(
      'MALFORMED_RPC_RESPONSE',
      `expected a non-empty string for "${field}", got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// fn_event_assign_observation — CREATE_AND_ASSIGN mode ONLY.
// ---------------------------------------------------------------------------

interface AssignRpcRow {
  readonly cluster_id: unknown;
  readonly decision_id: unknown;
  readonly cluster_created_now: unknown;
  readonly replayed: unknown;
}

interface AssignOutcome {
  readonly clusterId: string;
  readonly decisionId: string;
  readonly clusterCreatedNow: boolean;
  readonly replayed: boolean;
}

async function callAssignObservation(
  db: EventShadowDb,
  observation: PersistedRawObservation,
  plan: ProcessPlan,
): Promise<AssignOutcome> {
  const evidenceDigest = await computeRawEvidenceDigest(observation);
  const lineageEvidence = buildLineageEvidenceMarker(observation);
  const semanticStateFingerprint = await computeMembershipSemanticFingerprint(observation, plan);
  const idempotencyFingerprint = await computeMembershipIdempotencyFingerprint(
    observation, plan, evidenceDigest, lineageEvidence, semanticStateFingerprint,
  );

  const rows = await db.request<AssignRpcRow[]>('POST', 'rpc/fn_event_assign_observation', {
    p_observation_id: observation.id,
    p_cluster_id: null,
    p_cluster_key: plan.provisionalClusterKey,
    p_category: plan.clusterCategory,
    p_region: null,
    p_cluster_algorithm_version: plan.processorVersion,
    p_membership_method: MEMBERSHIP_METHOD,
    p_membership_confidence: MEMBERSHIP_CONFIDENCE,
    p_evidence_digest: evidenceDigest,
    p_editorial_origin_key: plan.lineage.editorialOriginKey,
    p_wire_lineage_key: plan.lineage.wireLineageKey,
    p_lineage_resolution_method: plan.lineage.lineageResolutionMethod,
    p_lineage_resolution_confidence: plan.lineage.lineageResolutionConfidence,
    p_lineage_evidence: lineageEvidence,
    p_membership_algorithm_version: OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION,
    p_decision_actor: OPS023_EVENT_SHADOW_DECISION_ACTOR,
    p_idempotency_fingerprint: idempotencyFingerprint,
    p_semantic_state_fingerprint: semanticStateFingerprint,
  });

  if (rows.length !== 1) {
    throw new EventShadowInvariantError(
      'ASSIGN_RESPONSE_INVARIANT',
      `fn_event_assign_observation returned ${rows.length} row(s) (expected exactly 1).`,
    );
  }
  const row = rows[0];
  return {
    clusterId: validateUuidLikeString(row.cluster_id, 'cluster_id'),
    decisionId: validateUuidLikeString(row.decision_id, 'decision_id'),
    clusterCreatedNow: validateBoolean(row.cluster_created_now, 'cluster_created_now'),
    replayed: validateBoolean(row.replayed, 'replayed'),
  };
}

// ---------------------------------------------------------------------------
// Persisted membership read-back — temporal integrity source of truth.
// ---------------------------------------------------------------------------

interface MembershipRow {
  readonly decision_id: unknown;
  readonly observation_id: unknown;
  readonly cluster_id: unknown;
  readonly assigned_at: unknown;
  readonly decision_type: unknown;
  readonly editorial_origin_key: unknown;
  readonly wire_lineage_key: unknown;
}

interface PersistedMembership {
  readonly decisionId: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly assignedAt: string;
  readonly decisionType: string;
  readonly editorialOriginKey: string | null;
  readonly wireLineageKey: string | null;
}

async function fetchPersistedMembership(db: EventShadowDb, decisionId: string): Promise<PersistedMembership> {
  const rows = await db.request<MembershipRow[]>(
    'GET',
    `event_observation_memberships?decision_id=eq.${encodeURIComponent(decisionId)}&select=decision_id,observation_id,cluster_id,assigned_at,decision_type,editorial_origin_key,wire_lineage_key`,
  );
  if (rows.length !== 1) {
    throw new EventShadowInvariantError(
      'MEMBERSHIP_ROW_INVARIANT',
      `expected exactly 1 event_observation_memberships row for decision_id=${decisionId}, got ${rows.length}.`,
    );
  }
  const row = rows[0];
  return {
    decisionId: validateUuidLikeString(row.decision_id, 'decision_id'),
    observationId: validateUuidLikeString(row.observation_id, 'observation_id'),
    clusterId: validateUuidLikeString(row.cluster_id, 'cluster_id'),
    assignedAt: validateNonEmptyString(row.assigned_at, 'assigned_at'),
    decisionType: validateNonEmptyString(row.decision_type, 'decision_type'),
    editorialOriginKey: row.editorial_origin_key === null ? null : validateNonEmptyString(row.editorial_origin_key, 'editorial_origin_key'),
    wireLineageKey: row.wire_lineage_key === null ? null : validateNonEmptyString(row.wire_lineage_key, 'wire_lineage_key'),
  };
}

function assertMembershipIdentity(
  membership: PersistedMembership,
  expected: { readonly decisionId: string; readonly observationId: string; readonly clusterId: string },
): void {
  if (membership.decisionId !== expected.decisionId) {
    throw new EventShadowInvariantError('MEMBERSHIP_IDENTITY_MISMATCH', 'persisted membership decision_id does not match the assignment RPC response.');
  }
  if (membership.observationId !== expected.observationId) {
    throw new EventShadowInvariantError('MEMBERSHIP_IDENTITY_MISMATCH', 'persisted membership observation_id does not match the RAW observation.');
  }
  if (membership.clusterId !== expected.clusterId) {
    throw new EventShadowInvariantError('MEMBERSHIP_IDENTITY_MISMATCH', 'persisted membership cluster_id does not match the assignment RPC response.');
  }
  if (membership.decisionType !== 'ASSIGN') {
    throw new EventShadowInvariantError('MEMBERSHIP_IDENTITY_MISMATCH', `persisted membership decision_type expected ASSIGN, got "${membership.decisionType}".`);
  }
}

/**
 * Fail-closed BEFORE Event Version creation: the persisted membership
 * lineage (editorial_origin_key / wire_lineage_key) must exactly match what
 * PR4 actually planned. fn_event_create_event_version never recomputes
 * editorial-independence semantics from the membership row — it only
 * receives plan.sourceIndependenceState directly — so if the write/read
 * contract ever silently drifted (persisted evidence disagreeing with the
 * processor plan that is about to drive the Event Version), that drift
 * must be caught here, never passed through unnoticed. Null-safe exact
 * equality; neither side is ever substituted for the other.
 */
function assertMembershipLineageMatchesPlan(
  membership: PersistedMembership,
  plan: ProcessPlan,
): void {
  if (membership.editorialOriginKey !== plan.lineage.editorialOriginKey) {
    throw new EventShadowInvariantError(
      'MEMBERSHIP_LINEAGE_MISMATCH',
      `persisted membership editorial_origin_key (${JSON.stringify(membership.editorialOriginKey)}) does not match the processor plan lineage.editorialOriginKey (${JSON.stringify(plan.lineage.editorialOriginKey)}).`,
    );
  }
  if (membership.wireLineageKey !== plan.lineage.wireLineageKey) {
    throw new EventShadowInvariantError(
      'MEMBERSHIP_LINEAGE_MISMATCH',
      `persisted membership wire_lineage_key (${JSON.stringify(membership.wireLineageKey)}) does not match the processor plan lineage.wireLineageKey (${JSON.stringify(plan.lineage.wireLineageKey)}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Self-contained strict ISO-8601 validation (SUPPLIED strings only — never
// the application clock). Duplicated locally, same discipline as PR4:
// each module owns its own timestamp validation, never a shared clock.
// ---------------------------------------------------------------------------

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

function isValidCivilDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function isValidNumericOffset(offset: string): boolean {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return false;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Parses a strict explicit-timezone ISO-8601 timestamp to whole MICROSECONDS
 * since the Unix epoch, as a BigInt — never through Date.parse()/toISOString()
 * for the final value, since a JS Date only carries millisecond resolution
 * and PostgreSQL timestamptz carries microsecond resolution. Fractional
 * digits beyond the 6th (microseconds) are truncated, never rounded: we
 * never invent precision the source did not supply.
 */
function parseStrictIsoTimestampToEpochMicros(value: string): bigint | null {
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  if (!isValidCivilDate(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (tz !== 'Z' && !isValidNumericOffset(tz)) return null;

  // Whole-second UTC instant, treating the wall-clock fields as if they were
  // already UTC (no fractional-ms args passed in, so this is an exact
  // integer number of seconds — Date.UTC is used here only as a calendar/
  // civil-time-to-epoch-seconds converter, never as the source of the final
  // sub-second value).
  const epochMsAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const epochSecondsAsIfUtc = BigInt(epochMsAsIfUtc / 1000);

  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const om = /^([+-])(\d{2}):?(\d{2})$/.exec(tz)!;
    const sign = om[1] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(om[2]) * 60 + Number(om[3]));
  }
  // The wall-clock fields were expressed in the supplied offset, not UTC:
  // true UTC instant = wall-clock-as-if-UTC minus the offset.
  const epochSecondsUtc = epochSecondsAsIfUtc - BigInt(offsetMinutes) * 60n;

  const fracDigits = (frac ?? '').padEnd(6, '0').slice(0, 6);
  const fracMicros = BigInt(fracDigits);

  return epochSecondsUtc * 1_000_000n + fracMicros;
}

/**
 * Final Event Version knowledge_cutoff = MAX(plan.knowledgeCutoffFloor,
 * persisted membership.assigned_at) — the frozen PR3 temporal-integrity
 * contract. Never publishedAt/publishedDate/Date.now()/new Date().
 *
 * Compares both supplied timestamps at microsecond precision (PostgreSQL
 * timestamptz resolution) via BigInt epoch-microsecond arithmetic — never by
 * round-tripping through a JS Date/epoch-millisecond value, which would
 * silently floor away up to 999 microseconds and could make a later instant
 * compare as earlier (or equal) to an unrelated one. The winning timestamp is
 * returned EXACTLY as supplied (only whitespace-trimmed), so its original
 * fractional precision and timezone-offset formatting are never rewritten.
 */
export function deriveFinalKnowledgeCutoff(knowledgeCutoffFloor: string, assignedAt: string): string {
  const floorMicros = parseStrictIsoTimestampToEpochMicros(knowledgeCutoffFloor);
  if (floorMicros === null) {
    throw new EventShadowInvariantError(
      'INVALID_KNOWLEDGE_CUTOFF_FLOOR',
      `plan.knowledgeCutoffFloor is not a valid explicit-timezone ISO-8601 timestamp: ${knowledgeCutoffFloor}`,
    );
  }
  const assignedMicros = parseStrictIsoTimestampToEpochMicros(assignedAt);
  if (assignedMicros === null) {
    throw new EventShadowInvariantError(
      'INVALID_ASSIGNED_AT',
      `persisted membership assigned_at is not a valid explicit-timezone ISO-8601 timestamp: ${assignedAt}`,
    );
  }
  return assignedMicros >= floorMicros ? assignedAt.trim() : knowledgeCutoffFloor.trim();
}

// ---------------------------------------------------------------------------
// fn_event_create_event_version.
// ---------------------------------------------------------------------------

async function computeEventVersionIdempotencyFingerprint(
  plan: ProcessPlan,
  clusterId: string,
  finalKnowledgeCutoff: string,
  observationId: string,
  membershipDecisionId: string,
): Promise<string> {
  return domainFingerprint('xau_v2:event_version_idempotency:v1', {
    clusterId,
    transition: plan.transition,
    knowledgeCutoff: finalKnowledgeCutoff,
    effectiveTime: plan.effectiveTime,
    effectiveTimePrecision: plan.effectiveTimePrecision,
    canonicalEventStateSchemaVersion: plan.canonicalEventStateSchemaVersion,
    canonicalEventState: plan.canonicalEventState,
    officialConfirmationState: plan.officialConfirmationState,
    sourceIndependenceState: plan.sourceIndependenceState,
    algorithmVersion: plan.processorVersion,
    decisionActor: OPS023_EVENT_SHADOW_DECISION_ACTOR,
    supersedesVersionId: null,
    observationId,
    membershipDecisionId,
  });
}

interface EventVersionRpcRow {
  readonly event_version_id: unknown;
  readonly version_number: unknown;
  readonly transition_type: unknown;
  readonly state_fingerprint: unknown;
  readonly source_independence_state: unknown;
  readonly evidence_count: unknown;
  readonly outcome: unknown;
  readonly replayed: unknown;
}

interface EventVersionOutcome {
  readonly eventVersionId: string;
  readonly versionNumber: number;
  readonly transitionType: string;
  readonly stateFingerprint: string;
  readonly sourceIndependenceState: string;
  readonly evidenceCount: number;
  readonly outcome: string;
  readonly replayed: boolean;
}

async function callCreateEventVersion(
  db: EventShadowDb,
  plan: ProcessPlan,
  clusterId: string,
  finalKnowledgeCutoff: string,
  observationId: string,
  membershipDecisionId: string,
): Promise<EventVersionOutcome> {
  const idempotencyFingerprint = await computeEventVersionIdempotencyFingerprint(
    plan, clusterId, finalKnowledgeCutoff, observationId, membershipDecisionId,
  );

  const rows = await db.request<EventVersionRpcRow[]>('POST', 'rpc/fn_event_create_event_version', {
    p_cluster_id: clusterId,
    p_transition_type: plan.transition,
    p_knowledge_cutoff: finalKnowledgeCutoff,
    p_effective_time: plan.effectiveTime,
    p_effective_time_precision: plan.effectiveTimePrecision,
    p_canonical_event_state_schema_version: plan.canonicalEventStateSchemaVersion,
    p_canonical_event_state: plan.canonicalEventState,
    p_official_confirmation_state: plan.officialConfirmationState,
    p_source_independence_state: plan.sourceIndependenceState,
    p_algorithm_version: plan.processorVersion,
    p_decision_actor: OPS023_EVENT_SHADOW_DECISION_ACTOR,
    p_idempotency_fingerprint: idempotencyFingerprint,
    p_supersedes_version_id: null,
  });

  if (rows.length !== 1) {
    throw new EventShadowInvariantError(
      'EVENT_VERSION_RESPONSE_INVARIANT',
      `fn_event_create_event_version returned ${rows.length} row(s) (expected exactly 1).`,
    );
  }
  const row = rows[0];
  const eventVersionId = validateUuidLikeString(row.event_version_id, 'event_version_id');
  const versionNumber = validateFiniteNumber(row.version_number, 'version_number');
  const transitionType = validateNonEmptyString(row.transition_type, 'transition_type');
  // Validated as a non-empty string only — never recomputed/reinterpreted here.
  const stateFingerprint = validateNonEmptyString(row.state_fingerprint, 'state_fingerprint');
  const sourceIndependenceState = validateNonEmptyString(row.source_independence_state, 'source_independence_state');
  const evidenceCount = validateFiniteNumber(row.evidence_count, 'evidence_count');
  const outcome = validateNonEmptyString(row.outcome, 'outcome');
  const replayed = validateBoolean(row.replayed, 'replayed');

  // PR5 V1 first-version-path invariants — fail closed, never reinterpret.
  if (outcome !== 'CREATED' && outcome !== 'REPLAYED') {
    throw new EventShadowInvariantError(
      'EVENT_VERSION_SHAPE_INVARIANT',
      `fn_event_create_event_version outcome "${outcome}" is not accepted by PR5 V1 (only CREATED/REPLAYED) — a processor-plan reinterpretation is never performed here.`,
    );
  }
  // Local response-coherence check only — no new RPC/SQL semantics.
  if (outcome === 'CREATED' && replayed !== false) {
    throw new EventShadowInvariantError(
      'EVENT_VERSION_SHAPE_INVARIANT',
      `fn_event_create_event_version returned outcome=CREATED with replayed=${replayed} (expected false).`,
    );
  }
  if (outcome === 'REPLAYED' && replayed !== true) {
    throw new EventShadowInvariantError(
      'EVENT_VERSION_SHAPE_INVARIANT',
      `fn_event_create_event_version returned outcome=REPLAYED with replayed=${replayed} (expected true).`,
    );
  }
  if (versionNumber !== 1) {
    throw new EventShadowInvariantError('EVENT_VERSION_SHAPE_INVARIANT', `expected version_number=1 for the PR5 V1 first-version path, got ${versionNumber}.`);
  }
  if (transitionType !== 'NOVELTY') {
    throw new EventShadowInvariantError('EVENT_VERSION_SHAPE_INVARIANT', `expected transition_type=NOVELTY, got "${transitionType}".`);
  }
  if (evidenceCount < 1) {
    throw new EventShadowInvariantError('EVENT_VERSION_SHAPE_INVARIANT', `expected evidence_count >= 1, got ${evidenceCount}.`);
  }
  if (sourceIndependenceState !== plan.sourceIndependenceState) {
    throw new EventShadowInvariantError(
      'SOURCE_INDEPENDENCE_MISMATCH',
      `fn_event_create_event_version returned source_independence_state="${sourceIndependenceState}" but the processor plan computed "${plan.sourceIndependenceState}".`,
    );
  }

  return { eventVersionId, versionNumber, transitionType, stateFingerprint, sourceIndependenceState, evidenceCount, outcome, replayed };
}

// ---------------------------------------------------------------------------
// Result shapes.
// ---------------------------------------------------------------------------

export interface ProcessedResult {
  readonly kind: 'PROCESSED';
  readonly observationId: string;
  readonly processorVersion: string;
  readonly orchestratorVersion: string;
  readonly clusterId: string;
  readonly decisionId: string;
  readonly eventVersionId: string;
  readonly membershipReplayed: boolean;
  readonly eventVersionReplayed: boolean;
  readonly clusterCreatedNow: boolean;
  readonly finalKnowledgeCutoff: string;
  readonly sourceIndependenceState: string;
}

export interface AbstainedResult {
  readonly kind: 'ABSTAINED';
  readonly observationId: string | null;
  readonly processorVersion: string;
  readonly abstention: string;
  readonly reason: string;
}

export interface SkippedResult {
  readonly kind: 'SKIPPED';
  readonly reason: 'OBSERVATION_NOT_FOUND';
  readonly observationId: string;
}

export type EventShadowObservationResult = ProcessedResult | AbstainedResult | SkippedResult;

// ---------------------------------------------------------------------------
// Public entry point — exactly one persisted RAW observation.
// ---------------------------------------------------------------------------

export async function processEventShadowObservation(
  db: EventShadowDb,
  observationId: string,
): Promise<EventShadowObservationResult> {
  const observation = await fetchObservation(db, observationId);
  if (observation === null) {
    return { kind: 'SKIPPED', reason: 'OBSERVATION_NOT_FOUND', observationId };
  }

  // PR5 V1 invariant: NEVER a caller-supplied strong identity.
  const plan = planEventProcessing({
    observation,
    strongIdentity: { kind: 'NONE' },
    clusterContext: null,
  });

  if (plan.kind === 'ABSTAIN') {
    return {
      kind: 'ABSTAINED',
      observationId: plan.observationId,
      processorVersion: plan.processorVersion,
      abstention: plan.abstention,
      reason: plan.reason,
    };
  }

  // Fail-closed BEFORE any DB mutation.
  assertSupportedPlanShape(plan);

  const assignment = await callAssignObservation(db, observation, plan);

  const membership = await fetchPersistedMembership(db, assignment.decisionId);
  assertMembershipIdentity(membership, {
    decisionId: assignment.decisionId,
    observationId: observation.id,
    clusterId: assignment.clusterId,
  });

  assertMembershipLineageMatchesPlan(membership, plan);

  const finalKnowledgeCutoff = deriveFinalKnowledgeCutoff(plan.knowledgeCutoffFloor, membership.assignedAt);

  const eventVersion = await callCreateEventVersion(
    db, plan, assignment.clusterId, finalKnowledgeCutoff, observation.id, assignment.decisionId,
  );

  return {
    kind: 'PROCESSED',
    observationId: observation.id,
    processorVersion: plan.processorVersion,
    orchestratorVersion: OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION,
    clusterId: assignment.clusterId,
    decisionId: assignment.decisionId,
    eventVersionId: eventVersion.eventVersionId,
    membershipReplayed: assignment.replayed,
    eventVersionReplayed: eventVersion.replayed,
    clusterCreatedNow: assignment.clusterCreatedNow,
    finalKnowledgeCutoff,
    sourceIndependenceState: eventVersion.sourceIndependenceState,
  };
}
