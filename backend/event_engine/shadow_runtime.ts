/**
 * =============================================================================
 *  ALPHA-XAU — backend/event_engine/shadow_runtime.ts
 *
 *  OPS-023 PR7 — Controlled Manual Worker Runtime (V1).
 *
 *  Wires the merged PR6 controlled shadow batch runner
 *  (backend/event_engine/shadow_batch.ts, imported and reused here, never
 *  reimplemented) into a CONTROLLED MANUAL authenticated HTTP endpoint:
 *
 *    POST /event-shadow
 *      -> authenticate operator (reuses the EXISTING INGEST_TOKEN /news
 *         manual-trigger convention from backend/ingest.ts — never a new
 *         token, never a new auth scheme)
 *      -> validate strict request envelope ({ observationIds: string[] }
 *         only — no other top-level field, no triggerType, no processor
 *         options, no cluster identity, no DB/RPC parameters)
 *      -> construct a real minimal PostgREST DB adapter (private, local to
 *         this module — no exported reusable client exists in the repo to
 *         reuse without introducing coupling)
 *      -> runEventShadowBatch(db, observationIds, 'manual') — the trigger
 *         is ALWAYS the literal 'manual', NEVER read from the request body
 *      -> map the result to a safe structured HTTP response
 *
 *  RESPONSIBILITIES ONLY: HTTP authentication, method/envelope validation,
 *  a minimal real PostgREST DB adapter, invoking PR6, and safe response
 *  mapping. This module never duplicates PR4/PR5/PR6 logic and never calls
 *  an Event mutation RPC directly — every RPC call stays inside PR5.
 *
 *  NO CRON IN PR7 (deliberate): this module is never referenced from
 *  backend/worker.ts's scheduled()/resolveJob()/JobName. Automatic
 *  candidate discovery and cron wiring are explicitly out of scope —
 *  PR6 accepts explicit observation IDs only, and there is currently no
 *  independently reviewed automatic backlog selector. That is PR8, after
 *  PR7 is proven against live Supabase with controlled observation IDs.
 *
 *  NO AUTOMATIC BACKLOG DISCOVERY: this module never scans news_articles,
 *  never queries "newest"/ingested_at/published_at, never builds a
 *  cursor/checkpoint. The only news_articles reads are the ones already
 *  performed inside PR5 for the explicit caller-provided observation IDs.
 * =============================================================================
 */

import {
  runEventShadowBatch,
  EventShadowBusyError,
  EventShadowBatchInvariantError,
  type EventShadowBatchDb,
} from './shadow_batch.js';

// ---------------------------------------------------------------------------
// Runtime environment — Cloudflare env injection is authoritative, never
// process.env.
// ---------------------------------------------------------------------------

export interface EventShadowRuntimeEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly INGEST_TOKEN: string;
}

const POSTGREST_TIMEOUT_MS = 15_000;
const MAX_ERROR_DETAIL_LENGTH = 400;

/** The trigger PR6 ALWAYS receives from this runtime. Never read from the
 *  request body — see parseEnvelope() below, which accepts no such field. */
const EVENT_SHADOW_RUNTIME_TRIGGER_TYPE = 'manual' as const;

// ---------------------------------------------------------------------------
// Safe error/message helpers — duplicated locally rather than imported
// across module boundaries (established repo convention; see PR4/PR5's
// duplicated timestamp validation). Never lets a service-role key, an
// INGEST_TOKEN, or an Authorization/apikey header value reach a log line
// or an HTTP response.
// ---------------------------------------------------------------------------

