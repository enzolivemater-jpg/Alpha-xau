/**
 * =============================================================================
 * ALPHA-XAU — Event Impact controlled explicit batch (V1).
 *
 * EI-5 composes the already-reviewed single-version shadow orchestrator.
 * It never discovers work, scans a backlog, calls an LLM, reads env vars,
 * instantiates a client, or calls the persistence RPC directly.
 *
 * explicit Event Version UUID list
 *   -> shared PostgreSQL run lock
 *   -> sequential processEventImpactShadowVersion() calls
 *   -> structured per-item + aggregate report
 *   -> guaranteed lock release
 *
 * Individual persistence remains atomic/idempotent inside EI-2/EI-4.
 * There is intentionally no batch-level transaction or dedup fingerprint.
 * =============================================================================
 */

import {
  EventImpactShadowInvariantError,
  processEventImpactShadowVersion,
  type EventImpactShadowDb,
  type EventImpactShadowResult,
} from './shadow_orchestrator.js';
import {
  acquireLock,
  releaseLock,
  type LockCapableDb,
  type LockRelease,
} from '../shared/run_lock.js';

export const EVENT_IMPACT_SHADOW_BATCH_VERSION =
  'event-impact-shadow-batch-v1' as const;
export const MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE = 25;

const LOCK_ENGINE = 'event_impact_shadow' as const;
const DEFAULT_TRIGGER_TYPE = 'manual' as const;
const MAX_TRIGGER_TYPE_LENGTH = 64;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type EventImpactShadowTriggerType =
  | 'cron'
  | 'manual'
  | 'webhook'
  | 'backfill';

const SUPPORTED_TRIGGER_TYPES: ReadonlySet<string> = new Set<
  EventImpactShadowTriggerType
>(['cron', 'manual', 'webhook', 'backfill']);

export interface EventImpactShadowBatchDb
  extends EventImpactShadowDb,
    LockCapableDb {}

export class EventImpactShadowBatchBusyError extends Error {
  readonly code = 'ALREADY_RUNNING' as const;

  constructor() {
    super(
      'ALREADY_RUNNING: an event_impact_shadow batch run is already in progress.',
    );
    this.name = 'EventImpactShadowBatchBusyError';
  }
}

export class EventImpactShadowBatchInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventImpactShadowBatchInvariantError';
    this.code = code;
  }
}

function redactString(value: string): string {
  return value
    .replace(
      /([?&](?:apiKey|api_key|apikey|token|access_token|key)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:apiKey|api_key|apikey|token|access_token|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]');
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactString(`${error.name}: ${error.message}`);
  }
  return redactString(String(error));
}

function validateBatchInput(
  eventVersionIds: readonly string[],
  triggerType: string,
): void {
  if (eventVersionIds.length === 0) {
    throw new EventImpactShadowBatchInvariantError(
      'EMPTY_EVENT_VERSION_LIST',
      'eventVersionIds must contain at least 1 UUID.',
    );
  }
  if (eventVersionIds.length > MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE) {
    throw new EventImpactShadowBatchInvariantError(
      'BATCH_SIZE_EXCEEDED',
      `eventVersionIds contains ${eventVersionIds.length} entries, exceeding MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE=${MAX_EVENT_IMPACT_SHADOW_BATCH_SIZE}.`,
    );
  }

  const seen = new Set<string>();
  for (const id of eventVersionIds) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new EventImpactShadowBatchInvariantError(
        'MALFORMED_EVENT_VERSION_ID',
        `eventVersionIds entry is not a UUID-like string: ${JSON.stringify(id)}.`,
      );
    }
    const comparisonKey = id.toLowerCase();
    if (seen.has(comparisonKey)) {
      throw new EventImpactShadowBatchInvariantError(
        'DUPLICATE_EVENT_VERSION_ID',
        `eventVersionIds contains a duplicate id (case-insensitive UUID comparison): ${id}.`,
      );
    }
    seen.add(comparisonKey);
  }

  if (typeof triggerType !== 'string' || triggerType.trim().length === 0) {
    throw new EventImpactShadowBatchInvariantError(
      'BLANK_TRIGGER_TYPE',
      'triggerType must be a non-blank string.',
    );
  }
  if (triggerType.length > MAX_TRIGGER_TYPE_LENGTH) {
    throw new EventImpactShadowBatchInvariantError(
      'TRIGGER_TYPE_TOO_LONG',
      `triggerType length ${triggerType.length} exceeds ${MAX_TRIGGER_TYPE_LENGTH} characters.`,
    );
  }
  if (!SUPPORTED_TRIGGER_TYPES.has(triggerType)) {
    throw new EventImpactShadowBatchInvariantError(
      'UNSUPPORTED_TRIGGER_TYPE',
      `triggerType "${triggerType}" is not supported.`,
    );
  }
}

