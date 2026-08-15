/**
 * =============================================================================
 *  ALPHA-XAU — backend/market_engine/providers.ts
 *
 *  COLLECTEURS. Un provider fait exactement trois choses : appeler un
 *  endpoint, parser sa réponse, produire des RawDataPoint. Il ne valide pas,
 *  il ne normalise pas vers la base, il n'invente jamais.
 *
 *  ---------------------------------------------------------------------------
 *  CARTOGRAPHIE DES SOURCES — décisions documentées
 *  ---------------------------------------------------------------------------
 *
 *  XAUUSD      stooq        symbole `xauusd`     aucune clé
 *  US10Y       fred         série  `DGS10`       FRED_API_KEY
 *  Real Yield  fred         série  `DFII10`      FRED_API_KEY
 *  VIX         fred         série  `VIXCLS`      FRED_API_KEY
 *  WTI         fred         série  `DCOILWTICO`  FRED_API_KEY
 *  DXY         twelve_data  symbole `DXY`        TWELVE_DATA_KEY
 *
 *  DÉCISION EXPLICITE SUR LE DXY — substitution refusée.
 *  FRED ne publie PAS l'ICE US Dollar Index. Il publie DTWEXBGS (Nominal
 *  Broad U.S. Dollar Index), qui repose sur un panier et une pondération
 *  DIFFÉRENTS. Écrire DTWEXBGS dans la colonne `dxy_value` serait une
 *  substitution silencieuse : le comité IA lirait « DXY » et raisonnerait
 *  sur autre chose. Conformément à la consigne d'intégrité, la substitution
 *  est REFUSÉE. Sans TWELVE_DATA_KEY, le DXY est UNAVAILABLE et le Macro
 *  Analyst reçoit "N/A" — ce qui plafonne mécaniquement sa confiance via le
 *  contrôle 4 du Risk Committee. C'est le comportement voulu.
 *
 *  NOTE SUR LES SÉRIES FRED QUOTIDIENNES.
 *  DGS10, DFII10, VIXCLS et DCOILWTICO sont des séries QUOTIDIENNES publiées
 *  en fin de journée ouvrée. Leur horodatage réel est une DATE, pas un
 *  instant. On la convertit en 00:00:00Z de la journée d'observation : c'est
 *  un horodatage dérivé de la source, jamais un `now()`. Conséquence assumée
 *  et correcte : ces champs apparaissent naturellement « âgés » de plusieurs
 *  heures, et STALE pendant les week-ends et jours fériés. Les seuils de
 *  fraîcheur de validate.ts en tiennent compte.
 * =============================================================================
 */

import type { MarketSymbol, RawDataPoint, SourceCode } from './types.js';

export interface ProviderEnv {
  readonly FRED_API_KEY?: string;
  readonly TWELVE_DATA_KEY?: string;
  readonly STOOQ_BASE_URL?: string;
  readonly FRED_BASE_URL?: string;
  readonly TWELVE_DATA_BASE_URL?: string;
}

const DEFAULTS = {
  STOOQ: 'https://stooq.com/q/l/',
  FRED: 'https://api.stlouisfed.org/fred',
  TWELVE_DATA: 'https://api.twelvedata.com',
  TIMEOUT_MS: 15_000,
  MAX_RETRIES: 2,
  BACKOFF_BASE_MS: 800,
  BACKOFF_MAX_MS: 8_000,
  MAX_RETRY_AFTER_MS: 20_000,
} as const;

/** Séries FRED utilisées. Figées ici : un seul lieu de vérité. */
export const FRED_SERIES: ReadonlyArray<{ symbol: MarketSymbol; seriesId: string }> = [
  { symbol: 'US10Y', seriesId: 'DGS10' },
  { symbol: 'US10YR', seriesId: 'DFII10' },
  { symbol: 'VIX', seriesId: 'VIXCLS' },
  { symbol: 'WTI', seriesId: 'DCOILWTICO' },
];

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Masque toute clé d'API avant journalisation ou remontée d'erreur. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:api_key|apikey|token|key)=)[^&]*/gi, '$1[REDACTED]');
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * GET avec timeout, retry exponentiel jitteré et respect du Retry-After.
 * Renvoie le corps brut : le parsing appartient à chaque provider.
 */
