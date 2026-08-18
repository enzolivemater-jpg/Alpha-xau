/**
 * =============================================================================
 *  ALPHA-XAU — backend/market_engine/types.ts
 *
 *  Contrat typé du moteur marché (correctif P0-1).
 *
 *  PRINCIPE FONDATEUR : une donnée absente est une VALEUR ABSENTE, jamais un
 *  zéro, jamais une valeur de repli. Toute la modélisation ci-dessous est
 *  construite autour de ce point : `value` est `number | null`, et `status`
 *  dit POURQUOI elle est nulle. Un consommateur ne peut pas lire une valeur
 *  sans lire son statut.
 * =============================================================================
 */

/** Instruments strictement nécessaires au comité IA et au terminal. */
export type MarketSymbol = 'XAUUSD' | 'US10Y' | 'US10YR' | 'VIX' | 'WTI';

/**
 * Fraîcheur d'un point de donnée, dérivée du timestamp RÉEL de la source.
 * Jamais d'un `now()` fabriqué à l'ingestion.
 */
export type Freshness = 'LIVE' | 'STALE' | 'UNAVAILABLE';

/** Codes présents dans data_sources. Toute autre valeur violerait la FK. */
export type SourceCode = 'stooq' | 'fred' | 'twelve_data';

/** Un point de donnée brut, tel que retourné par un provider. */
export interface RawDataPoint {
  readonly symbol: MarketSymbol;
  readonly source: SourceCode;
  /** null si la source a répondu sans valeur exploitable (ex. FRED "."). */
  readonly value: number | null;
  /** Horodatage UTC issu de la SOURCE. null si la source n'en fournit pas. */
  readonly observedAt: string | null;
  readonly open?: number | null;
  readonly high?: number | null;
  readonly low?: number | null;
  readonly volume?: number | null;
  /** Renseigné uniquement si la source publie un book. */
  readonly bid?: number | null;
  readonly ask?: number | null;
  /** Motif d'indisponibilité, à des fins de diagnostic. */
  readonly unavailableReason?: string;
}

/** Point de donnée validé, prêt pour la base. */
export interface ValidatedDataPoint {
  readonly symbol: MarketSymbol;
  readonly source: SourceCode;
  readonly value: number;
  readonly observedAt: string;
  readonly freshness: Exclude<Freshness, 'UNAVAILABLE'>;
  readonly ageSeconds: number;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly volume: number | null;
}

/** Rejet explicite : conservé pour l'observabilité, jamais écrit en base. */
export interface RejectedDataPoint {
  readonly symbol: MarketSymbol;
  readonly source: SourceCode;
  readonly reason: string;
}

export type ValidationOutcome =
  | { readonly ok: true; readonly point: ValidatedDataPoint }
  | { readonly ok: false; readonly rejection: RejectedDataPoint };

/* -------------------------------------------------------------------------- */
/*  Contrat de LECTURE consommé par committee_orchestrator.ts                  */
/* -------------------------------------------------------------------------- */

/**
 * Un champ du contexte marché. `value` et `status` sont indissociables :
 * status === 'UNAVAILABLE' implique value === null, et réciproquement.
 */
export interface MarketField {
  readonly value: number | null;
  readonly status: Freshness;
  readonly observedAt: string | null;
  readonly ageSeconds: number | null;
  readonly source: string | null;
}

/**
 * Instantané du marché retourné au comité IA.
 *
 * `available: false` signifie DATA_UNAVAILABLE au sens de la spécification :
 * le comité doit refuser de produire une analyse plutôt que de raisonner sur
 * une donnée fabriquée.
 */
export interface MarketSnapshot {
  readonly available: boolean;
  readonly reason: string | null;
  readonly spot: MarketField;
  readonly bid: MarketField;
  readonly ask: MarketField;
  readonly dxy: MarketField;
  readonly us10y: MarketField;
  readonly realYield: MarketField;
  readonly vix: MarketField;
  readonly wti: MarketField;
  readonly capturedAt: string | null;
}

/** Champ vide canonique. Un seul lieu de construction d'une valeur absente. */
export const UNAVAILABLE_FIELD: MarketField = {
  value: null,
  status: 'UNAVAILABLE',
  observedAt: null,
  ageSeconds: null,
  source: null,
};

/* -------------------------------------------------------------------------- */
/*  Rapport d'exécution                                                        */
/* -------------------------------------------------------------------------- */

export type RunStatus = 'STARTED' | 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'PARTIAL';

export interface ProviderOutcome {
  readonly ok: boolean;
  readonly fetched: number;
  readonly error?: string;
}

export interface MarketIngestReport {
  readonly runId: string;
  readonly status: RunStatus;
  readonly durationMs: number;
  readonly fetched: number;
  readonly rejected: number;
  readonly persisted: number;
  readonly duplicates: number;
  readonly providers: Readonly<Record<string, ProviderOutcome>>;
  readonly rejections: readonly RejectedDataPoint[];
  readonly errors: readonly string[];
}
