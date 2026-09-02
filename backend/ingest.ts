/**
 * =============================================================================
 *  ALPHA-XAU INSTITUTIONAL TERMINAL
 *  backend/news_engine/ingest.ts
 *
 *  GLOBAL NEWS & DATA INGESTION ENGINE
 *
 *  Référence : MASTER SPECIFICATION v1.0
 *    §19  Global News Intelligence Engine
 *    §21  News Filtering Engine
 *    §22  News Impact Scoring Model
 *    §23  Détail des variables
 *    §24  News Classification et actions
 *    §25  Geopolitical Impact Engine
 *    §26  Event Transmission Model
 *    §27  News Sentiment Engine
 *    §62  Data Ingestion Engine
 *    §64  Data Quality Engine
 *    §69  Security Layer
 *
 *  FORMULE IMPOSÉE (§22) — variables sur 0-100 :
 *    News Score = (Macro × 0.30)
 *               + (Volatilité × 0.20)
 *               + (Fiabilité_Source × 0.15)
 *               + (Surprise × 0.20)
 *               + (Durée_Impact × 0.15)
 *
 *  CLASSIFICATION (§24) :
 *    >= 80  CATALYST CRITICAL -> recalcul immédiat des scénarios H1/H2
 *    60-79  MAJOR IMPACT      -> réévaluation H3
 *    <  60  MARKET NOISE      -> archivage uniquement
 *
 *  RÈGLES ABSOLUES APPLIQUÉES (§2.2) :
 *    - aucune donnée inventée ;
 *    - toute variable estimée est enregistrée dans `assumptions` ;
 *    - faits et interprétations restent séparés en base.
 *
 *  Runtime : Cloudflare Workers / Vercel Edge Functions.
 *  Aucune dépendance Node : uniquement fetch, URL, TextEncoder, crypto.
 *  Aucun secret n'est journalisé (§69).
 * =============================================================================
 */

import { acquireLock, releaseLock } from './shared/run_lock.js';
import { ingestFederalReserveRaw, type FederalReserveRawIngestResult } from './news_sources/federal_reserve_raw.js';

/* -------------------------------------------------------------------------- */
/*  1. ENVIRONNEMENT ET CONFIGURATION                                          */
/* -------------------------------------------------------------------------- */

/**
 * Variables d'environnement. Aucune valeur par défaut n'est fournie pour les
 * secrets : une configuration incomplète doit faire échouer le démarrage,
 * jamais dégrader silencieusement (§69).
 */
export interface Env {
  /** URL du projet Supabase, ex. https://xxxx.supabase.co */
  readonly SUPABASE_URL: string;
  /** Clé service_role. BYPASSRLS : ne doit jamais atteindre le frontend. */
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  /** Jeton partagé protégeant le déclenchement HTTP manuel. */
  readonly INGEST_TOKEN: string;
  /** Clé NewsAPI. Absente => le collecteur NewsAPI est désactivé, pas en erreur. */
  readonly NEWSAPI_KEY?: string;
  /** Endpoint du moteur IA notifié sur CATALYST CRITICAL / MAJOR IMPACT. */
  readonly AI_ENGINE_URL?: string;
  readonly AI_ENGINE_TOKEN?: string;
  /** Fenêtre GDELT, ex. "60min", "2h". Défaut : 60min. */
  readonly GDELT_TIMESPAN?: string;
  /** Surcharge de test uniquement, comme STOOQ_BASE_URL/FRED_BASE_URL dans
   *  market_engine. Absente en production : l'URL réelle de GDELT reste
   *  inchangée. */
  readonly GDELT_BASE_URL?: string;
  /** debug | info | warn | error. Défaut : info. */
  readonly LOG_LEVEL?: string;
}

const CONFIG = {
  /** Version du moteur, persistée pour la traçabilité des scores (§97). */
  ENGINE_VERSION: 'news-engine-1.0.0',

  /** Timeouts par appel réseau. Un Worker dispose d'un budget CPU limité. */
  HTTP_TIMEOUT_MS: 12_000,
  // GDELT specifiquement : le Projet GDELT documente lui-meme un debit
  // limite pour proteger ses clusters ElasticSearch, et des utilisateurs
  // tiers rapportent des lenteurs meme sur des requetes triviales. 20s
  // (contre 12s partages avec NewsAPI et les ecritures Supabase) laisse
  // une marge sans allonger indument les autres appels du moteur.
  // Ne resout pas a l'aveugle : accompagne d'un decalage du cron
  // (voir wrangler.toml) pour eviter de cogner GDELT synchronise avec
  // d'innombrables autres jobs cron mondiaux au pile quart d'heure.
  GDELT_TIMEOUT_MS: 20_000,
  DB_TIMEOUT_MS: 15_000,

  /** Retry exponentiel : 400ms, 800ms, 1600ms (+ jitter). */
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 400,
  BACKOFF_MAX_MS: 8_000,
  /** Plafond de respect d'un header Retry-After : au-delà, on abandonne. */
  MAX_RETRY_AFTER_MS: 20_000,

  /** Volume par collecteur. GDELT applique un quota strict par IP. */
  GDELT_MAX_RECORDS: 250,
  NEWSAPI_PAGE_SIZE: 100,
  NEWSAPI_LOOKBACK_MIN: 60,

  /** Taille des lots d'insertion PostgREST. */
  DB_BATCH_SIZE: 100,

  /** Un article publié il y a plus de 48h n'a plus de valeur d'exécution. */
  MAX_ARTICLE_AGE_MS: 48 * 60 * 60 * 1000,
  /** Tolérance d'horloge sur les horodatages fournisseurs. */
  MAX_CLOCK_SKEW_MS: 10 * 60 * 1000,

  /** Longueurs maximales retenues en base. */
  MAX_TITLE_LEN: 500,
  MAX_CONTENT_LEN: 8_000,

  /** Seuils SPEC §24. */
  THRESHOLD_CRITICAL: 80,
  THRESHOLD_MAJOR: 60,

  /** Pondérations SPEC §22. Doivent totaliser 1. */
  WEIGHTS: {
    macro: 0.30,
    volatility: 0.20,
    reliability: 0.15,
    surprise: 0.20,
    duration: 0.15,
  },

  /** Fiabilité attribuée à un éditeur inconnu du référentiel (§23). */
  FALLBACK_SOURCE_CODE: 'unknown_source',
  FALLBACK_RELIABILITY: 40,

  /** Score de pertinence Gold minimal pour qu'un article soit conservé. */
  MIN_RELEVANCE: 1,
} as const;

/** Garde-fou : la somme des pondérations doit rester égale à 1 (§22). */
const WEIGHT_SUM =
  CONFIG.WEIGHTS.macro +
  CONFIG.WEIGHTS.volatility +
  CONFIG.WEIGHTS.reliability +
  CONFIG.WEIGHTS.surprise +
  CONFIG.WEIGHTS.duration;

if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(
    `Configuration invalide : la somme des pondérations vaut ${WEIGHT_SUM}, attendu 1.`,
  );
}

/* -------------------------------------------------------------------------- */
/*  2. TYPES                                                                   */
/* -------------------------------------------------------------------------- */

export type NewsCategory =
  | 'monetary_policy'
  | 'inflation'
  | 'employment'
  | 'growth'
  | 'fiscal'
  | 'trade'
  | 'geopolitics'
  | 'central_bank_speech'
  | 'energy'
  | 'financial_stability'
  | 'other';

export type Region = 'US' | 'EU' | 'UK' | 'CH' | 'JP' | 'CN' | 'RU' | 'MENA' | 'EM' | 'GLOBAL';
export type GoldDirection = 'bullish' | 'bearish' | 'neutral';
export type Classification = 'noise' | 'major' | 'critical';
export type NewsAction = 'ARCHIVE_ONLY' | 'REEVALUATE_H3' | 'RECALC_H1_H2';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ImpactDuration = 'short_term' | 'medium_term' | 'structural';

/** Article après normalisation, avant scoring. */
export interface NormalizedArticle {
  readonly title: string;
  readonly content: string | null;
  readonly url: string | null;
  readonly domain: string | null;
  readonly publishedAt: Date;
  readonly collector: 'gdelt' | 'newsapi';
  /** Clé de déduplication intra-lot (titre normalisé). */
  readonly dedupKey: string;
}

/** Détail du calcul, conservé pour l'auditabilité du score. */
export interface ScoreBreakdown {
  readonly macro: number;
  readonly volatility: number;
  readonly reliability: number;
  readonly surprise: number;
  readonly duration: number;
  readonly newsScore: number;
}

/** Modèle de transmission SPEC §26. */
export interface TransmissionModel {
  /** Canal d'impact, ex. "Risk -> Safe Haven -> Gold". */
  readonly channel: string;
  readonly duration: ImpactDuration;
  /** Facteurs susceptibles d'annuler l'effet (§26 question 3). */
  readonly cancelling_factors: readonly string[];
}

/** Hypothèse assumée faute de donnée réelle (§2.2). */
export interface Assumption {
  readonly variable: string;
  readonly reason: string;
  readonly assumed_value: number;
}

/** Ligne prête pour la table news_events. */
export interface ScoredEvent {
  readonly title: string;
  readonly content: string | null;
  readonly source: string;
  readonly source_url: string | null;
  readonly category: NewsCategory;
  readonly region: Region;
  readonly sentiment: number;
  readonly macro_score: number;
  readonly volatility_score: number;
  readonly reliability_score: number;
  readonly surprise_score: number;
  readonly duration_score: number;
  readonly classification: Classification;
  readonly gold_direction_impact: GoldDirection;
  readonly expected_move_usd: number | null;
  readonly risk_level: RiskLevel | null;
  readonly transmission: TransmissionModel;
  readonly assumptions: readonly Assumption[];
  readonly quality_score: number;
  readonly ingest_run_id: string;
  readonly ts: string;
  /** Non persisté : score et action recalculés en base, conservés pour le log. */
  readonly _computed: ScoreBreakdown & { readonly action: NewsAction };
}

export interface ProviderReport {
  readonly ok: boolean;
  readonly count: number;
  readonly retries: number;
  readonly duration_ms: number;
  readonly error?: string;
  readonly skipped?: string;
  // Champs optionnels d'observabilité RAW (federal_reserve et futurs
  // collecteurs officiels) — jamais requis, jamais utilisés par le
  // pipeline legacy gdelt/newsapi existant.
  readonly inserted?: number;
  readonly duplicates?: number;
  readonly rejected?: number;
  readonly database_errors?: number;
}

