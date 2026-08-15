/**
 * =============================================================================
 *  ALPHA-XAU — backend/market_engine/ingest_market.ts
 *
 *  MOTEUR MARCHÉ — correctif P0-1.
 *  Alimente `market_ticks`, seule rupture qui rendait le système inexécutable.
 *
 *  FLUX : SOURCE -> INGESTION -> VALIDATION -> NORMALISATION -> BASE
 *
 *  RÈGLES TENUES DE BOUT EN BOUT
 *  - Aucune valeur inventée. Une source muette produit une ABSENCE de ligne,
 *    jamais une ligne à zéro.
 *  - L'échec d'un provider n'annule pas les autres : la dernière donnée valide
 *    déjà en base n'est jamais détruite (le moteur est strictement insert-only).
 *  - La déduplication est déléguée à l'index unique PostgreSQL
 *    `uq_market_ticks_series`, jamais contournée depuis TypeScript.
 *  - `spread` est une colonne GENERATED : elle n'est jamais insérée.
 * =============================================================================
 */

import {
  FRED_SERIES,
  fetchFred,
  fetchStooq,
  fetchTwelveData,
  redactUrl,
  type ProviderEnv,
} from './providers.js';
import { dedupKey, validatePoint } from './validate.js';
import type {
  MarketIngestReport,
  MarketSymbol,
  ProviderOutcome,
  RawDataPoint,
  RejectedDataPoint,
  ValidatedDataPoint,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Environnement                                                              */
/* -------------------------------------------------------------------------- */

export interface MarketEnv extends ProviderEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly LOG_LEVEL?: string;
}

const CONFIG = {
  ENGINE: 'market_engine',
  ENGINE_VERSION: 'market-engine-1.0.0',
  DB_TIMEOUT_MS: 15_000,
  DB_MAX_RETRIES: 2,
  /** Symbole Stooq de l'or spot. */
  STOOQ_XAUUSD: 'xauusd',
  /** Symbole Twelve Data de l'ICE Dollar Index. */
  TWELVE_DXY: 'DXY',
  /** Verrou considéré comme abandonné au-delà de cette durée. */
  STALE_LOCK_MINUTES: 15,
} as const;

/**
 * Correspondance colonne de stamping macro <- instrument.
 * `market_ticks` dénormalise le contexte macro sur la ligne XAUUSD
 * (pattern « market context stamping » déjà retenu par le schéma) : c'est
 * exactement ce que `loadContext()` du comité lit.
 */
const STAMP_COLUMN: Partial<Record<MarketSymbol, string>> = {
  DXY: 'dxy_value',
  US10Y: 'us10y_yield',
  US10YR: 'real_yield',
  VIX: 'vix',
  WTI: 'wti',
};

/** asset_type par symbole. Doit correspondre à la table `instruments`. */
const ASSET_TYPE: Readonly<Record<MarketSymbol, string>> = {
  XAUUSD: 'metal',
  DXY: 'index',
  US10Y: 'bond',
  US10YR: 'bond',
  VIX: 'volatility',
  WTI: 'energy',
};

/* -------------------------------------------------------------------------- */
/*  Journalisation                                                             */
/* -------------------------------------------------------------------------- */

const SECRET_KEY_PATTERN = /(key|token|secret|password|authorization|apikey)/i;

function redact(input: unknown, depth = 0): unknown {
  if (depth > 5) return '[max-depth]';
  if (typeof input === 'string') return redactUrl(input).replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]');
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.slice(0, 30).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export class MarketLogger {
  constructor(private readonly runId: string, private readonly level: string = 'info') {}
  private emit(level: string, message: string, context?: Record<string, unknown>): void {
    const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    if ((order[level] ?? 20) < (order[this.level] ?? 20)) return;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      engine: CONFIG.ENGINE_VERSION,
      run_id: this.runId,
      message,
      ...(context ? { context: redact(context) } : {}),
    }));
  }
  info(m: string, c?: Record<string, unknown>): void { this.emit('info', m, c); }
  warn(m: string, c?: Record<string, unknown>): void { this.emit('warn', m, c); }
  error(m: string, c?: Record<string, unknown>): void { this.emit('error', m, c); }
}

