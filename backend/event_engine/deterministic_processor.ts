/**
 * =============================================================================
 *  ALPHA-XAU — backend/event_engine/deterministic_processor.ts
 *
 *  OPS-023 PR4 — Deterministic Event Processor (domain layer, V1).
 *
 *  Transforms ONE persisted RAW official observation (public.news_articles
 *  row shape) plus explicit prior event context into a SIDE-EFFECT-FREE
 *  EventProcessingPlan. This module is PURE: no database client, no
 *  fetch(), no Supabase, no environment variables, no Worker APIs, no
 *  timers, no Date.now(), no Math.random(), no crypto-generated random
 *  values, no LLM. Same input always produces deep-equal output.
 *
 *  Deterministic parsing of a SUPPLIED timestamp string (Date.parse on a
 *  caller-provided value, already format-validated by hand-rolled civil
 *  calendar checks below) is acceptable and used only for that purpose —
 *  the application's current clock is never read.
 *
 *  RESPONSIBILITY BOUNDARY: this is the DOMAIN DECISION layer only. PR5
 *  will later consume this pure plan and perform the real Event RPC
 *  orchestration (fn_event_assign_observation / fn_event_supersede_
 *  membership / fn_event_reassign_membership / fn_event_assert_identity_
 *  claim / fn_event_create_cluster_relation / fn_event_create_event_
 *  version) in shadow mode. This module NEVER calls any of them, never
 *  writes to PostgreSQL, never touches worker/cron, never performs fuzzy
 *  clustering, never calls an LLM, never infers Gold impact, never creates
 *  alerts/notifications, and never affects the legacy pipeline.
 *
 *  STRONG IDENTITY BOUNDARY: this processor NEVER derives strong identity
 *  from providerItemId / canonicalUrl / article URL / provider / sourceCode
 *  / sourceDomain / title / summary / content. It only CONSUMES a strong
 *  identity when the caller explicitly supplies one as curated input
 *  (StrongIdentityContext) — it never discovers or infers one.
 *
 *  CLUSTER DISPOSITION — PRECISION FIRST: there is no fuzzy identity logic
 *  here. Title/summary similarity, Levenshtein, embeddings, tokens/
 *  keywords, publication-time proximity, same provider, same URL, same
 *  category are NEVER used to assign an existing cluster. Absent an
 *  explicit curated strong-identity match, every observation independently
 *  plans CREATE_NEW_CLUSTER with a deterministic INTERNAL provisional
 *  cluster-key (`provisional:<observation-id>`) — never a strong identity,
 *  never written to event_cluster_identity_claims, existing only to make
 *  cluster creation deterministic/retryable for PR5.
 *
 *  KNOWLEDGE CUTOFF BOUNDARY: this processor does not yet know the
 *  persisted membership assigned_at, so it never returns a final database
 *  knowledge_cutoff — only knowledgeCutoffFloor = MAX(observedAt,
 *  ingestedAt) of the observation itself. PR5 must derive the final RPC
 *  cutoff as at least MAX(knowledgeCutoffFloor, membership.assigned_at).
 *
 *  EFFECTIVE TIME — CONSERVATIVE V1: always null/null. publishedAt/
 *  publishedDate/providerPublishedRaw/observedAt/ingestedAt never become
 *  effectiveTime here — publication time is not necessarily event
 *  effective time. A future source-specific deterministic parser may add
 *  effective-time semantics in a separate PR.
 *
 *  REVERSAL: never emitted in PR4 v1. No lexical/keyword inference from
 *  words such as "reversed"/"cancelled"/"withdrawn"/"rescinded" — REVERSAL
 *  requires future explicit curated deterministic rules (out of scope
 *  here).
 * =============================================================================
 */

export const OPS023_EVENT_PROCESSOR_VERSION = 'ops023-deterministic-event-processor-v1';

// ---------------------------------------------------------------------------
// 1. Persisted RAW input contract (public.news_articles row shape, camelCase)
// ---------------------------------------------------------------------------

export type IngestQualityState = 'VALID' | 'DEGRADED' | 'UNVERIFIED';

/**
 * publishedAt/publishedDate are PUBLICATION metadata only. They are NEVER
 * knowledge-availability time and NEVER become effectiveTime. Knowledge
 * availability comes from observedAt/ingestedAt here, and later from
 * membership assigned_at in PR5.
 */
export interface PersistedRawObservation {
  readonly id: string;
  readonly provider: string;
  readonly providerItemId: string | null;
  readonly sourceCode: string;
  readonly sourceDomain: string | null;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly content: string | null;
  readonly providerCategory: string | null;
  readonly publishedAt: string | null;
  readonly publishedDate: string | null;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly ingestQualityState: IngestQualityState;
  readonly ingestQualityReasons: readonly string[];
}

