/**
 * =============================================================================
 *  ALPHA-XAU — backend/market_engine/context.ts
 *
 *  CONTRAT DE LECTURE du moteur marché, consommé par
 *  backend/ai_engine/committee_orchestrator.ts.
 *
 *  Ce module est le SEUL point par lequel le comité IA obtient un état du
 *  marché. Objectif : qu'il soit impossible de lire une valeur sans lire son
 *  statut de fraîcheur, et impossible d'obtenir un nombre là où la source
 *  n'a rien fourni.
 *
 *  Il lit la vue existante `v_market_latest` : aucune vue nouvelle, aucun
 *  chemin d'accès parallèle.
 * =============================================================================
 */

import { SYMBOL_RULES, classifyFreshness } from './validate.js';
import type {
  Freshness,
  MarketField,
  MarketSnapshot,
  MarketSymbol,
} from './types.js';
import { UNAVAILABLE_FIELD } from './types.js';

export interface ContextEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
}

/** Ligne de `v_market_latest` telle que définie dans schema.sql. */
export interface MarketLatestRow {
  readonly symbol: string;
  readonly bid: number | string | null;
  readonly ask: number | string | null;
  readonly close: number | string | null;
  readonly dxy_value: number | string | null;
  readonly us10y_yield: number | string | null;
  readonly real_yield: number | string | null;
  readonly vix: number | string | null;
  readonly wti: number | string | null;
  readonly source: string | null;
  readonly ts: string | null;
  readonly staleness_seconds: number | string | null;
}

/** PostgREST sérialise NUMERIC en chaîne : la conversion est explicite. */
function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Construit un champ à partir d'une valeur et de son âge réel.
 * Une valeur absente OU trop ancienne devient UNAVAILABLE : dans les deux cas
 * le consommateur doit la traiter comme inexploitable, pas comme un zéro.
 */
export function buildField(
  value: number | null,
  ageSeconds: number | null,
  observedAt: string | null,
  source: string | null,
  symbol: MarketSymbol,
): MarketField {
  if (value === null || ageSeconds === null || observedAt === null) return UNAVAILABLE_FIELD;

  const freshness: Freshness = classifyFreshness(Math.max(0, ageSeconds), SYMBOL_RULES[symbol]);
  if (freshness === 'UNAVAILABLE') {
    return { value: null, status: 'UNAVAILABLE', observedAt, ageSeconds, source };
  }
  return { value, status: freshness, observedAt, ageSeconds, source };
}

/**
 * Assemble l'instantané à partir des lignes de `v_market_latest`.
 *
 * Les champs macro sont lus sur le STAMP de la ligne XAUUSD (dénormalisation
 * prévue par le schéma), avec repli sur la ligne dédiée de l'instrument
 * lorsque le stamp est vide — ce qui arrive quand la source macro était
 * indisponible au moment où le tick or a été écrit.
 */
export function buildSnapshot(rows: readonly MarketLatestRow[]): MarketSnapshot {
  const gold = rows.find((r) => r.symbol === 'XAUUSD');

  if (!gold || num(gold.close) === null || !gold.ts) {
    return {
      available: false,
      reason: 'DATA_UNAVAILABLE : aucun prix XAUUSD exploitable en base.',
      spot: UNAVAILABLE_FIELD, bid: UNAVAILABLE_FIELD, ask: UNAVAILABLE_FIELD,
      dxy: UNAVAILABLE_FIELD, us10y: UNAVAILABLE_FIELD, realYield: UNAVAILABLE_FIELD,
      vix: UNAVAILABLE_FIELD, wti: UNAVAILABLE_FIELD,
      capturedAt: null,
    };
  }

  const goldAge = num(gold.staleness_seconds);
  const spot = buildField(num(gold.close), goldAge, gold.ts, gold.source, 'XAUUSD');

  if (spot.status === 'UNAVAILABLE') {
    return {
      available: false,
      reason: `DATA_UNAVAILABLE : dernier prix XAUUSD périmé (${goldAge ?? '?'}s).`,
      spot: UNAVAILABLE_FIELD, bid: UNAVAILABLE_FIELD, ask: UNAVAILABLE_FIELD,
      dxy: UNAVAILABLE_FIELD, us10y: UNAVAILABLE_FIELD, realYield: UNAVAILABLE_FIELD,
      vix: UNAVAILABLE_FIELD, wti: UNAVAILABLE_FIELD,
      capturedAt: gold.ts,
    };
  }

  /** Stamp d'abord, ligne dédiée ensuite. Jamais de valeur par défaut. */
  const macro = (
    stamped: number | string | null,
    symbol: MarketSymbol,
  ): MarketField => {
    const fromStamp = num(stamped);
    if (fromStamp !== null) return buildField(fromStamp, goldAge, gold.ts, gold.source, symbol);

    const own = rows.find((r) => r.symbol === symbol);
    if (!own) return UNAVAILABLE_FIELD;
    return buildField(num(own.close), num(own.staleness_seconds), own.ts, own.source, symbol);
  };

  return {
    available: true,
    reason: null,
    spot,
    bid: buildField(num(gold.bid), goldAge, gold.ts, gold.source, 'XAUUSD'),
    ask: buildField(num(gold.ask), goldAge, gold.ts, gold.source, 'XAUUSD'),
    dxy: macro(gold.dxy_value, 'DXY'),
    us10y: macro(gold.us10y_yield, 'US10Y'),
    realYield: macro(gold.real_yield, 'US10YR'),
    vix: macro(gold.vix, 'VIX'),
    wti: macro(gold.wti, 'WTI'),
    capturedAt: gold.ts,
  };
}

const SELECT_COLUMNS =
  'symbol,bid,ask,close,dxy_value,us10y_yield,real_yield,vix,wti,source,ts,staleness_seconds';

/**
 * Point d'entrée du contrat : dernier contexte marché valide.
 *
 * Ne lève jamais sur absence de donnée — elle retourne `available: false`
 * avec un motif. C'est au comité de décider d'arrêter, et il le fait.
 */
export async function fetchMarketSnapshot(env: ContextEnv): Promise<MarketSnapshot> {
  const url = `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/v_market_latest?select=${SELECT_COLUMNS}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ...buildSnapshot([]),
        reason: `DATA_UNAVAILABLE : lecture v_market_latest en échec (HTTP ${response.status}).`,
      };
    }
    return buildSnapshot((await response.json()) as MarketLatestRow[]);
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? 'timeout'
      : err instanceof Error ? err.message : String(err);
    return {
      ...buildSnapshot([]),
      reason: `DATA_UNAVAILABLE : lecture v_market_latest impossible (${reason}).`,
    };
  } finally {
    clearTimeout(timer);
  }
}
