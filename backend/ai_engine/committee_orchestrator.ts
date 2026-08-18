/**
 * =============================================================================
 *  ALPHA-XAU INSTITUTIONAL TERMINAL
 *  backend/ai_engine/committee_orchestrator.ts
 *
 *  AI CORE — ARCHITECTURE MULTI-AGENTS (MASTER SPEC §50 à §57)
 *
 *  Pipeline séquentiel :
 *
 *      Macro Analyst ─┐
 *   Geopolitical AI ──┼─> Risk Committee ──> Portfolio Manager ──> Terminal
 *      Technical AI ──┘        (veto)            (synthèse)
 *
 *  PRINCIPE DIRECTEUR : un LLM ne peut pas être la dernière ligne de défense.
 *  Les prompts EXPRIMENT les règles, ce fichier les APPLIQUE. Toute contrainte
 *  citée comme "règle absolue" dans la spécification est vérifiée par du code
 *  déterministe après la réponse du modèle (validateCommitteeOutput), jamais
 *  déléguée à la seule obéissance de l'agent.
 *
 *  RÈGLE ABSOLUE APPLIQUÉE ICI :
 *    aucun scénario ne peut exister sans justification, sans probabilité et
 *    sans niveau d'invalidation mathématique. Un scénario non conforme fait
 *    basculer l'analyse entière en NO_VALID_SETUP.
 *
 *  Runtime : Cloudflare Workers / Vercel Edge. fetch/URL/AbortController seuls.
 * =============================================================================
 */

import {
  AGENT_PROMPTS,
  PROMPT_VERSION,
  type AgentName,
} from './prompts.js';
// Correctif P0-1 : contrat de lecture unique du moteur marché.
import { fetchMarketSnapshot } from '../market_engine/context.js';
// Correctif P0-CONCURRENCY : verrou partagé, arbitré par PostgreSQL.
import { acquireLock, releaseLock, isUniqueViolation } from '../shared/run_lock.js';

/* -------------------------------------------------------------------------- */
/*  1. ENVIRONNEMENT ET CONFIGURATION                                          */
/* -------------------------------------------------------------------------- */

export interface Env {
  readonly ANTHROPIC_API_KEY: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly COMMITTEE_TOKEN: string;
  /** Surcharge optionnelle des modèles. */
  readonly MODEL_ANALYST?: string;
  readonly MODEL_COMMITTEE?: string;
  readonly LOG_LEVEL?: string;
}

const CONFIG = {
  ENGINE_VERSION: 'ai-committee-1.0.0',

  ANTHROPIC_URL: 'https://api.anthropic.com/v1/messages',
  ANTHROPIC_VERSION: '2023-06-01',

  /**
   * Routage par tier. Les trois analystes produisent des lectures cadrées :
   * Sonnet 5 suffit et divise le coût. Le Risk Committee et le Portfolio
   * Manager font le raisonnement adversarial et la synthèse contrainte —
   * c'est là que la capacité du modèle change le résultat, d'où Opus 5.
   */
  MODEL_ANALYST_DEFAULT: 'claude-sonnet-5',
  MODEL_COMMITTEE_DEFAULT: 'claude-opus-5',

  // MAX_TOKENS_ANALYST relevé de 2000 à 3000 (2026-08-18) : troncature
  // réelle observée en production (macro_analyst, stop_reason=max_tokens)
  // juste après le retrait du prefill JSON. Ce budget avait été calibré
  // avec le prefill actif, qui empêchait mécaniquement toute balise
  // markdown ou texte préalable avant le JSON. Sans lui, le modèle peut
  // consommer une partie du budget en formatage avant le contenu utile.
  MAX_TOKENS_ANALYST: 3_000,
  // MAX_TOKENS_GEOPOLITICAL distinct (2026-08-18) : troncature persistante
  // à 3000 sur ce seul agent, cause structurelle identifiée dans son
  // schéma (prompts.ts) — un tableau `events[]` à 6 champs par élément,
  // dont deux en texte libre (canal de transmission, facteurs
  // d'annulation), de taille NON BORNÉE par nature : elle dépend du
  // volume de news géopolitiques réellement en circulation, pas d'un
  // nombre fixe de variables comme macro_analyst (Fed, CPI, DXY, taux —
  // schéma plat). Budget dédié plutôt que de relever le budget partagé
  // des trois analystes sur la base d'un seul cas structurellement
  // différent.
  MAX_TOKENS_GEOPOLITICAL: 5_000,
  MAX_TOKENS_COMMITTEE: 4_000,
  /** Température basse : on veut de la reproductibilité, pas de la créativité. */
  TEMPERATURE: 0.2,

  HTTP_TIMEOUT_MS: 60_000,
  DB_TIMEOUT_MS: 15_000,
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 1_000,
  BACKOFF_MAX_MS: 16_000,
  MAX_RETRY_AFTER_MS: 30_000,
  /** Une réponse JSON malformée vaut une relance, pas un échec immédiat. */
  MAX_JSON_REPAIRS: 1,

  /** Seuils Risk/Reward — SPEC contrôle 3 du Risk Committee. */
  RR_REJECT_BELOW: 1.0,
  RR_CAP_BELOW: 1.5,
  RR_CAP_VALUE: 0.55,

  /** Tolérance sur la somme des probabilités, alignée sur la contrainte SQL. */
  PROBABILITY_TOLERANCE: 0.01,

  /** Longueur minimale d'une justification (miroir du CHECK SQL >= 10). */
  MIN_REASONING_LENGTH: 20,
  /** Miroir du CHECK SQL chk_ai_scenarios_activation_substantive (>= 15). */
  MIN_ACTIVATION_LENGTH: 15,

  HORIZONS: ['H1', 'H2', 'H3', 'H4'] as const,
  HORIZON_WINDOWS: {
    H1: '6 hours',
    H2: '24 hours',
    H3: '7 days',
    H4: '30 days',
  } as const,
} as const;

/* -------------------------------------------------------------------------- */
/*  2. TYPES                                                                   */
/* -------------------------------------------------------------------------- */

export type Direction = 'bullish' | 'bearish' | 'neutral';
export type Horizon = (typeof CONFIG.HORIZONS)[number];
/**
 * Verdicts du Risk Committee (P1-3).
 *
 * REJECTED, DATA_INSUFFICIENT et CONFLICT bloquent tous l'exécution, mais
 * désignent trois défaillances distinctes :
 *   REJECTED           le scénario est défaillant (données OK, agents OK) ;
 *   DATA_INSUFFICIENT  les données sont insuffisantes ou périmées ;
 *   CONFLICT           les agents sont irréconciliables et non arbitrables.
 * Les replier l'un sur l'autre rendrait la calibration aveugle : ils ne se
 * corrigent pas de la même façon.
 */
export type Verdict =
  | 'APPROVED'
  | 'APPROVED_WITH_CONDITIONS'
  | 'REJECTED'
  | 'DATA_INSUFFICIENT'
  | 'CONFLICT';

/** Verdicts interdisant toute exécution. */
export const BLOCKING_VERDICTS: readonly Verdict[] =
  ['REJECTED', 'DATA_INSUFFICIENT', 'CONFLICT'];

export const isBlockingVerdict = (v: Verdict): boolean => BLOCKING_VERDICTS.includes(v);
export type ExecutionStatus = 'VALID_SETUP' | 'NO_VALID_SETUP';

export interface MarketContext {
  readonly symbol: string;
  readonly spot: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly dxy: number | null;
  readonly us10y: number | null;
  readonly realYield: number | null;
  readonly vix: number | null;
  readonly wti: number | null;
  readonly atr: number | null;
  readonly stalenessSeconds: number;
  readonly capturedAt: string;
}

export interface NewsContextItem {
  readonly id: string;
  readonly title: string;
  readonly newsScore: number;
  readonly classification: string;
  readonly goldDirection: string;
  readonly region: string;
  readonly category: string;
  readonly riskLevel: string | null;
  readonly ts: string;
}

export interface MacroOutput {
  readonly macro_regime: string;
  readonly gold_pressure: Direction;
  readonly main_driver: string;
  readonly real_yield_assessment: string;
  readonly dollar_assessment: string;
  readonly divergences: readonly string[];
  readonly missing_data: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
}

export interface GeopoliticalOutput {
  readonly risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly gold_direction: Direction;
  readonly dominant_event: string;
  readonly events: readonly Record<string, unknown>[];
  readonly missing_data: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
}

export interface TechnicalOutput {
  readonly trend_daily: string;
  readonly trend_h4: string;
  readonly trend_h1: string;
  readonly structure: string;
  readonly technical_bias: Direction;
  readonly key_supports: readonly number[];
  readonly key_resistances: readonly number[];
  readonly liquidity_zones: readonly Record<string, unknown>[];
  readonly atr: number;
  readonly current_session: string;
  readonly expected_volatility: string;
  readonly stop_hunt_risk: string;
  readonly missing_data: readonly string[];
  readonly confidence: number;
  readonly reasoning: string;
}

export interface ScenarioReview {
  readonly horizon: Horizon;
  readonly has_valid_invalidation: boolean;
  readonly risk_reward: number;
  readonly verdict: 'accepted' | 'rejected';
  readonly rejection_reason: string | null;
}

export interface RiskCommitteeOutput {
  readonly verdict: Verdict;
  readonly confidence_cap: number;
  readonly contradictions: ReadonlyArray<{
    description: string;
    severity: string;
    blocking: boolean;
  }>;
  readonly scenario_reviews: readonly ScenarioReview[];
  readonly data_quality_issues: readonly string[];
  readonly bias_flags: readonly string[];
  readonly rejection_reasons: readonly string[];
  readonly reasoning: string;
}

/** Scénario tel qu'exposé au frontend : probabilité et confiance en 0-100. */
export interface Scenario {
  readonly direction: Direction;
  readonly probability: number;
  readonly target: number;
  readonly invalidation: number;
  /**
   * P1-4 : QUAND le scénario devient actif. Une cible et une invalidation
   * disent où il va et où il meurt, jamais quand il commence à exister.
   * Obligatoire, minimum MIN_ACTIVATION_LENGTH caractères.
   */
  readonly activation_condition: string;
  readonly confidence: number;
  readonly reasoning: string;
}