export interface EventImpactBatchProcessedItem {
  readonly kind: 'PROCESSED';
  readonly eventVersionId: string;
  readonly assessmentId: string;
  readonly assessmentStatus: 'INSUFFICIENT_EVIDENCE' | 'UNAVAILABLE';
  readonly assessmentReason: string;
  readonly assessmentReplayed: boolean;
  readonly interpretationCount: 0;
  readonly knowledgeCutoff: string;
  readonly inputFingerprint: string;
  readonly semanticFingerprint: string;
  readonly idempotencyFingerprint: string;
}

export interface EventImpactBatchAbstainedItem {
  readonly kind: 'ABSTAINED';
  readonly requestedEventVersionId: string;
  readonly eventVersionId: string | null;
  readonly abstention: string;
  readonly reason: string;
}

export interface EventImpactBatchSkippedItem {
  readonly kind: 'SKIPPED';
  readonly eventVersionId: string;
  readonly reason: 'EVENT_VERSION_NOT_FOUND';
}

export interface EventImpactBatchFailedItem {
  readonly kind: 'FAILED';
  readonly eventVersionId: string;
  readonly errorCode: string;
  readonly safeErrorMessage: string;
}

export type EventImpactShadowBatchItemResult =
  | EventImpactBatchProcessedItem
  | EventImpactBatchAbstainedItem
  | EventImpactBatchSkippedItem
  | EventImpactBatchFailedItem;

function toBatchItem(
  requestedEventVersionId: string,
  result: EventImpactShadowResult,
): EventImpactShadowBatchItemResult {
  if (result.kind === 'PROCESSED') {
    return {
      kind: 'PROCESSED',
      eventVersionId: result.eventVersionId,
      assessmentId: result.assessmentId,
      assessmentStatus: result.assessmentStatus,
      assessmentReason: result.assessmentReason,
      assessmentReplayed: result.assessmentReplayed,
      interpretationCount: result.interpretationCount,
      knowledgeCutoff: result.knowledgeCutoff,
      inputFingerprint: result.inputFingerprint,
      semanticFingerprint: result.semanticFingerprint,
      idempotencyFingerprint: result.idempotencyFingerprint,
    };
  }
  if (result.kind === 'ABSTAINED') {
    return {
      kind: 'ABSTAINED',
      requestedEventVersionId,
      eventVersionId: result.eventVersionId,
      abstention: result.abstention,
      reason: result.reason,
    };
  }
  return {
    kind: 'SKIPPED',
    eventVersionId: result.eventVersionId,
    reason: result.reason,
  };
}

function toFailedItem(
  eventVersionId: string,
  error: unknown,
): EventImpactBatchFailedItem {
  const errorCode =
    error instanceof EventImpactShadowInvariantError
      ? error.code
      : 'UNEXPECTED_ERROR';
  return {
    kind: 'FAILED',
    eventVersionId,
    errorCode,
    safeErrorMessage: safeErrorMessage(error),
  };
}

export interface EventImpactShadowBatchReport {
  readonly version: string;
  readonly engine: 'event_impact_shadow';
  readonly triggerType: string;
  readonly runRowId: string;
  readonly status: 'success' | 'partial' | 'failed';
  readonly requested: number;
  readonly processed: number;
  readonly abstained: number;
  readonly skipped: number;
  readonly failed: number;
  readonly assessmentsCreated: number;
  readonly assessmentsReplayed: number;
  readonly insufficientEvidence: number;
  readonly unavailable: number;
  readonly durationMs: number;
  readonly items: readonly EventImpactShadowBatchItemResult[];
}

