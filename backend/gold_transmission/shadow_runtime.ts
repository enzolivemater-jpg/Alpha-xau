/**
 * =============================================================================
 *  ALPHA-XAU — backend/gold_transmission/shadow_runtime.ts
 *
 *  GT-6 — Controlled Manual Worker Runtime (V1) for Gold Transmission.
 *
 *  Wires the merged GT-5 controlled explicit batch runner
 *  (backend/gold_transmission/shadow_batch.ts, imported and reused here,
 *  never reimplemented) into a CONTROLLED MANUAL authenticated HTTP
 *  endpoint:
 *
 *    POST /gold-transmission-shadow
 *      -> authenticate operator (reuses the EXISTING INGEST_TOKEN /news,
 *         /event-shadow and /event-impact-shadow manual-trigger convention
 *         — never a new token, never a new auth scheme)
 *      -> validate strict request envelope ({ eventVersionIds: unknown[] }
 *         only — no other top-level field, no triggerType, no processor
 *         options, no assessment/producer fields, no DB/RPC parameters)
 *      -> construct a real minimal PostgREST DB adapter (private, local to
 *         this module — mirrors backend/event_impact/shadow_runtime.ts's
 *         already twice-independently-reviewed adapter, re-evaluated for
 *         Gold Transmission rather than mechanically copied; no exported
 *         reusable PostgREST client exists in the repo to reuse without
 *         introducing coupling)
 *      -> runGoldTransmissionShadowBatch(db, eventVersionIds, 'manual') —
 *         the trigger is ALWAYS the literal 'manual', NEVER read from the
 *         request body
 *      -> map the result to a safe structured HTTP response
 *
 *  RESPONSIBILITIES ONLY: HTTP authentication, method/envelope validation,
 *  a minimal real PostgREST DB adapter, invoking GT-5, and safe response
 *  mapping. This module NEVER duplicates GT-2/GT-3/GT-4/GT-5 logic and
 *  NEVER calls the Gold Transmission persistence RPC
 *  (fn_gold_transmission_create_assessment) directly — every RPC call
 *  stays inside GT-2/GT-4. It never decides a transmission channel state,
 *  never infers a market-variable effect, never maps news_score/
 *  expected_move_usd/gold_direction_impact/Committee probability/target/
 *  confidence/market_regime, never performs pricing/positioning/regime
 *  inference, never calls an LLM.
 *
 *  NO CRON, NO DISCOVERY (deliberate): this module is never referenced
 *  from backend/worker.ts's scheduled()/resolveJob()/JobName. There is no
 *  Gold Transmission candidate discovery/backlog selector of any kind —
 *  GT-5 accepts explicit Event Version IDs only, and this runtime forwards
 *  exactly the caller-supplied list, nothing derived or scanned.
 *
 *  EXACT ROUTE MATCH ONLY: backend/worker.ts wires this handler behind
 *  `path === '/gold-transmission-shadow'` — deliberately NOT
 *  `startsWith('/gold-transmission-shadow')`. No sub-routes, no automatic
 *  selector.
 *
 *  Current deterministic V1 behavior remains intentionally conservative
 *  (GT-3): fail-closed / zero-path wherever typed facts are unavailable.
 *  This runtime does not, and must not, widen that behavior.
 * =============================================================================
 */

import {
  runGoldTransmissionShadowBatch,
  GoldTransmissionShadowBatchBusyError,
  GoldTransmissionShadowBatchInvariantError,
  type GoldTransmissionShadowBatchDb,
} from './shadow_batch.js';

// ---------------------------------------------------------------------------
// Runtime environment — Cloudflare env injection is authoritative, never
// process.env.
// ---------------------------------------------------------------------------

export interface GoldTransmissionShadowRuntimeEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly INGEST_TOKEN: string;
}

const POSTGREST_TIMEOUT_MS = 15_000;
const MAX_ERROR_DETAIL_LENGTH = 400;

/** The trigger GT-5 ALWAYS receives from this runtime. Never read from the
 *  request body — see parseEnvelope() below, which accepts no such field. */
const GOLD_TRANSMISSION_SHADOW_RUNTIME_TRIGGER_TYPE = 'manual' as const;

// ---------------------------------------------------------------------------
// Safe error/message helpers — duplicated locally rather than imported
// across module boundaries (established repo convention; mirrors
// backend/event_impact/shadow_runtime.ts's already twice-hardened
// behavior). Never lets a service-role key, an INGEST_TOKEN, or an
// Authorization/apikey header value reach a log line or an HTTP response.
// ---------------------------------------------------------------------------