function redactString(value: string): string {
  return value
    .replace(/([?&](?:apiKey|api_key|apikey|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/("?(?:apikey|authorization)"?\s*:\s*"?)[^",\s]+/gi, '$1[REDACTED]');
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactString(raw).slice(0, MAX_ERROR_DETAIL_LENGTH);
}

/**
 * Defense in depth beyond the generic pattern-based redactString() above:
 * replaces every VERBATIM occurrence of a known exact secret value. Used
 * wherever a message might otherwise embed a secret's literal bytes (e.g.
 * a raw underlying network error message). Empty/undefined secrets are
 * skipped — never redact an empty string (would corrupt every message).
 */
function redactExactSecrets(value: string, secrets: readonly (string | undefined)[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // An operational batch report must never be cached.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Authentication — mirrors the EXISTING /news manual-trigger convention
// (backend/ingest.ts isAuthorized/timingSafeEqual) EXACTLY: same header
// contract (x-ingest-token, or Authorization: Bearer <token> fallback),
// same constant-time comparison, same token (INGEST_TOKEN). No new token,
// no new auth scheme introduced in PR7.
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ba.length ^ bb.length;
  const len = Math.max(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function isAuthorized(request: Request, env: EventShadowRuntimeEnv): boolean {
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get('x-ingest-token')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  return timingSafeEqual(header, env.INGEST_TOKEN);
}

// ---------------------------------------------------------------------------
// Request envelope — SHAPE ONLY. PR6 remains authoritative for semantic
// validation (empty list, >25 ids, UUID validity, duplicate UUIDs) — never
// duplicated here.
// ---------------------------------------------------------------------------

export interface EventShadowRequestEnvelope {
  readonly observationIds: readonly unknown[];
}

class EventShadowRuntimeEnvelopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EventShadowRuntimeEnvelopeError';
    this.code = code;
  }
}

const ALLOWED_ENVELOPE_KEYS = new Set(['observationIds']);

/**
 * Transport-level bound, deliberately NOT a duplication of PR6's semantic
 * limits (max 25 ids / UUID validity / duplicates — all still PR6's
 * responsibility). 16 KiB comfortably fits 25 UUIDs (25 * 36 bytes ≈ 900
 * bytes) plus generous JSON/field-name overhead, with headroom to spare.
 */
export const MAX_EVENT_SHADOW_REQUEST_BODY_BYTES = 16 * 1024;

/** Content-Length is a CLIENT-SUPPLIED HINT, not trustworthy on its own —
 *  reject fast on an oversized declared length (without reading the body
 *  at all), but the actual body is ALWAYS also bounded below regardless
 *  of what this header claims (or omits). */
function checkDeclaredContentLength(request: Request): void {
  const header = request.headers.get('content-length');
  if (header === null) return;
  const declared = Number(header);
  if (Number.isFinite(declared) && declared > MAX_EVENT_SHADOW_REQUEST_BODY_BYTES) {
    throw new EventShadowRuntimeEnvelopeError(
      'REQUEST_BODY_TOO_LARGE',
      `Request body exceeds the ${MAX_EVENT_SHADOW_REQUEST_BODY_BYTES}-byte limit (Content-Length: ${header}).`,
    );
  }
}

/** A simple bounded text read: the actual body is measured (UTF-8 byte
 *  length, not JS string length) and rejected if oversized — BEFORE
 *  JSON.parse ever runs — regardless of whether Content-Length was
 *  present, absent, or understated. */
async function readBoundedRequestBody(request: Request): Promise<string> {
  const text = await request.text();
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_EVENT_SHADOW_REQUEST_BODY_BYTES) {
    throw new EventShadowRuntimeEnvelopeError(
      'REQUEST_BODY_TOO_LARGE',
      `Request body exceeds the ${MAX_EVENT_SHADOW_REQUEST_BODY_BYTES}-byte limit.`,
    );
  }
  return text;
}

async function parseEnvelope(request: Request): Promise<EventShadowRequestEnvelope> {
  checkDeclaredContentLength(request);
  const bodyText = await readBoundedRequestBody(request);

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    throw new EventShadowRuntimeEnvelopeError('MALFORMED_JSON', 'Request body is not valid JSON.');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EventShadowRuntimeEnvelopeError('INVALID_BODY_SHAPE', 'Request body must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  if (!('observationIds' in obj)) {
    throw new EventShadowRuntimeEnvelopeError('MISSING_OBSERVATION_IDS', 'Request body must include "observationIds".');
  }

  const unexpectedKeys = Object.keys(obj).filter((key) => !ALLOWED_ENVELOPE_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    throw new EventShadowRuntimeEnvelopeError(
      'UNEXPECTED_FIELD',
      `Unexpected field(s) in request body: ${unexpectedKeys.join(', ')}. Only "observationIds" is accepted.`,
    );
  }

  if (!Array.isArray(obj.observationIds)) {
    throw new EventShadowRuntimeEnvelopeError('OBSERVATION_IDS_NOT_ARRAY', '"observationIds" must be an array.');
  }

  return { observationIds: obj.observationIds };
}

// ---------------------------------------------------------------------------
// Minimal real PostgREST DB adapter — private, local to this module. No
// exported reusable PostgREST client exists elsewhere in the repo (the
// SupabaseClient classes in backend/ingest.ts and
// backend/ai_engine/committee_orchestrator.ts are both private/unexported,
// and PR7 must not modify either module), so this is a fresh minimal
// implementation of the SAME EventShadowBatchDb/LockCapableDb structural
// `request<T>(method, path, body?, extraHeaders?)` contract PR5/PR6/
// run_lock.ts already depend on.
// ---------------------------------------------------------------------------

export class EventShadowDbError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EventShadowDbError';
    this.status = status;
  }
}

