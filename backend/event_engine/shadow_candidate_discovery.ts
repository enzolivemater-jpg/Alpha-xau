/**
 * =============================================================================
 *  ALPHA-XAU — backend/event_engine/shadow_candidate_discovery.ts
 *
 *  OPS-023 PR8 — Deterministic, READ-ONLY Candidate Discovery (V1).
 *
 *  Answers exactly one question: "which RAW observations are safe and
 *  necessary to send into the already-proven PR7/PR6/PR5 Event Shadow
 *  path?" — and NEVER executes that decision. This module NEVER calls
 *  runEventShadowBatch, NEVER calls processEventShadowObservation, NEVER
 *  calls any Event mutation RPC, and NEVER imports shadow_runtime.ts /
 *  shadow_batch.ts / shadow_orchestrator.ts / deterministic_processor.ts —
 *  it is the boundary between PR7 (explicit operator-supplied observation
 *  IDs) and future automatic orchestration, never a part of either side.
 *
 *  SIDE-EFFECT FREE except for READ-ONLY injected DB requests: no
 *  Supabase client instantiated here, no environment variable read here,
 *  no fetch() here, no Date.now()/new Date() current clock, no
 *  Math.random()/crypto-generated random value. Same two RPC responses
 *  always produce the exact same discovery result.
 *
 *  STATE-DERIVED, NEVER A CURSOR (deliberate) : this module holds no
 *  watermark, no "last processed" timestamp, no persisted scan position.
 *  The live PR7 recovery incident (membership committed, Event Version
 *  missing, for all four founding observations) proved that a time-based
 *  cursor can move past an incomplete observation permanently — the
 *  observation would never be reconsidered. Discovery therefore reads the
 *  Event state itself (backend/event_engine/../../database/migrations/
 *  0022_event_shadow_candidate_discovery.sql, fn_event_shadow_discover_
 *  candidates) via exactly two read-only RPC calls, one per lane:
 *
 *    RECOVERY — an eligible RAW observation with EXACTLY one PR5-compatible
 *    founding membership decision, still current, not yet referenced by
 *    any event_version_evidence row (the exact proven PR5 lost-response /
 *    partial-commit recovery shape).
 *
 *    FRESH — an eligible RAW observation with ZERO event_observation_
 *    memberships rows at all (guarantees PR5 CREATE_NEW_CLUSTER V1
 *    compatibility).
 *
 *  Completed candidates disappear from discovery on their own (Event
 *  state is append-only); partial membership-only failures remain
 *  naturally visible in RECOVERY until an Event Version evidence row
 *  exists for their founding decision. This is the desired state-derived
 *  reconciliation model — no cursor to repair, no watermark to reset.
 *
 *  EXPECTED_PROCESSOR_VERSION / EXPECTED_ORCHESTRATOR_VERSION below are
 *  duplicated LOCAL constants, deliberately never imported from
 *  deterministic_processor.ts / shadow_orchestrator.ts (same discipline
 *  as PR4/PR5's own duplicated timestamp validation: each module owns its
 *  frozen expectations, never a shared reference that could silently
 *  drift). They MUST match the RPC's own returned
 *  expected_processor_version / expected_orchestrator_version constants
 *  (database/migrations/0022_event_shadow_candidate_discovery.sql) — a
 *  mismatch fails discovery closed rather than silently resynchronizing,
 *  forcing an explicit review of this module whenever PR4/PR5 versions
 *  change.
 *
 *  FAIRNESS : the final selection deterministically ALTERNATES
 *  RECOVERY[0], FRESH[0], RECOVERY[1], FRESH[1], ... (recovery first when
 *  both are available) so a persistent recovery backlog can never starve
 *  new RAW observations, and a flood of new observations can never starve
 *  an existing partial-commit recovery. No randomness.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Version identity.
// ---------------------------------------------------------------------------

export const OPS023_EVENT_SHADOW_DISCOVERY_VERSION = 'ops023-event-shadow-candidate-discovery-v1';

/** Mirrors deterministic_processor.ts's OPS023_EVENT_PROCESSOR_VERSION —
 *  deliberately duplicated, never imported. See module header. */