function redactString(value: string): string {
  return value
    .replace(/([?&](?:apiKey|api_key|apikey|access_token|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    // token68 (RFC 6750 §2.1): A-Z a-z 0-9 - . _ ~ + / , with optional
    // trailing "=" padding. A character class of only [A-Za-z0-9._-] would
    // only PARTIALLY match a token containing +, / or ~ — leaving the
    // unmatched tail (and any "=" padding) unredacted. "/" is escaped
    // because this is a "/"-delimited regex literal, not because it is
    // special inside a character class.
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/("?(?:apikey|authorization)"?\s*:\s*"?)[^",\s]+/gi, '$1[REDACTED]');
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

/**
 * Redaction order carried forward from EI-6's independently-reviewed fix:
 * BOTH the exact-known-secret pass (redactExactSecrets) and the generic
 * pattern-based pass (redactString) run on the FULL, untruncated message.
 * Truncating first can cut a secret in half at the length boundary: the
 * surviving fragment no longer equals the full secret, so an exact-value
 * `.split(secret)` silently fails to match it, and that fragment survives
 * into FAILED.safeErrorMessage and the HTTP report. Truncation therefore
 * happens LAST, strictly after every redaction pass, never before.
 */
function errorMessage(err: unknown, exactSecrets: readonly (string | undefined)[] = []): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const secretsRedacted = redactExactSecrets(raw, exactSecrets);
  const patternRedacted = redactString(secretsRedacted);
  return patternRedacted.slice(0, MAX_ERROR_DETAIL_LENGTH);
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
// Authentication — mirrors the EXISTING /news, /event-shadow and
// /event-impact-shadow manual-trigger convention EXACTLY: same header
// contract (x-ingest-token, or Authorization: Bearer <token> fallback),
// same constant-time comparison, same token (INGEST_TOKEN). No new token,
// no new auth scheme in GT-6.
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

function isAuthorized(request: Request, env: GoldTransmissionShadowRuntimeEnv): boolean {
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get('x-ingest-token')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  return timingSafeEqual(header, env.INGEST_TOKEN);
}

// ---------------------------------------------------------------------------
// Request envelope — SHAPE ONLY. GT-5 remains authoritative for semantic
// validation (empty list, >25 ids, UUID validity, duplicate ids) — never
// duplicated here.
// ---------------------------------------------------------------------------

export interface GoldTransmissionShadowRequestEnvelope {
  readonly eventVersionIds: readonly unknown[];
}

class GoldTransmissionShadowRuntimeEnvelopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoldTransmissionShadowRuntimeEnvelopeError';
    this.code = code;
  }
}

const ALLOWED_ENVELOPE_KEYS = new Set(['eventVersionIds']);

/**
 * Transport-level bound, deliberately NOT a duplication of GT-5's semantic
 * limits (max 25 ids / UUID validity / duplicates — all still GT-5's
 * responsibility). 16 KiB comfortably fits 25 UUIDs (25 * 36 bytes ≈ 900
 * bytes) plus generous JSON/field-name overhead, with headroom to spare —
 * same bound already established by backend/event_engine/shadow_runtime.ts
 * and backend/event_impact/shadow_runtime.ts.
 */
export const MAX_GOLD_TRANSMISSION_SHADOW_REQUEST_BODY_BYTES = 16 * 1024;

/** Content-Length is a CLIENT-SUPPLIED HINT, not trustworthy on its own —
 *  reject fast on an oversized declared length (without reading the body
 *  at all), but the actual body is ALWAYS also bounded below regardless
 *  of what this header claims (or omits). */
function checkDeclaredContentLength(request: Request): void {
  const header = request.headers.get('content-length');
  if (header === null) return;
  const declared = Number(header);
  if (Number.isFinite(declared) && declared > MAX_GOLD_TRANSMISSION_SHADOW_REQUEST_BODY_BYTES) {
    throw new GoldTransmissionShadowRuntimeEnvelopeError(
      'REQUEST_BODY_TOO_LARGE',
      `Request body exceeds the ${MAX_GOLD_TRANSMISSION_SHADOW_REQUEST_BODY_BYTES}-byte limit (Content-Length: ${header}).`,
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
  if (byteLength > MAX_GOLD_TRANSMISSION_SHADOW_REQUEST_BODY_BYTES) {
    throw new GoldTransmissionShadowRuntimeEnvelopeError(
      'REQUEST_BODY_TOO_LARGE',
      `Request body exceeds the ${MAX_GOLD_TRANSMISSION_SHADOW_REQUEST_BODY_BYTES}-byte limit.`,
    );
  }
  return text;
}

async function parseEnvelope(request: Request): Promise<GoldTransmissionShadowRequestEnvelope> {
  checkDeclaredContentLength(request);
  const bodyText = await readBoundedRequestBody(request);

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    throw new GoldTransmissionShadowRuntimeEnvelopeError('MALFORMED_JSON', 'Request body is not valid JSON.');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GoldTransmissionShadowRuntimeEnvelopeError('INVALID_BODY_SHAPE', 'Request body must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  if (!('eventVersionIds' in obj)) {
    throw new GoldTransmissionShadowRuntimeEnvelopeError('MISSING_EVENT_VERSION_IDS', 'Request body must include "eventVersionIds".');
  }

  const unexpectedKeys = Object.keys(obj).filter((key) => !ALLOWED_ENVELOPE_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    throw new GoldTransmissionShadowRuntimeEnvelopeError(
      'UNEXPECTED_FIELD',
      `Unexpected field(s) in request body: ${unexpectedKeys.join(', ')}. Only "eventVersionIds" is accepted.`,
    );
  }

  if (!Array.isArray(obj.eventVersionIds)) {
    throw new GoldTransmissionShadowRuntimeEnvelopeError('EVENT_VERSION_IDS_NOT_ARRAY', '"eventVersionIds" must be an array.');
  }

  return { eventVersionIds: obj.eventVersionIds };
}

// ---------------------------------------------------------------------------
// Minimal real PostgREST DB adapter — private, local to this module. No
// exported reusable PostgREST client exists elsewhere in the repo, so this
// is a fresh minimal implementation of the SAME GoldTransmissionShadowBatchDb/
// LockCapableDb structural `request<T>(method, path, body?, extraHeaders?)`
// contract GT-2/GT-4/GT-5/run_lock.ts already depend on — re-evaluated for
// Gold Transmission (not a mechanical rename) but landing on the SAME
// hardened shape backend/event_impact/shadow_runtime.ts already carries,
// since the requirements (HTTPS-only URL, apikey-only auth, no derived
// Bearer, path-escape rejection, GET-never-sends-a-body, exact-secret
// redaction before truncation) are identical. Deliberately NOT a refactor
// of any existing adapter to share code, which would widen this PR
// unnecessarily — the logic is intentionally duplicated per-engine, the
// established convention in this repo.
// ---------------------------------------------------------------------------

export class GoldTransmissionShadowDbError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GoldTransmissionShadowDbError';
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
    throw new GoldTransmissionShadowDbError('SUPABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new GoldTransmissionShadowDbError('SUPABASE_URL must use the https: protocol.');
  }
  return parsed;
}

/** No request may escape /rest/v1/: reject any path carrying a scheme
 *  separator (a second, embedded URL) or a parent-directory traversal
 *  segment. */
export function validatePostgrestPath(path: string): void {
  if (path.includes('://') || path.includes('..')) {
    throw new GoldTransmissionShadowDbError('PostgREST path rejected: potential escape sequence.');
  }
}

/** apikey is ALWAYS the service-role credential — any case-variant
 *  supplied via extraHeaders is stripped before the authoritative value
 *  is applied, so extraHeaders can never override it. Safe internal
 *  headers (e.g. Prefer) pass through untouched.
 *
 *  Modern Supabase secret API keys (sb_secret_...) are not JWTs and must
 *  be presented via `apikey` alone; legacy service_role JWT keys are also
 *  accepted by PostgREST through `apikey` alone. This adapter NEVER sends
 *  `Authorization: Bearer <credential>` — the service credential is sent
 *  ONLY as `apikey`. An `authorization` value supplied via extraHeaders is
 *  still stripped as defense in depth — this adapter never forwards a
 *  caller-supplied Authorization header for a service-level PostgREST
 *  call. */
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

export class PostgrestGoldTransmissionShadowDb implements GoldTransmissionShadowBatchDb {
  private readonly base: string;
  private readonly apiKey: string;
  // Retained ONLY for defensive exact-value redaction of any error that
  // might otherwise escape this adapter (see the network-failure catch
  // below) — never sent as a header, never logged, never echoed. A raw
  // network-error message could in principle embed either secret's
  // literal bytes with no recognizable "token="/Bearer/apikey prefix for
  // the generic pattern-based redactString() above to catch, so both
  // known exact secret values are redacted here regardless of shape.
  private readonly ingestToken: string;

  constructor(env: GoldTransmissionShadowRuntimeEnv) {
    const url = validateSupabaseUrl(env.SUPABASE_URL);
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, '')}/rest/v1`;
    this.apiKey = env.SUPABASE_SERVICE_ROLE_KEY;
    this.ingestToken = env.INGEST_TOKEN;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (!SUPPORTED_DB_METHODS.has(method)) {
      throw new GoldTransmissionShadowDbError(`Unsupported PostgREST method: ${String(method)}. Only GET, POST, PATCH are allowed.`);
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
      throw new GoldTransmissionShadowDbError(
        isAbort
          ? `PostgREST request timed out after ${POSTGREST_TIMEOUT_MS}ms.`
          // Exact-value redaction for BOTH known secrets — never only the
          // credential this specific adapter call used. A raw network
          // error can embed either secret's literal bytes with no
          // "token="/Bearer/apikey-shaped prefix, so pattern-based
          // redactString() alone cannot be relied on here. Secrets are
          // passed INTO errorMessage() (redacted before truncation), never
          // wrapped around its already-truncated output.
          : `PostgREST network failure: ${errorMessage(err, [this.apiKey, this.ingestToken])}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The upstream response BODY is never echoed into the thrown message
      // — not even redacted. This error can be caught per-item by GT-5 and
      // surfaced as safeErrorMessage in an auditable report that this
      // runtime intentionally returns with HTTP 200 (see the handler
      // below), so the generic outer-500 branch alone cannot guarantee
      // SUPABASE_SERVICE_ROLE_KEY never reaches an HTTP response if an
      // upstream PostgREST error body happened to contain it. Only the
      // HTTP status — and a narrow, SAFE, CANNED "duplicate key" signal
      // (never the raw body) preserved so run_lock.ts's isUniqueViolation()
      // keeps working for the lock-acquisition path — survive into the
      // thrown error.
      const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_DETAIL_LENGTH);
      const isDuplicateConflict = /23505|duplicate key|already exists/i.test(detail);
      throw new GoldTransmissionShadowDbError(
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
      throw new GoldTransmissionShadowDbError('PostgREST returned malformed JSON for a successful (2xx) response.');
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------

/** GT-5 invariant codes that originate from CALLER input (the request
 *  envelope's eventVersionIds) — mapped to HTTP 400. Every other
 *  GoldTransmissionShadowBatchInvariantError (e.g.
 *  GOLD_TRANSMISSION_SHADOW_LOCK_RELEASE_FAILED) is an operational
 *  failure, mapped to HTTP 500. */
const CALLER_INPUT_INVARIANT_CODES = new Set([
  'INVALID_EVENT_VERSION_LIST',
  'EMPTY_EVENT_VERSION_LIST',
  'BATCH_SIZE_EXCEEDED',
  'MALFORMED_EVENT_VERSION_ID',
  'DUPLICATE_EVENT_VERSION_ID',
]);

export async function handleGoldTransmissionShadowRequest(
  request: Request,
  env: GoldTransmissionShadowRuntimeEnv,
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405, { allow: 'POST' });
  }

  if (!isAuthorized(request, env)) {
    // No detail on the reason for refusal — never help an attacker.
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let envelope: GoldTransmissionShadowRequestEnvelope;
  try {
    envelope = await parseEnvelope(request);
  } catch (err) {
    if (err instanceof GoldTransmissionShadowRuntimeEnvelopeError) {
      if (err.code === 'REQUEST_BODY_TOO_LARGE') {
        return jsonResponse({ error: err.message, code: err.code }, 413);
      }
      return jsonResponse({ error: err.message, code: err.code }, 400);
    }
    return jsonResponse({ error: 'Malformed request.' }, 400);
  }

  let db: GoldTransmissionShadowBatchDb;
  try {
    db = new PostgrestGoldTransmissionShadowDb(env);
  } catch {
    return jsonResponse({ error: 'Gold-transmission-shadow runtime configuration error.' }, 500);
  }

  try {
    // The trigger is ALWAYS the literal 'manual' — never from the request
    // body, never 'cron'/'webhook'/'backfill' via this runtime path.
    const report = await runGoldTransmissionShadowBatch(
      db,
      envelope.eventVersionIds as readonly string[],
      GOLD_TRANSMISSION_SHADOW_RUNTIME_TRIGGER_TYPE,
    );
    // report.status === 'partial' or 'failed' is still an HTTP 200: the
    // runtime operation itself succeeded and produced an auditable report —
    // same established manual shadow-runtime operational-report convention
    // as /event-shadow and /event-impact-shadow.
    return jsonResponse({ ok: true, report }, 200);
  } catch (err) {
    if (err instanceof GoldTransmissionShadowBatchBusyError) {
      return jsonResponse({ error: err.message, code: 'GOLD_TRANSMISSION_SHADOW_ALREADY_RUNNING' }, 409);
    }
    if (err instanceof GoldTransmissionShadowBatchInvariantError) {
      if (CALLER_INPUT_INVARIANT_CODES.has(err.code)) {
        return jsonResponse({ error: err.message, code: err.code }, 400);
      }
      return jsonResponse({ error: 'Gold-transmission-shadow batch failed.', code: err.code }, 500);
    }
    // Unexpected/runtime/network error — no stack trace, no secret. The
    // underlying message is deliberately NOT echoed to the caller: even a
    // redacted message is a wider surface than this runtime needs to expose.
    return jsonResponse({ error: 'Internal gold-transmission-shadow runtime error.' }, 500);
  }
}