export interface IngestReport {
  readonly run_id: string;
  readonly status: 'success' | 'partial' | 'failed';
  readonly duration_ms: number;
  readonly fetched: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly persisted: number;
  readonly critical: number;
  readonly major: number;
  readonly providers: Record<string, ProviderReport>;
  readonly errors: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  3. LOGGER STRUCTURÉ                                                        */
/* -------------------------------------------------------------------------- */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logs JSON une ligne par événement : directement exploitables par
 * Cloudflare Logpush / Vercel Log Drains.
 *
 * SÉCURITÉ (§69) : `redact` neutralise toute valeur ressemblant à un secret
 * avant sérialisation. Aucune clé ne doit apparaître dans les logs.
 */
class Logger {
  private readonly min: number;

  constructor(
    level: string | undefined,
    private readonly runId: string,
  ) {
    const normalized = (level ?? 'info').toLowerCase() as LogLevel;
    this.min = LEVEL_ORDER[normalized] ?? LEVEL_ORDER.info;
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.min) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      engine: CONFIG.ENGINE_VERSION,
      run_id: this.runId,
      message,
      ...(context ? { context: redact(context) } : {}),
    };
    // Un seul canal : la plateforme serverless se charge de la collecte.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }

  debug(m: string, c?: Record<string, unknown>): void { this.emit('debug', m, c); }
  info(m: string, c?: Record<string, unknown>): void { this.emit('info', m, c); }
  warn(m: string, c?: Record<string, unknown>): void { this.emit('warn', m, c); }
  error(m: string, c?: Record<string, unknown>): void { this.emit('error', m, c); }
}

const SECRET_KEY_PATTERN = /(key|token|secret|password|authorization|apikey|bearer)/i;

/** Masque récursivement les champs sensibles d'un objet de contexte. */
function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactString(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return '[unserializable]';
}

/** Retire les secrets susceptibles d'apparaître dans une URL ou un message. */
function redactString(value: string): string {
  return value
    .replace(/([?&](?:apiKey|api_key|apikey|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]');
}

/* -------------------------------------------------------------------------- */
/*  4. UTILITAIRES                                                             */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Contraint une valeur dans [min, max] et arrondit à 2 décimales. */
function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;
}

/**
 * Comparaison à temps constant : empêche de deviner INGEST_TOKEN
 * octet par octet en mesurant la latence de réponse (§69).
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  // La longueur fuit, mais elle ne suffit pas à reconstruire le secret.
  let diff = ba.length ^ bb.length;
  const len = Math.max(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Extrait le domaine d'une URL, sans lever d'exception. */
function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Message d'erreur exploitable quelle que soit la valeur levée. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return redactString(`${err.name}: ${err.message}`);
  return redactString(String(err));
}

/* -------------------------------------------------------------------------- */
/*  5. CLIENT HTTP : TIMEOUT, RETRY EXPONENTIEL, RATE LIMIT                     */
/* -------------------------------------------------------------------------- */

/** Erreur réseau enrichie du code HTTP, pour décider du retry. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timeout après ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

interface FetchResult<T> {
  readonly data: T;
  readonly retries: number;
}

/**
 * Interprète le header Retry-After (secondes ou date HTTP).
 * Renvoie null si absent ou illisible.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Backoff exponentiel avec jitter complet.
 * Le jitter évite que plusieurs instances de Worker ne retentent en phase
 * et ne reproduisent le pic de charge qui a déclenché le 429.
 */
function backoffDelay(attempt: number): number {
  const exponential = Math.min(CONFIG.BACKOFF_BASE_MS * 2 ** attempt, CONFIG.BACKOFF_MAX_MS);
  return Math.floor(Math.random() * exponential);
}

/**
 * GET JSON avec timeout, retry exponentiel et respect du rate limit.
 *
 * Politique de retry :
 *   - 429 : retry, en respectant Retry-After s'il est présent et raisonnable ;
 *   - 5xx : retry (indisponibilité transitoire) ;
 *   - 408 : retry (timeout côté serveur) ;
 *   - réseau / timeout : retry ;
 *   - 4xx autres : échec immédiat, un retry ne changerait rien.
 *
 * Seules les requêtes idempotentes (GET) passent par cette fonction.
 */
async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  log: Logger,
  label: string,
  timeoutMs: number = CONFIG.HTTP_TIMEOUT_MS,
): Promise<FetchResult<T>> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        throw new HttpError(`${label} rate limited`, 429, true, retryAfter ?? undefined);
      }

      if (response.status >= 500 || response.status === 408) {
        throw new HttpError(`${label} indisponible (HTTP ${response.status})`, response.status, true);
      }

      if (!response.ok) {
        // Corps tronqué : suffisant pour diagnostiquer, sans polluer les logs.
        const body = (await response.text().catch(() => '')).slice(0, 300);
        throw new HttpError(
          `${label} a répondu HTTP ${response.status} ${redactString(body)}`,
          response.status,
          false,
        );
      }

      // Certains fournisseurs renvoient du HTML (page d'erreur, captcha) avec
      // un statut 200 : le parsing JSON doit être protégé.
      const raw = await response.text();
      try {
        const data = JSON.parse(raw) as T;
        log.debug(`${label} OK`, {
          attempt,
          duration_ms: Date.now() - startedAt,
          bytes: raw.length,
        });
        return { data, retries: attempt };
      } catch {
        throw new HttpError(
          `${label} a renvoyé une charge utile non JSON (${raw.slice(0, 80)})`,
          response.status,
          // Une réponse non JSON en 200 traduit souvent une page d'attente :
          // un nouvel essai a des chances d'aboutir.
          true,
        );
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) lastError = new TimeoutError(timeoutMs);

      const isHttp = err instanceof HttpError;
      const retryable = isAbort || !isHttp || (err as HttpError).retryable;

      if (!retryable || attempt === CONFIG.MAX_RETRIES) break;

      // Un Retry-After au-delà du plafond signifie un quota épuisé pour une
      // durée dépassant le budget du run : on abandonne proprement plutôt
      // que de bloquer le Worker.
      const suggested = isHttp ? (err as HttpError).retryAfterMs : undefined;
      if (suggested !== undefined && suggested > CONFIG.MAX_RETRY_AFTER_MS) {
        log.warn(`${label} : quota épuisé, abandon du collecteur`, { retry_after_ms: suggested });
        break;
      }

      const delay = suggested ?? backoffDelay(attempt);
      log.warn(`${label} : nouvelle tentative`, {
        attempt: attempt + 1,
        max: CONFIG.MAX_RETRIES,
        delay_ms: delay,
        reason: errorMessage(lastError),
      });
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
}

/* -------------------------------------------------------------------------- */
/*  6. NETTOYAGE ET NORMALISATION DU TEXTE                                     */
/* -------------------------------------------------------------------------- */

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
  '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&euro;': '€', '&pound;': '£',
};

/**
 * Nettoyage défensif : les flux agrégés contiennent du HTML résiduel,
 * des entités, des caractères de contrôle et des marqueurs de troncature.
 */
function cleanText(raw: string | null | undefined, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;

  let text = raw
    // Blocs script/style avant suppression des balises.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&[a-z]+;|&#x[0-9a-f]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? ' ')
    // Marqueur de troncature propre à NewsAPI : "… [+2317 chars]".
    .replace(/\[\+\d+\s*chars?\]/gi, ' ')
    // Caractères de contrôle et zero-width.
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length === 0) return null;
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  return text;
}

/**
 * Retire le suffixe éditeur ajouté par les agrégateurs
 * ("Gold hits record high - Reuters"), qui empêcherait la déduplication
 * d'un même article diffusé par plusieurs flux.
 */
function stripPublisherSuffix(title: string): string {
  return title.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/u, '').trim();
}