/**
 * CONTRAT FRONTEND — les sept clés imposées par la spécification, à
 * l'identique. `meta` est un ajout documenté : sans model_version ni
 * run_id, une analyse n'est pas auditable a posteriori (§87) et la
 * performance_scorecard ne peut pas la retrouver. Le frontend peut
 * l'ignorer sans conséquence.
 */
export interface CommitteeAnalysis {
  readonly market_regime: string;
  readonly overall_bias: Direction;
  readonly confidence: number;
  readonly scenarios: Readonly<Record<Horizon, Scenario>>;
  readonly drivers: readonly string[];
  readonly risks: readonly string[];
  readonly invalidations: readonly string[];
  readonly meta: {
    readonly analysis_id: string | null;
    readonly model_version: string;
    readonly execution_status: ExecutionStatus;
    readonly risk_verdict: Verdict;
    readonly confidence_cap: number;
    readonly spot_reference: number;
    readonly data_quality_issues: readonly string[];
    readonly validation_errors: readonly string[];
    readonly agents: Readonly<Record<string, { model: string; latency_ms: number }>>;
    readonly generated_at: string;
    readonly total_latency_ms: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  3. LOGGER (identique au news_engine : logs JSON, secrets masqués)          */
/* -------------------------------------------------------------------------- */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY_PATTERN = /(key|token|secret|password|authorization|apikey|bearer)/i;

function redactString(value: string): string {
  return value
    .replace(/(sk-ant-[A-Za-z0-9._\-]+)/g, '[REDACTED]')
    .replace(/([?&](?:apiKey|api_key|apikey|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]');
}

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

class Logger {
  private readonly min: number;
  constructor(level: string | undefined, private readonly runId: string) {
    const normalized = (level ?? 'info').toLowerCase() as LogLevel;
    this.min = LEVEL_ORDER[normalized] ?? LEVEL_ORDER.info;
  }
  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.min) return;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      engine: CONFIG.ENGINE_VERSION,
      run_id: this.runId,
      message,
      ...(context ? { context: redact(context) } : {}),
    }));
  }
  debug(m: string, c?: Record<string, unknown>): void { this.emit('debug', m, c); }
  info(m: string, c?: Record<string, unknown>): void { this.emit('info', m, c); }
  warn(m: string, c?: Record<string, unknown>): void { this.emit('warn', m, c); }
  error(m: string, c?: Record<string, unknown>): void { this.emit('error', m, c); }
}

/* -------------------------------------------------------------------------- */
/*  4. UTILITAIRES                                                             */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorMessage(err: unknown): string {
  if (err instanceof Error) return redactString(`${err.name}: ${err.message}`);
  return redactString(String(err));
}

function backoffDelay(attempt: number): number {
  const exponential = Math.min(CONFIG.BACKOFF_BASE_MS * 2 ** attempt, CONFIG.BACKOFF_MAX_MS);
  return Math.floor(Math.random() * exponential);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ba.length ^ bb.length;
  const len = Math.max(ba.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Vérifie qu'une valeur est un nombre fini exploitable comme prix. */
function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/* -------------------------------------------------------------------------- */
/*  5. CLIENT ANTHROPIC                                                        */
/* -------------------------------------------------------------------------- */

class AnthropicError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean,
              readonly retryAfterMs?: number) {
    super(message);
    this.name = 'AnthropicError';
  }
}

interface AnthropicResponse {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/**
 * Appel Messages API avec timeout, retry exponentiel et gestion du 429.
 *
 * Le tour assistant est pré-rempli avec "{" : le modèle ne peut plus produire
 * de préambule ni de bloc markdown, sa continuation EST le JSON. C'est plus
 * fiable qu'une instruction de format seule, et le "{" est réinjecté avant
 * parsing.
 */
async function callClaude(
  agent: AgentName,
  model: string,
  userContent: string,
  maxTokens: number,
  env: Env,
  log: Logger,
): Promise<{ json: unknown; latencyMs: number }> {
  const startedAt = Date.now();
  const systemPrompt = AGENT_PROMPTS[agent];

  let lastError: unknown;
  let repairs = 0;
  let repairHint = '';

  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(CONFIG.ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': CONFIG.ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // `temperature` retiré (2026-08-18) : Anthropic a marqué ce
          // paramètre obsolète pour ce modèle, confirmé par une vraie
          // erreur 400 en production (invalid_request_error, pas une
          // supposition). Le modèle applique désormais son propre réglage
          // fixe. CONFIG.TEMPERATURE reste déclaré (0.2) au cas où un
          // futur modèle réintroduirait ce paramètre, mais n'est plus
          // envoyé dans la requête.
          system: systemPrompt,
          messages: [
            { role: 'user', content: userContent + repairHint },
            // Prefill RETIRÉ (2026-08-18) : erreur 400 réelle en
            // production — « This model does not support assistant
            // message prefill. The conversation must end with a user
            // message. » Le modèle appelé a cessé d'accepter cette
            // technique. Le system prompt doit désormais porter seul la
            // contrainte « JSON pur, sans balise markdown » ; voir le
            // parsing ci-dessous, adapté en conséquence.
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        throw new AnthropicError(`${agent}: rate limited`, 429, true, retryAfter ?? undefined);
      }
      if (response.status >= 500 || response.status === 408 || response.status === 529) {
        throw new AnthropicError(`${agent}: HTTP ${response.status}`, response.status, true);
      }
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 300);
        throw new AnthropicError(
          `${agent}: HTTP ${response.status} ${redactString(body)}`, response.status, false,
        );
      }

      const data = (await response.json()) as AnthropicResponse;

      // Une troncature produit un JSON syntaxiquement invalide : il faut la
      // détecter explicitement pour ne pas la confondre avec une désobéissance
      // de format et gaspiller une réparation.
      if (data.stop_reason === 'max_tokens') {
        throw new AnthropicError(
          `${agent}: réponse tronquée (max_tokens=${maxTokens})`, 200, false,
        );
      }

      const text = (data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      try {
        // Sans prefill, le modèle peut entourer sa sortie de balises
        // markdown (```json ... ```) malgré la consigne du system prompt —
        // c'est un comportement documenté sur d'autres modèles Anthropic
        // en l'absence de prefill forçant un JSON brut. On les retire
        // avant de parser, sans quoi JSON.parse échouerait sur un texte
        // par ailleurs valide.
        const cleaned = text
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();
        const json = JSON.parse(cleaned) as unknown;
        log.info(`${agent} OK`, {
          model,
          attempt,
          latency_ms: Date.now() - startedAt,
          input_tokens: data.usage?.input_tokens,
          output_tokens: data.usage?.output_tokens,
        });
        return { json, latencyMs: Date.now() - startedAt };
      } catch {
        if (repairs < CONFIG.MAX_JSON_REPAIRS) {
          repairs++;
          repairHint = '\n\nATTENTION : ta réponse précédente n\'était pas un JSON valide. '
            + 'Réponds UNIQUEMENT par l\'objet JSON demandé, sans aucun autre caractère.';
          log.warn(`${agent}: JSON invalide, réparation`, { repair: repairs });
          continue;
        }
        throw new AnthropicError(`${agent}: JSON invalide après réparation`, 200, false);
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) lastError = new Error(`${agent}: timeout après ${CONFIG.HTTP_TIMEOUT_MS}ms`);

      const isApi = err instanceof AnthropicError;
      const retryable = isAbort || !isApi || (err as AnthropicError).retryable;
      if (!retryable || attempt === CONFIG.MAX_RETRIES) break;

      const suggested = isApi ? (err as AnthropicError).retryAfterMs : undefined;
      if (suggested !== undefined && suggested > CONFIG.MAX_RETRY_AFTER_MS) {
        log.warn(`${agent}: quota saturé, abandon`, { retry_after_ms: suggested });
        break;
      }

      const delay = suggested ?? backoffDelay(attempt);
      log.warn(`${agent}: nouvelle tentative`, {
        attempt: attempt + 1, delay_ms: delay, reason: errorMessage(lastError),
      });
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
}

/* -------------------------------------------------------------------------- */
/*  6. COERCITION DÉFENSIVE DES SORTIES AGENTS                                 */
/* -------------------------------------------------------------------------- */

/**
 * Un LLM peut renvoyer un JSON valide mais structurellement inattendu.
 * Ces helpers normalisent sans jamais lever : une valeur absente devient une
 * valeur neutre explicite, ce qui alimente ensuite les data_quality_issues.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = 'N/A'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asDirection(value: unknown): Direction {
  return value === 'bullish' || value === 'bearish' ? value : 'neutral';
}

/** Ramène une confiance dans [0,1], que l'agent l'ait exprimée en 0-1 ou 0-100. */
function asUnitConfidence(value: unknown): number {
  const raw = asNumber(value, 0.5);
  const unit = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, unit));
}

/* -------------------------------------------------------------------------- */
/*  7. CONSTRUCTION DU CONTEXTE                                                */
/* -------------------------------------------------------------------------- */

/**
 * Sérialise le contexte marché. Les valeurs absentes deviennent "N/A" en
 * clair : c'est ce que la SPEC §2.2 exige, et cela empêche l'agent de
 * confondre une donnée manquante avec un zéro.
 */
function renderMarketContext(market: MarketContext): string {
  const fmt = (v: number | null, unit = ''): string =>
    v === null || !Number.isFinite(v) ? 'N/A' : `${v}${unit}`;

  return `DONNÉES DE MARCHÉ (faits — ne pas extrapoler)
Symbole            : ${market.symbol}
Spot               : ${fmt(market.spot)}
Bid / Ask          : ${fmt(market.bid)} / ${fmt(market.ask)}
DXY                : ${fmt(market.dxy)}
US10Y              : ${fmt(market.us10y, '%')}
Rendement réel     : ${fmt(market.realYield, '%')}
VIX                : ${fmt(market.vix)}
WTI                : ${fmt(market.wti)}
ATR                : ${fmt(market.atr)}
Horodatage donnée  : ${market.capturedAt}
Fraîcheur          : ${market.stalenessSeconds}s${market.stalenessSeconds > 900 ? ' — DONNÉE PÉRIMÉE (>15min)' : ''}`;
}