function errorMessage(err: unknown): string {
  return redactUrl(err instanceof Error ? err.message : String(err));
}

/* -------------------------------------------------------------------------- */
/*  Client PostgREST                                                           */
/* -------------------------------------------------------------------------- */

export class MarketDb {
  private readonly base: string;
  private readonly key: string;

  constructor(env: MarketEnv) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Configuration Supabase incomplète (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    }
    this.base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= CONFIG.DB_MAX_RETRIES; attempt++) {
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
          throw new Error(`Supabase HTTP ${response.status}`);
        }
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          // 4xx : erreur de contrat, inutile de réessayer.
          throw Object.assign(new Error(`Supabase HTTP ${response.status}: ${detail}`), { fatal: true });
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : []) as T;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if ((err as { fatal?: boolean }).fatal || attempt === CONFIG.DB_MAX_RETRIES) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/* -------------------------------------------------------------------------- */
/*  Verrou anti-concurrence                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Empêche deux exécutions simultanées du même moteur.
 *
 * Le verrou est l'index partiel UNIQUE `uq_ingestion_runs_active` posé par la
 * migration 0004 : une seule ligne `status='running'` par `engine` peut
 * exister. C'est PostgreSQL qui arbitre, pas un booléen applicatif — deux
 * Workers concurrents ne peuvent pas gagner tous les deux.
 *
 * Retourne null si le verrou est déjà pris : le run est alors SKIPPED.
 */