/** Clé de déduplication : titre en minuscules, sans ponctuation ni accents. */
function dedupKeyOf(title: string): string {
  return stripPublisherSuffix(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse une date fournisseur. Renvoie null si absente ou aberrante. */
function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  // GDELT : "20260807T113000Z" (sans séparateurs).
  const gdelt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  const iso = gdelt
    ? `${gdelt[1]}-${gdelt[2]}-${gdelt[3]}T${gdelt[4]}:${gdelt[5]}:${gdelt[6]}Z`
    : value;

  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;

  const now = Date.now();
  // Une date future traduit une horloge fournisseur désynchronisée :
  // la contrainte chk_market_ticks_no_future a son équivalent ici.
  if (ms > now + CONFIG.MAX_CLOCK_SKEW_MS) return null;
  if (ms < now - CONFIG.MAX_ARTICLE_AGE_MS) return null;
  return new Date(ms);
}

/* -------------------------------------------------------------------------- */
/*  7. COLLECTEURS                                                             */
/* -------------------------------------------------------------------------- */

/** Réponse GDELT DOC 2.0, mode ArtList. Champs optionnels par prudence. */
interface GdeltResponse {
  readonly articles?: ReadonlyArray<{
    readonly url?: string;
    readonly title?: string;
    readonly seendate?: string;
    readonly domain?: string;
    readonly language?: string;
    readonly sourcecountry?: string;
  }>;
}

/** Réponse NewsAPI /v2/everything. */
interface NewsApiResponse {
  readonly status?: string;
  readonly code?: string;
  readonly message?: string;
  readonly totalResults?: number;
  readonly articles?: ReadonlyArray<{
    readonly source?: { readonly id?: string | null; readonly name?: string | null };
    readonly title?: string | null;
    readonly description?: string | null;
    readonly content?: string | null;
    readonly url?: string | null;
    readonly publishedAt?: string | null;
  }>;
}

/**
 * Requête GDELT ciblée sur les moteurs de prix de l'or (§19, §20).
 * La syntaxe GDELT n'accepte pas de parenthèses imbriquées profondes :
 * la requête reste volontairement plate.
 */
const GDELT_QUERY =
  '(gold price OR bullion OR "federal reserve" OR "interest rate decision" OR inflation ' +
  'OR "consumer price index" OR "nonfarm payrolls" OR "real yields" OR "safe haven" ' +
  'OR sanctions OR "military strike" OR "central bank") sourcelang:english';

/**
 * Collecteur GDELT. Aucune clé requise, mais quota par IP strict :
 * un 429 doit être traité comme un état normal et non comme une panne.
 */
async function collectGdelt(env: Env, log: Logger): Promise<{
  articles: NormalizedArticle[];
  report: ProviderReport;
}> {
  const startedAt = Date.now();
  const url = new URL(env.GDELT_BASE_URL ?? 'https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', GDELT_QUERY);
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', String(CONFIG.GDELT_MAX_RECORDS));
  url.searchParams.set('timespan', env.GDELT_TIMESPAN ?? '60min');
  url.searchParams.set('sort', 'datedesc');

  try {
    const { data, retries } = await fetchJsonWithRetry<GdeltResponse>(
      url.toString(),
      { method: 'GET', headers: { accept: 'application/json', 'user-agent': CONFIG.ENGINE_VERSION } },
      log,
      'GDELT',
      CONFIG.GDELT_TIMEOUT_MS,
    );

    const articles: NormalizedArticle[] = [];
    for (const raw of data.articles ?? []) {
      const title = cleanText(raw.title, CONFIG.MAX_TITLE_LEN);
      const publishedAt = parseTimestamp(raw.seendate);
      // Donnée manquante : rejet silencieux, jamais de valeur inventée (§2.2).
      if (!title || !publishedAt) continue;

      const urlValue = raw.url ?? null;
      articles.push({
        title,
        content: null, // GDELT ne fournit pas le corps de l'article.
        url: urlValue,
        domain: (raw.domain ?? '').toLowerCase() || extractDomain(urlValue),
        publishedAt,
        collector: 'gdelt',
        dedupKey: dedupKeyOf(title),
      });
    }

    log.info('GDELT collecté', { received: data.articles?.length ?? 0, kept: articles.length });
    return {
      articles,
      report: { ok: true, count: articles.length, retries, duration_ms: Date.now() - startedAt },
    };
  } catch (err) {
    // Dégradation partielle : l'échec d'un collecteur ne doit pas
    // interrompre l'ingestion de l'autre.
    log.error('GDELT en échec', { reason: errorMessage(err) });
    return {
      articles: [],
      report: {
        ok: false,
        count: 0,
        retries: CONFIG.MAX_RETRIES,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(err),
      },
    };
  }
}

/** Requête NewsAPI. Le paramètre q est limité à 500 caractères. */
const NEWSAPI_QUERY =
  '(gold OR bullion OR XAUUSD) AND (fed OR inflation OR "interest rate" OR yields OR ' +
  'dollar OR geopolitical OR sanctions OR "central bank")';

/**
 * Collecteur NewsAPI. La clé transite exclusivement par le header X-Api-Key,
 * jamais en query string : une URL peut se retrouver dans un log d'accès (§69).
 */
async function collectNewsApi(env: Env, log: Logger): Promise<{
  articles: NormalizedArticle[];
  report: ProviderReport;
}> {
  const startedAt = Date.now();

  if (!env.NEWSAPI_KEY) {
    // Absence de clé = collecteur désactivé, pas une erreur d'exécution.
    log.warn('NewsAPI ignoré : NEWSAPI_KEY non configurée');
    return {
      articles: [],
      report: { ok: true, count: 0, retries: 0, duration_ms: 0, skipped: 'NEWSAPI_KEY absente' },
    };
  }

  const from = new Date(Date.now() - CONFIG.NEWSAPI_LOOKBACK_MIN * 60 * 1000).toISOString();
  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', NEWSAPI_QUERY);
  url.searchParams.set('from', from);
  url.searchParams.set('language', 'en');
  url.searchParams.set('sortBy', 'publishedAt');
  url.searchParams.set('pageSize', String(CONFIG.NEWSAPI_PAGE_SIZE));

  try {
    const { data, retries } = await fetchJsonWithRetry<NewsApiResponse>(
      url.toString(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-Api-Key': env.NEWSAPI_KEY,
          'user-agent': CONFIG.ENGINE_VERSION,
        },
      },
      log,
      'NewsAPI',
    );

    // NewsAPI signale certaines erreurs avec un HTTP 200 et status="error".
    if (data.status && data.status !== 'ok') {
      throw new Error(`NewsAPI status=${data.status} code=${data.code ?? 'n/a'}`);
    }

    const articles: NormalizedArticle[] = [];
    for (const raw of data.articles ?? []) {
      // NewsAPI publie des articles supprimés sous le titre "[Removed]".
      if (!raw.title || raw.title.trim() === '[Removed]') continue;

      const title = cleanText(raw.title, CONFIG.MAX_TITLE_LEN);
      const publishedAt = parseTimestamp(raw.publishedAt);
      if (!title || !publishedAt) continue;

      // description + content : le corps NewsAPI est tronqué à 200 caractères
      // en plan gratuit, la description apporte le contexte manquant.
      const body = [raw.description, raw.content].filter(Boolean).join(' ');
      const urlValue = raw.url ?? null;

      articles.push({
        title,
        content: cleanText(body, CONFIG.MAX_CONTENT_LEN),
        url: urlValue,
        domain: extractDomain(urlValue),
        publishedAt,
        collector: 'newsapi',
        dedupKey: dedupKeyOf(title),
      });
    }

    log.info('NewsAPI collecté', { received: data.articles?.length ?? 0, kept: articles.length });
    return {
      articles,
      report: { ok: true, count: articles.length, retries, duration_ms: Date.now() - startedAt },
    };
  } catch (err) {
    log.error('NewsAPI en échec', { reason: errorMessage(err) });
    return {
      articles: [],
      report: {
        ok: false,
        count: 0,
        retries: CONFIG.MAX_RETRIES,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(err),
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  8. VALIDATION DE SOURCE ET RÉFÉRENTIEL DE FIABILITÉ (§23, §64)             */
/* -------------------------------------------------------------------------- */

interface SourceRecord {
  readonly code: string;
  readonly domain: string | null;
  readonly reliability_score: number;
}

/**
 * Le référentiel data_sources est la seule autorité sur la fiabilité.
 * Il est chargé une fois par run et indexé par domaine : un éditeur absent
 * du référentiel reçoit la fiabilité plancher, jamais une valeur inventée.
 */
class SourceRegistry {
  private constructor(private readonly byDomain: ReadonlyMap<string, SourceRecord>) {}

  static async load(db: SupabaseClient, log: Logger): Promise<SourceRegistry> {
    const rows = await db.select<SourceRecord>(
      'data_sources',
      'code,domain,reliability_score',
      'is_news_source=eq.true&is_active=eq.true',
    );
    const map = new Map<string, SourceRecord>();
    for (const row of rows) {
      if (row.domain) map.set(row.domain.toLowerCase(), row);
    }
    log.info('Référentiel sources chargé', { publishers: map.size });
    return new SourceRegistry(map);
  }

  /**
   * Résolution par correspondance de domaine puis de domaine parent
   * ("uk.reuters.com" -> "reuters.com").
   */
  resolve(domain: string | null): SourceRecord {
    const fallback: SourceRecord = {
      code: CONFIG.FALLBACK_SOURCE_CODE,
      domain,
      reliability_score: CONFIG.FALLBACK_RELIABILITY,
    };
    if (!domain) return fallback;

    const direct = this.byDomain.get(domain);
    if (direct) return direct;

    const parts = domain.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      const match = this.byDomain.get(parent);
      if (match) return match;
    }
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/*  9. MOTEUR DE SCORING (§22, §23)                                            */
/* -------------------------------------------------------------------------- */

interface KeywordRule {
  readonly pattern: RegExp;
  readonly macro: number;
  readonly volatility: number;
  readonly duration: number;
  readonly category: NewsCategory;
  /** Direction attendue sur l'or si le sens de l'événement est univoque. */
  readonly bias?: GoldDirection;
  readonly channel: string;
  readonly impactDuration: ImpactDuration;
  readonly cancelling: readonly string[];
}

/**
 * Barème SPEC §23. Les valeurs Macro et Volatilité reprennent les ancrages
 * explicites de la spécification (FED 100/100, NFP 90 en volatilité,
 * PMI secondaire 30 en macro) ; les autres sont interpolées sur la même
 * échelle en fonction de la sensibilité historique de XAUUSD.
 *
 * L'ordre compte : la première règle qui matche fixe la catégorie.
 * Les règles les plus spécifiques figurent en premier.
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
  {
    pattern: /\b(fomc|federal open market committee|fed (?:rate )?decision|interest rate decision|rate decision)\b/i,
    macro: 100, volatility: 95, duration: 70,
    category: 'monetary_policy', channel: 'Policy rate -> Real yields -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['inflation surprise inverse', 'repricing du dollar'],
  },
  {
    pattern: /\b(rate cut|rate hike|cuts rates|raises rates|hikes rates|quantitative easing|quantitative tightening|balance sheet)\b/i,
    macro: 95, volatility: 88, duration: 75,
    category: 'monetary_policy', channel: 'Policy rate -> Real yields -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['réaction inverse du dollar', 'anticipation déjà intégrée'],
  },
  {
    pattern: /\b(cpi|consumer price index|inflation (?:data|report|rate|print))\b/i,
    macro: 95, volatility: 92, duration: 60,
    category: 'inflation', channel: 'Inflation -> Real yields -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['réaction hawkish de la Fed', 'hausse des taux réels'],
  },
  {
    pattern: /\b(pce|core pce|personal consumption expenditures)\b/i,
    macro: 92, volatility: 80, duration: 60,
    category: 'inflation', channel: 'Inflation -> Real yields -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['divergence CPI/PCE', 'communication Fed contraire'],
  },
  {
    pattern: /\b(non[- ]?farm payrolls|nonfarm|nfp|jobs report|employment report)\b/i,
    macro: 90, volatility: 90, duration: 45,
    category: 'employment', channel: 'Emploi -> Trajectoire Fed -> Real yields -> Gold',
    impactDuration: 'short_term',
    cancelling: ['révisions du mois précédent', 'divergence salaires/emplois'],
  },
  {
    pattern: /\b(powell|jerome powell|fed chair|jackson hole|beige book|fed minutes|dot plot)\b/i,
    macro: 85, volatility: 78, duration: 40,
    category: 'central_bank_speech', channel: 'Guidance -> Anticipations de taux -> Gold',
    impactDuration: 'short_term',
    cancelling: ['propos déjà tenus', 'démenti ultérieur'],
  },
  {
    pattern: /\b(ecb|european central bank|lagarde|bank of japan|boj|bank of england|boe|snb|pboc)\b/i,
    macro: 78, volatility: 65, duration: 55,
    category: 'monetary_policy', channel: 'Politique monétaire -> Devises -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['divergence avec la Fed', 'effet dollar dominant'],
  },
  {
    pattern: /\b(war|invasion|military (?:strike|operation|action)|air ?strike|missile (?:attack|strike)|troops deployed|armed conflict)\b/i,
    macro: 88, volatility: 90, duration: 88,
    category: 'geopolitics', bias: 'bullish',
    channel: 'Conflit -> Incertitude -> Demande refuge -> Gold',
    impactDuration: 'structural',
    cancelling: ['cessez-le-feu rapide', 'hausse simultanée des taux réels'],
  },
  {
    pattern: /\b(escalation|escalate|nuclear|retaliat\w*|state of emergency|coup|blockade)\b/i,
    macro: 75, volatility: 82, duration: 70,
    category: 'geopolitics', bias: 'bullish',
    channel: 'Risque -> Safe Haven -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['désescalade diplomatique', 'absence de confirmation'],
  },
  {
    pattern: /\b(sanctions?|embargo|asset freeze|export controls?)\b/i,
    macro: 75, volatility: 62, duration: 80,
    category: 'geopolitics', bias: 'bullish',
    channel: 'Sanctions -> Fragmentation financière -> Réserves en or',
    impactDuration: 'structural',
    cancelling: ['levée des sanctions', 'contournement effectif'],
  },
  {
    pattern: /\b(bank (?:failure|collapse|run)|banking crisis|insolven\w+|bailout|credit crunch|liquidity crisis|sovereign default)\b/i,
    macro: 90, volatility: 88, duration: 82,
    category: 'financial_stability', bias: 'bullish',
    channel: 'Stress financier -> Fuite vers la qualité -> Gold',
    impactDuration: 'structural',
    cancelling: ['intervention rapide du prêteur en dernier ressort'],
  },
  {
    pattern: /\b(central banks?|reserve[s]?) (?:buy|bought|purchas\w+|accumulat\w+|add\w*)\b.{0,30}\bgold\b/i,
    macro: 82, volatility: 55, duration: 92,
    category: 'geopolitics', bias: 'bullish',
    channel: 'Achats officiels -> Demande structurelle -> Gold',
    impactDuration: 'structural',
    cancelling: ['inversion des flux officiels'],
  },
  {
    pattern: /\b(debt ceiling|government shutdown|credit rating|downgrade[sd]?|fiscal deficit)\b/i,
    macro: 78, volatility: 68, duration: 65,
    category: 'fiscal', channel: 'Risque souverain -> Prime de terme -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['accord budgétaire', 'confirmation de notation'],
  },
  {
    pattern: /\b(tariffs?|trade war|trade deal|import duties|trade talks)\b/i,
    macro: 68, volatility: 60, duration: 62,
    category: 'trade', channel: 'Commerce -> Croissance et inflation -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['accord commercial', 'exemptions accordées'],
  },
  {
    pattern: /\b(gdp|gross domestic product|recession|economic growth)\b/i,
    macro: 72, volatility: 58, duration: 60,
    category: 'growth', channel: 'Croissance -> Trajectoire Fed -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['révisions ultérieures', 'divergence emploi/croissance'],
  },
  {
    pattern: /\b(ppi|producer price index|retail sales|durable goods)\b/i,
    macro: 62, volatility: 52, duration: 40,
    category: 'growth', channel: 'Données secondaires -> Anticipations -> Gold',
    impactDuration: 'short_term',
    cancelling: ['contradiction avec le CPI'],
  },
  {
    pattern: /\b(jobless claims|unemployment rate|adp employment)\b/i,
    macro: 58, volatility: 50, duration: 30,
    category: 'employment', channel: 'Emploi -> Anticipations Fed -> Gold',
    impactDuration: 'short_term',
    cancelling: ['volatilité hebdomadaire de la série'],
  },
  {
    pattern: /\b(treasury yields?|10[- ]year|real yields?|bond market|yield curve|tips)\b/i,
    macro: 80, volatility: 65, duration: 55,
    category: 'monetary_policy', channel: 'Taux réels -> Coût d\'opportunité -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['compensation par la prime de risque'],
  },
  {
    pattern: /\b(dollar index|dxy|dollar (?:strength|weakness)|greenback)\b/i,
    macro: 70, volatility: 58, duration: 45,
    category: 'monetary_policy', channel: 'Dollar -> Prix en USD -> Gold',
    impactDuration: 'short_term',
    cancelling: ['mouvement spécifique à une devise et non global'],
  },
  {
    pattern: /\b(oil price|crude|opec|energy crisis|gas prices)\b/i,
    macro: 60, volatility: 55, duration: 55,
    category: 'energy', channel: 'Énergie -> Inflation -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['réponse restrictive des banques centrales'],
  },
  {
    pattern: /\b(pmi|ism (?:manufacturing|services)|business confidence|consumer confidence)\b/i,
    // SPEC §23 : "PMI secondaire : 30/100".
    macro: 30, volatility: 35, duration: 25,
    category: 'growth', channel: 'Enquête -> Anticipations -> Gold',
    impactDuration: 'short_term',
    cancelling: ['démenti par les données dures'],
  },
  {
    pattern: /\b(election|referendum|parliament|vote|impeachment)\b/i,
    macro: 55, volatility: 50, duration: 58,
    category: 'geopolitics', channel: 'Politique -> Incertitude -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['résultat conforme aux sondages'],
  },
  {
    pattern: /\b(etf (?:inflow|outflow|holdings)|gld|cot report|managed money|net long|net short)\b/i,
    macro: 65, volatility: 48, duration: 55,
    category: 'other', channel: 'Positionnement -> Flux -> Gold',
    impactDuration: 'medium_term',
    cancelling: ['positionnement extrême et risque de squeeze inverse'],
  },
];

/** Règle par défaut : article pertinent pour l'or mais sans catalyseur identifié. */
const DEFAULT_RULE: KeywordRule = {
  pattern: /.^/,
  macro: 25, volatility: 20, duration: 20,
  category: 'other', channel: 'Canal de transmission non identifié',
  impactDuration: 'short_term',
  cancelling: [],
};

/** Lexique directionnel (§27). Poids positif = haussier pour l'or. */
const BULLISH_LEXICON: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(rate cut|cuts? rates|dovish|easing|stimulus)\b/i, 2],
  [/\b(safe haven|flight to quality|risk[- ]off|haven demand)\b/i, 2],
  [/\b(war|invasion|military strike|escalation|attack)\b/i, 2],
  [/\b(banking crisis|bank failure|default|contagion)\b/i, 2],
  [/\b(inflation (?:surge|jump|accelerat\w+)|hotter than expected)\b/i, 1],
  [/\b(record high|surges?|rallies|jumps?|climbs?)\b/i, 1],
  [/\b(weaker dollar|dollar falls|yields? (?:fall|drop|decline))\b/i, 1],
];

const BEARISH_LEXICON: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(rate hike|hikes? rates|hawkish|tightening|tapering)\b/i, 2],
  [/\b(risk[- ]on|rally in stocks|record (?:stock|equity))\b/i, 1],
  [/\b(stronger dollar|dollar (?:rises|surges)|yields? (?:rise|surge|jump))\b/i, 2],
  [/\b(cooler than expected|inflation (?:eases|slows|cools))\b/i, 1],
  [/\b(gold (?:falls|slides|drops|tumbles|retreats))\b/i, 2],
  [/\b(ceasefire|peace (?:deal|talks)|de[- ]escalation|truce)\b/i, 2],
];

/** Lexique de surprise (§23 Surprise Factor). */
const SURPRISE_LEXICON: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(unexpected\w*|surprise\w*|shock\w*|stunning|abrupt\w*)\b/i, 30],
  // Une action non programmée est par construction l'écart maximal à la
  // trajectoire anticipée : c'est le marqueur de surprise le plus fort (§23).
  [/\b(emergency|unscheduled|snap (?:decision|election)|intermeeting)\b/i, 45],
  // "Breaking" est un habillage éditorial, pas une mesure de surprise.
  [/\bbreaking\b/i, 8],
  [/\b(hotter than expected|higher than expected|above (?:forecasts?|expectations?)|beats? (?:forecasts?|expectations?))\b/i, 25],
  [/\b(cooler than expected|lower than expected|below (?:forecasts?|expectations?)|misses? (?:forecasts?|expectations?))\b/i, 25],
  [/\b(first time since|record|unprecedented|historic)\b/i, 15],
];

