/**
 * =============================================================================
 *  ALPHA-XAU — backend/event_engine/shadow_batch.ts
 *
 *  OPS-023 PR6 — Controlled Shadow Batch Runner (V1).
 *
 *  The FIRST multi-observation orchestration layer above the merged PR5
 *  single-observation adapter (backend/event_engine/shadow_orchestrator.ts,
 *  imported and reused here, never reimplemented). This module never
 *  duplicates PR4/PR5 logic, never instantiates a Supabase client, never
 *  reads environment variables, and never calls an Event mutation RPC
 *  directly — every Event RPC call stays inside PR5.
 *
 *    explicit observation UUID list (caller-supplied, PR6 never discovers)
 *      -> shared PostgreSQL 'event_shadow' run lock (backend/shared/run_lock.ts,
 *         the SAME mechanism already used by market_engine/news_engine/
 *         ai_committee, never a second locking implementation)
 *      -> sequential processEventShadowObservation() calls, strict caller
 *         order, one at a time (never Promise.all/allSettled)
 *      -> structured per-observation + aggregate report
 *      -> guaranteed lock release
 *
 *  NO AUTOMATIC SELECTION : this module never scans the RAW backlog, never
 *  queries "newest" observations, never builds a cursor/checkpoint, never
 *  uses a time window. The caller supplies the exact observation id list.
 *
 *  NO RUNTIME WIRING YET : this PR does not modify backend/worker.ts or
 *  wrangler.toml. No cron, no fetch route, no deployment.
 *
 *  NO NEW IDEMPOTENCY LOGIC : PR5's fingerprints remain the sole retry
 *  authority. This module adds zero batch-level fingerprint/dedup logic —
 *  a batch is simply a sequence of independent PR5 calls, each already
 *  safe to retry on its own.
 * =============================================================================
 */

import {
  processEventShadowObservation,
  EventShadowInvariantError,
  type EventShadowDb,
  type EventShadowObservationResult,
} from './shadow_orchestrator.js';
import {
  acquireLock,
  releaseLock,
  type LockCapableDb,
  type LockRelease,
} from '../shared/run_lock.js';

export const OPS023_EVENT_SHADOW_BATCH_VERSION = 'ops023-event-shadow-batch-v1';
export const MAX_EVENT_SHADOW_BATCH_SIZE = 25;

const LOCK_ENGINE = 'event_shadow' as const;
const DEFAULT_TRIGGER_TYPE = 'manual';
const MAX_TRIGGER_TYPE_LENGTH = 64;

/**
 * The REAL ingestion_runs.trigger_type CHECK constraint (verified live) —
 * 'cron' | 'manual' | 'webhook' | 'backfill'. This is the application-side
 * mirror of that DB constraint (no migration, no constraint change): any
 * other value would fail acquireLock's INSERT against real PostgreSQL, so
 * it fails closed here instead, before any DB call is ever made.
 */
export type EventShadowTriggerType = 'cron' | 'manual' | 'webhook' | 'backfill';
const SUPPORTED_TRIGGER_TYPES: ReadonlySet<string> = new Set<EventShadowTriggerType>([
  'cron', 'manual', 'webhook', 'backfill',
]);

// ---------------------------------------------------------------------------
// Injected structural DB port — compatible with BOTH the PR5 port
// (EventShadowDb) and the run_lock port (LockCapableDb). Both already share
// the identical `request<T>(method, path, body?, extraHeaders?)` shape, so a
// single structural interface satisfies both without a second locking
// implementation and without any adapter/shim layer.
// ---------------------------------------------------------------------------

export interface EventShadowBatchDb extends EventShadowDb, LockCapableDb {}

// ---------------------------------------------------------------------------
// Typed errors.
// ---------------------------------------------------------------------------

export class EventShadowBusyError extends Error {
  readonly code = 'ALREADY_RUNNING' as const;
  constructor() {
    super('ALREADY_RUNNING: an event_shadow batch run is already in progress.');
    this.name = 'EventShadowBusyError';
  }
}

export class EventShadowBatchInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventShadowBatchInvariantError';
    this.code = code;
  }
}

/** Message d'erreur exploitable quelle que soit la valeur levée — jamais un
 *  secret (clé API/jeton) recopié tel quel, comme dans les autres modules
 *  du dépôt (backend/ingest.ts, committee_orchestrator.ts). Dupliqué
 *  localement à dessein : jamais d'utilitaire de messages d'erreur partagé
 *  entre modules. */
