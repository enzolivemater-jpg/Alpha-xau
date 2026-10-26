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
 *  chemin d'accès parallèle. Depuis A-C3, la fraîcheur se décide sur
 *  `staleness_us` (âge exact en microsecondes, migration
 *  20261026120000_market_latest_exact_staleness) ; `staleness_seconds`,
 *  arrondi par la vue, n'est plus lu pour décider.
 * =============================================================================
 */

import { SYMBOL_RULES, classifyFreshness, classifyFreshnessExact, wholeSecondsElapsed } from './validate.js';
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
  /** Arrondi à la seconde la plus proche par la vue : affichage seulement. */
  readonly staleness_seconds: number | string | null;
  /** Âge exact en microsecondes (A-C3), seule base de la fraîcheur. */
  readonly staleness_us?: number | string | null;
}

/**
 * Écriture décimale uniquement. `Number()` lit aussi "" et "  " comme 0 (une
 * fraîcheur vide deviendrait « 0 seconde », donc parfaitement fraîche) et
 * "0x10" comme 16.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** PostgREST sérialise NUMERIC en chaîne : la conversion est explicite. */
function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let parsed: number;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && DECIMAL.test(value.trim())) parsed = Number(value.trim());
  else return null;
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
 * Âge exact en microsecondes : un entier JSON sûr ou une chaîne d'entier
 * décimal (BIGINT). Toute autre forme est illisible : null, jamais 0.
 */
function exactMicros(value: number | string | null | undefined): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Comme buildField, sur l'âge exact (A-C3) : la classe est décidée avant tout
 * arrondi ; l'âge rapporté est en secondes entières écoulées (plancher), donc
 * négatif pour une ligne datée après l'horloge de la base, comme avant.
 */
export function buildFieldExact(
  value: number | null,
  ageMicros: bigint | null,
  observedAt: string | null,
  source: string | null,
  symbol: MarketSymbol,
): MarketField {
  if (value === null || ageMicros === null || observedAt === null) return UNAVAILABLE_FIELD;

  const ageNanos = ageMicros * 1000n;
  const ageSeconds = wholeSecondsElapsed(ageNanos);
  const freshness: Freshness = classifyFreshnessExact(ageNanos < 0n ? 0n : ageNanos, SYMBOL_RULES[symbol]);
  if (freshness === 'UNAVAILABLE') {
    return { value: null, status: 'UNAVAILABLE', observedAt, ageSeconds, source };
  }
  return { value, status: freshness, observedAt, ageSeconds, source };
}

/**
 * Assemble l'instantané à partir des lignes de `v_market_latest`.
 *
 * Chaque driver macro est lu exclusivement sur sa ligne native. Les stamps
 * historiques de la ligne XAUUSD restent compatibles avec l'ancien stockage,
 * mais ne sont jamais utilisés comme preuve de provenance ou de fraîcheur.
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

  const goldAge = exactMicros(gold.staleness_us);
  const spot = buildFieldExact(num(gold.close), goldAge, gold.ts, gold.source, 'XAUUSD');

  if (spot.status === 'UNAVAILABLE') {
    return {
      available: false,
      reason: goldAge === null
        ? 'DATA_UNAVAILABLE : âge exact du dernier prix XAUUSD illisible (staleness_us).'
        : `DATA_UNAVAILABLE : dernier prix XAUUSD périmé (${goldAge / 1000n} ms).`,
      spot: UNAVAILABLE_FIELD, bid: UNAVAILABLE_FIELD, ask: UNAVAILABLE_FIELD,
      dxy: UNAVAILABLE_FIELD, us10y: UNAVAILABLE_FIELD, realYield: UNAVAILABLE_FIELD,
      vix: UNAVAILABLE_FIELD, wti: UNAVAILABLE_FIELD,
      capturedAt: gold.ts,
    };
  }

  /** Ligne native uniquement. Une absence échoue fermée en UNAVAILABLE. */
  const macro = (symbol: MarketSymbol): MarketField => {
    const own = rows.find((r) => r.symbol === symbol);
    if (!own) return UNAVAILABLE_FIELD;
    return buildFieldExact(num(own.close), exactMicros(own.staleness_us), own.ts, own.source, symbol);
  };

  return {
    available: true,
    reason: null,
    spot,
    bid: buildFieldExact(num(gold.bid), goldAge, gold.ts, gold.source, 'XAUUSD'),
    ask: buildFieldExact(num(gold.ask), goldAge, gold.ts, gold.source, 'XAUUSD'),
    // DXY retiré (2026-08-18) : Twelve Data ne le référence pas comme
    // symbole interrogeable (vérifié via /symbol_search, pas supposé).
    // dxy_value reste NULL en permanence -> toujours UNAVAILABLE, jamais
    // une valeur inventée.
    dxy: UNAVAILABLE_FIELD,
    us10y: macro('US10Y'),
    realYield: macro('US10YR'),
    vix: macro('VIX'),
    wti: macro('WTI'),
    capturedAt: gold.ts,
  };
}

const SELECT_COLUMNS =
  'symbol,bid,ask,close,dxy_value,us10y_yield,real_yield,vix,wti,source,ts,staleness_seconds,staleness_us';

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