/** Régions (§20.2), du plus spécifique au plus général. */
const REGION_RULES: ReadonlyArray<readonly [RegExp, Region]> = [
  [/\b(israel|gaza|iran|iraq|syria|lebanon|yemen|saudi|houthi|red sea|middle east|hormuz)\b/i, 'MENA'],
  [/\b(russia|moscow|putin|kremlin|ukraine|kyiv)\b/i, 'RU'],
  [/\b(china|beijing|taiwan|pboc|yuan|south china sea|xi jinping)\b/i, 'CN'],
  [/\b(japan|tokyo|boj|yen)\b/i, 'JP'],
  [/\b(swiss|switzerland|snb|franc)\b/i, 'CH'],
  [/\b(uk|britain|british|london|bank of england|boe|sterling|gilt)\b/i, 'UK'],
  [/\b(euro(?:pe|zone)?|ecb|germany|france|italy|lagarde|bund)\b/i, 'EU'],
  [/\b(fed|federal reserve|u\.?s\.?|united states|washington|treasury|powell|dollar)\b/i, 'US'],
  [/\b(india|brazil|turkey|emerging markets?|south africa)\b/i, 'EM'],
];

/** Termes établissant la pertinence pour XAUUSD. Filtre du bruit (§21). */
const RELEVANCE_TERMS: readonly RegExp[] = [
  /\b(gold|bullion|xauusd|xau)\b/i,
  /\b(fed|federal reserve|fomc|powell|ecb|boj|boe|central bank)\b/i,
  /\b(inflation|cpi|pce|ppi|payrolls|nfp|gdp)\b/i,
  /\b(real yields?|treasury yields?|10[- ]year|bond market|yield curve)\b/i,
  /\b(dollar|dxy|greenback)\b/i,
  /\b(war|sanctions|military|geopolitical|escalation|conflict)\b/i,
  /\b(banking crisis|default|liquidity crisis|financial stability)\b/i,
  /\b(safe haven|risk[- ]off|volatility|vix)\b/i,
];

/** Compte les axes de pertinence distincts touchés par l'article. */
function relevanceScore(text: string): number {
  let hits = 0;
  for (const term of RELEVANCE_TERMS) {
    if (term.test(text)) hits++;
  }
  return hits;
}

/**
 * SURPRISE (§23) : compare résultat réel et attentes de marché.
 *
 * Trois niveaux de preuve, par ordre de fiabilité décroissante :
 *   1. écart chiffré explicite dans le texte ("4.0% vs 3.1% expected") ;
 *   2. lexique de surprise ("unexpected", "beats forecasts") ;
 *   3. aucune preuve -> valeur neutre EXPLICITEMENT enregistrée comme
 *      hypothèse (§2.2 : ne jamais présenter une estimation comme un fait).
 */