function redactString(value: string): string {
  return value
    .replace(/([?&](?:apiKey|api_key|apikey|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return redactString(`${err.name}: ${err.message}`);
  return redactString(String(err));
}

// ---------------------------------------------------------------------------
// Input validation — BEFORE any DB call (no acquireLock, no reclaim RPC).
// Fails closed: never silently normalizes, drops, truncates, sorts, or
// deduplicates. Caller order is preserved exactly.
// ---------------------------------------------------------------------------

const UUID_LIKE_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function validateBatchInput(observationIds: readonly string[], triggerType: string): void {
  if (observationIds.length === 0) {
    throw new EventShadowBatchInvariantError(
      'EMPTY_OBSERVATION_LIST',
      'observationIds must contain at least 1 UUID.',
    );
  }
  if (observationIds.length > MAX_EVENT_SHADOW_BATCH_SIZE) {
    throw new EventShadowBatchInvariantError(
      'BATCH_SIZE_EXCEEDED',
      `observationIds contains ${observationIds.length} entries, exceeding MAX_EVENT_SHADOW_BATCH_SIZE=${MAX_EVENT_SHADOW_BATCH_SIZE}.`,
    );
  }

  // PostgreSQL UUID identity is case-insensitive w.r.t. textual hex
  // representation — duplicate detection MUST use a canonical lowercase
  // comparison key, never the raw string, or the same RAW observation
  // could be processed twice inside one batch under two different
  // capitalizations. The comparison key is used ONLY for this check: the
  // original observationIds array, caller order, and exact strings
  // forwarded to PR5 are never rewritten, trimmed, or normalized.
  const seen = new Set<string>();
  for (const id of observationIds) {
    if (typeof id !== 'string' || !UUID_LIKE_PATTERN.test(id)) {
      throw new EventShadowBatchInvariantError(
        'MALFORMED_OBSERVATION_ID',
        `observationIds entry is not a UUID-like string: ${JSON.stringify(id)}.`,
      );
    }
    const comparisonKey = id.toLowerCase();
    if (seen.has(comparisonKey)) {
      throw new EventShadowBatchInvariantError(
        'DUPLICATE_OBSERVATION_ID',
        `observationIds contains a duplicate id (case-insensitive UUID comparison): ${id}.`,
      );
    }
    seen.add(comparisonKey);
  }

  if (typeof triggerType !== 'string' || triggerType.trim().length === 0) {
    throw new EventShadowBatchInvariantError(
      'BLANK_TRIGGER_TYPE',
      'triggerType must be a non-blank string.',
    );
  }
  if (triggerType.length > MAX_TRIGGER_TYPE_LENGTH) {
    throw new EventShadowBatchInvariantError(
      'TRIGGER_TYPE_TOO_LONG',
      `triggerType length ${triggerType.length} exceeds the ${MAX_TRIGGER_TYPE_LENGTH} character limit.`,
    );
  }
  // The allowlist is the actual source-of-truth constraint (mirrors the
  // real ingestion_runs.trigger_type CHECK) — never normalized/falled back,
  // the exact accepted value is forwarded to acquireLock unchanged.
  if (!SUPPORTED_TRIGGER_TYPES.has(triggerType)) {
    throw new EventShadowBatchInvariantError(
      'UNSUPPORTED_TRIGGER_TYPE',
      `triggerType "${triggerType}" is not one of the supported values: ${[...SUPPORTED_TRIGGER_TYPES].join(', ')}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Item outcomes.
// ---------------------------------------------------------------------------

export interface BatchProcessedItem {
  readonly kind: 'PROCESSED';
  readonly observationId: string;
  readonly clusterId: string;
  readonly decisionId: string;
  readonly eventVersionId: string;
  readonly clusterCreatedNow: boolean;
  readonly membershipReplayed: boolean;
  readonly eventVersionReplayed: boolean;
  readonly finalKnowledgeCutoff: string;
  readonly sourceIndependenceState: string;
}

export interface BatchAbstainedItem {
  readonly kind: 'ABSTAINED';
  readonly observationId: string;
  readonly abstention: string;
  readonly reason: string;
}

export interface BatchSkippedItem {
  readonly kind: 'SKIPPED';
  readonly observationId: string;
  readonly reason: string;
}

export interface BatchFailedItem {
  readonly kind: 'FAILED';
  readonly observationId: string;
  readonly errorCode: string;
  readonly safeErrorMessage: string;
}

export type EventShadowBatchItemResult =
  | BatchProcessedItem
  | BatchAbstainedItem
  | BatchSkippedItem
  | BatchFailedItem;

function toBatchItem(observationId: string, result: EventShadowObservationResult): EventShadowBatchItemResult {
  if (result.kind === 'PROCESSED') {
    return {
      kind: 'PROCESSED',
      observationId: result.observationId,
      clusterId: result.clusterId,
      decisionId: result.decisionId,
      eventVersionId: result.eventVersionId,
      clusterCreatedNow: result.clusterCreatedNow,
      membershipReplayed: result.membershipReplayed,
      eventVersionReplayed: result.eventVersionReplayed,
      finalKnowledgeCutoff: result.finalKnowledgeCutoff,
      sourceIndependenceState: result.sourceIndependenceState,
    };
  }
  if (result.kind === 'ABSTAINED') {
    return { kind: 'ABSTAINED', observationId, abstention: result.abstention, reason: result.reason };
  }
  // result.kind === 'SKIPPED'
  return { kind: 'SKIPPED', observationId, reason: result.reason };
}

function toFailedItem(observationId: string, err: unknown): BatchFailedItem {
  const errorCode = err instanceof EventShadowInvariantError ? err.code : 'UNEXPECTED_ERROR';
  return { kind: 'FAILED', observationId, errorCode, safeErrorMessage: errorMessage(err) };
}

// ---------------------------------------------------------------------------
// Aggregate report.
// ---------------------------------------------------------------------------

export interface EventShadowBatchReport {
  readonly version: string;
  readonly engine: 'event_shadow';
  readonly triggerType: string;
  readonly runRowId: string;
  readonly status: 'success' | 'partial' | 'failed';
  readonly requested: number;
  readonly processed: number;
  readonly abstained: number;
  readonly skipped: number;
  readonly failed: number;
  readonly clustersCreated: number;
  readonly membershipReplayed: number;
  readonly eventVersionReplayed: number;
  readonly fullyReplayed: number;
  readonly eventVersionsCreated: number;
  readonly durationMs: number;
  readonly items: readonly EventShadowBatchItemResult[];
}

function buildReport(input: {
  readonly triggerType: string;
  readonly runRowId: string;
  readonly requested: number;
  readonly items: readonly EventShadowBatchItemResult[];
  readonly durationMs: number;
}): EventShadowBatchReport {
  let processed = 0;
  let abstained = 0;
  let skipped = 0;
  let failed = 0;
  let clustersCreated = 0;
  let membershipReplayed = 0;
  let eventVersionReplayed = 0;
  let fullyReplayed = 0;
  let eventVersionsCreated = 0;

  for (const item of input.items) {
    if (item.kind === 'PROCESSED') {
      processed += 1;
      if (item.clusterCreatedNow) clustersCreated += 1;
      if (item.membershipReplayed) membershipReplayed += 1;
      if (item.eventVersionReplayed) eventVersionReplayed += 1;
      if (item.membershipReplayed && item.eventVersionReplayed) fullyReplayed += 1;
      if (!item.eventVersionReplayed) eventVersionsCreated += 1;
    } else if (item.kind === 'ABSTAINED') {
      abstained += 1;
    } else if (item.kind === 'SKIPPED') {
      skipped += 1;
    } else {
      failed += 1;
    }
  }

  // ABSTAINED/SKIPPED are never operational failures.
  const status: 'success' | 'partial' | 'failed' =
    failed === 0 ? 'success' : failed === input.requested ? 'failed' : 'partial';

  return {
    version: OPS023_EVENT_SHADOW_BATCH_VERSION,
    engine: LOCK_ENGINE,
    triggerType: input.triggerType,
    runRowId: input.runRowId,
    status,
    requested: input.requested,
    processed,
    abstained,
    skipped,
    failed,
    clustersCreated,
    membershipReplayed,
    eventVersionReplayed,
    fullyReplayed,
    eventVersionsCreated,
    durationMs: input.durationMs,
    items: input.items,
  };
}

function toLockRelease(report: EventShadowBatchReport): LockRelease {
  const errors = report.items
    .filter((item): item is BatchFailedItem => item.kind === 'FAILED')
    .map((item) => `${item.observationId}: ${item.errorCode}: ${item.safeErrorMessage}`);

  return {
    status: report.status,
    durationMs: report.durationMs,
    fetched: report.requested,
    rejected: report.abstained + report.skipped,
    persisted: report.eventVersionsCreated,
    duplicates: report.fullyReplayed,
    providers: {
      event_shadow: {
        batch_version: report.version,
        requested: report.requested,
        processed: report.processed,
        abstained: report.abstained,
        skipped: report.skipped,
        failed: report.failed,
        clusters_created: report.clustersCreated,
        membership_replayed: report.membershipReplayed,
        event_version_replayed: report.eventVersionReplayed,
        fully_replayed: report.fullyReplayed,
        event_versions_created: report.eventVersionsCreated,
      },
    },
    errors,
  };
}

/**
 * SAFE MINIMAL fallback release payload for the (structurally unreachable
 * under normal per-item error isolation, but still guarded defensively)
 * case where an unexpected operational error escapes the processing block
 * BEFORE a real EventShadowBatchReport could be built. Never fabricates
 * successful processing metrics — conservatively reports the whole run as
 * failed, zero persisted/duplicated, with a safe error entry describing
 * the operational failure.
 */
function buildFallbackLockRelease(input: {
  readonly requested: number;
  readonly durationMs: number;
  readonly error: unknown;
}): LockRelease {
  return {
    status: 'failed',
    durationMs: input.durationMs,
    fetched: input.requested,
    persisted: 0,
    duplicates: 0,
    providers: {
      event_shadow: {
        batch_version: OPS023_EVENT_SHADOW_BATCH_VERSION,
      },
    },
    errors: [`event_shadow batch operational failure before a report could be built: ${errorMessage(input.error)}`],
  };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export async function runEventShadowBatch(
  db: EventShadowBatchDb,
  observationIds: readonly string[],
  triggerType: string = DEFAULT_TRIGGER_TYPE,
): Promise<EventShadowBatchReport> {
  // Fail closed BEFORE any DB call — no reclaim RPC, no lock insert.
  validateBatchInput(observationIds, triggerType);

  // Date.now() is used ONLY for operational batch duration below — never
  // fed into PR4/PR5, fingerprints, knowledge cutoff, or effective time.
  const startedAt = Date.now();

  const lock = await acquireLock(db, LOCK_ENGINE, triggerType);
  if (!lock.acquired) {
    // Lock was never acquired: no observation processing, no release call.
    throw new EventShadowBusyError();
  }

  // From here on, release is a STRUCTURAL guarantee: everything that can
  // run after a successful acquireLock is covered by this try/finally, and
  // releaseLock is attempted EXACTLY ONCE from the finally path — whether
  // processing completes normally (report built) or an unexpected
  // operational error escapes the per-item isolation below (report never
  // built, a safe minimal fallback payload is released instead). If
  // release itself fails, the caller must never receive a report implying
  // the lock was correctly returned — throw instead of returning/rethrowing.
  let report: EventShadowBatchReport | null = null;
  let operationalError: unknown = null;
  try {
    // Strict caller order, one at a time — no Promise.all/allSettled. One
    // observation's failure is isolated here and never aborts the
    // remaining ids; PR5 itself remains the sole authority on retry/
    // idempotency, so this loop adds zero new idempotency logic.
    const items: EventShadowBatchItemResult[] = [];
    for (const observationId of observationIds) {
      try {
        const result = await processEventShadowObservation(db, observationId);
        items.push(toBatchItem(observationId, result));
      } catch (err) {
        items.push(toFailedItem(observationId, err));
      }
    }

    report = buildReport({
      triggerType,
      runRowId: lock.runRowId,
      requested: observationIds.length,
      items,
      durationMs: Date.now() - startedAt,
    });
    return report;
  } catch (err) {
    // Genuinely unexpected — normal per-item PR5 failures are already
    // isolated above and never reach here. Captured for the fallback
    // release payload below, then rethrown unchanged: the original
    // operational error remains visible unless release itself fails.
    operationalError = err;
    throw err;
  } finally {
    const releasePayload = report !== null
      ? toLockRelease(report)
      : buildFallbackLockRelease({
        requested: observationIds.length,
        durationMs: Date.now() - startedAt,
        error: operationalError,
      });
    await releaseLock(db, lock.runRowId, releasePayload).catch((err: unknown) => {
      throw new EventShadowBatchInvariantError(
        'EVENT_SHADOW_LOCK_RELEASE_FAILED',
        `releaseLock failed for event_shadow run ${lock.runRowId}: ${errorMessage(err)}`,
      );
    });
  }
}