// ---------------------------------------------------------------------------
// 2. Verified official source registry — EXACT tuples only, no suffix
//    matching, no single-field proof. These four sources only; GDELT/
//    NewsAPI are explicitly out of scope for PR4.
// ---------------------------------------------------------------------------

export type OfficialAuthority = 'FEDERAL_RESERVE' | 'ECB' | 'US_TREASURY' | 'OFAC';

interface OfficialSourceTuple {
  readonly authority: OfficialAuthority;
  readonly provider: string;
  readonly sourceCode: string;
  readonly sourceDomain: string;
}

const OFFICIAL_SOURCES: readonly OfficialSourceTuple[] = [
  { authority: 'FEDERAL_RESERVE', provider: 'federal_reserve', sourceCode: 'federalreserve', sourceDomain: 'federalreserve.gov' },
  { authority: 'ECB', provider: 'ecb', sourceCode: 'ecb', sourceDomain: 'ecb.europa.eu' },
  { authority: 'US_TREASURY', provider: 'us_treasury', sourceCode: 'us_treasury', sourceDomain: 'home.treasury.gov' },
  { authority: 'OFAC', provider: 'ofac', sourceCode: 'ofac', sourceDomain: 'ofac.treasury.gov' },
];

const OFFICIAL_SOURCES_BY_SOURCE_CODE: ReadonlyMap<string, OfficialSourceTuple> = new Map(
  OFFICIAL_SOURCES.map((tuple) => [tuple.sourceCode, tuple]),
);

const AUTHORITY_CODE: Readonly<Record<OfficialAuthority, string>> = {
  FEDERAL_RESERVE: 'federal_reserve',
  ECB: 'ecb',
  US_TREASURY: 'us_treasury',
  OFAC: 'ofac',
};

type OfficialSourceVerification =
  | { readonly ok: true; readonly tuple: OfficialSourceTuple }
  | { readonly ok: false; readonly reason: 'SOURCE_CONTRACT_MISMATCH' | 'UNSUPPORTED_SOURCE' };

/**
 * Exact tuple verification only. A known sourceCode with a mismatching
 * provider or sourceDomain is a SPOOF attempt (SOURCE_CONTRACT_MISMATCH),
 * never silently accepted or silently downgraded to "unknown".
 */
function verifyOfficialSource(observation: PersistedRawObservation): OfficialSourceVerification {
  const known = OFFICIAL_SOURCES_BY_SOURCE_CODE.get(observation.sourceCode);
  if (known === undefined) {
    return { ok: false, reason: 'UNSUPPORTED_SOURCE' };
  }
  if (observation.provider !== known.provider || observation.sourceDomain !== known.sourceDomain) {
    return { ok: false, reason: 'SOURCE_CONTRACT_MISMATCH' };
  }
  return { ok: true, tuple: known };
}

// ---------------------------------------------------------------------------
// 3. Quality gate
// ---------------------------------------------------------------------------

const DEGRADED_REASON_ALLOWLIST: ReadonlySet<string> = new Set([
  'publication_timestamp_parse_failed',
  'publication_date_parse_failed',
  'publication_precision_unknown',
]);

/**
 * Fails CLOSED on any contradictory or unrecognized state — never silently
 * repairs malformed quality state (VALID+reasons, DEGRADED+no reasons, or
 * an ingestQualityState outside the known three values).
 */