function scoreSurprise(
  text: string,
  isScheduledRelease: boolean,
  assumptions: Assumption[],
): number {
  // 1. Écart chiffré : "came in at 4.0% versus 3.1% expected".
  const numericMatch =
    /(-?\d+(?:[.,]\d+)?)\s*%?\s*(?:vs\.?|versus|against|compared (?:to|with))\s*(?:a\s*)?(?:forecast|expectation|estimate|consensus|expected|poll)?\s*(?:of\s*)?(-?\d+(?:[.,]\d+)?)/i
      .exec(text);

  if (numericMatch) {
    const actual = Number(numericMatch[1]?.replace(',', '.'));
    const expected = Number(numericMatch[2]?.replace(',', '.'));
    if (Number.isFinite(actual) && Number.isFinite(expected) && expected !== 0) {
      const deviation = Math.abs((actual - expected) / expected);
      // 0% d'écart -> 0 ; 30% d'écart ou plus -> 100. Échelle linéaire bornée.
      return clamp(deviation * 333);
    }
  }

  // 2. Lexique de surprise.
  let lexical = 0;
  for (const [pattern, weight] of SURPRISE_LEXICON) {
    if (pattern.test(text)) lexical += weight;
  }
  if (lexical > 0) return clamp(lexical);

  // 3. Aucune preuve : hypothèse assumée et tracée.
  // Défaut relevé 25->40 (2026-08-23) : 43/48 articles monetary_policy/inflation
  // sur 7j tombaient sous le seuil MAJOR (score moyen 59, macro moyen 83) à cause
  // de ce plancher. L'absence de chiffre 'actual vs expected' ne signifie pas
  // absence de pertinence — cf. audit ingestion_runs/news_events 2026-08-23.
  const assumed = isScheduledRelease ? 50 : 40;
  assumptions.push({
    variable: 'surprise_score',
    reason: isScheduledRelease
      ? 'Publication programmée sans consensus ni chiffre réel détecté dans le texte : surprise indéterminée.'
      : 'Aucun écart chiffré ni marqueur lexical de surprise détecté.',
    assumed_value: assumed,
  });
  return assumed;
}

/**
 * QUALITÉ DE LA DONNÉE (§64) : fraîcheur, complétude, fiabilité de la source.
 * Un score faible n'invalide pas l'événement mais réduit la confiance que le
 * moteur IA lui accordera.
 */
function scoreQuality(article: NormalizedArticle, reliability: number): number {
  const ageMinutes = (Date.now() - article.publishedAt.getTime()) / 60_000;
  // Fraîcheur : 100 à moins de 15 min, décroissance linéaire sur 24h.
  const freshness = ageMinutes <= 15 ? 100 : clamp(100 - ((ageMinutes - 15) / 1440) * 100);

  // Complétude : présence du corps, de l'URL et du domaine identifié.
  let completeness = 40;
  if (article.content) completeness += 35;
  if (article.url) completeness += 15;
  if (article.domain) completeness += 10;

  return clamp(freshness * 0.4 + completeness * 0.3 + reliability * 0.3);
}

/** Détermine la région dominante de l'événement. */
function detectRegion(text: string): Region {
  for (const [pattern, region] of REGION_RULES) {
    if (pattern.test(text)) return region;
  }
  return 'GLOBAL';
}

/**
 * SENTIMENT (§27) et direction attendue sur l'or.
 * Le sentiment est exprimé dans [-1, 1] : négatif = risk-off, favorable à l'or.
 */
function scoreDirection(text: string, rule: KeywordRule): {
  direction: GoldDirection;
  sentiment: number;
} {
  let bull = 0;
  let bear = 0;
  for (const [pattern, weight] of BULLISH_LEXICON) if (pattern.test(text)) bull += weight;
  for (const [pattern, weight] of BEARISH_LEXICON) if (pattern.test(text)) bear += weight;

  // Le biais structurel de la règle (guerre, sanctions) pèse comme un signal fort.
  if (rule.bias === 'bullish') bull += 2;
  if (rule.bias === 'bearish') bear += 2;

  const net = bull - bear;
  const total = bull + bear;

  // SPEC §2.2 : privilégier "Flat" en l'absence d'avantage clair.
  const direction: GoldDirection = net >= 2 ? 'bullish' : net <= -2 ? 'bearish' : 'neutral';
  const sentiment = total === 0 ? 0 : Math.round((-net / total) * 1000) / 1000;

  return { direction, sentiment: Math.max(-1, Math.min(1, sentiment)) };
}

/** Niveau de risque géopolitique (§25). Null si l'événement n'est pas géopolitique. */
function scoreRiskLevel(
  category: NewsCategory,
  newsScore: number,
): RiskLevel | null {
  if (category !== 'geopolitics' && category !== 'financial_stability') return null;
  if (newsScore >= 80) return 'CRITICAL';
  if (newsScore >= 65) return 'HIGH';
  if (newsScore >= 45) return 'MEDIUM';
  return 'LOW';
}

/**
 * Agrège toutes les règles déclenchées par le texte.
 *
 * Macro, volatilité et durée retiennent le MAXIMUM : le catalyseur le plus
 * fort commande l'impact. La règle dominante (macro le plus élevé) fixe la
 * catégorie, le canal de transmission et la durée qualitative. Les facteurs
 * annulants sont unis, puisqu'un seul suffit à invalider le scénario.
 */
function resolveCatalyst(text: string): KeywordRule {
  const matched = KEYWORD_RULES.filter((r) => r.pattern.test(text));
  if (matched.length === 0) return DEFAULT_RULE;

  const dominant = matched.reduce((best, current) =>
    current.macro > best.macro ? current : best);
  if (matched.length === 1) return dominant;

  const cancelling = new Set<string>();
  for (const r of matched) for (const c of r.cancelling) cancelling.add(c);

  return {
    ...dominant,
    macro: Math.max(...matched.map((r) => r.macro)),
    volatility: Math.max(...matched.map((r) => r.volatility)),
    duration: Math.max(...matched.map((r) => r.duration)),
    // Un biais directionnel explicite l'emporte sur l'absence de biais.
    bias: matched.find((r) => r.bias !== undefined)?.bias ?? dominant.bias,
    cancelling: [...cancelling],
  };
}

/** Publications programmées : leur surprise se mesure contre un consensus. */
const SCHEDULED_RELEASE =
  /\b(cpi|pce|ppi|payrolls|nfp|gdp|retail sales|jobless claims|pmi|ism|fomc|rate decision)\b/i;

/**
 * Applique le modèle complet à un article normalisé.
 * Renvoie null si l'article n'est pas pertinent pour XAUUSD (§21 filtrage).
 */
function scoreArticle(
  article: NormalizedArticle,
  registry: SourceRegistry,
  runId: string,
): ScoredEvent | null {
  const text = `${article.title} ${article.content ?? ''}`;

  // --- Filtrage du bruit informationnel (§21) --------------------------------
  if (relevanceScore(text) < CONFIG.MIN_RELEVANCE) return null;

  // --- Validation de source (§64) --------------------------------------------
  const source = registry.resolve(article.domain);

  // --- Identification du ou des catalyseurs -----------------------------------
  // Un événement peut cumuler plusieurs catalyseurs ("emergency rate cut amid
  // banking crisis"). Retenir la première règle sous-estimerait l'impact : on
  // agrège par le maximum, la règle dominante fixant catégorie et canal.
  const rule = resolveCatalyst(text);

  const assumptions: Assumption[] = [];
  if (rule === DEFAULT_RULE) {
    assumptions.push({
      variable: 'macro_score',
      reason: 'Aucun catalyseur connu identifié : barème par défaut appliqué.',
      assumed_value: DEFAULT_RULE.macro,
    });
  }
  if (source.code === CONFIG.FALLBACK_SOURCE_CODE) {
    assumptions.push({
      variable: 'reliability_score',
      reason: `Éditeur absent du référentiel (${article.domain ?? 'domaine inconnu'}) : fiabilité plancher appliquée.`,
      assumed_value: CONFIG.FALLBACK_RELIABILITY,
    });
  }
  if (!article.content) {
    assumptions.push({
      variable: 'scoring_input',
      reason: 'Corps d\'article indisponible : scoring établi sur le titre seul.',
      assumed_value: 0,
    });
  }

  // --- Les cinq variables (§23), toutes sur 0-100 ----------------------------
  const macro = clamp(rule.macro);
  const volatility = clamp(rule.volatility);
  const reliability = clamp(source.reliability_score);
  const surprise = scoreSurprise(text, SCHEDULED_RELEASE.test(text), assumptions);
  const duration = clamp(rule.duration);

  // --- FORMULE SPEC §22 -------------------------------------------------------
  // Recalculée à l'identique en base par fn_news_score() : la valeur ci-dessous
  // sert au routage immédiat et au log, la colonne générée fait foi.
  const newsScore = clamp(
    macro * CONFIG.WEIGHTS.macro +
    volatility * CONFIG.WEIGHTS.volatility +
    reliability * CONFIG.WEIGHTS.reliability +
    surprise * CONFIG.WEIGHTS.surprise +
    duration * CONFIG.WEIGHTS.duration,
  );

  // --- Classification et action (§24) ----------------------------------------
  const classification: Classification =
    newsScore >= CONFIG.THRESHOLD_CRITICAL ? 'critical'
      : newsScore >= CONFIG.THRESHOLD_MAJOR ? 'major'
        : 'noise';

  const action: NewsAction =
    newsScore >= CONFIG.THRESHOLD_CRITICAL ? 'RECALC_H1_H2'
      : newsScore >= CONFIG.THRESHOLD_MAJOR ? 'REEVALUATE_H3'
        : 'ARCHIVE_ONLY';

  const { direction, sentiment } = scoreDirection(text, rule);

  return {
    title: article.title,
    content: article.content,
    source: source.code,
    source_url: article.url,
    category: rule.category,
    region: detectRegion(text),
    sentiment,
    macro_score: macro,
    volatility_score: volatility,
    reliability_score: reliability,
    surprise_score: surprise,
    duration_score: duration,
    classification,
    gold_direction_impact: direction,
    // Aucune amplitude n'est publiée par les sources : la colonne reste NULL
    // plutôt que de recevoir une valeur inventée (§2.2).
    expected_move_usd: null,
    risk_level: scoreRiskLevel(rule.category, newsScore),
    transmission: {
      channel: rule.channel,
      duration: rule.impactDuration,
      cancelling_factors: rule.cancelling,
    },
    assumptions,
    quality_score: scoreQuality(article, reliability),
    ingest_run_id: runId,
    ts: article.publishedAt.toISOString(),
    _computed: { macro, volatility, reliability, surprise, duration, newsScore, action },
  };
}

/* -------------------------------------------------------------------------- */
/* 10. DÉDUPLICATION                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Déduplication intra-lot. La déduplication inter-lots est assurée en base
 * par l'index unique sur la colonne générée dedup_hash : deux barrières
 * indépendantes, la base restant l'autorité finale.
 *
 * En cas de doublon, l'exemplaire retenu est celui de la source la plus
 * fiable, puis le plus complet.
 */
function deduplicate(
  articles: readonly NormalizedArticle[],
  registry: SourceRegistry,
): { unique: NormalizedArticle[]; duplicates: number } {
  const best = new Map<string, NormalizedArticle>();
  let duplicates = 0;

  for (const article of articles) {
    if (article.dedupKey.length < 8) continue; // Titre trop court pour être fiable.

    const existing = best.get(article.dedupKey);
    if (!existing) {
      best.set(article.dedupKey, article);
      continue;
    }

    duplicates++;
    const currentScore = registry.resolve(article.domain).reliability_score
      + (article.content ? 10 : 0);
    const existingScore = registry.resolve(existing.domain).reliability_score
      + (existing.content ? 10 : 0);

    if (currentScore > existingScore) best.set(article.dedupKey, article);
  }

  return { unique: [...best.values()], duplicates };
}