/** Validates SUPABASE_URL BEFORE any DB request: must parse as a URL and
 *  use https:. Fails closed on anything else. */
export function validateSupabaseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EventShadowDbError('SUPABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new EventShadowDbError('SUPABASE_URL must use the https: protocol.');
  }
  return parsed;
}

/** No request may escape /rest/v1/: reject any path carrying a scheme
 *  separator (a second, embedded URL) or a parent-directory traversal
 *  segment. */
export function validatePostgrestPath(path: string): void {
  if (path.includes('://') || path.includes('..')) {
    throw new EventShadowDbError('PostgREST path rejected: potential escape sequence.');
  }
}

/** apikey/authorization are ALWAYS the service-role credentials — any
 *  case-variant supplied via extraHeaders is stripped before the
 *  authoritative values are applied, so extraHeaders can never override
 *  them. Safe internal headers (e.g. Prefer) pass through untouched. */
export function buildPostgrestHeaders(
  apiKey: string,
  hasBody: boolean,
  extraHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(extraHeaders)) {
    const lower = key.toLowerCase();
    if (lower === 'apikey' || lower === 'authorization') continue;
    headers[lower] = value;
  }
  headers.apikey = apiKey;
  headers.authorization = `Bearer ${apiKey}`;
  headers.accept = 'application/json';
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

/**
 * Runtime mirror of the TypeScript method union — a TYPE is not a runtime
 * security boundary (a JavaScript caller can bypass it entirely), so
 * request() fails closed here too, BEFORE global fetch is ever called.
 * Exactly GET, POST, PATCH; no silent lowercase-to-uppercase
 * normalization of any other verb, and no other HTTP verb is accepted.
 */
const SUPPORTED_DB_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PATCH']);