const EXPECTED_PROCESSOR_VERSION = 'ops023-deterministic-event-processor-v1';
/** Mirrors shadow_orchestrator.ts's OPS023_EVENT_SHADOW_ORCHESTRATOR_VERSION —
 *  deliberately duplicated, never imported. See module header. */
const EXPECTED_ORCHESTRATOR_VERSION = 'ops023-event-shadow-orchestrator-v1';

export const MIN_EVENT_SHADOW_DISCOVERY_CANDIDATES = 1;
export const MAX_EVENT_SHADOW_DISCOVERY_CANDIDATES = 25;

const DISCOVERY_RPC_PATH = 'rpc/fn_event_shadow_discover_candidates';

// ---------------------------------------------------------------------------
// Injected structural DB port — compatible with the SAME request<T>()
// shape already established by EventShadowDb/LockCapableDb. READ-ONLY use
// only: this module never issues a PATCH, and its one POST is the
// read-only discovery RPC itself (PostgREST's calling convention for
// STABLE functions with parameters, never a mutation).
// ---------------------------------------------------------------------------

export interface EventShadowDiscoveryDb {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Typed errors — fails closed on any malformed/unexpected RPC response,
// never silently drops or repairs a row.
// ---------------------------------------------------------------------------

export class EventShadowDiscoveryInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventShadowDiscoveryInvariantError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Deterministic strict ISO-8601 timestamp / UUID validation — supplied
// strings only, duplicated locally rather than imported (established
// repo convention; see PR4/PR5's own duplicated timestamp validation).
// Discovery never computes a knowledge cutoff and never compares two
// timestamps against each other — it only needs to know whether a
// SUPPLIED string is a well-formed explicit-timezone ISO-8601 instant,
// so no arithmetic/epoch conversion is implemented here.
// ---------------------------------------------------------------------------

const UUID_LIKE_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && UUID_LIKE_PATTERN.test(value);
}

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

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(trimmed);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, tz] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (!isValidCivilDate(year, month, day)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (tz !== 'Z' && !isValidNumericOffset(tz)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Result shapes.
// ---------------------------------------------------------------------------

export type EventShadowDiscoveryLane = 'FRESH' | 'RECOVERY';

export interface EventShadowCandidate {
  readonly observationId: string;
  readonly lane: EventShadowDiscoveryLane;
  readonly ingestedAt: string;
  readonly clusterId: string | null;
  readonly decisionId: string | null;
  readonly assignedAt: string | null;
}

export interface EventShadowDiscoveryResult {
  readonly version: string;
  readonly maxCandidates: number;
  readonly selected: readonly EventShadowCandidate[];
  readonly selectedObservationIds: readonly string[];
  readonly recoveryFetched: number;
  readonly freshFetched: number;
  readonly recoverySelected: number;
  readonly freshSelected: number;
}

// ---------------------------------------------------------------------------
// Strict RPC row validation — fails closed, never silently drops a
// malformed row and never silently repairs one.
// ---------------------------------------------------------------------------

const EXPECTED_ROW_KEYS: ReadonlySet<string> = new Set([
  'observation_id', 'lane', 'ingested_at', 'cluster_id', 'decision_id',
  'assigned_at', 'expected_processor_version', 'expected_orchestrator_version',
]);

function validateRow(raw: unknown, expectedLane: EventShadowDiscoveryLane): EventShadowCandidate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_RPC_ROW',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned a non-object row.`,
    );
  }
  const row = raw as Record<string, unknown>;

  const keys = Object.keys(row);
  const hasAllExpectedKeys = [...EXPECTED_ROW_KEYS].every((key) => key in row);
  const hasOnlyExpectedKeys = keys.every((key) => EXPECTED_ROW_KEYS.has(key));
  if (!hasAllExpectedKeys || !hasOnlyExpectedKeys) {
    throw new EventShadowDiscoveryInvariantError(
      'UNEXPECTED_ROW_SHAPE',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned a row with an unexpected shape: ${JSON.stringify(keys)}.`,
    );
  }

  if (!isUuidLike(row.observation_id)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_OBSERVATION_ID',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned a malformed observation_id: ${JSON.stringify(row.observation_id)}.`,
    );
  }

  if (row.lane !== expectedLane) {
    throw new EventShadowDiscoveryInvariantError(
      'WRONG_LANE',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned lane=${JSON.stringify(row.lane)} for observationId ${row.observation_id}.`,
    );
  }

  if (!isStrictIsoTimestamp(row.ingested_at)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_INGESTED_AT',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned a malformed ingested_at for observationId ${row.observation_id}: ${JSON.stringify(row.ingested_at)}.`,
    );
  }

  if (row.expected_processor_version !== EXPECTED_PROCESSOR_VERSION) {
    throw new EventShadowDiscoveryInvariantError(
      'PROCESSOR_VERSION_MISMATCH',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned expected_processor_version=${JSON.stringify(row.expected_processor_version)}, this module expects ${EXPECTED_PROCESSOR_VERSION}.`,
    );
  }

  if (row.expected_orchestrator_version !== EXPECTED_ORCHESTRATOR_VERSION) {
    throw new EventShadowDiscoveryInvariantError(
      'ORCHESTRATOR_VERSION_MISMATCH',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned expected_orchestrator_version=${JSON.stringify(row.expected_orchestrator_version)}, this module expects ${EXPECTED_ORCHESTRATOR_VERSION}.`,
    );
  }

  if (expectedLane === 'FRESH') {
    if (row.cluster_id !== null || row.decision_id !== null || row.assigned_at !== null) {
      throw new EventShadowDiscoveryInvariantError(
        'FRESH_ROW_UNEXPECTED_IDENTITY',
        `fn_event_shadow_discover_candidates(FRESH) returned a non-null cluster_id/decision_id/assigned_at for observationId ${row.observation_id}; FRESH must carry zero membership history.`,
      );
    }
    return {
      observationId: row.observation_id,
      lane: 'FRESH',
      ingestedAt: row.ingested_at,
      clusterId: null,
      decisionId: null,
      assignedAt: null,
    };
  }

  // expectedLane === 'RECOVERY'
  if (row.cluster_id === null || row.decision_id === null || row.assigned_at === null) {
    throw new EventShadowDiscoveryInvariantError(
      'RECOVERY_ROW_MISSING_IDENTITY',
      `fn_event_shadow_discover_candidates(RECOVERY) returned a null cluster_id/decision_id/assigned_at for observationId ${row.observation_id}; RECOVERY requires all three.`,
    );
  }
  if (!isUuidLike(row.cluster_id)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_CLUSTER_ID',
      `fn_event_shadow_discover_candidates(RECOVERY) returned a malformed cluster_id for observationId ${row.observation_id}: ${JSON.stringify(row.cluster_id)}.`,
    );
  }
  if (!isUuidLike(row.decision_id)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_DECISION_ID',
      `fn_event_shadow_discover_candidates(RECOVERY) returned a malformed decision_id for observationId ${row.observation_id}: ${JSON.stringify(row.decision_id)}.`,
    );
  }
  if (!isStrictIsoTimestamp(row.assigned_at)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_ASSIGNED_AT',
      `fn_event_shadow_discover_candidates(RECOVERY) returned a malformed assigned_at for observationId ${row.observation_id}: ${JSON.stringify(row.assigned_at)}.`,
    );
  }

  return {
    observationId: row.observation_id,
    lane: 'RECOVERY',
    ingestedAt: row.ingested_at,
    clusterId: row.cluster_id,
    decisionId: row.decision_id,
    assignedAt: row.assigned_at,
  };
}