/* -------------------------------------------------------------------------- */
/* 11. PERSISTANCE POSTGREST                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Client PostgREST minimal. Aucun driver Postgres : les Workers ne
 * disposent pas de sockets TCP bruts, et l'API REST de Supabase applique
 * nativement les contraintes et triggers du schéma.
 */
class SupabaseClient {
  private readonly base: string;

  constructor(
    env: Env,
    private readonly log: Logger,
  ) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase incomplète : SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY requis.');
    }
    this.base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  private readonly key: string;

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.key,
      authorization: `Bearer ${this.key}`,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /** Exécute une requête PostgREST avec timeout et retry sur erreur transitoire.
   *  Public : consommé par shared/run_lock.ts (interface LockCapableDb). */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const url = `${this.base}/${path}`;

    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.DB_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method,
          headers: this.headers(extraHeaders),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.status === 429 || response.status >= 500) {
          throw new HttpError(`Supabase HTTP ${response.status}`, response.status, true);
        }
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 400);
          throw new HttpError(`Supabase HTTP ${response.status} : ${detail}`, response.status, false);
        }

        const text = await response.text();
        return (text ? JSON.parse(text) : []) as T;
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const retryable = isAbort || !(err instanceof HttpError) || err.retryable;

        if (!retryable || attempt === CONFIG.MAX_RETRIES) {
          throw isAbort ? new TimeoutError(CONFIG.DB_TIMEOUT_MS) : err;
        }
        const delay = backoffDelay(attempt);
        this.log.warn('Supabase : nouvelle tentative', {
          attempt: attempt + 1,
          delay_ms: delay,
          reason: errorMessage(err),
        });
        await sleep(delay);
      }
    }
    throw new Error('Supabase : nombre maximal de tentatives atteint.');
  }

  async select<T>(table: string, columns: string, filter = ''): Promise<T[]> {
    const query = `${table}?select=${encodeURIComponent(columns)}${filter ? `&${filter}` : ''}`;
    return this.request<T[]>('GET', query);
  }

  /**
   * Insertion en masse avec ignorance des doublons.
   * `on_conflict=dedup_hash` cible l'index unique sur la colonne générée :
   * un article déjà ingéré par un autre flux est ignoré sans erreur.
   */
  /**
   * Insertion en masse avec ignorance des doublons.
   * `on_conflict=dedup_hash` cible l'index unique sur la colonne générée :
   * un article déjà ingéré par un autre flux est ignoré sans erreur.
   *
   * Renvoie (id, title, ts) des lignes effectivement insérées : ScoredEvent
   * n'a pas d'id avant écriture, ce triplet sert de clé de corrélation pour
   * rattacher chaque event scoré à sa ligne réelle (alertes, notification).
   */
  async insertNews(
    rows: readonly Record<string, unknown>[],
  ): Promise<Array<{ id: string; title: string; ts: string }>> {
    if (rows.length === 0) return [];
    return this.request<Array<{ id: string; title: string; ts: string }>>(
      'POST',
      'news_events?on_conflict=dedup_hash&select=id,title,ts',
      rows,
      { prefer: 'return=representation,resolution=ignore-duplicates' },
    );
  }

  // createRun()/finalizeRun() supprimées : le verrou (acquisition ET
  // finalisation de la ligne ingestion_runs) passe désormais par
  // shared/run_lock.ts (acquireLock/releaseLock), seule implémentation de
  // locking du projet — voir runIngestion() plus bas.

  async insertAlerts(rows: readonly Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    // dedup_key porte un index unique partiel sur les alertes actives :
    // une même news ne peut pas générer deux alertes ouvertes.
    await this.request('POST', 'alerts?on_conflict=dedup_key', rows, {
      prefer: 'return=minimal,resolution=ignore-duplicates',
    });
  }

  /**
   * Marque un lot de news comme notifiées. Appelé après un succès HTTP,
   * qu'il vienne du chemin direct (dispatchActions) ou de la sweep de
   * réconciliation (reconcileNotifications).
   */
  async markNotified(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = ids.map((id) => `"${id}"`).join(',');
    await this.request('PATCH', `news_events?id=in.(${list})`, {
      notified_at: new Date().toISOString(),
    });
  }

  /** Incrémente le compteur de tentatives sans marquer comme notifié (échec). */
  async bumpNotifyAttempts(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = ids.map((id) => `"${id}"`).join(',');
    // PostgREST ne sait pas incrémenter en une passe : lecture puis écriture
    // resterait exposée à une course bénigne (au pire une tentative comptée
    // en trop, sans conséquence au vu du plafond de 10). Un RPC dédiée serait
    // atomique mais introduirait une fonction supplémentaire pour un compteur
    // de diagnostic non critique — non justifié ici.
    const current = await this.select<{ id: string; notify_attempts: number }>(
      'news_events', 'id,notify_attempts', `id=in.(${list})`,
    );
    await Promise.all(
      current.map((row) =>
        this.request('PATCH', `news_events?id=eq.${row.id}`, {
          notify_attempts: row.notify_attempts + 1,
        })),
    );
  }

  /** Événements actionnables jamais acquittés au-delà de la fenêtre de grâce. */
  async fetchPendingNotifications(): Promise<Array<{
    id: string; title: string; action: NewsAction; news_score: number;
  }>> {
    return this.select<{ id: string; title: string; action: NewsAction; news_score: number }>(
      'v_news_pending_notification',
      'id,title,action,news_score',
    );
  }
}

/** Retire les champs internes avant insertion. */
function toRow(event: ScoredEvent): Record<string, unknown> {
  const { _computed, transmission, assumptions, ...rest } = event;
  void _computed;
  return { ...rest, transmission, assumptions };
}

/**
 * Rattache chaque event scoré à l'id réel attribué par PostgREST.
 *
 * PostgREST ne garantit pas l'ordre de `return=representation` face à
 * l'ordre du payload : on corrèle donc par (title, ts), suffisamment
 * discriminant puisque le lot a déjà été dédupliqué par dedupKey avant
 * l'insertion. Un event sans correspondance a été rejeté par
 * `on_conflict=dedup_hash` (doublon déjà connu en base) : il est omis,
 * pas d'échec — c'est le comportement attendu de la déduplication inter-lots.
 */
function correlateInsertedIds(
  scored: readonly ScoredEvent[],
  inserted: ReadonlyArray<{ id: string; title: string; ts: string }>,
): Array<{ event: ScoredEvent; id: string }> {
  const byKey = new Map(inserted.map((row) => [`${row.title}\u0000${row.ts}`, row.id]));
  const matched: Array<{ event: ScoredEvent; id: string }> = [];
  for (const event of scored) {
    const id = byKey.get(`${event.title}\u0000${event.ts}`);
    if (id) matched.push({ event, id });
  }
  return matched;
}

/* -------------------------------------------------------------------------- */
/* 12. ACTIONS AVAL (§24, §66, §70)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Envoie le ping de réveil au moteur IA. Fonction pure vis-à-vis de la base :
 * elle ne fait aucune hypothèse sur l'origine des événements (dispatch direct
 * ou sweep de réconciliation), ce qui lui permet d'être partagée par les deux.
 */
/**
 * Notification du moteur IA — CONTRAT EVENT-DRIVEN.
 *
 * Correctif P0-EVENT-DRIVEN : l'ancien payload envoyait des COMPTEURS
 * (`recalc_h1_h2: 3`) que le comité ne pouvait pas exploiter — ni identifier
 * l'événement, ni garantir l'idempotence, ni tracer la news déclenchante.
 * Chaque événement actionnable produit désormais une notification typée et
 * identifiée.
 *
 * `event_id` est dérivé de l'identifiant de la news, donc STABLE : un rejeu
 * de la sweep de réconciliation porte le même identifiant et sera reconnu
 * comme doublon par le comité.
 */
export interface CommitteeNotification {
  readonly event_id: string;
  readonly event_type: 'RECALC_H1_H2' | 'REEVALUATE_H3';
  readonly source: string;
  readonly triggered_at: string;
  readonly news_event_id: string;
  readonly news_score: number;
}

export function buildNotification(
  newsId: string,
  action: NewsAction,
  newsScore: number,
): CommitteeNotification | null {
  if (action === 'ARCHIVE_ONLY') return null;
  return {
    event_id: `news:${newsId}:${action}`,
    event_type: action,
    source: CONFIG.ENGINE_VERSION,
    triggered_at: new Date().toISOString(),
    news_event_id: newsId,
    news_score: newsScore,
  };
}