function renderNewsContext(news: readonly NewsContextItem[]): string {
  if (news.length === 0) {
    return 'FLUX NEWS : aucun événement actionnable sur la fenêtre. Ne pas inventer d\'événement.';
  }
  const lines = news.slice(0, 25).map((n) =>
    `- [${n.classification.toUpperCase()} ${n.newsScore}/100] ${n.title}\n`
    + `  region=${n.region} cat=${n.category} impact_or=${n.goldDirection}`
    + `${n.riskLevel ? ` risk=${n.riskLevel}` : ''} ts=${n.ts}`);
  return `FLUX NEWS SCORÉ (${news.length} événements) :\n${lines.join('\n')}`;
}

/* -------------------------------------------------------------------------- */
/*  8. VALIDATION DÉTERMINISTE — LE CŒUR DU SYSTÈME                            */
/* -------------------------------------------------------------------------- */

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly scenarios: Readonly<Record<Horizon, Scenario>> | null;
}

/**
 * Calcule le Risk/Reward d'un scénario. Renvoie null si l'invalidation est
 * confondue avec le spot : la division serait infinie, le scénario est
 * inexploitable et doit être rejeté, pas approximé.
 */
export function riskReward(spot: number, target: number, invalidation: number): number | null {
  const risk = Math.abs(spot - invalidation);
  if (risk < 1e-9) return null;
  return Math.abs(target - spot) / risk;
}

/**
 * RÈGLE ABSOLUE — appliquée en code, pas en prompt.
 *
 * Un scénario est rejeté s'il lui manque l'un des trois éléments obligatoires,
 * ou si sa géométrie est incohérente (miroir exact de la contrainte SQL
 * chk_ai_scenarios_geometry : le rejet doit se produire ici, pas au moment
 * de l'INSERT, sinon l'erreur remonterait comme un incident base).
 */
export function validateScenario(
  horizon: Horizon,
  raw: unknown,
  spot: number,
): { scenario: Scenario | null; errors: string[] } {
  const errors: string[] = [];
  const s = asRecord(raw);

  const direction = asDirection(s['direction']);
  const probability = asNumber(s['probability'], NaN);
  const target = s['target'];
  const invalidation = s['invalidation'];
  const reasoning = typeof s['reasoning'] === 'string' ? s['reasoning'].trim() : '';
  const activation = typeof s['activation_condition'] === 'string'
    ? s['activation_condition'].trim() : '';

  // 1. JUSTIFICATION
  if (reasoning.length < CONFIG.MIN_REASONING_LENGTH) {
    errors.push(`${horizon}: justification absente ou insuffisante (${reasoning.length} caractères, minimum ${CONFIG.MIN_REASONING_LENGTH}).`);
  }

  // 2. PROBABILITÉ
  if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
    errors.push(`${horizon}: probabilité invalide (${String(s['probability'])}). Attendu : entier 0-100.`);
  }

  // 3. CONDITION D'ACTIVATION (P1-4) — un scénario n'est pas exploitable
  //    du seul fait qu'il porte une cible et une invalidation.
  if (activation.length < CONFIG.MIN_ACTIVATION_LENGTH) {
    errors.push(`${horizon}: condition d'activation absente ou insuffisante (${activation.length} caractères, minimum ${CONFIG.MIN_ACTIVATION_LENGTH}). Un scénario doit déclarer QUAND il devient actif.`);
  }

  // 4. INVALIDATION MATHÉMATIQUE — un prix, jamais du texte, jamais null.
  if (!isFinitePositive(invalidation)) {
    errors.push(`${horizon}: niveau d'invalidation non numérique (${JSON.stringify(s['invalidation'])}). Un scénario sans invalidation chiffrée est rejeté.`);
  }
  if (!isFinitePositive(target)) {
    errors.push(`${horizon}: cible non numérique (${JSON.stringify(s['target'])}).`);
  }

  if (errors.length > 0) return { scenario: null, errors };

  const t = target as number;
  const inv = invalidation as number;

  // 4. GÉOMÉTRIE — miroir de la contrainte SQL.
  if (direction === 'bullish' && t <= inv) {
    errors.push(`${horizon}: scénario haussier avec cible (${t}) sous ou égale à l'invalidation (${inv}). Géométrie incohérente.`);
  }
  if (direction === 'bearish' && t >= inv) {
    errors.push(`${horizon}: scénario baissier avec cible (${t}) au-dessus ou égale à l'invalidation (${inv}). Géométrie incohérente.`);
  }

  // 5. RISK / REWARD — contrôle 3 du Risk Committee, revérifié en code.
  if (direction !== 'neutral') {
    const rr = riskReward(spot, t, inv);
    if (rr === null) {
      errors.push(`${horizon}: invalidation confondue avec le spot (${spot}), risk/reward incalculable.`);
    } else if (rr < CONFIG.RR_REJECT_BELOW) {
      errors.push(`${horizon}: risk/reward de ${rr.toFixed(2)} inférieur au seuil ${CONFIG.RR_REJECT_BELOW}. Asymétrie défavorable.`);
    }
  }

  if (errors.length > 0) return { scenario: null, errors };

  return {
    scenario: {
      direction,
      probability: Math.round(probability),
      target: t,
      invalidation: inv,
      activation_condition: activation,
      confidence: Math.round(Math.max(0, Math.min(100, asNumber(s['confidence'], 50)))),
      reasoning,
    },
    errors: [],
  };
}

/**
 * Normalise les probabilités pour qu'elles totalisent exactement 100.
 *
 * Méthode du plus fort reste : on répartit l'écart d'arrondi sur les
 * scénarios dont la partie décimale est la plus élevée. Un simple round()
 * par scénario laisserait fréquemment une somme à 99 ou 101, ce qui violerait
 * le CONSTRAINT TRIGGER SQL (somme = 1.00 ± 0.01) et ferait échouer l'INSERT.
 */