function validateLaneRows(
  rows: unknown,
  expectedLane: EventShadowDiscoveryLane,
  maxCandidates: number,
): EventShadowCandidate[] {
  if (!Array.isArray(rows)) {
    throw new EventShadowDiscoveryInvariantError(
      'MALFORMED_RPC_RESPONSE',
      `fn_event_shadow_discover_candidates(${expectedLane}) did not return an array.`,
    );
  }
  if (rows.length > maxCandidates) {
    throw new EventShadowDiscoveryInvariantError(
      'TOO_MANY_ROWS_RETURNED',
      `fn_event_shadow_discover_candidates(${expectedLane}) returned ${rows.length} rows, exceeding the requested limit of ${maxCandidates}.`,
    );
  }

  const seen = new Set<string>();
  const result: EventShadowCandidate[] = [];
  for (const raw of rows) {
    const candidate = validateRow(raw, expectedLane);
    if (seen.has(candidate.observationId)) {
      throw new EventShadowDiscoveryInvariantError(
        'DUPLICATE_OBSERVATION_ID',
        `fn_event_shadow_discover_candidates(${expectedLane}) returned observationId ${candidate.observationId} more than once.`,
      );
    }
    seen.add(candidate.observationId);
    result.push(candidate);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fairness composition — deterministic alternation, RECOVERY first when
// both lanes have work, oldest-first order preserved inside each lane.
// Never randomness, never a simple RECOVERY-then-FRESH concatenation
// (which could let a persistent recovery backlog starve new observations).
// ---------------------------------------------------------------------------

function composeAlternating(
  recovery: readonly EventShadowCandidate[],
  fresh: readonly EventShadowCandidate[],
  maxCandidates: number,
): EventShadowCandidate[] {
  const selected: EventShadowCandidate[] = [];
  const rounds = Math.max(recovery.length, fresh.length);
  for (let i = 0; i < rounds && selected.length < maxCandidates; i++) {
    if (i < recovery.length && selected.length < maxCandidates) selected.push(recovery[i]);
    if (i < fresh.length && selected.length < maxCandidates) selected.push(fresh[i]);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export async function discoverEventShadowCandidates(
  db: EventShadowDiscoveryDb,
  maxCandidates: number = MAX_EVENT_SHADOW_DISCOVERY_CANDIDATES,
): Promise<EventShadowDiscoveryResult> {
  if (
    typeof maxCandidates !== 'number'
    || !Number.isInteger(maxCandidates)
    || maxCandidates < MIN_EVENT_SHADOW_DISCOVERY_CANDIDATES
    || maxCandidates > MAX_EVENT_SHADOW_DISCOVERY_CANDIDATES
  ) {
    throw new EventShadowDiscoveryInvariantError(
      'INVALID_MAX_CANDIDATES',
      `maxCandidates must be an integer between ${MIN_EVENT_SHADOW_DISCOVERY_CANDIDATES} and ${MAX_EVENT_SHADOW_DISCOVERY_CANDIDATES}, got ${JSON.stringify(maxCandidates)}.`,
    );
  }

  // RECOVERY is always fetched first — never FRESH first — matching the
  // fairness contract's own precedence (RECOVERY[0] leads the alternation).
  const recoveryRows = await db.request<unknown>('POST', DISCOVERY_RPC_PATH, {
    p_lane: 'RECOVERY',
    p_limit: maxCandidates,
  });
  const freshRows = await db.request<unknown>('POST', DISCOVERY_RPC_PATH, {
    p_lane: 'FRESH',
    p_limit: maxCandidates,
  });

  const recovery = validateLaneRows(recoveryRows, 'RECOVERY', maxCandidates);
  const fresh = validateLaneRows(freshRows, 'FRESH', maxCandidates);

  const recoveryIds = new Set(recovery.map((c) => c.observationId));
  for (const candidate of fresh) {
    if (recoveryIds.has(candidate.observationId)) {
      throw new EventShadowDiscoveryInvariantError(
        'OBSERVATION_ID_IN_BOTH_LANES',
        `observationId ${candidate.observationId} was returned by BOTH the RECOVERY and FRESH discovery lanes.`,
      );
    }
  }

  const selected = composeAlternating(recovery, fresh, maxCandidates);

  return {
    version: OPS023_EVENT_SHADOW_DISCOVERY_VERSION,
    maxCandidates,
    selected,
    selectedObservationIds: selected.map((c) => c.observationId),
    recoveryFetched: recovery.length,
    freshFetched: fresh.length,
    recoverySelected: selected.filter((c) => c.lane === 'RECOVERY').length,
    freshSelected: selected.filter((c) => c.lane === 'FRESH').length,
  };
}