export class PostgrestEventShadowDb implements EventShadowBatchDb {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(env: EventShadowRuntimeEnv) {
    const url = validateSupabaseUrl(env.SUPABASE_URL);
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, '')}/rest/v1`;
    this.apiKey = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (!SUPPORTED_DB_METHODS.has(method)) {
      throw new EventShadowDbError(`Unsupported PostgREST method: ${String(method)}. Only GET, POST, PATCH are allowed.`);
    }
    validatePostgrestPath(path);

    // GET must never send a body, regardless of what a caller passes.
    const hasBody = method !== 'GET' && body !== undefined;
    const headers = buildPostgrestHeaders(this.apiKey, hasBody, extraHeaders);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POSTGREST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.base}/${path}`, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new EventShadowDbError(
        isAbort
          ? `PostgREST request timed out after ${POSTGREST_TIMEOUT_MS}ms.`
          : `PostgREST network failure: ${redactExactSecrets(errorMessage(err), [this.apiKey])}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // BLOCKER FIX (PR7 review): the upstream response BODY is never
      // echoed into the thrown message — not even redacted. This error can
      // be caught per-observation by PR6 and surfaced as
      // FAILED.safeErrorMessage in an auditable report that PR7
      // intentionally returns with HTTP 200 (see the handler below), so
      // the generic outer-500 branch alone cannot guarantee
      // SUPABASE_SERVICE_ROLE_KEY never reaches an HTTP response if an
      // upstream PostgREST error body happened to contain it. Only the
      // HTTP status — and a narrow, SAFE, CANNED "duplicate key" signal
      // (never the raw body) preserved so run_lock.ts's isUniqueViolation()
      // keeps working for the lock-acquisition path — survive into the
      // thrown error.
      const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_DETAIL_LENGTH);
      const isDuplicateConflict = /23505|duplicate key|already exists/i.test(detail);
      throw new EventShadowDbError(
        isDuplicateConflict
          ? `PostgREST request failed with HTTP ${response.status} (duplicate key).`
          : `PostgREST request failed with HTTP ${response.status}.`,
        response.status,
      );
    }

    const text = await response.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EventShadowDbError('PostgREST returned malformed JSON for a successful (2xx) response.');
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------

/** PR6 invariant codes that originate from CALLER input (the request
 *  envelope's observationIds) — mapped to HTTP 400. Every other
 *  EventShadowBatchInvariantError (e.g. EVENT_SHADOW_LOCK_RELEASE_FAILED)
 *  is an operational failure, mapped to HTTP 500. */
const CALLER_INPUT_INVARIANT_CODES = new Set([
  'EMPTY_OBSERVATION_LIST',
  'BATCH_SIZE_EXCEEDED',
  'MALFORMED_OBSERVATION_ID',
  'DUPLICATE_OBSERVATION_ID',
]);

export async function handleEventShadowRequest(
  request: Request,
  env: EventShadowRuntimeEnv,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405, { allow: 'POST' });
  }

  if (!isAuthorized(request, env)) {
    // No detail on the reason for refusal — never help an attacker.
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let envelope: EventShadowRequestEnvelope;
  try {
    envelope = await parseEnvelope(request);
  } catch (err) {
    if (err instanceof EventShadowRuntimeEnvelopeError) {
      if (err.code === 'REQUEST_BODY_TOO_LARGE') {
        return jsonResponse({ error: err.message, code: err.code }, 413);
      }
      return jsonResponse({ error: err.message, code: err.code }, 400);
    }
    return jsonResponse({ error: 'Malformed request.' }, 400);
  }

  let db: EventShadowBatchDb;
  try {
    db = new PostgrestEventShadowDb(env);
  } catch {
    return jsonResponse({ error: 'Event-shadow runtime configuration error.' }, 500);
  }

  try {
    // The trigger is ALWAYS the literal 'manual' — never from the request
    // body, never 'cron'/'webhook'/'backfill' via this runtime path.
    const report = await runEventShadowBatch(db, envelope.observationIds as readonly string[], EVENT_SHADOW_RUNTIME_TRIGGER_TYPE);
    // report.status === 'partial' or 'failed' is still an HTTP 200: the
    // runtime operation itself succeeded and produced an auditable report.
    return jsonResponse({ ok: true, report }, 200);
  } catch (err) {
    if (err instanceof EventShadowBusyError) {
      return jsonResponse({ error: err.message, code: 'EVENT_SHADOW_ALREADY_RUNNING' }, 409);
    }
    if (err instanceof EventShadowBatchInvariantError) {
      if (CALLER_INPUT_INVARIANT_CODES.has(err.code)) {
        return jsonResponse({ error: err.message, code: err.code }, 400);
      }
      return jsonResponse({ error: 'Event-shadow batch failed.', code: err.code }, 500);
    }
    // Unexpected/runtime/network error — no stack trace, no secret. The
    // underlying message is deliberately NOT echoed to the caller: even a
    // redacted message is a wider surface than this runtime needs to expose.
    return jsonResponse({ error: 'Internal event-shadow runtime error.' }, 500);
  }
}