export function normalizeProbabilities(
  scenarios: Record<Horizon, Scenario>,
): Record<Horizon, Scenario> {
  const horizons = CONFIG.HORIZONS;
  const total = horizons.reduce((sum, h) => sum + scenarios[h].probability, 0);

  // Somme nulle : distribution impossible à normaliser par proportion.
  // On répartit uniformément plutôt que de diviser par zéro.
  if (total <= 0) {
    const equal = 25;
    return Object.fromEntries(
      horizons.map((h) => [h, { ...scenarios[h], probability: equal }]),
    ) as Record<Horizon, Scenario>;
  }

  const scaled = horizons.map((h) => {
    const exact = (scenarios[h].probability / total) * 100;
    return { horizon: h, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let remaining = 100 - scaled.reduce((sum, s) => sum + s.floor, 0);
  const byRemainder = [...scaled].sort((a, b) => b.remainder - a.remainder);
  const bonus = new Map<Horizon, number>();
  for (const entry of byRemainder) {
    bonus.set(entry.horizon, remaining > 0 ? 1 : 0);
    if (remaining > 0) remaining--;
  }

  return Object.fromEntries(
    scaled.map((s) => [
      s.horizon,
      { ...scenarios[s.horizon], probability: s.floor + (bonus.get(s.horizon) ?? 0) },
    ]),
  ) as Record<Horizon, Scenario>;
}

/**
 * Valide la sortie complète du Portfolio Manager.
 * Un seul scénario non conforme invalide l'analyse entière : la spécification
 * ne prévoit pas d'analyse partielle, et un terminal affichant trois scénarios
 * sur quatre mentirait sur la distribution de probabilité.
 */
export function validateCommitteeOutput(
  raw: unknown,
  spot: number,
): ValidationResult {
  const errors: string[] = [];
  const root = asRecord(raw);
  const rawScenarios = asRecord(root['scenarios']);

  const validated: Partial<Record<Horizon, Scenario>> = {};
  for (const horizon of CONFIG.HORIZONS) {
    if (!(horizon in rawScenarios)) {
      errors.push(`Scénario ${horizon} absent de la réponse.`);
      continue;
    }
    const { scenario, errors: scenarioErrors } =
      validateScenario(horizon, rawScenarios[horizon], spot);
    if (scenario) validated[horizon] = scenario;
    errors.push(...scenarioErrors);
  }

  if (errors.length > 0) return { valid: false, errors, scenarios: null };

  const complete = validated as Record<Horizon, Scenario>;
  const normalized = normalizeProbabilities(complete);

  // Garde-fou final : la somme DOIT être exacte avant tout INSERT.
  const sum = CONFIG.HORIZONS.reduce((s, h) => s + normalized[h].probability, 0);
  if (Math.abs(sum - 100) > CONFIG.PROBABILITY_TOLERANCE * 100) {
    return {
      valid: false,
      errors: [`Somme des probabilités = ${sum} après normalisation, attendu 100.`],
      scenarios: null,
    };
  }

  return { valid: true, errors: [], scenarios: normalized };
}

/* -------------------------------------------------------------------------- */
/*  9. PERSISTANCE                                                             */
/* -------------------------------------------------------------------------- */

class SupabaseClient {
  private readonly base: string;
  private readonly key: string;

  constructor(env: Env, private readonly log: Logger) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase incomplète.');
    }
    this.base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  /** Public : consommé par shared/run_lock.ts (interface LockCapableDb). */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.DB_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.base}/${path}`, {
          method,
          headers: {
            apikey: this.key,
            authorization: `Bearer ${this.key}`,
            'content-type': 'application/json',
            ...extraHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.status === 429 || response.status >= 500) {
          throw new AnthropicError(`Supabase HTTP ${response.status}`, response.status, true);
        }
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 400);
          throw new AnthropicError(`Supabase HTTP ${response.status}: ${detail}`, response.status, false);
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : []) as T;
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const retryable = isAbort || !(err instanceof AnthropicError) || err.retryable;
        if (!retryable || attempt === CONFIG.MAX_RETRIES) throw err;
        await sleep(backoffDelay(attempt));
        this.log.warn('Supabase : nouvelle tentative', { attempt: attempt + 1 });
      }
    }
    throw new Error('Supabase : tentatives épuisées.');
  }

  async select<T>(table: string, columns: string, filter = ''): Promise<T[]> {
    return this.request<T[]>('GET', `${table}?select=${encodeURIComponent(columns)}${filter ? `&${filter}` : ''}`);
  }

  /**
   * Écrit l'analyse et ses scénarios.
   *
   * Le CONSTRAINT TRIGGER de somme des probabilités est DEFERRABLE INITIALLY
   * DEFERRED : les quatre scénarios doivent donc être insérés en UNE requête,
   * sinon la vérification se déclencherait sur un lot incomplet.
   */
  async persistAnalysis(
    analysis: CommitteeAnalysis,
    marketRegime: string,
    modelVersion: string,
    spot: number,
    newsIds: readonly string[],
  ): Promise<string | null> {
    const rows = await this.request<Array<{ id: string }>>(
      'POST', 'ai_analyses?select=id',
      [{
        model_version: modelVersion,
        market_regime: marketRegime,
        regime_confidence: analysis.confidence / 100,
        symbol: 'XAUUSD',
        spot_reference: spot,
        summary: analysis.drivers.join(' | ').slice(0, 2000),
        // P1-1/P1-2/P1-3/P1-6 : colonnes TYPÉES, plus des fragments de JSON.
        // Le frontend lit ces colonnes ; il n'a plus rien à reconstituer.
        risk_verdict: analysis.meta.risk_verdict,
        execution_status: analysis.meta.execution_status,
        overall_bias: analysis.overall_bias,
        confidence_cap: analysis.meta.confidence_cap,
        data_quality: analysis.meta.data_quality_issues,
        rejection_reasons: analysis.meta.validation_errors,
        macro_context: {
          drivers: analysis.drivers,
          risks: analysis.risks,
          invalidations: analysis.invalidations,
        },
        // Une analyse bloquée expire vite : elle ne doit pas figer le
        // terminal pendant six heures sur un état d'indisponibilité.
        valid_until: new Date(
          Date.now() + (analysis.meta.execution_status === 'NO_VALID_SETUP'
            ? 90 * 60 * 1000
            : 6 * 3600 * 1000),
        ).toISOString(),
      }],
      { prefer: 'return=representation' },
    );

    const analysisId = rows[0]?.id;
    if (!analysisId) return null;

    await this.request('POST', 'ai_scenarios',
      CONFIG.HORIZONS.map((h) => {
        const s = analysis.scenarios[h];
        return {
          analysis_id: analysisId,
          horizon: h,
          horizon_window: CONFIG.HORIZON_WINDOWS[h],
          direction: s.direction,
          // La base stocke des probabilités en [0,1], le frontend en 0-100.
          probability: s.probability / 100,
          target: s.target,
          invalidation: s.invalidation,
          activation_condition: s.activation_condition,
          confidence: s.confidence / 100,
          reasoning: s.reasoning,
        };
      }),
      { prefer: 'return=minimal' },
    );

    if (newsIds.length > 0) {
      await this.request('POST', 'ai_analysis_news',
        newsIds.map((id) => ({
          analysis_id: analysisId,
          news_id: id,
          weight: Math.round((1 / newsIds.length) * 10000) / 10000,
        })),
        { prefer: 'return=minimal,resolution=ignore-duplicates' },
      );
    }

    return analysisId;
  }
}

/* -------------------------------------------------------------------------- */
/* 10. CHARGEMENT DU CONTEXTE DEPUIS LA BASE                                   */
/* -------------------------------------------------------------------------- */

// LatestTickRow a été retiré : la forme des lignes de v_market_latest est
// désormais définie une seule fois, dans market_engine/context.ts
// (MarketLatestRow). Deux définitions concurrentes du même contrat sont
// précisément ce qui provoque les dérives de nommage relevées à l'audit.

interface ActionableNewsRow {
  id: string; title: string; news_score: number; classification: string;
  gold_direction_impact: string; region: string; category: string;
  risk_level: string | null; ts: string;
}

async function loadContext(db: SupabaseClient, env: Env): Promise<{
  market: MarketContext;
  news: NewsContextItem[];
}> {
  // Le contexte marché passe désormais par le contrat du market_engine
  // (correctif P0-1) : un seul point d'accès, et une valeur ne peut plus
  // être lue sans son statut de fraîcheur.
  const [snapshot, newsRows] = await Promise.all([
    fetchMarketSnapshot(env),
    db.select<ActionableNewsRow>(
      'v_news_actionable',
      'id,title,news_score,classification,gold_direction_impact,region,category,risk_level,ts',
      'limit=25',
    ),
  ]);

  if (!snapshot.available || snapshot.spot.value === null) {
    // SPEC §39 : sans donnée de prix, aucune opportunité ne peut être évaluée.
    // Le comité refuse d'analyser plutôt que de raisonner sur une donnée
    // fabriquée. Le motif remonte tel quel depuis le moteur marché.
    throw new Error(snapshot.reason ?? 'DATA_UNAVAILABLE : aucun prix XAUUSD exploitable.');
  }

  return {
    market: {
      symbol: 'XAUUSD',
      spot: snapshot.spot.value,
      bid: snapshot.bid.value,
      ask: snapshot.ask.value,
      // Un champ UNAVAILABLE vaut null : renderMarketContext l'affichera
      // "N/A" à l'agent, jamais 0.
      dxy: snapshot.dxy.value,
      us10y: snapshot.us10y.value,
      realYield: snapshot.realYield.value,
      vix: snapshot.vix.value,
      wti: snapshot.wti.value,
      atr: null, // Calculé par le market_engine ultérieurement ; "N/A" ici.
      stalenessSeconds: snapshot.spot.ageSeconds ?? 0,
      capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
    },
    news: newsRows.map((n) => ({
      id: n.id,
      title: n.title,
      newsScore: n.news_score,
      classification: n.classification,
      goldDirection: n.gold_direction_impact,
      region: n.region,
      category: n.category,
      riskLevel: n.risk_level,
      ts: n.ts,
    })),
  };
}


/* -------------------------------------------------------------------------- */
/* 10bis. CONTRAT EVENT-DRIVEN — correctif P0-EVENT-DRIVEN                     */
/* -------------------------------------------------------------------------- */

/**
 * Portée d'un recalcul.
 *
 * La granularité du déclencheur commande la granularité de la sortie :
 *   FULL    cron horaire        -> les quatre horizons sont recalculés
 *   H1_H2   CATALYST CRITICAL   -> seuls H1 et H2 changent, H3/H4 préservés
 *   H3      MAJOR IMPACT        -> seul H3 change, H1/H2/H4 préservés
 */
export type RecalcScope = 'FULL' | 'H1_H2' | 'H3';

export type CommitteeEventType = 'RECALC_H1_H2' | 'REEVALUATE_H3';

/** Horizons réellement recalculés selon la portée. */
export const SCOPE_HORIZONS: Readonly<Record<RecalcScope, readonly Horizon[]>> = {
  FULL: ['H1', 'H2', 'H3', 'H4'],
  H1_H2: ['H1', 'H2'],
  H3: ['H3'],
};

/**
 * Agents interrogés selon la portée.
 *
 * H1_H2 conserve les cinq agents : un CATALYST CRITICAL peut être une
 * décision FED autant qu'une escalade militaire, et l'intraday dépend de la
 * structure de marché. Aucun agent n'est superflu.
 *
 * H3 (horizon hebdomadaire : COT, ETF, cycle du dollar, banques centrales)
 * n'est pas piloté par la microstructure intraday. Le Technical Analyst est
 * donc écarté — c'est la seule réduction, et elle est justifiée par
 * l'horizon, pas par le coût.
 */
export const SCOPE_AGENTS: Readonly<Record<RecalcScope, readonly AgentName[]>> = {
  FULL: ['macro_analyst', 'geopolitical_analyst', 'technical_analyst', 'risk_committee', 'portfolio_manager'],
  H1_H2: ['macro_analyst', 'geopolitical_analyst', 'technical_analyst', 'risk_committee', 'portfolio_manager'],
  H3: ['macro_analyst', 'geopolitical_analyst', 'risk_committee', 'portfolio_manager'],
};

const EVENT_SCOPE: Readonly<Record<CommitteeEventType, RecalcScope>> = {
  RECALC_H1_H2: 'H1_H2',
  REEVALUATE_H3: 'H3',
};

/** Payload accepté par l'endpoint event-driven. */
export interface CommitteeEvent {
  readonly event_id: string;
  readonly event_type: CommitteeEventType;
  readonly source: string;
  readonly triggered_at: string;
  readonly news_event_id: string | null;
  readonly news_score: number | null;
}

export type EventValidation =
  | { readonly ok: true; readonly event: CommitteeEvent }
  | { readonly ok: false; readonly errors: readonly string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valide un payload event-driven.
 *
 * Fonction pure et totale : elle ne lève jamais et n'a aucun effet de bord.
 * Un événement malformé est REJETÉ ici, avant toute prise de verrou et
 * avant tout appel LLM — un payload invalide ne doit jamais coûter un
 * appel modèle.
 */
export function validateCommitteeEvent(raw: unknown): EventValidation {
  const errors: string[] = [];
  const body = asRecord(raw);

  const eventId = typeof body['event_id'] === 'string' ? body['event_id'].trim() : '';
  if (eventId.length === 0) errors.push('event_id manquant ou vide.');
  if (eventId.length > 200) errors.push('event_id trop long (maximum 200 caractères).');

  const rawType = body['event_type'];
  const eventType = (['RECALC_H1_H2', 'REEVALUATE_H3'] as const)
    .find((t) => t === rawType);
  if (!eventType) {
    errors.push(`event_type inconnu : ${JSON.stringify(rawType)}. Attendu RECALC_H1_H2 ou REEVALUATE_H3.`);
  }

  const source = typeof body['source'] === 'string' ? body['source'].trim() : '';
  if (source.length === 0) errors.push('source manquante.');

  const triggeredRaw = body['triggered_at'];
  const triggeredMs = typeof triggeredRaw === 'string' ? Date.parse(triggeredRaw) : NaN;
  if (!Number.isFinite(triggeredMs)) {
    errors.push(`triggered_at invalide : ${JSON.stringify(triggeredRaw)}.`);
  }

  // Champs optionnels : présents => strictement typés. Une valeur mal
  // formée est une erreur, pas un motif de la remplacer silencieusement.
  let newsEventId: string | null = null;
  if (body['news_event_id'] !== undefined && body['news_event_id'] !== null) {
    if (typeof body['news_event_id'] === 'string' && UUID_RE.test(body['news_event_id'])) {
      newsEventId = body['news_event_id'];
    } else {
      errors.push('news_event_id présent mais n\'est pas un UUID valide.');
    }
  }

  let newsScore: number | null = null;
  if (body['news_score'] !== undefined && body['news_score'] !== null) {
    const value = body['news_score'];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) {
      newsScore = value;
    } else {
      errors.push('news_score présent mais hors de l\'intervalle [0,100].');
    }
  }

  if (errors.length > 0 || !eventType) return { ok: false, errors };

  return {
    ok: true,
    event: {
      event_id: eventId,
      event_type: eventType,
      source,
      triggered_at: new Date(triggeredMs).toISOString(),
      news_event_id: newsEventId,
      news_score: newsScore,
    },
  };
}

/**
 * Applique la portée : les horizons hors périmètre reprennent EXACTEMENT
 * leur valeur de référence, ceux du périmètre sont remplacés.
 *
 * CONSERVATION DE LA MASSE DE PROBABILITÉ — point le plus délicat.
 * La base impose que les quatre probabilités totalisent 1.00. Un recalcul
 * partiel ne peut donc pas redistribuer librement : il doit rendre
 * exactement la masse qu'il a empruntée. Les horizons recalculés se
 * repartagent le budget que la référence leur allouait, et les horizons
 * préservés gardent le leur au point près.
 *
 * Conséquence assumée et documentée : sur une portée à un seul horizon
 * (H3), la probabilité est nécessairement inchangée — c'est la DIRECTION,
 * la cible, l'invalidation et la confiance qui sont réévaluées. Faire
 * autrement obligerait à modifier H1/H2/H4, ce que la spécification
 * interdit explicitement.
 *
 * Fonction pure : testable sans base ni réseau.
 */
export function applyScope(
  recalculated: Readonly<Record<Horizon, Scenario>>,
  baseline: Readonly<Record<Horizon, Scenario>>,
  scope: RecalcScope,
): Record<Horizon, Scenario> {
  if (scope === 'FULL') return { ...recalculated };

  const inScope = SCOPE_HORIZONS[scope];
  const budget = inScope.reduce((sum, h) => sum + baseline[h].probability, 0);

  const merged = {} as Record<Horizon, Scenario>;
  for (const horizon of CONFIG.HORIZONS) {
    merged[horizon] = inScope.includes(horizon)
      ? recalculated[horizon]
      : baseline[horizon];
  }

  // Un seul horizon dans la portée : sa probabilité EST le budget.
  if (inScope.length === 1) {
    const only = inScope[0]!;
    merged[only] = { ...merged[only], probability: budget };
    return merged;
  }

  // Plusieurs horizons : ils se repartagent le budget selon les poids
  // proposés par le Portfolio Manager, par la méthode du plus fort reste.
  const proposed = inScope.reduce((sum, h) => sum + recalculated[h].probability, 0);
  const shares = inScope.map((h) => {
    const exact = proposed > 0
      ? (recalculated[h].probability / proposed) * budget
      : budget / inScope.length;
    return { horizon: h, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let remaining = budget - shares.reduce((sum, s) => sum + s.floor, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    const bonus = remaining > 0 ? 1 : 0;
    if (remaining > 0) remaining--;
    merged[share.horizon] = {
      ...merged[share.horizon],
      probability: share.floor + bonus,
    };
  }

  return merged;
}

/** Dernière analyse valide, servant de référence à un recalcul partiel. */
interface LatestAnalysisRow {
  id: string;
  market_regime: string;
  regime_confidence: number;
  spot_reference: number;
  scenarios: Record<string, {
    direction?: string; probability?: number | string; target?: number | string;
    invalidation?: number | string; activation_condition?: string;
    confidence?: number | string; reasoning?: string;
  }>;
}

/**
 * Charge les scénarios de référence depuis `v_ai_latest`.
 * Retourne null si aucune analyse exploitable n'existe : un recalcul
 * partiel sans référence est impossible.
 */
export async function fetchBaselineScenarios(
  db: SupabaseClient,
): Promise<Record<Horizon, Scenario> | null> {
  const rows = await db.select<LatestAnalysisRow>(
    'v_ai_latest',
    'id,market_regime,regime_confidence,spot_reference,scenarios',
    'symbol=eq.XAUUSD&order=analysis_ts.desc&limit=1',
  ).catch(() => [] as LatestAnalysisRow[]);

  const latest = rows[0];
  if (!latest) return null;

  const baseline = {} as Record<Horizon, Scenario>;
  for (const horizon of CONFIG.HORIZONS) {
    const raw = (latest.scenarios ?? {})[horizon];
    if (!raw) return null;

    // La base stocke des probabilités en [0,1], le contrat frontend en 0-100.
    const probability = Math.round(asNumber(Number(raw.probability), NaN) * 100);
    const target = Number(raw.target);
    const invalidation = Number(raw.invalidation);
    if (!Number.isFinite(probability) || !Number.isFinite(target) || !Number.isFinite(invalidation)) {
      return null;
    }

    baseline[horizon] = {
      direction: asDirection(raw.direction),
      probability,
      target,
      invalidation,
      // Reprise telle quelle : la référence a déjà franchi la validation.
      activation_condition: asString(
        raw.activation_condition,
        'Condition d\'activation de référence non disponible.',
      ),
      confidence: Math.round(asNumber(Number(raw.confidence), 0) * 100),
      reasoning: asString(raw.reasoning, 'Scénario de référence conservé.'),
    };
  }
  return baseline;
}

/* -------------------------------------------------------------------------- */
/* 11. ORCHESTRATION SÉQUENTIELLE                                              */
/* -------------------------------------------------------------------------- */

/**
 * Construit la sortie NO_VALID_SETUP.
 *
 * SPEC §39 : quand une condition manque, la sortie obligatoire est
 * NO VALID SETUP. Les quatre scénarios restent présents — ils décrivent des
 * états probabilistes, pas des recommandations d'exécution — mais le biais
 * est forcé à neutral et la confiance plafonnée.
 */
function buildNoValidSetup(
  spot: number,
  reasons: readonly string[],
  partial: Partial<CommitteeAnalysis['meta']>,
  verdict: Verdict = 'REJECTED',
): CommitteeAnalysis {
  const flat: Scenario = {
    direction: 'neutral',
    probability: 25,
    target: spot,
    invalidation: spot,
    // Aucune activation possible : le dire explicitement plutôt que de
    // fabriquer un déclencheur qui n'existe pas.
    activation_condition: 'Aucune activation : analyse bloquée par le comité de risque.',
    confidence: 0,
    reasoning: 'Analyse invalidée par le comité de risque. Aucun scénario exploitable retenu.',
  };
  // La contrainte SQL chk_ai_analyses_rejection_motivated refuse un blocage
  // sans motif : un rejet opaque n'est pas exploitable en calibration.
  const motives = reasons.length > 0
    ? [...reasons]
    : [`Blocage ${verdict} prononcé sans motif explicite par le comité.`];

  return {
    market_regime: 'range_bound',
    overall_bias: 'neutral',
    confidence: 0,
    scenarios: { H1: flat, H2: flat, H3: flat, H4: flat },
    drivers: [],
    risks: motives,
    invalidations: ['Analyse non émise : aucune invalidation exploitable.'],
    meta: {
      analysis_id: null,
      model_version: `${CONFIG.ENGINE_VERSION}+prompts-${PROMPT_VERSION}`,
      execution_status: 'NO_VALID_SETUP',
      risk_verdict: verdict,
      confidence_cap: 0,
      spot_reference: spot,
      data_quality_issues: [],
      validation_errors: motives,
      agents: {},
      generated_at: new Date().toISOString(),
      total_latency_ms: 0,
      ...partial,
    },
  };
}

/**
 * Persiste une analyse bloquée (P1-2).
 *
 * Identique au chemin nominal : mêmes contraintes, même vue, même
 * fraîcheur. C'est ce qui garantit qu'un blocage supplante immédiatement
 * l'analyse approuvée précédente dans v_ai_latest.
 */
async function persistBlocked(
  db: SupabaseClient,
  blocked: CommitteeAnalysis,
  modelVersion: string,
  spot: number,
  news: readonly NewsContextItem[],
  log: Logger,
): Promise<CommitteeAnalysis> {
  try {
    const analysisId = await db.persistAnalysis(
      blocked, blocked.market_regime, modelVersion, spot, news.map((n) => n.id),
    );
    log.info('Analyse bloquée persistée', {
      analysis_id: analysisId, verdict: blocked.meta.risk_verdict,
    });
    return { ...blocked, meta: { ...blocked.meta, analysis_id: analysisId } };
  } catch (err) {
    log.error('Persistance de l\'analyse bloquée en échec', { reason: errorMessage(err) });
    return blocked;
  }
}

/**
 * Exécute le comité complet.
 *
 * Les trois analystes sont interrogés SÉQUENTIELLEMENT et non en parallèle :
 * le Technical Analyst doit rester aveugle au contexte macro (§53, protection
 * contre le biais de confirmation), mais le Risk Committee a besoin des trois
 * sorties, et le Portfolio Manager des quatre. L'ordre est donc porteur de
 * sens et non un simple choix d'implémentation.
 */
export interface RunCommitteeOptions {
  /** Portée du recalcul. FULL par défaut (cron horaire). */
  readonly scope?: RecalcScope;
  /** Trigger inscrit dans ingestion_runs, à des fins de diagnostic. */
  readonly triggerType?: string;
  /**
   * Le verrou est déjà détenu par l'appelant (chemin event-driven, qui
   * l'englobe avec la réclamation d'idempotence). Cette fonction ne le
   * reprend pas et ne le libère pas : le propriétaire du verrou en reste
   * responsable. Reprendre un verrou déjà détenu produirait un
   * ALREADY_RUNNING contre soi-même.
   */
  readonly alreadyLocked?: boolean;
}

/**
 * Exécute le comité.
 *
 * VERROU (correctif P0-CONCURRENCY) : la prise de verrou précède TOUT appel
 * LLM. Si un comité tourne déjà — cron ou event-driven, même isolat ou non —
 * cette fonction lève `CommitteeBusyError` sans consommer un seul token.
 */
export class CommitteeBusyError extends Error {
  readonly status = 'ALREADY_RUNNING' as const;
  constructor() {
    super('ALREADY_RUNNING : un comité est déjà en cours d\'exécution.');
    this.name = 'CommitteeBusyError';
  }
}

export async function runCommittee(
  env: Env,
  options: RunCommitteeOptions = {},
): Promise<CommitteeAnalysis> {
  const scope: RecalcScope = options.scope ?? 'FULL';
  const runId = crypto.randomUUID();
  const log = new Logger(env.LOG_LEVEL, runId);
  const startedAt = Date.now();

  const db = new SupabaseClient(env, log);
  const agents: Record<string, { model: string; latency_ms: number }> = {};

  // ---- VERROU : avant tout appel LLM, sans exception. ----
  if (options.alreadyLocked === true) {
    return runCommitteeLocked(env, db, log, scope, startedAt, agents);
  }

  const lock = await acquireLock(db, 'ai_committee', options.triggerType ?? 'cron');
  if (!lock.acquired) {
    log.warn('SKIPPED : comité déjà en cours', { scope });
    throw new CommitteeBusyError();
  }

  // BUG CORRIGÉ (2026-08-18) : ce bloc écrivait `status: 'success'` en dur
  // dans le `finally`, quelle que soit l'issue réelle de
  // `runCommitteeLocked`. Un `finally` s'exécute AUSSI en cas d'exception
  // — donc chaque échec (données insuffisantes, erreur Anthropic, JSON
  // invalide...) écrivait quand même `success` dans `ingestion_runs` avant
  // que l'exception ne remonte. Conséquence observée en production : trois
  // cycles horaires consécutifs marqués `success` (~1,3s chacun — bien
  // trop court pour 5 appels LLM séquentiels), `errors: []`, et `ai_analyses`
  // strictement vide. Le vrai `FAILED` n'apparaissait que dans les logs
  // Cloudflare (`wrangler tail`, capturé par le `catch` de `runJob` dans
  // worker.ts), jamais dans Supabase — deux mécanismes d'enregistrement
  // désynchronisés. Le statut réel est maintenant capturé avant relâche.
  let outcome: { status: 'success' | 'failed'; errors: readonly string[] } =
    { status: 'success', errors: [] };
  try {
    const result = await runCommitteeLocked(env, db, log, scope, startedAt, agents);
    return result;
  } catch (err) {
    outcome = { status: 'failed', errors: [errorMessage(err)] };
    throw err;
  } finally {
    // Libération inconditionnelle : succès, erreur ou exception. Un verrou
    // non relâché bloquerait le comité jusqu'à la récupération stale.
    // Le statut relâché reflète désormais l'issue réelle capturée ci-dessus.
    await releaseLock(db, lock.runRowId, {
      status: outcome.status,
      durationMs: Date.now() - startedAt,
      errors: outcome.errors,
    }).catch((err: unknown) => {
      log.error('Libération du verrou comité en échec', { reason: errorMessage(err) });
    });
  }
}

/** Corps du comité, exécuté sous verrou. */
async function runCommitteeLocked(
  env: Env,
  db: SupabaseClient,
  log: Logger,
  scope: RecalcScope,
  startedAt: number,
  agents: Record<string, { model: string; latency_ms: number }>,
): Promise<CommitteeAnalysis> {
  const analystModel = env.MODEL_ANALYST ?? CONFIG.MODEL_ANALYST_DEFAULT;
  const committeeModel = env.MODEL_COMMITTEE ?? CONFIG.MODEL_COMMITTEE_DEFAULT;
  const modelVersion =
    `${CONFIG.ENGINE_VERSION}+prompts-${PROMPT_VERSION}+${analystModel}/${committeeModel}`;

  const { market, news } = await loadContext(db, env);
  const marketBlock = renderMarketContext(market);
  const newsBlock = renderNewsContext(news);

  log.info('Comité démarré', {
    spot: market.spot, staleness_s: market.stalenessSeconds, news_count: news.length,
  });

  // --- Étape 1 : Macro Analyst ---------------------------------------------
  const macroCall = await callClaude(
    'macro_analyst', analystModel,
    `${marketBlock}\n\n${newsBlock}\n\nProduis ton analyse macro au format JSON demandé.`,
    CONFIG.MAX_TOKENS_ANALYST, env, log,
  );
  agents['macro_analyst'] = { model: analystModel, latency_ms: macroCall.latencyMs };
  const macroRaw = asRecord(macroCall.json);
  const macro: MacroOutput = {
    macro_regime: asString(macroRaw['macro_regime'], 'range_bound'),
    gold_pressure: asDirection(macroRaw['gold_pressure']),
    main_driver: asString(macroRaw['main_driver']),
    real_yield_assessment: asString(macroRaw['real_yield_assessment']),
    dollar_assessment: asString(macroRaw['dollar_assessment']),
    divergences: asStringArray(macroRaw['divergences']),
    missing_data: asStringArray(macroRaw['missing_data']),
    confidence: asUnitConfidence(macroRaw['confidence']),
    reasoning: asString(macroRaw['reasoning'], ''),
  };

  // --- Étape 2 : Geopolitical Analyst --------------------------------------
  const geoCall = await callClaude(
    'geopolitical_analyst', analystModel,
    `${newsBlock}\n\nContexte marché pour référence uniquement :\n${marketBlock}\n\n`
    + 'Produis ton analyse géopolitique au format JSON demandé.',
    CONFIG.MAX_TOKENS_GEOPOLITICAL, env, log,
  );
  agents['geopolitical_analyst'] = { model: analystModel, latency_ms: geoCall.latencyMs };
  const geoRaw = asRecord(geoCall.json);
  const geo: GeopoliticalOutput = {
    risk_level: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)
      .find((l) => l === geoRaw['risk_level']) ?? 'LOW',
    gold_direction: asDirection(geoRaw['gold_direction']),
    dominant_event: asString(geoRaw['dominant_event']),
    events: Array.isArray(geoRaw['events']) ? geoRaw['events'].map(asRecord) : [],
    missing_data: asStringArray(geoRaw['missing_data']),
    confidence: asUnitConfidence(geoRaw['confidence']),
    reasoning: asString(geoRaw['reasoning'], ''),
  };

  // --- Étape 3 : Technical Analyst -----------------------------------------
  // Délibérément privé du contexte macro et géopolitique (§53).
  // Écarté sur la portée H3 : l'horizon hebdomadaire n'est pas piloté par
  // la microstructure intraday (voir SCOPE_AGENTS).
  const runTechnical = SCOPE_AGENTS[scope].includes('technical_analyst');
  const techCall = runTechnical ? await callClaude(
    'technical_analyst', analystModel,
    `${marketBlock}\n\nProduis ton analyse technique au format JSON demandé. `
    + 'Tu n\'as accès à aucun contexte fondamental : c\'est intentionnel.',
    CONFIG.MAX_TOKENS_ANALYST, env, log,
  ) : null;
  if (techCall) {
    agents['technical_analyst'] = { model: analystModel, latency_ms: techCall.latencyMs };
  }
  const techRaw = asRecord(techCall?.json);
  const tech: TechnicalOutput = {
    trend_daily: asString(techRaw['trend_daily'], 'range'),
    trend_h4: asString(techRaw['trend_h4'], 'range'),
    trend_h1: asString(techRaw['trend_h1'], 'range'),
    structure: asString(techRaw['structure']),
    technical_bias: asDirection(techRaw['technical_bias']),
    key_supports: Array.isArray(techRaw['key_supports'])
      ? techRaw['key_supports'].filter(isFinitePositive) : [],
    key_resistances: Array.isArray(techRaw['key_resistances'])
      ? techRaw['key_resistances'].filter(isFinitePositive) : [],
    liquidity_zones: Array.isArray(techRaw['liquidity_zones'])
      ? techRaw['liquidity_zones'].map(asRecord) : [],
    atr: asNumber(techRaw['atr'], 0),
    current_session: asString(techRaw['current_session'], 'off_hours'),
    expected_volatility: asString(techRaw['expected_volatility'], 'normal'),
    stop_hunt_risk: asString(techRaw['stop_hunt_risk'], 'medium'),
    missing_data: asStringArray(techRaw['missing_data']),
    confidence: asUnitConfidence(techRaw['confidence']),
    reasoning: asString(techRaw['reasoning'], ''),
  };

  // --- Étape 4 : Risk Committee (veto) -------------------------------------
  const riskCall = await callClaude(
    'risk_committee', committeeModel,
    `${marketBlock}\n\n${newsBlock}\n\n`
    + `SORTIE MACRO ANALYST :\n${JSON.stringify(macro, null, 2)}\n\n`
    + `SORTIE GEOPOLITICAL ANALYST :\n${JSON.stringify(geo, null, 2)}\n\n`
    + `SORTIE TECHNICAL ANALYST :\n${JSON.stringify(tech, null, 2)}\n\n`
    + 'Applique tes cinq contrôles et rends ton verdict au format JSON demandé.',
    CONFIG.MAX_TOKENS_COMMITTEE, env, log,
  );
  agents['risk_committee'] = { model: committeeModel, latency_ms: riskCall.latencyMs };
  const riskRaw = asRecord(riskCall.json);
  const risk: RiskCommitteeOutput = {
    // Un verdict non reconnu ne peut pas être interprété : il devient
    // DATA_INSUFFICIENT et non REJECTED, car l'échec porte sur la réponse
    // de l'agent, pas sur la qualité du scénario.
    verdict: (['APPROVED', 'APPROVED_WITH_CONDITIONS', 'REJECTED',
               'DATA_INSUFFICIENT', 'CONFLICT'] as const)
      .find((v) => v === riskRaw['verdict']) ?? 'DATA_INSUFFICIENT',
    confidence_cap: asUnitConfidence(riskRaw['confidence_cap']),
    contradictions: Array.isArray(riskRaw['contradictions'])
      ? riskRaw['contradictions'].map((c) => {
        const r = asRecord(c);
        return {
          description: asString(r['description'], ''),
          severity: asString(r['severity'], 'medium'),
          blocking: r['blocking'] === true,
        };
      }) : [],
    scenario_reviews: [],
    data_quality_issues: asStringArray(riskRaw['data_quality_issues']),
    bias_flags: asStringArray(riskRaw['bias_flags']),
    rejection_reasons: asStringArray(riskRaw['rejection_reasons']),
    reasoning: asString(riskRaw['reasoning'], ''),
  };

  log.info('Verdict du comité de risque', {
    verdict: risk.verdict,
    confidence_cap: risk.confidence_cap,
    contradictions: risk.contradictions.length,
    blocking: risk.contradictions.filter((c) => c.blocking).length,
  });

  // Un verdict REJECTED sans motif est incohérent : le comité doit justifier
  // son veto. On force le motif plutôt que d'accepter un rejet opaque.
  const rejectionReasons = risk.verdict === 'REJECTED' && risk.rejection_reasons.length === 0
    ? ['Comité de risque : rejet prononcé sans motif explicite.']
    : risk.rejection_reasons;

  // --- Préparation de la portée --------------------------------------------
  // Un recalcul partiel exige une analyse de référence : sans elle, il n'y a
  // rien à préserver. Le repli sur FULL est explicite et tracé, jamais tu.
  let baseline: Record<Horizon, Scenario> | null = null;
  let effectiveScope: RecalcScope = scope;
  if (scope !== 'FULL') {
    baseline = await fetchBaselineScenarios(db);
    if (baseline === null) {
      log.warn('Aucune analyse de référence : repli sur un recalcul complet', { scope });
      effectiveScope = 'FULL';
    }
  }

  const scopeInstruction = effectiveScope === 'FULL'
    ? ''
    : `PORTÉE DE CE RECALCUL : ${SCOPE_HORIZONS[effectiveScope].join(' et ')} uniquement.\n`
      + `Les autres horizons conservent leur valeur de référence :\n`
      + `${JSON.stringify(baseline, null, 2)}\n`
      + 'Reproduis-les à l\'identique et concentre ton analyse sur les horizons de la portée.\n';

  // --- Étape 5 : Portfolio Manager -----------------------------------------
  const pmCall = await callClaude(
    'portfolio_manager', committeeModel,
    `${marketBlock}\n\n${newsBlock}\n\n`
    + `SORTIE MACRO ANALYST :\n${JSON.stringify(macro, null, 2)}\n\n`
    + `SORTIE GEOPOLITICAL ANALYST :\n${JSON.stringify(geo, null, 2)}\n\n`
    + `SORTIE TECHNICAL ANALYST :\n${JSON.stringify(tech, null, 2)}\n\n`
    + `VERDICT DU RISK COMMITTEE (contraignant) :\n${JSON.stringify({ ...risk, rejection_reasons: rejectionReasons }, null, 2)}\n\n`
    + `Spot de référence pour tes calculs : ${market.spot}\n`
    + scopeInstruction
    + 'Produis la synthèse finale au format JSON demandé. '
    + 'Rappel : somme des quatre probabilités = 100 exactement, '
    + 'et chaque scénario doit porter une invalidation numérique.',
    CONFIG.MAX_TOKENS_COMMITTEE, env, log,
  );
  agents['portfolio_manager'] = { model: committeeModel, latency_ms: pmCall.latencyMs };

  // --- Validation déterministe ---------------------------------------------
  const validation = validateCommitteeOutput(pmCall.json, market.spot);

  const metaBase = {
    model_version: modelVersion,
    risk_verdict: risk.verdict,
    confidence_cap: risk.confidence_cap,
    spot_reference: market.spot,
    data_quality_issues: risk.data_quality_issues,
    agents,
    generated_at: new Date().toISOString(),
    total_latency_ms: Date.now() - startedAt,
  };

  // ------------------------------------------------------------------
  // P1-2 : UNE ANALYSE BLOQUÉE EST PERSISTÉE COMME LES AUTRES.
  //
  // Auparavant ces deux branches sortaient avant la persistance. La
  // conséquence était le pire mode de défaillance du système : le
  // terminal continuait d'afficher la dernière analyse APPROUVÉE, sans
  // aucun signal, jusqu'à six heures après que le comité eut commencé à
  // tout rejeter. Un blocage doit SUPPLANTER l'analyse précédente, pas
  // la laisser vivre.
  // ------------------------------------------------------------------
  if (!validation.valid || validation.scenarios === null) {
    log.error('Validation en échec : NO_VALID_SETUP', { errors: validation.errors });
    // Le verdict du comité est conservé s'il était déjà bloquant ; sinon
    // l'échec porte sur le scénario produit, donc REJECTED.
    const verdict: Verdict = isBlockingVerdict(risk.verdict) ? risk.verdict : 'REJECTED';
    const blocked = buildNoValidSetup(
      market.spot, [...rejectionReasons, ...validation.errors], metaBase, verdict,
    );
    return persistBlocked(db, blocked, modelVersion, market.spot, news, log);
  }

  if (isBlockingVerdict(risk.verdict)) {
    log.warn('Comité de risque : analyse bloquée, NO_VALID_SETUP', { verdict: risk.verdict });
    const blocked = buildNoValidSetup(
      market.spot, rejectionReasons, metaBase, risk.verdict,
    );
    return persistBlocked(db, blocked, modelVersion, market.spot, news, log);
  }

  // --- Assemblage final -----------------------------------------------------
  const pmRaw = asRecord(pmCall.json);

  // Le plafond du Risk Committee est CONTRAIGNANT : appliqué en code, car un
  // agent peut l'ignorer dans sa réponse.
  const capPercent = Math.round(risk.confidence_cap * 100);
  const declaredConfidence = Math.round(Math.max(0, Math.min(100, asNumber(pmRaw['confidence'], 0))));
  const confidence = Math.min(declaredConfidence, capPercent);

  if (declaredConfidence > capPercent) {
    log.warn('Confiance du PM plafonnée par le comité de risque', {
      declared: declaredConfidence, cap: capPercent,
    });
  }

  // APPLICATION DE LA PORTÉE — appliquée en CODE, pas déléguée au prompt.
  // Le Portfolio Manager a reçu l'instruction de préserver les horizons
  // hors périmètre ; ici on garantit qu'ils le sont, quoi qu'il ait répondu.
  const scopedScenarios = baseline !== null && effectiveScope !== 'FULL'
    ? applyScope(validation.scenarios, baseline, effectiveScope)
    : validation.scenarios;

  // Le plafond s'applique aussi scénario par scénario.
  const cappedScenarios = Object.fromEntries(
    CONFIG.HORIZONS.map((h) => [h, {
      ...scopedScenarios[h],
      confidence: Math.min(scopedScenarios[h].confidence, capPercent),
    }]),
  ) as Record<Horizon, Scenario>;

  const drivers = asStringArray(pmRaw['drivers']);
  const risks = asStringArray(pmRaw['risks']);
  const invalidations = asStringArray(pmRaw['invalidations']);

  const analysis: CommitteeAnalysis = {
    market_regime: asString(pmRaw['market_regime'], macro.macro_regime),
    overall_bias: asDirection(pmRaw['overall_bias']),
    confidence,
    scenarios: cappedScenarios,
    drivers: drivers.length > 0 ? drivers : [macro.main_driver],
    // Une analyse sans risque identifié est incomplète : on injecte au moins
    // les signalements du comité plutôt que de publier un tableau vide.
    risks: risks.length > 0
      ? risks
      : [...risk.contradictions.map((c) => c.description), ...risk.bias_flags]
        .filter((s) => s.length > 0),
    invalidations: invalidations.length > 0
      ? invalidations
      : CONFIG.HORIZONS.map((h) => `${h} : invalidation à ${cappedScenarios[h].invalidation}`),
    meta: {
      ...metaBase,
      analysis_id: null,
      execution_status: 'VALID_SETUP',
      validation_errors: [],
    },
  };

  // --- Persistance ----------------------------------------------------------
  let analysisId: string | null = null;
  try {
    analysisId = await db.persistAnalysis(
      analysis, analysis.market_regime, modelVersion, market.spot, news.map((n) => n.id),
    );
    log.info('Analyse persistée', { analysis_id: analysisId });
  } catch (err) {
    // L'analyse reste servie au terminal même si l'écriture échoue : elle est
    // simplement absente de l'historique de calibration.
    log.error('Persistance de l\'analyse en échec', { reason: errorMessage(err) });
  }

  return { ...analysis, meta: { ...analysis.meta, analysis_id: analysisId } };
}


/* -------------------------------------------------------------------------- */
/* 11bis. TRAITEMENT EVENT-DRIVEN                                              */
/* -------------------------------------------------------------------------- */

export type EventStatus =
  | 'PROCESSED'
  | 'ALREADY_PROCESSED'
  | 'ALREADY_RUNNING'
  | 'INVALID_EVENT'
  | 'DATA_UNAVAILABLE'
  | 'FAILED';

export interface EventResult {
  readonly status: EventStatus;
  readonly event_id: string | null;
  readonly event_type: CommitteeEventType | null;
  readonly scope: RecalcScope | null;
  readonly horizons_recalculated: readonly Horizon[];
  readonly analysis_id: string | null;
  readonly errors: readonly string[];
}

/**
 * Réclame l'événement de façon idempotente.
 *
 * L'INSERT sur `ai_events.event_id` (clé primaire) est atomique. Une
 * violation d'unicité signifie que l'événement a DÉJÀ été traité : la
 * seconde livraison n'entraîne aucun appel LLM.
 *
 * Retourne false si l'événement est un doublon.
 */
async function claimEvent(db: SupabaseClient, event: CommitteeEvent): Promise<boolean> {
  try {
    await db.request('POST', 'ai_events', [{
      event_id: event.event_id,
      event_type: event.event_type,
      status: 'RUNNING',
      source: event.source,
      triggered_at: event.triggered_at,
      news_event_id: event.news_event_id,
      news_score: event.news_score,
    }], { prefer: 'return=minimal' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isUniqueViolation(message)) return false;
    throw err;
  }
}

/** Clôture la trace de l'événement. Best-effort : n'invalide pas l'analyse. */
async function closeEvent(
  db: SupabaseClient,
  eventId: string,
  status: 'PROCESSED' | 'SKIPPED_NO_CHANGE' | 'DATA_UNAVAILABLE' | 'FAILED',
  startedAt: number,
  analysisId: string | null,
  error: string | null,
): Promise<void> {
  await db.request('PATCH', `ai_events?event_id=eq.${encodeURIComponent(eventId)}`, {
    status,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    analysis_id: analysisId,
    error,
  }, { prefer: 'return=minimal' }).catch(() => undefined);
}

/**
 * Point d'entrée event-driven.
 *
 * Ordre des opérations, et raison de cet ordre :
 *   1. VALIDER      — un payload invalide ne doit jamais coûter un token.
 *   2. VERROU       — pris avant la réclamation d'idempotence : si le verrou
 *                     est occupé, l'event_id reste libre et l'événement
 *                     pourra être rejoué. L'ordre inverse consommerait
 *                     l'identifiant d'un événement jamais traité.
 *   3. IDEMPOTENCE  — réclamation atomique de l'event_id.
 *   4. COMITÉ       — sous verrou, avec la portée du déclencheur.
 *
 * Le verrou est pris ici et non dans `runCommittee` afin d'englober aussi
 * la réclamation d'idempotence : `runCommittee` est donc appelée en mode
 * `alreadyLocked`.
 */
export async function handleCommitteeEvent(raw: unknown, env: Env): Promise<EventResult> {
  const startedAt = Date.now();
  const log = new Logger(env.LOG_LEVEL, 'event');

  const empty = {
    event_id: null, event_type: null, scope: null,
    horizons_recalculated: [] as readonly Horizon[], analysis_id: null,
  };

  // 1. VALIDATION
  const validation = validateCommitteeEvent(raw);
  if (!validation.ok) {
    log.warn('INVALID_EVENT', { errors: validation.errors });
    return { ...empty, status: 'INVALID_EVENT', errors: validation.errors };
  }
  const event = validation.event;
  const scope = EVENT_SCOPE[event.event_type];
  const base = {
    event_id: event.event_id,
    event_type: event.event_type,
    scope,
    horizons_recalculated: SCOPE_HORIZONS[scope],
  };

  const db = new SupabaseClient(env, log);

  // 2. VERROU
  // trigger_type est contraint en base par
  // chk ingestion_runs_trigger_type_check IN ('cron','manual','webhook','backfill').
  // 'webhook' est la valeur exacte pour un déclenchement HTTP event-driven.
  // Le type d'événement précis est tracé dans ai_events, pas ici.
  const lock = await acquireLock(db, 'ai_committee', 'webhook');
  if (!lock.acquired) {
    // L'événement n'est PAS réclamé : il reste rejouable. Le comité en cours
    // lit de toute façon l'intégralité des news actionnables.
    log.warn('ALREADY_RUNNING', { event_id: event.event_id });
    return { ...base, status: 'ALREADY_RUNNING', analysis_id: null, errors: [] };
  }

  // BUG CORRIGÉ (2026-08-18) : même défaut que runCommittee() ci-dessus —
  // `status: 'success'` en dur dans le `finally`, indépendamment de l'issue
  // réelle. Le `catch` juste au-dessus distinguait déjà correctement
  // DATA_UNAVAILABLE de FAILED, mais cette information n'atteignait jamais
  // `releaseLock`. Capturée maintenant via `outcome`, mise à jour avant
  // chaque retour du `try` et dans le `catch`.
  let outcome: { status: 'success' | 'failed'; errors: readonly string[] } =
    { status: 'success', errors: [] };
  try {
    // 3. IDEMPOTENCE
    const claimed = await claimEvent(db, event);
    if (!claimed) {
      log.info('ALREADY_PROCESSED : aucun appel LLM', { event_id: event.event_id });
      return { ...base, status: 'ALREADY_PROCESSED', analysis_id: null, errors: [] };
    }

    // 4. COMITÉ, sous verrou déjà détenu.
    log.info('Traitement event-driven', {
      event_id: event.event_id, event_type: event.event_type, scope,
      news_event_id: event.news_event_id, news_score: event.news_score,
    });

    const analysis = await runCommittee(env, {
      scope,
      triggerType: 'webhook',
      alreadyLocked: true,
    });

    const analysisId = analysis.meta.analysis_id;
    if (analysis.meta.execution_status === 'NO_VALID_SETUP' || analysisId === null) {
      await closeEvent(db, event.event_id, 'SKIPPED_NO_CHANGE', startedAt, analysisId, null);
      return {
        ...base, status: 'PROCESSED', analysis_id: analysisId,
        errors: analysis.meta.validation_errors,
      };
    }

    await closeEvent(db, event.event_id, 'PROCESSED', startedAt, analysisId, null);
    return { ...base, status: 'PROCESSED', analysis_id: analysisId, errors: [] };
  } catch (err) {
    const message = errorMessage(err);
    // Contexte marché insuffisant : statut distinct d'un échec technique.
    const isDataIssue = /DATA_UNAVAILABLE/i.test(message);
    outcome = { status: 'failed', errors: [message] };
    await closeEvent(
      db, event.event_id, isDataIssue ? 'DATA_UNAVAILABLE' : 'FAILED',
      startedAt, null, message,
    );
    log.error(isDataIssue ? 'DATA_UNAVAILABLE' : 'FAILED', { reason: message });
    return {
      ...base,
      status: isDataIssue ? 'DATA_UNAVAILABLE' : 'FAILED',
      analysis_id: null,
      errors: [message],
    };
  } finally {
    // Libération inconditionnelle du verrou. Statut réel capturé ci-dessus.
    await releaseLock(db, lock.runRowId, {
      status: outcome.status, durationMs: Date.now() - startedAt, errors: outcome.errors,
    }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* 12. POINTS D'ENTRÉE SERVERLESS                                              */
/* -------------------------------------------------------------------------- */

interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }
interface ScheduledEventLike { readonly cron?: string }

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.COMMITTEE_TOKEN) return false;
  const header = request.headers.get('x-committee-token')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  return timingSafeEqual(header, env.COMMITTEE_TOKEN);
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (request.method === 'GET' && path.endsWith('/health')) {
    return jsonResponse({ status: 'ok', engine: CONFIG.ENGINE_VERSION }, 200);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utiliser POST.' }, 405);
  }
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: 'Non autorisé' }, 401);
  }

  // ---- ROUTAGE EVENT-DRIVEN (correctif P0-EVENT-DRIVEN) ----
  // Un corps porteur d'un event_type est traité comme un déclencheur
  // granulaire. Un corps vide reste un recalcul complet (usage manuel).
  let body: unknown = null;
  try {
    const text = await request.text();
    body = text.trim().length > 0 ? JSON.parse(text) : null;
  } catch {
    return jsonResponse({ status: 'INVALID_EVENT', errors: ['Corps JSON illisible.'] }, 400);
  }

  if (body !== null && typeof body === 'object' && 'event_type' in (body as object)) {
    const result = await handleCommitteeEvent(body, env);
    const httpStatus =
      result.status === 'INVALID_EVENT' ? 400
        : result.status === 'DATA_UNAVAILABLE' ? 503
          : result.status === 'FAILED' ? 500
            // PROCESSED / ALREADY_PROCESSED / ALREADY_RUNNING : l'événement a
            // été pris en charge. Un 2xx confirme la livraison au news_engine,
            // qui n'a pas à le rejouer.
            : 200;
    return jsonResponse(result, httpStatus);
  }

  try {
    const analysis = await runCommittee(env, { triggerType: 'manual' });
    return jsonResponse(analysis, 200);
  } catch (err) {
    if (err instanceof CommitteeBusyError) {
      return jsonResponse({ status: 'ALREADY_RUNNING', errors: [err.message] }, 200);
    }
    new Logger(env.LOG_LEVEL, 'unhandled').error('Comité en échec', { reason: errorMessage(err) });
    return jsonResponse({ error: 'Erreur interne du moteur d\'analyse' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(
      runCommittee(env).catch((err: unknown) => {
        new Logger(env.LOG_LEVEL, 'cron').error('Run cron du comité en échec', {
          cron: event.cron, reason: errorMessage(err),
        });
      }),
    );
  },
};

/** Exposé pour les tests unitaires. */
export const __internals = {
  CONFIG,
  validateCommitteeEvent,
  applyScope,
  SCOPE_HORIZONS,
  SCOPE_AGENTS,
  validateScenario,
  validateCommitteeOutput,
  normalizeProbabilities,
  riskReward,
  renderMarketContext,
  renderNewsContext,
  buildNoValidSetup,
  asUnitConfidence,
  asDirection,
  timingSafeEqual,
  redact,
};