function passesQualityGate(observation: PersistedRawObservation): boolean {
  const reasons = observation.ingestQualityReasons;
  switch (observation.ingestQualityState) {
    case 'VALID':
      return reasons.length === 0;
    case 'DEGRADED':
      if (reasons.length === 0) return false;
      return reasons.every((reason) => DEGRADED_REASON_ALLOWLIST.has(reason));
    case 'UNVERIFIED':
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 4. Deterministic timestamp validation (supplied strings only — never the
//    application clock). Self-contained: does not import raw_news.ts, to
//    keep this domain layer fully independent.
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
 * Strict ISO 8601 with explicit timezone (Z or numeric offset), real civil
 * date + real time-of-day required BEFORE any Date.parse call — Date.parse
 * is used only to convert an already-validated string to an epoch instant,
 * never to decide validity itself.
 */
function parseStrictIsoTimestampToEpochMs(value: string): number | null {
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  if (!isValidCivilDate(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (tz !== 'Z' && !isValidNumericOffset(tz)) return null;

  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * knowledgeCutoffFloor = MAX(observedAt, ingestedAt) of THIS observation
 * only — never publishedAt/publishedDate, never Date.now(). Returns null
 * on invalid input (caller must abstain DATA_QUALITY_INSUFFICIENT).
 */
function computeKnowledgeCutoffFloor(observation: PersistedRawObservation): string | null {
  const observedMs = parseStrictIsoTimestampToEpochMs(observation.observedAt);
  const ingestedMs = parseStrictIsoTimestampToEpochMs(observation.ingestedAt);
  if (observedMs === null || ingestedMs === null) return null;
  const maxMs = Math.max(observedMs, ingestedMs);
  return new Date(maxMs).toISOString();
}

// ---------------------------------------------------------------------------
// 5. Official editorial lineage — an EDITORIAL lineage assertion, never a
//    strong event identity. providerItemId/canonicalUrl/title never become
//    editorialOriginKey.
// ---------------------------------------------------------------------------

export type LineageResolutionMethod = 'DIRECT_OFFICIAL_SOURCE';

export interface OfficialLineage {
  readonly editorialOriginKey: string;
  readonly wireLineageKey: null;
  readonly lineageResolutionMethod: LineageResolutionMethod;
  readonly lineageResolutionConfidence: 1;
}

function deriveOfficialLineage(tuple: OfficialSourceTuple): OfficialLineage {
  return {
    editorialOriginKey: `official:${AUTHORITY_CODE[tuple.authority]}`,
    wireLineageKey: null,
    lineageResolutionMethod: 'DIRECT_OFFICIAL_SOURCE',
    lineageResolutionConfidence: 1,
  };
}

// ---------------------------------------------------------------------------
// 6. Generic source-independence resolver — pure, exported. Operates on the
//    COMPLETE active evidence-lineage set. Never derived from provider
//    count, sourceCode count, sourceDomain count, or article count.
// ---------------------------------------------------------------------------

export type SourceIndependenceState =
  | 'UNKNOWN'
  | 'SINGLE_EDITORIAL_ORIGIN'
  | 'SYNDICATED_ONLY'
  | 'INDEPENDENTLY_CORROBORATED';

export interface EvidenceLineageItem {
  readonly editorialOriginKey: string | null;
  readonly wireLineageKey: string | null;
}

function isResolvedOriginKey(key: string | null): key is string {
  return key !== null && key.trim().length > 0;
}

export function resolveSourceIndependence(
  evidenceLineages: readonly EvidenceLineageItem[],
): SourceIndependenceState {
  if (evidenceLineages.length === 0) {
    return 'UNKNOWN';
  }
  if (evidenceLineages.some((item) => !isResolvedOriginKey(item.editorialOriginKey))) {
    return 'UNKNOWN';
  }

  const distinctOrigins = new Set(evidenceLineages.map((item) => item.editorialOriginKey as string));
  if (distinctOrigins.size === 1) {
    return 'SINGLE_EDITORIAL_ORIGIN';
  }

  const distinctWireKeys = new Set(evidenceLineages.map((item) => item.wireLineageKey));
  const allShareOneNonNullWireKey = distinctWireKeys.size === 1 && [...distinctWireKeys][0] !== null;
  if (allShareOneNonNullWireKey) {
    return 'SYNDICATED_ONLY';
  }

  return 'INDEPENDENTLY_CORROBORATED';
}

// ---------------------------------------------------------------------------
// 7. Strong identity boundary — consumed only when explicitly curated by
//    the caller, never discovered from observation fields.
// ---------------------------------------------------------------------------

export type StrongIdentityContext =
  | { readonly kind: 'NONE' }
  | {
      readonly kind: 'CURATED_STRONG_IDENTITY';
      readonly authorityNamespace: string;
      readonly identityType: string;
      readonly identityValue: string;
      readonly candidateClusterIds: readonly string[];
    };

export interface StrongIdentityClaimProposal {
  readonly authorityNamespace: string;
  readonly identityType: string;
  readonly identityValue: string;
}

// ---------------------------------------------------------------------------
// 8. Event type v1 — frozen mapping, current official collector categories
//    only. Unknown/blank categories always abstain, never guessed.
// ---------------------------------------------------------------------------

export type EventType =
  | 'MONETARY_POLICY_COMMUNICATION'
  | 'OFFICIAL_SPEECH'
  | 'CENTRAL_BANK_COMMUNICATION'
  | 'STATISTICAL_RELEASE'
  | 'OFFICIAL_PRESS_RELEASE'
  | 'SANCTIONS_ACTION';

function resolveEventType(authority: OfficialAuthority, providerCategory: string | null): EventType | null {
  const category = providerCategory === null ? null : providerCategory.trim();

  switch (authority) {
    case 'FEDERAL_RESERVE':
      if (category === 'monetary_policy_press_release') return 'MONETARY_POLICY_COMMUNICATION';
      if (category === 'speech') return 'OFFICIAL_SPEECH';
      return null;
    case 'ECB':
      if (category === 'press_communication') return 'CENTRAL_BANK_COMMUNICATION';
      if (category === 'statistical_press_release') return 'STATISTICAL_RELEASE';
      return null;
    case 'US_TREASURY':
      if (category === 'press_release') return 'OFFICIAL_PRESS_RELEASE';
      return null;
    case 'OFAC':
      // OFAC Recent Actions listing category is dynamic (free text) — any
      // non-blank verified category maps to SANCTIONS_ACTION; blank/null
      // always abstains, never guessed.
      if (category !== null && category.length > 0) return 'SANCTIONS_ACTION';
      return null;
  }
}

// ---------------------------------------------------------------------------
// 8bis. EVENT ELIGIBILITY PRECISION GATE — ECB broad press_communication
//   only, V1.
//
//   LIVE DEFECT THIS CLOSES: ECB's `press.html` RSS feed (providerCategory
//   'press_communication') is broad — public-outreach items (a real
//   persisted example: "ECB and Frankfurt Radio Symphony invite the public
//   to Europa Open Air concert on 20 August 2026") were previously accepted
//   into Event Version as event_type=CENTRAL_BANK_COMMUNICATION, exactly
//   like a genuine monetary-policy communication. Accuracy is prioritized
//   over coverage: a non-eligible or unresolved ECB press_communication
//   item now fails CLOSED via an explicit ABSTAIN
//   (EVENT_ELIGIBILITY_UNRESOLVED), never silently mapped to
//   UNSUPPORTED_SOURCE and never silently processed.
//
//   SCOPE: applies ONLY to ECB authority + providerCategory
//   'press_communication' (i.e. only where resolveEventType() above would
//   otherwise resolve CENTRAL_BANK_COMMUNICATION). ECB
//   'statistical_press_release' (STATISTICAL_RELEASE) is UNCHANGED —
//   remains eligible unconditionally, exactly as before this gate.
//   FEDERAL_RESERVE/US_TREASURY/OFAC categories are UNCHANGED. This gate
//   does NOT redesign Event Types and is NOT Event Facts V2 — it is a
//   narrow precision filter inserted between source/quality validation and
//   Event Type resolution.
//
//   DETERMINISTIC EVIDENCE ONLY — no fuzzy similarity, no embeddings, no
//   LLM, no relevance scoring, no inference from publication time:
//     (a) canonicalUrl parses to a URL whose hostname is EXACTLY
//         ecb.europa.eu (never a substring/suffix match — closes a
//         spoofing vector where a non-ECB hostname could otherwise gain
//         eligibility from an ECB-looking path), AND its pathname starts
//         with one of a small, explicit set of URL path families known to
//         represent structurally substantive central-bank communication
//         (speeches, interviews, meeting accounts, the monetary policy
//         statement / press conference); OR
//     (b) the SAME hostname-verified canonicalUrl, combined with a title
//         that starts with one of a small, explicit set of known recurring
//         macro/monetary release title prefixes (the generic `/press/pr/`
//         family carries these alongside non-eligible items, so title
//         evidence — not the path alone — is what narrows it).
//   canonicalUrl is used ONLY as structural routing evidence here — never
//   as strong event identity, never to derive a cluster identity (the
//   existing strong-identity boundary in §7 above is untouched).
// ---------------------------------------------------------------------------

const ECB_EXPECTED_HOSTNAME = 'ecb.europa.eu';
const ECB_EXPECTED_HOSTNAME_SUFFIX = '.ecb.europa.eu';

/** URL path families that alone represent structurally substantive ECB
 *  central-bank communication, regardless of title wording. */
const ECB_STRUCTURALLY_ELIGIBLE_PATH_PREFIXES: readonly string[] = [
  '/press/key/',
  '/press/inter/',
  '/press/accounts/',
  '/press/press_conference/monetary-policy-statement/',
];

/** Narrowly-defined recurring macro/monetary release TITLE prefixes found
 *  under the generic `/press/pr/` family, where evidence is explicit.
 *  Extending this list requires the same precision-first review discipline
 *  as the list itself — never a broad keyword/fuzzy rule. */
const ECB_RECURRING_RELEASE_TITLE_PREFIXES: readonly string[] = [
  'Monetary policy decisions',
  'ECB Consumer Expectations Survey results',
  'ECB wage tracker',
  'ECB publishes consolidated banking data',
];

interface EcbUrlEvidence {
  readonly hostnameVerified: boolean;
  readonly pathname: string | null;
}

/** Deterministic parse, mirroring the SAME hostname validation already
 *  established and reviewed in the ECB RAW collector
 *  (backend/news_sources/ecb.ts validateEcbUrl): https: only, hostname is
 *  EXACTLY ecb.europa.eu OR a genuine subdomain (*.ecb.europa.eu, e.g. the
 *  real production www.ecb.europa.eu) — checked with a leading-dot suffix
 *  match, never a bare substring/suffix check that a spoofed hostname
 *  (e.g. "ecb.europa.eu.attacker.example" or "notecb.europa.eu") could
 *  pass. An unparseable URL, a non-https scheme, or a non-matching
 *  hostname yields zero structural evidence. */
function parseEcbUrlEvidence(canonicalUrl: string | null): EcbUrlEvidence {
  if (canonicalUrl === null) return { hostnameVerified: false, pathname: null };
  let parsed: URL;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    return { hostnameVerified: false, pathname: null };
  }
  if (parsed.protocol !== 'https:') {
    return { hostnameVerified: false, pathname: null };
  }
  const host = parsed.hostname.toLowerCase();
  const isEcbHost = host === ECB_EXPECTED_HOSTNAME || host.endsWith(ECB_EXPECTED_HOSTNAME_SUFFIX);
  if (!isEcbHost) {
    return { hostnameVerified: false, pathname: null };
  }
  return { hostnameVerified: true, pathname: parsed.pathname };
}

function isEcbStructurallyEligiblePath(pathname: string): boolean {
  return ECB_STRUCTURALLY_ELIGIBLE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isEcbRecurringReleaseTitle(title: string): boolean {
  const normalized = normalizeWhitespace(title);
  return ECB_RECURRING_RELEASE_TITLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

type EcbEligibilityDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

/** Applies ONLY when authority=ECB and providerCategory=press_communication
 *  (i.e. resolveEventType() would otherwise return CENTRAL_BANK_
 *  COMMUNICATION). Both branches require hostname-verified canonicalUrl —
 *  a title-pattern match alone, with no genuine ecb.europa.eu URL to
 *  corroborate it, is NOT eligible. */
function resolveEcbPressCommunicationEligibility(
  observation: PersistedRawObservation,
): EcbEligibilityDecision {
  const evidence = parseEcbUrlEvidence(observation.canonicalUrl);
  if (!evidence.hostnameVerified) {
    return {
      eligible: false,
      reason: 'ECB press_communication item has no canonicalUrl verifiable against the expected ecb.europa.eu hostname.',
    };
  }
  if (evidence.pathname !== null && isEcbStructurallyEligiblePath(evidence.pathname)) {
    return { eligible: true };
  }
  if (isEcbRecurringReleaseTitle(observation.title)) {
    return { eligible: true };
  }
  return {
    eligible: false,
    reason: 'ECB press_communication item matches neither a known structurally-eligible URL path family nor a narrowly-defined recurring macro/monetary release title pattern.',
  };
}

// ---------------------------------------------------------------------------
// 9. Canonical Event State v1 — coarse factual state only. No provenance/
//    IDs/URLs/timestamps, no Gold analytical fields.
// ---------------------------------------------------------------------------

export const CANONICAL_EVENT_STATE_SCHEMA_VERSION = 1 as const;

export interface CanonicalEventState {
  readonly event_type: EventType;
  readonly subject: string;
  readonly detail: string | null;
}

/** Trim outer whitespace, collapse internal whitespace runs to one ASCII
 *  space, preserve case/wording — never a semantic rewrite, never a
 *  translation. */
function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function resolveDetail(content: string | null, summary: string | null): string | null {
  if (content !== null) {
    const normalized = normalizeWhitespace(content);
    if (normalized.length > 0) return normalized;
  }
  if (summary !== null) {
    const normalized = normalizeWhitespace(summary);
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function buildCanonicalEventState(eventType: EventType, observation: PersistedRawObservation): CanonicalEventState {
  return {
    event_type: eventType,
    subject: normalizeWhitespace(observation.title),
    detail: resolveDetail(observation.content, observation.summary),
  };
}

function canonicalEventStatesEqual(a: CanonicalEventState, b: CanonicalEventState): boolean {
  return a.event_type === b.event_type && a.subject === b.subject && a.detail === b.detail;
}

// ---------------------------------------------------------------------------
// 10. Official confirmation state vocabulary (frozen, 0012). OFFICIALLY_
//     REVERSED is never emitted by PR4.
// ---------------------------------------------------------------------------

export type OfficialConfirmationState =
  | 'UNCONFIRMED'
  | 'SECONDARY_CONFIRMED'
  | 'OFFICIALLY_CONFIRMED'
  | 'OFFICIALLY_CORRECTED'
  | 'OFFICIALLY_REVERSED';

function resolveConfirmationUpgrade(previous: OfficialConfirmationState): OfficialConfirmationState {
  if (previous === 'UNCONFIRMED' || previous === 'SECONDARY_CONFIRMED') {
    return 'OFFICIALLY_CONFIRMED';
  }
  return previous;
}

// ---------------------------------------------------------------------------
// 11. Prior cluster / version context supplied by the caller.
// ---------------------------------------------------------------------------

export interface PreviousEventVersionContext {
  readonly eventVersionId: string;
  readonly canonicalEventState: CanonicalEventState;
  readonly effectiveTime: string | null;
  readonly effectiveTimePrecision: string | null;
  readonly officialConfirmationState: OfficialConfirmationState;
  readonly sourceIndependenceState: SourceIndependenceState;
}

export interface PriorClusterContext {
  readonly clusterId: string;
  readonly previousVersion: PreviousEventVersionContext | null;
  readonly activeEvidenceLineages: readonly EvidenceLineageItem[];
}

// ---------------------------------------------------------------------------
// 12. Event Processing Plan — discriminated union output.
// ---------------------------------------------------------------------------

export type ClusterDisposition = 'CREATE_NEW_CLUSTER' | 'ASSIGN_EXISTING';
export type VersionDisposition = 'CREATE_VERSION' | 'NO_MATERIAL_CHANGE';
export type Transition = 'NOVELTY' | 'CONFIRMATION' | 'CORRECTION' | null;

export interface LineageProposal {
  readonly editorialOriginKey: string;
  readonly wireLineageKey: string | null;
  readonly lineageResolutionMethod: LineageResolutionMethod;
  readonly lineageResolutionConfidence: 1;
}

export interface ProcessPlan {
  readonly kind: 'PROCESS';
  readonly processorVersion: string;
  readonly observationId: string;

  readonly clusterDisposition: ClusterDisposition;
  readonly resolvedClusterId: string | null;
  readonly provisionalClusterKey: string | null;
  readonly clusterCategory: EventType;
  readonly clusterRegion: null;

  readonly lineage: LineageProposal;
  readonly strongIdentityClaimProposal: StrongIdentityClaimProposal | null;

  readonly canonicalEventStateSchemaVersion: typeof CANONICAL_EVENT_STATE_SCHEMA_VERSION;
  readonly canonicalEventState: CanonicalEventState;
  readonly effectiveTime: null;
  readonly effectiveTimePrecision: null;

  readonly officialConfirmationState: OfficialConfirmationState;
  readonly sourceIndependenceState: SourceIndependenceState;

  readonly versionDisposition: VersionDisposition;
  readonly transition: Transition;
  readonly previousEventVersionId: string | null;

  readonly knowledgeCutoffFloor: string;
}

export type AbstentionCategory =
  | 'UNSUPPORTED_SOURCE'
  | 'SOURCE_CONTRACT_MISMATCH'
  | 'DATA_QUALITY_INSUFFICIENT'
  | 'SIGNAL_CONFLICT'
  | 'INVALID_CLUSTER_CONTEXT'
  | 'UNSUPPORTED_OFFICIAL_CATEGORY'
  | 'INVALID_INPUT'
  // Event eligibility precision gate (§8bis) — a source/category-verified,
  // quality-passing observation whose deterministic structural evidence
  // (URL path family / recurring-release title pattern) does not clear the
  // gate. Never silently folded into UNSUPPORTED_SOURCE or
  // UNSUPPORTED_OFFICIAL_CATEGORY, both of which mean something different
  // (the source/category itself was rejected, not that a specific item
  // within an otherwise-accepted category failed a precision check).
  | 'EVENT_ELIGIBILITY_UNRESOLVED';

export interface AbstainPlan {
  readonly kind: 'ABSTAIN';
  readonly processorVersion: string;
  readonly observationId: string | null;
  readonly abstention: AbstentionCategory;
  readonly reason: string;
}

export type EventProcessingPlan = ProcessPlan | AbstainPlan;

function abstain(
  observationId: string | null,
  abstention: AbstentionCategory,
  reason: string,
): AbstainPlan {
  return {
    kind: 'ABSTAIN',
    processorVersion: OPS023_EVENT_PROCESSOR_VERSION,
    observationId,
    abstention,
    reason,
  };
}

// ---------------------------------------------------------------------------
// 13. Main entry point.
// ---------------------------------------------------------------------------

export interface ProcessObservationInput {
  readonly observation: PersistedRawObservation;
  readonly strongIdentity: StrongIdentityContext;
  readonly clusterContext: PriorClusterContext | null;
}

export function planEventProcessing(input: ProcessObservationInput): EventProcessingPlan {
  const { observation, strongIdentity, clusterContext } = input;

  // ---- Source/provenance validity (exact tuple only) ----------------------
  const sourceVerification = verifyOfficialSource(observation);
  if (!sourceVerification.ok) {
    return abstain(observation.id, sourceVerification.reason, sourceVerification.reason);
  }
  const tuple = sourceVerification.tuple;

  // ---- RAW quality eligibility --------------------------------------------
  if (!passesQualityGate(observation)) {
    return abstain(observation.id, 'DATA_QUALITY_INSUFFICIENT', 'QUALITY_GATE_REJECTED');
  }

  // ---- Temporal input validity (knowledge cutoff floor) -------------------
  const knowledgeCutoffFloor = computeKnowledgeCutoffFloor(observation);
  if (knowledgeCutoffFloor === null) {
    return abstain(observation.id, 'DATA_QUALITY_INSUFFICIENT', 'TEMPORAL_INPUT_INVALID');
  }

  // ---- Event type v1 --------------------------------------------------------
  const eventType = resolveEventType(tuple.authority, observation.providerCategory);
  if (eventType === null) {
    return abstain(observation.id, 'UNSUPPORTED_OFFICIAL_CATEGORY', 'UNSUPPORTED_OFFICIAL_CATEGORY');
  }

  // ---- Event eligibility precision gate (§8bis) — ECB broad
  // press_communication only. STATISTICAL_RELEASE and every other
  // authority/category combination are unaffected.
  if (tuple.authority === 'ECB' && eventType === 'CENTRAL_BANK_COMMUNICATION') {
    const eligibility = resolveEcbPressCommunicationEligibility(observation);
    if (!eligibility.eligible) {
      return abstain(observation.id, 'EVENT_ELIGIBILITY_UNRESOLVED', eligibility.reason);
    }
  }

  // ---- Official editorial lineage ------------------------------------------
  const officialLineage = deriveOfficialLineage(tuple);
  const lineageProposal: LineageProposal = {
    editorialOriginKey: officialLineage.editorialOriginKey,
    wireLineageKey: officialLineage.wireLineageKey,
    lineageResolutionMethod: officialLineage.lineageResolutionMethod,
    lineageResolutionConfidence: officialLineage.lineageResolutionConfidence,
  };

  // ---- Strong identity boundary (curated-only) -----------------------------
  let clusterDisposition: ClusterDisposition;
  let resolvedClusterId: string | null;
  let strongIdentityClaimProposal: StrongIdentityClaimProposal | null;

  if (strongIdentity.kind === 'NONE') {
    clusterDisposition = 'CREATE_NEW_CLUSTER';
    resolvedClusterId = null;
    strongIdentityClaimProposal = null;
  } else {
    const { authorityNamespace, identityType, identityValue, candidateClusterIds } = strongIdentity;
    if (
      authorityNamespace.trim().length === 0
      || identityType.trim().length === 0
      || identityValue.trim().length === 0
    ) {
      return abstain(observation.id, 'INVALID_INPUT', 'STRONG_IDENTITY_CONTEXT_INVALID');
    }

    if (candidateClusterIds.length === 0) {
      // No existing cluster resolves this curated identity yet: propose
      // a fresh identity-claim assertion alongside the new cluster.
      clusterDisposition = 'CREATE_NEW_CLUSTER';
      resolvedClusterId = null;
      strongIdentityClaimProposal = { authorityNamespace, identityType, identityValue };
    } else if (candidateClusterIds.length === 1) {
      // The curated identity ALREADY resolves to one existing cluster —
      // the active identity claim behind that resolution is precisely
      // what produced this single candidate. Proposing a new assertion
      // here would have PR5 call fn_event_assert_identity_claim again for
      // the same active key/cluster, which PR2C correctly rejects as a
      // duplicate active identity claim. No new proposal is emitted.
      clusterDisposition = 'ASSIGN_EXISTING';
      resolvedClusterId = candidateClusterIds[0];
      strongIdentityClaimProposal = null;
    } else {
      // Never choose a winner, never auto-MERGE.
      return abstain(observation.id, 'SIGNAL_CONFLICT', 'IDENTITY_COLLISION');
    }
  }

  // ---- Canonical Event State v1 ---------------------------------------------
  const canonicalEventState = buildCanonicalEventState(eventType, observation);

  // ---- Cluster context validation (ASSIGN_EXISTING only) --------------------
  let resolvedClusterContext: PriorClusterContext | null = null;
  if (clusterDisposition === 'ASSIGN_EXISTING') {
    if (clusterContext === null || clusterContext.clusterId !== resolvedClusterId) {
      return abstain(observation.id, 'INVALID_CLUSTER_CONTEXT', 'INVALID_CLUSTER_CONTEXT');
    }
    resolvedClusterContext = clusterContext;
  }
  // For CREATE_NEW_CLUSTER, any supplied clusterContext.previousVersion is
  // deliberately never consulted below.

  // ---- Source independence over the COMPLETE active evidence-lineage set ---
  const priorLineages: readonly EvidenceLineageItem[] = resolvedClusterContext?.activeEvidenceLineages ?? [];
  const completeEvidenceLineages: readonly EvidenceLineageItem[] = [
    ...priorLineages,
    { editorialOriginKey: officialLineage.editorialOriginKey, wireLineageKey: officialLineage.wireLineageKey },
  ];
  const sourceIndependenceState = resolveSourceIndependence(completeEvidenceLineages);

  // ---- Transition / materiality domain decision ------------------------------
  const previousVersion = resolvedClusterContext?.previousVersion ?? null;

  let versionDisposition: VersionDisposition;
  let transition: Transition;
  let officialConfirmationState: OfficialConfirmationState;
  let previousEventVersionId: string | null;

  if (previousVersion === null) {
    // A) No predecessor (fresh cluster, or an existing cluster with no
    // Event Version yet).
    versionDisposition = 'CREATE_VERSION';
    transition = 'NOVELTY';
    officialConfirmationState = 'OFFICIALLY_CONFIRMED';
    previousEventVersionId = null;
  } else {
    const factsIdentical =
      canonicalEventStatesEqual(canonicalEventState, previousVersion.canonicalEventState)
      && previousVersion.effectiveTime === null
      && previousVersion.effectiveTimePrecision === null;

    if (factsIdentical) {
      // B) Facts/effective time unchanged.
      const upgradedOfficialConfirmationState = resolveConfirmationUpgrade(previousVersion.officialConfirmationState);
      const officialChanged = upgradedOfficialConfirmationState !== previousVersion.officialConfirmationState;
      const independenceChanged = sourceIndependenceState !== previousVersion.sourceIndependenceState;

      if (officialChanged || independenceChanged) {
        versionDisposition = 'CREATE_VERSION';
        transition = 'CONFIRMATION';
        officialConfirmationState = upgradedOfficialConfirmationState;
        previousEventVersionId = previousVersion.eventVersionId;
      } else {
        versionDisposition = 'NO_MATERIAL_CHANGE';
        transition = null;
        officialConfirmationState = previousVersion.officialConfirmationState;
        previousEventVersionId = previousVersion.eventVersionId;
      }
    } else {
      // C)/D) Canonical facts differ. CORRECTION is allowed ONLY when the
      // PRIOR active evidence (excluding this new observation) has exactly
      // one resolved distinct editorial origin, equal to this observation's.
      const priorResolvedOrigins = new Set(
        priorLineages
          .filter((item) => isResolvedOriginKey(item.editorialOriginKey))
          .map((item) => item.editorialOriginKey as string),
      );
      const priorHasUnresolvedOrigin = priorLineages.some((item) => !isResolvedOriginKey(item.editorialOriginKey));
      const singleMatchingPriorOrigin =
        !priorHasUnresolvedOrigin
        && priorResolvedOrigins.size === 1
        && [...priorResolvedOrigins][0] === officialLineage.editorialOriginKey;

      if (singleMatchingPriorOrigin) {
        versionDisposition = 'CREATE_VERSION';
        transition = 'CORRECTION';
        officialConfirmationState = 'OFFICIALLY_CORRECTED';
        previousEventVersionId = previousVersion.eventVersionId;
      } else {
        // Never overwrite the previous state on a conflicting factual claim.
        return abstain(observation.id, 'SIGNAL_CONFLICT', 'FACTUAL_CONFLICT');
      }
    }
  }

  return {
    kind: 'PROCESS',
    processorVersion: OPS023_EVENT_PROCESSOR_VERSION,
    observationId: observation.id,

    clusterDisposition,
    resolvedClusterId,
    provisionalClusterKey: clusterDisposition === 'CREATE_NEW_CLUSTER' ? `provisional:${observation.id}` : null,
    clusterCategory: eventType,
    clusterRegion: null,

    lineage: lineageProposal,
    strongIdentityClaimProposal,

    canonicalEventStateSchemaVersion: CANONICAL_EVENT_STATE_SCHEMA_VERSION,
    canonicalEventState,
    effectiveTime: null,
    effectiveTimePrecision: null,

    officialConfirmationState,
    sourceIndependenceState,

    versionDisposition,
    transition,
    previousEventVersionId,

    knowledgeCutoffFloor,
  };
}