async function postNotification(
  notification: CommitteeNotification,
  env: Env,
  log: Logger,
): Promise<boolean> {
  if (!env.AI_ENGINE_URL) {
    // BLOCKER #3 : niveau `warn` et non `debug`. Avec LOG_LEVEL=info par
    // défaut, un `debug` était invisible : le chemin event-driven mourait
    // sans laisser la moindre trace, ce qui est le pire mode de panne —
    // le système paraît sain et ne réagit plus aux CATALYST.
    log.warn('AI_ENGINE_URL non configurée : notification event-driven IGNORÉE. '
      + 'Le comité ne réagira qu\'au cron horaire. Poser AI_ENGINE_URL et '
      + 'AI_ENGINE_TOKEN (= COMMITTEE_TOKEN) pour activer le temps réel.');
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(env.AI_ENGINE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // COUPLAGE OBLIGATOIRE : AI_ENGINE_TOKEN doit être ÉGAL à
        // COMMITTEE_TOKEN du moteur IA — c'est cette valeur que compare son
        // contrôle d'autorisation (timingSafeEqual). Deux valeurs distinctes
        // produisent un 401 sur chaque notification. Voir wrangler.toml.
        ...(env.AI_ENGINE_TOKEN ? { authorization: `Bearer ${env.AI_ENGINE_TOKEN}` } : {}),
      },
      body: JSON.stringify(notification),
      signal: controller.signal,
    });
    // Un 2xx confirme la prise en charge ; tout le reste est traité comme un
    // échec rejouable par la sweep, y compris un 200 mal formé côté moteur IA.
    // PROCESSED, ALREADY_PROCESSED et ALREADY_RUNNING répondent tous 200 :
    // dans les trois cas l'événement est pris en charge et ne doit pas être
    // rejoué indéfiniment.
    return response.ok;
  } catch (err) {
    log.warn('Notification du moteur IA en échec', { reason: errorMessage(err) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notifie le comité pour chaque événement actionnable, séquentiellement.
 *
 * Séquentiel et non parallèle : le comité est protégé par un verrou unique.
 * En rafale, la première notification déclenche le recalcul et les suivantes
 * reçoivent ALREADY_RUNNING — ce qui est correct, le comité en cours lisant
 * déjà l'intégralité des news actionnables via v_news_actionable.
 *
 * Renvoie les identifiants de news effectivement pris en charge.
 */
async function notifyAiEngine(
  events: ReadonlyArray<{ id: string; action: NewsAction; score: number }>,
  env: Env,
  log: Logger,
): Promise<string[]> {
  if (!env.AI_ENGINE_URL) {
    // Voir ci-dessus : configuration manquante => panne observable.
    log.warn('AI_ENGINE_URL non configurée : aucune notification émise.', {
      evenements_non_notifies: events.length,
    });
    return [];
  }

  const delivered: string[] = [];
  // Le plus fort score d'abord : si le verrou n'autorise qu'un recalcul,
  // il doit être déclenché par l'événement le plus significatif.
  const ordered = [...events].sort((a, b) => b.score - a.score);

  for (const event of ordered) {
    const notification = buildNotification(event.id, event.action, event.score);
    if (notification === null) continue;
    const ok = await postNotification(notification, env, log);
    if (ok) delivered.push(event.id);
  }

  log.info('Notifications event-driven', { envoyees: ordered.length, prises_en_charge: delivered.length });
  return delivered;
}

/**
 * Traduit la classification en actions concrètes :
 *   CATALYST CRITICAL -> alerte critique + recalcul immédiat H1/H2 ;
 *   MAJOR IMPACT      -> alerte haute + réévaluation H3 ;
 *   MARKET NOISE      -> archivage, aucune action.
 *
 * ARCHITECTURE : la base (news_events + alerts) est la file durable unique,
 * identique sur Cloudflare Workers et Vercel Functions. La notification HTTP
 * au moteur IA n'est qu'un accélérateur de latence : sur succès, les
 * événements sont marqués notified_at ; sur échec, ils restent éligibles à
 * la sweep de réconciliation (reconcileNotifications) au lieu d'être ré-émis
 * en boucle ici ou perdus silencieusement.
 */
async function dispatchActions(
  persisted: ReadonlyArray<{ event: ScoredEvent; id: string }>,
  db: SupabaseClient,
  env: Env,
  log: Logger,
): Promise<void> {
  const actionable = persisted.filter((p) => p.event._computed.action !== 'ARCHIVE_ONLY');
  if (actionable.length === 0) return;

  const alerts = actionable.map(({ event, id }) => ({
    alert_type: event.category === 'geopolitics' ? 'macro' : 'news',
    severity: event._computed.action === 'RECALC_H1_H2' ? 'critical' : 'high',
    trigger: {
      rule: 'news_score_threshold',
      news_score: event._computed.newsScore,
      threshold: event._computed.action === 'RECALC_H1_H2'
        ? CONFIG.THRESHOLD_CRITICAL
        : CONFIG.THRESHOLD_MAJOR,
      action: event._computed.action,
      breakdown: {
        macro: event.macro_score,
        volatility: event.volatility_score,
        reliability: event.reliability_score,
        surprise: event.surprise_score,
        duration: event.duration_score,
      },
      engine: CONFIG.ENGINE_VERSION,
    },
    message: `[${event._computed.action}] ${event.title}`,
    status: 'triggered',
    triggered_at: new Date().toISOString(),
    symbol: 'XAUUSD',
    news_id: id,
    // Une seule alerte active par titre : anti-spam sur les reprises de dépêche.
    dedup_key: `news:${event.ts.slice(0, 13)}:${dedupKeyOf(event.title).slice(0, 80)}`,
  }));

  try {
    await db.insertAlerts(alerts);
    log.info('Alertes créées', { count: alerts.length });
  } catch (err) {
    // Non bloquant : les événements restent notifiables même sans alerte.
    log.error('Création des alertes en échec', { reason: errorMessage(err) });
  }

  // Seuls les événements EFFECTIVEMENT pris en charge sont marqués notifiés :
  // un échec partiel laisse les autres à la sweep de réconciliation.
  const delivered = await notifyAiEngine(
    actionable.map(({ event, id }) => ({
      id,
      action: event._computed.action,
      score: event._computed.newsScore,
    })),
    env,
    log,
  );

  const ids = actionable.map((p) => p.id);
  if (delivered.length > 0) {
    await db.markNotified(delivered);
    log.info('Moteur IA notifié', { events: delivered.length, sur: ids.length });
  }
  if (delivered.length < ids.length) {
    // Chemin direct en échec : la sweep de réconciliation prend le relais
    // au prochain tick cron (dans 90s minimum, cf. v_news_pending_notification).
    await db.bumpNotifyAttempts(ids);
  }
}

/**
 * Sweep de réconciliation : rattrape tout événement CATALYST/MAJOR jamais
 * acquitté par le chemin direct, au-delà de la fenêtre de grâce de 90s
 * (`v_news_pending_notification`). S'exécute sur le même tick cron que
 * l'ingestion : coût quasi nul en régime normal, l'index partiel sur
 * `notified_at IS NULL` garde la vue vide la plupart du temps.
 *
 * Volontairement séparée de runIngestion() : un déploiement peut appeler
 * cette fonction seule à une fréquence différente si le budget cron le
 * justifie, sans dépendre du cycle de collecte des news.
 */
export async function reconcileNotifications(env: Env): Promise<{ swept: number; notified: number }> {
  const log = new Logger(env.LOG_LEVEL, 'reconcile');
  const db = new SupabaseClient(env, log);

  const pending = await db.fetchPendingNotifications();
  if (pending.length === 0) {
    log.debug('Sweep de réconciliation : rien à traiter');
    return { swept: 0, notified: 0 };
  }

  log.warn('Sweep de réconciliation : événements non acquittés détectés', {
    count: pending.length,
    ids: pending.map((p) => p.id),
  });

  const ids = pending.map((p) => p.id);
  const delivered = await notifyAiEngine(
    pending.map((p) => ({ id: p.id, action: p.action, score: p.news_score })),
    env,
    log,
  );

  if (delivered.length > 0) {
    await db.markNotified(delivered);
    log.info('Sweep de réconciliation : notification rattrapée', { count: delivered.length });
  }
  if (delivered.length < ids.length) {
    const failed = ids.filter((id) => !delivered.includes(id));
    await db.bumpNotifyAttempts(failed);
    // Un événement approchant le plafond de tentatives est un incident
    // opérationnel : le signaler comme alerte système plutôt que de le
    // laisser se réessayer silencieusement jusqu'à expiration.
    const stuck = pending.filter((p) => p.news_score >= CONFIG.THRESHOLD_CRITICAL);
    if (stuck.length > 0) {
      await db.insertAlerts(stuck.map((p) => ({
        alert_type: 'system',
        severity: 'high',
        trigger: { rule: 'ai_engine_notification_failing', news_id: p.id },
        message: `Notification moteur IA en échec répété pour "${p.title}"`,
        status: 'triggered',
        triggered_at: new Date().toISOString(),
        news_id: p.id,
        dedup_key: `notify-stuck:${p.id}`,
      })));
    }
    log.error('Sweep de réconciliation : notification toujours en échec', {
      count: ids.length - delivered.length,
    });
  }

  return { swept: pending.length, notified: delivered.length };
}

/* -------------------------------------------------------------------------- */
/* 13. ORCHESTRATION DU PIPELINE (§62)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Levée quand un run news_engine est déjà actif (verrou shared/run_lock.ts
 * non acquis). Cas NOMINAL — un cron qui déborde sur le suivant — pas une
 * erreur : voir acquireLock().
 */
export class NewsEngineBusyError extends Error {
  readonly status = 'ALREADY_RUNNING' as const;
  constructor() {
    super('ALREADY_RUNNING : un run news_engine est déjà en cours d\'exécution.');
    this.name = 'NewsEngineBusyError';
  }
}

/**
 * Pipeline complet :
 *   collecte -> validation source -> déduplication -> nettoyage
 *   -> classification -> scoring -> persistance -> actions.
 *
 * Chaque étape est isolée : l'échec d'un collecteur produit un run `partial`,
 * pas un run `failed`. Un run n'échoue que si la base est inaccessible.
 *
 * VERROU (aligné sur ai_committee, correctif P0-CONCURRENCY) : la prise du
 * verrou précède toute collecte, via l'implémentation partagée
 * shared/run_lock.ts (mêmes garanties PostgreSQL, même récupération des
 * verrous abandonnés que market_engine/ai_committee).
 */
export async function runIngestion(env: Env, triggerType: string): Promise<IngestReport> {
  const startedAt = Date.now();
  const bootLog = new Logger(env.LOG_LEVEL, 'pending');
  const db = new SupabaseClient(env, bootLog);

  const lock = await acquireLock(db, 'news_engine', triggerType);
  if (!lock.acquired) {
    bootLog.warn('SKIPPED : un run news_engine est déjà en cours.');
    throw new NewsEngineBusyError();
  }
  const runId = lock.runRowId;
  const log = new Logger(env.LOG_LEVEL, runId);
  log.info('Ingestion démarrée', { trigger: triggerType });

  const errors: string[] = [];
  let report: IngestReport;

  try {
    const registry = await SourceRegistry.load(db, log);

    // Horodatage de run UNIQUE pour toute la collecte de sources
    // officielles RAW (jamais un new Date() par article — voir
    // NEWS-OFFICIAL-005 §6).
    const officialObservedAt = new Date().toISOString();

    // Federal Reserve RAW (news_articles) et la collecte legacy
    // GDELT+NewsAPI (news_events) démarrent TOUS LES DEUX ici, avant tout
    // await : ni l'un ni l'autre n'attend la latence de l'autre. Le
    // .catch() est attaché immédiatement pour qu'un échec inattendu de
    // l'adaptateur ne devienne jamais une unhandled rejection — il se
    // dégrade en résultat unhealthy explicite à la place.
    const fedRawPromise: Promise<FederalReserveRawIngestResult> = ingestFederalReserveRaw({
      db,
      ingestRunId: runId,
      observedAt: officialObservedAt,
    }).catch((err: unknown): FederalReserveRawIngestResult => {
      const reason = errorMessage(err);
      log.error('Federal Reserve RAW : échec inattendu de l\'adaptateur', { reason });
      return {
        ok: false,
        durationMs: 0,
        observations: 0,
        collectorRejected: 0,
        inserted: 0,
        duplicates: 0,
        writerRejected: 0,
        databaseErrors: 0,
        feeds: [],
        errors: [reason],
      };
    });

    const legacyPromise = Promise.all([
      collectGdelt(env, log),
      collectNewsApi(env, log),
    ]);

    // Barrière de cycle de vie (P1) : Promise.all([legacyPromise, fedRawPromise])
    // rejetterait dès que L'UN des deux échoue, laissant l'AUTRE continuer en
    // arrière-plan pendant que le catch extérieur finalise le run et
    // releaseLock() — une tâche du run pourrait alors s'exécuter après la
    // libération du verrou. Promise.allSettled ATTEND que les DEUX promesses
    // soient réglées avant toute décision, quelle que soit l'issue de
    // chacune : aucun chemin ne peut atteindre le catch/releaseLock pendant
    // que l'autre est encore en vol.
    const [legacySettled, fedRawSettled] = await Promise.allSettled([legacyPromise, fedRawPromise]);

    if (legacySettled.status === 'rejected') {
      throw legacySettled.reason;
    }
    if (fedRawSettled.status === 'rejected') {
      // Défensif : fedRawPromise porte déjà son propre .catch() immédiat
      // (ligne ci-dessus) qui dégrade tout échec en résultat unhealthy —
      // cette branche ne devrait jamais s'exécuter, mais un état impossible
      // ne doit jamais être supposé silencieusement.
      throw fedRawSettled.reason;
    }

    const [gdelt, newsapi] = legacySettled.value;
    const fedRaw = fedRawSettled.value;

    log.info('Federal Reserve RAW terminé', {
      observations: fedRaw.observations,
      collector_rejected: fedRaw.collectorRejected,
      inserted: fedRaw.inserted,
      duplicates: fedRaw.duplicates,
      writer_rejected: fedRaw.writerRejected,
      database_errors: fedRaw.databaseErrors,
      feeds: fedRaw.feeds,
      duration_ms: fedRaw.durationMs,
    });

    const providers: Record<string, ProviderReport> = {
      gdelt: gdelt.report,
      newsapi: newsapi.report,
      federal_reserve: {
        ok: fedRaw.ok,
        count: fedRaw.observations,
        retries: 0,
        duration_ms: fedRaw.durationMs,
        inserted: fedRaw.inserted,
        duplicates: fedRaw.duplicates,
        rejected: fedRaw.collectorRejected + fedRaw.writerRejected,
        database_errors: fedRaw.databaseErrors,
        ...(fedRaw.ok ? {} : { error: fedRaw.errors.join('; ') || 'federal_reserve raw ingestion unhealthy' }),
      },
    };
    if (gdelt.report.error) errors.push(`gdelt: ${gdelt.report.error}`);
    if (newsapi.report.error) errors.push(`newsapi: ${newsapi.report.error}`);
    if (!fedRaw.ok) errors.push(`federal_reserve: ${providers.federal_reserve.error}`);

    const fetched = gdelt.articles.length + newsapi.articles.length;
    const { unique, duplicates } = deduplicate([...gdelt.articles, ...newsapi.articles], registry);

    // Scoring. Les articles non pertinents pour XAUUSD sont rejetés ici.
    const scored: ScoredEvent[] = [];
    for (const article of unique) {
      const event = scoreArticle(article, registry, runId);
      if (event) scored.push(event);
    }
    const rejected = unique.length - scored.length;

    log.info('Scoring terminé', {
      fetched, duplicates, rejected, scored: scored.length,
    });

    // Persistance par lots : une insertion unique de 300 lignes dépasserait
    // la limite de taille de requête et le budget CPU du Worker.
    const persisted: Array<{ event: ScoredEvent; id: string }> = [];
    for (let i = 0; i < scored.length; i += CONFIG.DB_BATCH_SIZE) {
      const batch = scored.slice(i, i + CONFIG.DB_BATCH_SIZE);
      try {
        const insertedRows = await db.insertNews(batch.map(toRow));
        persisted.push(...correlateInsertedIds(batch, insertedRows));
      } catch (err) {
        // Un lot en échec ne doit pas emporter les suivants.
        const message = `batch ${i / CONFIG.DB_BATCH_SIZE}: ${errorMessage(err)}`;
        errors.push(message);
        log.error('Insertion de lot en échec', { batch_index: i, reason: errorMessage(err) });
      }
    }

    const critical = persisted.filter((p) => p.event._computed.action === 'RECALC_H1_H2').length;
    const major = persisted.filter((p) => p.event._computed.action === 'REEVALUATE_H3').length;

    if (persisted.length > 0) {
      await dispatchActions(persisted, db, env, log);
    }

    const allProvidersOk = gdelt.report.ok && newsapi.report.ok && fedRaw.ok;
    report = {
      run_id: runId,
      status: errors.length === 0 && allProvidersOk ? 'success' : 'partial',
      duration_ms: Date.now() - startedAt,
      fetched,
      rejected,
      duplicates,
      persisted: persisted.length,
      critical,
      major,
      providers,
      errors,
    };

    log.info('Ingestion terminée', {
      status: report.status,
      persisted: persisted.length,
      critical,
      major,
      duration_ms: report.duration_ms,
    });
  } catch (err) {
    errors.push(errorMessage(err));
    report = {
      run_id: runId,
      status: 'failed',
      duration_ms: Date.now() - startedAt,
      fetched: 0, rejected: 0, duplicates: 0, persisted: 0, critical: 0, major: 0,
      providers: {},
      errors,
    };
    log.error('Ingestion en échec', { reason: errorMessage(err) });
  }

  // Le journal du run est écrit quel que soit l'issue : sans lui, une source
  // morte resterait invisible (§100 checklist données). Libération
  // inconditionnelle du verrou, comme ai_committee : un verrou non relâché
  // bloquerait le moteur jusqu'à la récupération stale (15 min).
  await releaseLock(db, runId, {
    status: report.status,
    durationMs: report.duration_ms,
    fetched: report.fetched,
    rejected: report.rejected,
    persisted: report.persisted,
    duplicates: report.duplicates,
    critical: report.critical,
    major: report.major,
    providers: report.providers,
    errors: report.errors,
  }).catch((err: unknown) => {
    log.error('Libération du verrou news_engine en échec', { reason: errorMessage(err) });
  });

  return report;
}

/* -------------------------------------------------------------------------- */
/* 14. POINTS D'ENTRÉE SERVERLESS                                              */
/* -------------------------------------------------------------------------- */

/** Contrat minimal du contexte Cloudflare, pour éviter une dépendance de types. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface ScheduledEventLike {
  readonly cron?: string;
  readonly scheduledTime?: number;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Un rapport d'ingestion ne doit jamais être mis en cache.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Vérifie le jeton d'appel. Le déclenchement manuel est réservé aux
 * opérateurs : sans cette barrière, n'importe qui pourrait épuiser les
 * quotas des fournisseurs (§69).
 */
function isAuthorized(request: Request, env: Env): boolean {
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get('x-ingest-token')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  return timingSafeEqual(header, env.INGEST_TOKEN);
}

/**
 * Handler HTTP. POST uniquement : l'ingestion modifie l'état du système
 * et ne doit pas être déclenchable par une simple navigation.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path.endsWith('/health')) {
    return jsonResponse({ status: 'ok', engine: CONFIG.ENGINE_VERSION }, 200);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utiliser POST.' }, 405);
  }
  if (!isAuthorized(request, env)) {
    // Aucun détail sur la raison du refus : ne pas aider un attaquant.
    return jsonResponse({ error: 'Non autorisé' }, 401);
  }

  try {
    if (path.endsWith('/reconcile')) {
      const result = await reconcileNotifications(env);
      return jsonResponse(result, 200);
    }
    const report = await runIngestion(env, 'manual');
    return jsonResponse(report, report.status === 'failed' ? 500 : 200);
  } catch (err) {
    if (err instanceof NewsEngineBusyError) {
      // Même convention que ai_committee : run déjà en cours = livraison
      // prise en compte, pas une erreur serveur.
      return jsonResponse({ status: 'ALREADY_RUNNING', errors: [err.message] }, 200);
    }
    // Le message d'erreur interne n'est jamais renvoyé au client.
    new Logger(env.LOG_LEVEL, 'unhandled').error('Exception non gérée', {
      reason: errorMessage(err),
    });
    return jsonResponse({ error: 'Erreur interne du moteur d\'ingestion' }, 500);
  }
}

/** Export Cloudflare Workers : déclenchement cron + endpoint HTTP. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(
    event: ScheduledEventLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    // waitUntil garantit que le run se termine même après le retour du handler.
    // La sweep suit l'ingestion sur le même tick : coût quasi nul en régime
    // normal (index partiel sur notified_at IS NULL), et garantit qu'aucun
    // événement CATALYST/MAJOR ne reste orphelin d'un échec HTTP transitoire.
    ctx.waitUntil(
      runIngestion(env, 'cron')
        .catch((err: unknown) => {
          new Logger(env.LOG_LEVEL, 'cron').error('Run cron en échec', {
            cron: event.cron,
            reason: errorMessage(err),
          });
        })
        .then(() => reconcileNotifications(env))
        .catch((err: unknown) => {
          new Logger(env.LOG_LEVEL, 'cron-reconcile').error('Sweep de réconciliation en échec', {
            reason: errorMessage(err),
          });
        }),
    );
  },
};

/**
 * Export Vercel Edge Functions.
 * Configuration : `export const config = { runtime: 'edge' }` dans la route.
 */
export async function POST(request: Request): Promise<Response> {
  // Sur Vercel, les secrets sont exposés via process.env et non via un
  // objet env injecté : la lecture est isolée ici pour garder le reste du
  // moteur agnostique du runtime.
  const env = readEnvFromProcess();
  return handleRequest(request, env);
}

/** Lecture défensive de process.env, absent sur Cloudflare Workers. */
function readEnvFromProcess(): Env {
  const source =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

  const required = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
    return value;
  };

  return {
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
    INGEST_TOKEN: required('INGEST_TOKEN'),
    NEWSAPI_KEY: source['NEWSAPI_KEY'],
    AI_ENGINE_URL: source['AI_ENGINE_URL'],
    AI_ENGINE_TOKEN: source['AI_ENGINE_TOKEN'],
    GDELT_TIMESPAN: source['GDELT_TIMESPAN'],
    LOG_LEVEL: source['LOG_LEVEL'],
  };
}

/* -------------------------------------------------------------------------- */
/*  Exports internes exposés pour les tests unitaires (tests/unit).            */
/* -------------------------------------------------------------------------- */
export const __internals = {
  cleanText,
  dedupKeyOf,
  parseTimestamp,
  parseRetryAfter,
  backoffDelay,
  relevanceScore,
  scoreSurprise,
  scoreDirection,
  scoreQuality,
  scoreRiskLevel,
  detectRegion,
  deduplicate,
  scoreArticle,
  resolveCatalyst,
  correlateInsertedIds,
  timingSafeEqual,
  redact,
  CONFIG,
  KEYWORD_RULES,
};