function buildReport(input: {
  readonly triggerType: string;
  readonly runRowId: string;
  readonly requested: number;
  readonly items: readonly EventImpactShadowBatchItemResult[];
  readonly durationMs: number;
}): EventImpactShadowBatchReport {
  let processed = 0;
  let abstained = 0;
  let skipped = 0;
  let failed = 0;
  let assessmentsCreated = 0;
  let assessmentsReplayed = 0;
  let insufficientEvidence = 0;
  let unavailable = 0;

  for (const item of input.items) {
    if (item.kind === 'PROCESSED') {
      processed += 1;
      if (item.assessmentReplayed) assessmentsReplayed += 1;
      else assessmentsCreated += 1;
      if (item.assessmentStatus === 'INSUFFICIENT_EVIDENCE') {
        insufficientEvidence += 1;
      } else {
        unavailable += 1;
      }
    } else if (item.kind === 'ABSTAINED') {
      abstained += 1;
    } else if (item.kind === 'SKIPPED') {
      skipped += 1;
    } else {
      failed += 1;
    }
  }

  const status: 'success' | 'partial' | 'failed' =
    failed === 0 ? 'success' : failed === input.requested ? 'failed' : 'partial';

  return {
    version: EVENT_IMPACT_SHADOW_BATCH_VERSION,
    engine: LOCK_ENGINE,
    triggerType: input.triggerType,
    runRowId: input.runRowId,
    status,
    requested: input.requested,
    processed,
    abstained,
    skipped,
    failed,
    assessmentsCreated,
    assessmentsReplayed,
    insufficientEvidence,
    unavailable,
    durationMs: input.durationMs,
    items: input.items,
  };
}

function toLockRelease(report: EventImpactShadowBatchReport): LockRelease {
  const errors = report.items
    .filter(
      (item): item is EventImpactBatchFailedItem => item.kind === 'FAILED',
    )
    .map(
      (item) =>
        `${item.eventVersionId}: ${item.errorCode}: ${item.safeErrorMessage}`,
    );

  return {
    status: report.status,
    durationMs: report.durationMs,
    fetched: report.requested,
    rejected: report.abstained + report.skipped,
    persisted: report.assessmentsCreated,
    duplicates: report.assessmentsReplayed,
    providers: {
      event_impact_shadow: {
        batch_version: report.version,
        requested: report.requested,
        processed: report.processed,
        abstained: report.abstained,
        skipped: report.skipped,
        failed: report.failed,
        assessments_created: report.assessmentsCreated,
        assessments_replayed: report.assessmentsReplayed,
        insufficient_evidence: report.insufficientEvidence,
        unavailable: report.unavailable,
      },
    },
    errors,
  };
}

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
      event_impact_shadow: {
        batch_version: EVENT_IMPACT_SHADOW_BATCH_VERSION,
      },
    },
    errors: [
      `event_impact_shadow operational failure before report: ${safeErrorMessage(input.error)}`,
    ],
  };
}

export async function runEventImpactShadowBatch(
  db: EventImpactShadowBatchDb,
  eventVersionIds: readonly string[],
  triggerType: string = DEFAULT_TRIGGER_TYPE,
): Promise<EventImpactShadowBatchReport> {
  validateBatchInput(eventVersionIds, triggerType);

  const startedAt = Date.now();
  const lock = await acquireLock(db, LOCK_ENGINE, triggerType);
  if (!lock.acquired) {
    throw new EventImpactShadowBatchBusyError();
  }

  let report: EventImpactShadowBatchReport | null = null;
  let operationalError: unknown = null;

  try {
    const items: EventImpactShadowBatchItemResult[] = [];

    for (const eventVersionId of eventVersionIds) {
      try {
        const result = await processEventImpactShadowVersion(
          db,
          eventVersionId,
        );
        items.push(toBatchItem(eventVersionId, result));
      } catch (error) {
        items.push(toFailedItem(eventVersionId, error));
      }
    }

    report = buildReport({
      triggerType,
      runRowId: lock.runRowId,
      requested: eventVersionIds.length,
      items,
      durationMs: Date.now() - startedAt,
    });
    return report;
  } catch (error) {
    operationalError = error;
    throw error;
  } finally {
    const releasePayload =
      report !== null
        ? toLockRelease(report)
        : buildFallbackLockRelease({
            requested: eventVersionIds.length,
            durationMs: Date.now() - startedAt,
            error: operationalError,
          });

    await releaseLock(db, lock.runRowId, releasePayload).catch(
      (error: unknown) => {
        throw new EventImpactShadowBatchInvariantError(
          'EVENT_IMPACT_SHADOW_LOCK_RELEASE_FAILED',
          `releaseLock failed for event_impact_shadow run ${lock.runRowId}: ${safeErrorMessage(error)}`,
        );
      },
    );
  }
}