export async function fetchText(url: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= DEFAULTS.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULTS.TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'text/plain, application/json' },
      });
      clearTimeout(timer);

      if (response.status === 429) {
        const wait = parseRetryAfter(response.headers.get('retry-after'));
        if (wait !== null && wait > DEFAULTS.MAX_RETRY_AFTER_MS) {
          throw new ProviderError('quota saturé (429)', false);
        }
        throw new ProviderError('rate limited (429)', true);
      }
      if (response.status >= 500 || response.status === 408) {
        throw new ProviderError(`HTTP ${response.status}`, true);
      }
      if (!response.ok) {
        throw new ProviderError(`HTTP ${response.status}`, false);
      }
      return await response.text();
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      lastError = isAbort ? new ProviderError('timeout', true) : err;

      const retryable = lastError instanceof ProviderError ? lastError.retryable : true;
      if (!retryable || attempt === DEFAULTS.MAX_RETRIES) break;

      const cap = Math.min(DEFAULTS.BACKOFF_BASE_MS * 2 ** attempt, DEFAULTS.BACKOFF_MAX_MS);
      await sleep(Math.floor(Math.random() * cap));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ProviderError(redactUrl(message), false);
}

/* -------------------------------------------------------------------------- */
/*  Helpers de parsing                                                         */
/* -------------------------------------------------------------------------- */

/** Convertit en nombre fini, ou null. N'accepte ni "", ni ".", ni "N/D". */
export function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.' || /^(n\/?[ad]|null|na)$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compose un instant UTC à partir d'une date et d'une heure fournies par la
 * source. Retourne null si la date est inexploitable : on ne fabrique jamais
 * un horodatage de remplacement.
 */