export async function acquireRunLock(
  db: MarketDb,
  engine: string,
  triggerType: string,
): Promise<string | null> {
  // Libère d'abord un verrou abandonné (Worker tué avant d'écrire finished_at).
  await db.request('POST', 'rpc/fn_reclaim_stale_runs', {
    p_engine: engine,
    p_older_than_minutes: CONFIG.STALE_LOCK_MINUTES,
  }).catch(() => undefined);

  try {
    const rows = await db.request<Array<{ id: string }>>(
      'POST', 'ingestion_runs?select=id',
      [{ engine, trigger_type: triggerType, status: 'running' }],
      { prefer: 'return=representation' },
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // 23505 = violation d'unicité => un run est déjà actif. Cas nominal.
    if (/23505|duplicate key/i.test(errorMessage(err))) return null;
    throw err;
  }
}

export async function releaseRunLock(
  db: MarketDb,
  runRowId: string,
  report: Omit<MarketIngestReport, 'runId'>,
): Promise<void> {
  const status = report.status === 'SUCCESS' ? 'success'
    : report.status === 'PARTIAL' ? 'partial'
    : 'failed';

  await db.request('PATCH', `ingestion_runs?id=eq.${encodeURIComponent(runRowId)}`, {
    finished_at: new Date().toISOString(),
    duration_ms: report.durationMs,
    status,
    fetched_count: report.fetched,
    rejected_count: report.rejected,
    persisted_count: report.persisted,
    duplicate_count: report.duplicates,
    providers: report.providers,
    errors: report.errors,
  }, { prefer: 'return=minimal' });
}

/* -------------------------------------------------------------------------- */
/*  Collecte                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Interroge toutes les sources. Chaque provider est isolé : son échec est
 * capturé et n'interrompt pas la collecte des autres.
 */
export async function collectAll(
  env: MarketEnv,
  log: MarketLogger,
): Promise<{ raw: RawDataPoint[]; providers: Record<string, ProviderOutcome> }> {
  const providers: Record<string, ProviderOutcome> = {};

  const tasks: Array<{ name: string; run: () => Promise<RawDataPoint> }> = [
    { name: 'stooq:XAUUSD', run: () => fetchStooq('XAUUSD', CONFIG.STOOQ_XAUUSD, env) },
    { name: 'twelve_data:DXY', run: () => fetchTwelveData('DXY', CONFIG.TWELVE_DXY, env) },
    ...FRED_SERIES.map((s) => ({
      name: `fred:${s.symbol}`,
      run: () => fetchFred(s.symbol, s.seriesId, env),
    })),
  ];

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const raw: RawDataPoint[] = [];

  settled.forEach((result, index) => {
    const name = tasks[index]?.name ?? `provider_${index}`;
    if (result.status === 'fulfilled') {
      raw.push(result.value);
      const usable = result.value.value !== null;
      providers[name] = { ok: usable, fetched: usable ? 1 : 0, ...(usable ? {} : { error: result.value.unavailableReason ?? 'valeur absente' }) };
      if (!usable) log.warn(`${name} : donnée indisponible`, { reason: result.value.unavailableReason });
    } else {
      providers[name] = { ok: false, fetched: 0, error: errorMessage(result.reason) };
      log.error(`${name} : collecteur en échec`, { reason: errorMessage(result.reason) });
    }
  });

  return { raw, providers };
}

/* -------------------------------------------------------------------------- */
/*  Normalisation vers market_ticks                                            */
/* -------------------------------------------------------------------------- */

export interface TickRow {
  symbol: string;
  asset_type: string;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  timeframe: string;
  source: string;
  ts: string;
  dxy_value?: number | null;
  us10y_yield?: number | null;
  real_yield?: number | null;
  vix?: number | null;
  wti?: number | null;
}

/**
 * Construit les lignes à insérer.
 *
 * Une ligne par instrument validé, plus le STAMPING macro sur la ligne
 * XAUUSD. Un champ macro non validé reste `null` sur le stamp — c'est ce
 * `null` que le comité lira comme "N/A".
 *
 * `timeframe` vaut 'tick' : les points collectés sont des instantanés, pas
 * des bougies complètes. Le CHECK `chk_market_ticks_candle_completeness`
 * n'exige un OHLC complet que pour les timeframes agrégés.
 */
export function buildTickRows(points: readonly ValidatedDataPoint[]): TickRow[] {
  const seen = new Set<string>();
  const rows: TickRow[] = [];

  const stamp: Record<string, number | null> = {
    dxy_value: null, us10y_yield: null, real_yield: null, vix: null, wti: null,
  };
  for (const point of points) {
    const column = STAMP_COLUMN[point.symbol];
    if (column) stamp[column] = point.value;
  }

  for (const point of points) {
    // ------------------------------------------------------------------
    // CONTRAINTE STRUCTURELLE : market_ticks.close porte CHECK (close > 0).
    // Or le rendement réel EST négatif par périodes (DFII10 l'a été de 2020
    // à 2022), et US10Y peut l'être aussi — le schéma l'admet d'ailleurs :
    // real_yield accepte BETWEEN -10 AND 25, us10y_yield BETWEEN -5 AND 25.
    //
    // Le schéma désigne donc lui-même l'emplacement correct des macro :
    // les COLONNES DE STAMPING, qui tolèrent le négatif, et non `close`,
    // qui l'interdit. Les macro ne produisent aucune ligne propre ; elles
    // sont estampillées sur le tick XAUUSD — exactement ce que lisent
    // v_market_latest et le comité.
    //
    // Conséquence assumée : sans prix de l'or, aucune ligne n'est écrite.
    // C'est cohérent avec la spécification, puisque sans or il n'y a de
    // toute façon pas d'analyse possible.
    // ------------------------------------------------------------------
    if (STAMP_COLUMN[point.symbol]) continue;

    // Déduplication intra-lot, alignée sur l'index unique SQL.
    const key = dedupKey(point.symbol, 'tick', point.observedAt, point.source);
    if (seen.has(key)) continue;
    seen.add(key);

    const row: TickRow = {
      symbol: point.symbol,
      asset_type: ASSET_TYPE[point.symbol],
      close: point.value,
      open: point.open,
      high: point.high,
      low: point.low,
      bid: point.bid,
      ask: point.ask,
      volume: point.volume,
      timeframe: 'tick',
      source: point.source,
      ts: point.observedAt,
      // `spread` est GENERATED ALWAYS : jamais fourni.
    };

    if (point.symbol === 'XAUUSD') {
      row.dxy_value = stamp['dxy_value'] ?? null;
      row.us10y_yield = stamp['us10y_yield'] ?? null;
      row.real_yield = stamp['real_yield'] ?? null;
      row.vix = stamp['vix'] ?? null;
      row.wti = stamp['wti'] ?? null;
    }

    rows.push(row);
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/*  Exécution                                                                  */
/* -------------------------------------------------------------------------- */

export async function runMarketIngestion(
  env: MarketEnv,
  triggerType: string = 'cron',
): Promise<MarketIngestReport> {
  const runId = crypto.randomUUID();
  const log = new MarketLogger(runId, env.LOG_LEVEL);
  const startedAt = Date.now();
  log.info('STARTED', { engine: CONFIG.ENGINE, trigger: triggerType });

  const db = new MarketDb(env);

  const lockId = await acquireRunLock(db, CONFIG.ENGINE, triggerType);
  if (lockId === null) {
    log.warn('SKIPPED : un run market_engine est déjà actif');
    return {
      runId, status: 'SKIPPED', durationMs: Date.now() - startedAt,
      fetched: 0, rejected: 0, persisted: 0, duplicates: 0,
      providers: {}, rejections: [], errors: ['Run concurrent détecté, exécution ignorée.'],
    };
  }

  const errors: string[] = [];
  const rejections: RejectedDataPoint[] = [];
  let persisted = 0;
  let duplicates = 0;
  let providers: Record<string, ProviderOutcome> = {};
  let validated: ValidatedDataPoint[] = [];

  try {
    const collected = await collectAll(env, log);
    providers = collected.providers;

    const now = new Date();
    for (const raw of collected.raw) {
      const outcome = validatePoint(raw, now);
      if (outcome.ok) validated.push(outcome.point);
      else rejections.push(outcome.rejection);
    }

    log.info('Validation terminée', {
      valides: validated.length,
      rejetes: rejections.length,
      details: rejections.map((r) => `${r.symbol}: ${r.reason}`),
    });

    const rows = buildTickRows(validated);

    if (rows.length > 0) {
      // on_conflict + ignore-duplicates : c'est l'index unique PostgreSQL
      // qui déduplique. Aucune logique de doublon côté application.
      const inserted = await db.request<Array<{ symbol: string }>>(
        'POST',
        'market_ticks?on_conflict=symbol,timeframe,ts,source&select=symbol',
        rows,
        { prefer: 'return=representation,resolution=ignore-duplicates' },
      );
      persisted = inserted.length;
      duplicates = rows.length - persisted;
      log.info('Écriture market_ticks', { proposes: rows.length, inseres: persisted, doublons: duplicates });
    } else {
      log.warn('Aucune ligne valide à écrire : les données existantes sont préservées.');
    }
  } catch (err) {
    errors.push(errorMessage(err));
    log.error('FAILED', { reason: errorMessage(err) });
  }

  // Un run est SUCCESS seulement si l'or a été obtenu : sans XAUUSD, le
  // terminal et le comité n'ont pas d'instrument principal.
  const goldPersisted = validated.some((p) => p.symbol === 'XAUUSD');
  const status: MarketIngestReport['status'] =
    errors.length > 0 ? 'FAILED'
      : goldPersisted && rejections.length === 0 ? 'SUCCESS'
        : goldPersisted ? 'PARTIAL'
          : 'FAILED';

  const report: MarketIngestReport = {
    runId,
    status,
    durationMs: Date.now() - startedAt,
    fetched: validated.length + rejections.length,
    rejected: rejections.length,
    persisted,
    duplicates,
    providers,
    rejections,
    errors,
  };

  await releaseRunLock(db, lockId, report).catch((err: unknown) => {
    log.error('Libération du verrou en échec', { reason: errorMessage(err) });
  });

  log.info(report.status, {
    duree_ms: report.durationMs, persistes: persisted, rejetes: rejections.length,
  });
  return report;
}