export function toUtcIso(date: string, time?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const timePart = time && /^\d{2}:\d{2}(:\d{2})?$/.test(time.trim())
    ? (time.trim().length === 5 ? `${time.trim()}:00` : time.trim())
    : '00:00:00';
  const iso = `${date.trim()}T${timePart}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/* -------------------------------------------------------------------------- */
/*  Provider 1 — Stooq (XAUUSD)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Stooq renvoie un CSV à en-tête unique.
 * Format demandé `sd2t2ohlcv` :
 *   Symbol,Date,Time,Open,High,Low,Close,Volume
 *
 * HYPOTHÈSE DOCUMENTÉE : les champs Date/Time de Stooq sont interprétés comme
 * UTC. Stooq ne publie pas de fuseau dans la réponse. Si cette hypothèse est
 * fausse, l'erreur porte sur l'horodatage (donc la fraîcheur), jamais sur le
 * prix. Une ligne dont Close vaut "N/D" produit une valeur null, pas un zéro.
 */
export function parseStooqCsv(csv: string, symbol: MarketSymbol): RawDataPoint {
  const source: SourceCode = 'stooq';
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { symbol, source, value: null, observedAt: null, unavailableReason: 'CSV vide ou sans ligne de données' };
  }

  const header = (lines[0] ?? '').toLowerCase().split(',').map((h) => h.trim());
  const row = (lines[1] ?? '').split(',').map((c) => c.trim());
  const col = (name: string): string | undefined => {
    const index = header.indexOf(name);
    return index === -1 ? undefined : row[index];
  };

  const close = toNumberOrNull(col('close'));
  const date = col('date') ?? '';
  const observedAt = toUtcIso(date, col('time'));

  if (close === null) {
    return { symbol, source, value: null, observedAt, unavailableReason: 'Close non numérique (marché fermé ou symbole inconnu)' };
  }
  if (observedAt === null) {
    return { symbol, source, value: null, observedAt: null, unavailableReason: 'Horodatage source illisible' };
  }

  return {
    symbol,
    source,
    value: close,
    observedAt,
    open: toNumberOrNull(col('open')),
    high: toNumberOrNull(col('high')),
    low: toNumberOrNull(col('low')),
    volume: toNumberOrNull(col('volume')),
    bid: null,
    ask: null,
  };
}

export async function fetchStooq(symbol: MarketSymbol, stooqTicker: string, env: ProviderEnv): Promise<RawDataPoint> {
  const base = env.STOOQ_BASE_URL ?? DEFAULTS.STOOQ;
  const url = `${base}?s=${encodeURIComponent(stooqTicker)}&f=sd2t2ohlcv&h&e=csv`;
  const csv = await fetchText(url);
  return parseStooqCsv(csv, symbol);
}

/* -------------------------------------------------------------------------- */
/*  Provider 2 — FRED (US10Y, Real Yield, VIX, WTI)                            */
/* -------------------------------------------------------------------------- */

interface FredResponse {
  readonly observations?: ReadonlyArray<{ readonly date?: string; readonly value?: string }>;
}

/**
 * FRED encode une observation manquante par la chaîne ".". C'est le cas
 * normal des jours fériés. `toNumberOrNull` la rejette explicitement : une
 * telle observation devient UNAVAILABLE, jamais 0.
 */
export function parseFred(body: string, symbol: MarketSymbol): RawDataPoint {
  const source: SourceCode = 'fred';
  let payload: FredResponse;
  try {
    payload = JSON.parse(body) as FredResponse;
  } catch {
    return { symbol, source, value: null, observedAt: null, unavailableReason: 'Réponse FRED non JSON' };
  }

  const observations = payload.observations ?? [];
  // On balaie du plus récent au plus ancien : les jours fériés en fin de
  // fenêtre valent "." et doivent être ignorés, pas interprétés.
  for (let i = observations.length - 1; i >= 0; i--) {
    const observation = observations[i];
    if (!observation) continue;
    const value = toNumberOrNull(observation.value);
    const observedAt = toUtcIso(observation.date ?? '');
    if (value !== null && observedAt !== null) {
      return { symbol, source, value, observedAt, open: null, high: null, low: null, bid: null, ask: null, volume: null };
    }
  }

  return { symbol, source, value: null, observedAt: null, unavailableReason: 'Aucune observation numérique dans la fenêtre' };
}

export async function fetchFred(
  symbol: MarketSymbol,
  seriesId: string,
  env: ProviderEnv,
): Promise<RawDataPoint> {
  if (!env.FRED_API_KEY) {
    return { symbol, source: 'fred', value: null, observedAt: null, unavailableReason: 'FRED_API_KEY absente : collecteur désactivé' };
  }
  const base = env.FRED_BASE_URL ?? DEFAULTS.FRED;
  // Fenêtre de 14 jours : couvre les ponts et jours fériés sans rapatrier
  // un historique inutile.
  const start = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const url = `${base}/series/observations?series_id=${encodeURIComponent(seriesId)}`
    + `&api_key=${encodeURIComponent(env.FRED_API_KEY)}`
    + `&file_type=json&observation_start=${start}&sort_order=asc`;
  return parseFred(await fetchText(url), symbol);
}

/* -------------------------------------------------------------------------- */
/*  Provider 3 — Twelve Data (DXY)                                             */
/* -------------------------------------------------------------------------- */

interface TwelveDataQuote {
  readonly symbol?: string;
  readonly close?: string | number;
  readonly open?: string | number;
  readonly high?: string | number;
  readonly low?: string | number;
  readonly volume?: string | number;
  readonly timestamp?: number;
  readonly datetime?: string;
  readonly status?: string;
  readonly code?: number;
  readonly message?: string;
}

export function parseTwelveData(body: string, symbol: MarketSymbol): RawDataPoint {
  const source: SourceCode = 'twelve_data';
  let quote: TwelveDataQuote;
  try {
    quote = JSON.parse(body) as TwelveDataQuote;
  } catch {
    return { symbol, source, value: null, observedAt: null, unavailableReason: 'Réponse Twelve Data non JSON' };
  }

  // Twelve Data répond en HTTP 200 avec status:"error" sur quota dépassé.
  if (quote.status === 'error') {
    return { symbol, source, value: null, observedAt: null, unavailableReason: `Erreur API (code ${quote.code ?? '?'})` };
  }

  const value = toNumberOrNull(quote.close);
  if (value === null) {
    return { symbol, source, value: null, observedAt: null, unavailableReason: 'Champ close absent ou non numérique' };
  }

  let observedAt: string | null = null;
  if (typeof quote.timestamp === 'number' && Number.isFinite(quote.timestamp)) {
    observedAt = new Date(quote.timestamp * 1000).toISOString();
  } else if (typeof quote.datetime === 'string') {
    const parsed = Date.parse(`${quote.datetime.replace(' ', 'T')}Z`);
    if (Number.isFinite(parsed)) observedAt = new Date(parsed).toISOString();
  }
  if (observedAt === null) {
    return { symbol, source, value: null, observedAt: null, unavailableReason: 'Horodatage source absent' };
  }

  return {
    symbol,
    source,
    value,
    observedAt,
    open: toNumberOrNull(quote.open),
    high: toNumberOrNull(quote.high),
    low: toNumberOrNull(quote.low),
    volume: toNumberOrNull(quote.volume),
    bid: null,
    ask: null,
  };
}

export async function fetchTwelveData(
  symbol: MarketSymbol,
  vendorSymbol: string,
  env: ProviderEnv,
): Promise<RawDataPoint> {
  if (!env.TWELVE_DATA_KEY) {
    return {
      symbol,
      source: 'twelve_data',
      value: null,
      observedAt: null,
      unavailableReason: 'TWELVE_DATA_KEY absente : DXY indisponible. Substitution par DTWEXBGS refusée (indice différent).',
    };
  }
  const base = env.TWELVE_DATA_BASE_URL ?? DEFAULTS.TWELVE_DATA;
  const url = `${base}/quote?symbol=${encodeURIComponent(vendorSymbol)}&apikey=${encodeURIComponent(env.TWELVE_DATA_KEY)}`;
  return parseTwelveData(await fetchText(url), symbol);
}
