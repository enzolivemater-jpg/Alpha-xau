/**
 * =============================================================================
 *  ALPHA-XAU — backend/market_engine/validate.ts
 *
 *  VALIDATION. Aucun point ne franchit cette barrière sans être :
 *  numérique fini, strictement positif quand la nature de l'instrument
 *  l'impose, horodaté par la SOURCE, non futur, et dans une plage de
 *  plausibilité.
 *
 *  Les bornes de plausibilité ne corrigent JAMAIS une valeur : elles la
 *  rejettent. Un prix aberrant est écarté, pas ramené dans l'intervalle.
 * =============================================================================
 */

import type {
  Freshness,
  MarketSymbol,
  RawDataPoint,
  ValidationOutcome,
} from './types.js';

/**
 * Contraintes par instrument.
 *
 * - min/max : bornes de plausibilité. Larges à dessein — leur rôle est
 *   d'attraper une réponse corrompue (0, -1, 1e9, un code d'erreur parsé
 *   comme un nombre), pas d'exprimer une vue de marché.
 * - allowNegative : seuls les rendements peuvent l'être. Le rendement réel
 *   a été négatif pendant des années : l'interdire serait une erreur
 *   factuelle. Un PRIX négatif reste impossible.
 * - liveMaxAgeS / staleMaxAgeS : seuils de fraîcheur. Les séries FRED sont
 *   quotidiennes et absentes le week-end : leurs seuils sont exprimés en
 *   jours, sinon toute donnée obligataire serait déclarée périmée chaque
 *   samedi alors qu'elle est la dernière valeur publiée disponible.
 */
export interface SymbolRule {
  readonly min: number;
  readonly max: number;
  readonly allowNegative: boolean;
  readonly liveMaxAgeS: number;
  readonly staleMaxAgeS: number;
}

const HOUR = 3600;
const DAY = 86_400;

export const SYMBOL_RULES: Readonly<Record<MarketSymbol, SymbolRule>> = {
  // Or spot : le cron marché tourne à */5 (quota Twelve Data). Un seuil
  // LIVE fixé exactement à 300s collerait au bord de l'intervalle de
  // cron : le moindre retard d'un run (latence réseau, redémarrage du
  // Worker) ferait basculer XAUUSD en STALE avant le run suivant, à
  // chaque cycle. 360s laisse une marge d'une minute.
  XAUUSD: { min: 100, max: 100_000, allowNegative: false, liveMaxAgeS: 360, staleMaxAgeS: 3 * DAY },
  // Rendement nominal 10 ans. Borne basse alignée sur le CHECK SQL (-5..25).
  US10Y: { min: -5, max: 25, allowNegative: true, liveMaxAgeS: 36 * HOUR, staleMaxAgeS: 6 * DAY },
  // Rendement réel 10 ans (TIPS). CHECK SQL : -10..25.
  US10YR: { min: -10, max: 25, allowNegative: true, liveMaxAgeS: 36 * HOUR, staleMaxAgeS: 6 * DAY },
  // VIX : jamais négatif, plafond large pour ne pas écarter un pic de crise.
  VIX: { min: 0, max: 300, allowNegative: false, liveMaxAgeS: 36 * HOUR, staleMaxAgeS: 6 * DAY },
  // WTI : le contrat a coté en négatif en avril 2020. Le spot publié par
  // FRED reste positif ; on rejette le négatif mais on garde une borne basse
  // à 0 plutôt qu'un plancher arbitraire.
  WTI: { min: 0, max: 1_000, allowNegative: false, liveMaxAgeS: 36 * HOUR, staleMaxAgeS: 6 * DAY },
};

/** Tolérance sur les horloges source désynchronisées, alignée sur le CHECK SQL. */
export const FUTURE_TOLERANCE_S = 300;

/**
 * Classe la fraîcheur à partir de l'âge RÉEL du point.
 * Ne modifie jamais l'horodatage : une donnée ancienne reste ancienne.
 */
export function classifyFreshness(ageSeconds: number, rule: SymbolRule): Freshness {
  if (ageSeconds > rule.staleMaxAgeS) return 'UNAVAILABLE';
  if (ageSeconds > rule.liveMaxAgeS) return 'STALE';
  return 'LIVE';
}

/**
 * Valide un point brut. Retourne un résultat discriminé : le code appelant
 * ne peut pas accéder à `point` sans avoir vérifié `ok`.
 *
 * @param now Injecté pour rendre la fonction testable de façon déterministe.
 */
export function validatePoint(raw: RawDataPoint, now: Date = new Date()): ValidationOutcome {
  const rule = SYMBOL_RULES[raw.symbol];
  const reject = (reason: string): ValidationOutcome => ({
    ok: false,
    rejection: { symbol: raw.symbol, source: raw.source, reason },
  });

  // 1. Valeur présente. Une absence reste une absence.
  if (raw.value === null || raw.value === undefined) {
    return reject(raw.unavailableReason ?? 'Valeur absente');
  }
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    return reject('Valeur non numérique ou non finie');
  }

  // 2. Signe.
  if (raw.value < 0 && !rule.allowNegative) {
    return reject(`Valeur négative interdite pour ${raw.symbol} (${raw.value})`);
  }

  // 3. Plausibilité. Rejet, jamais correction.
  if (raw.value < rule.min || raw.value > rule.max) {
    return reject(`Valeur hors plage de plausibilité [${rule.min}, ${rule.max}] : ${raw.value}`);
  }

  // 4. Horodatage source.
  if (!raw.observedAt) return reject('Horodatage source absent');
  const observedMs = Date.parse(raw.observedAt);
  if (!Number.isFinite(observedMs)) return reject('Horodatage source invalide');

  const ageSeconds = Math.round((now.getTime() - observedMs) / 1000);

  // 5. Pas de donnée future (miroir de chk_market_ticks_no_future).
  if (ageSeconds < -FUTURE_TOLERANCE_S) {
    return reject(`Horodatage dans le futur (${-ageSeconds}s d'avance)`);
  }

  // 6. Fraîcheur.
  const freshness = classifyFreshness(Math.max(0, ageSeconds), rule);
  if (freshness === 'UNAVAILABLE') {
    return reject(`Donnée trop ancienne (${ageSeconds}s > ${rule.staleMaxAgeS}s)`);
  }

  // 7. Cohérence OHLC. Le CHECK SQL l'imposerait de toute façon ; le rejet
  //    ici évite une transaction perdue et produit un diagnostic lisible.
  const { open, high, low } = raw;
  const ohlcPresent = typeof high === 'number' && typeof low === 'number';
  if (ohlcPresent) {
    const highest = Math.max(raw.value, typeof open === 'number' ? open : raw.value);
    const lowest = Math.min(raw.value, typeof open === 'number' ? open : raw.value);
    if (high < low || high < highest || low > lowest) {
      return reject(`OHLC incohérent (h=${high} l=${low} o=${open} c=${raw.value})`);
    }
  }

  // 8. Book, si publié.
  const bid = typeof raw.bid === 'number' && Number.isFinite(raw.bid) ? raw.bid : null;
  const ask = typeof raw.ask === 'number' && Number.isFinite(raw.ask) ? raw.ask : null;
  if (bid !== null && bid <= 0) return reject('Bid non strictement positif');
  if (ask !== null && ask <= 0) return reject('Ask non strictement positif');
  if (bid !== null && ask !== null && ask < bid) return reject(`Book inversé (bid=${bid} ask=${ask})`);

  return {
    ok: true,
    point: {
      symbol: raw.symbol,
      source: raw.source,
      value: raw.value,
      observedAt: new Date(observedMs).toISOString(),
      freshness,
      ageSeconds: Math.max(0, ageSeconds),
      open: typeof open === 'number' && Number.isFinite(open) ? open : null,
      high: ohlcPresent && typeof high === 'number' ? high : null,
      low: ohlcPresent && typeof low === 'number' ? low : null,
      bid,
      ask,
      volume: typeof raw.volume === 'number' && Number.isFinite(raw.volume) && raw.volume >= 0
        ? raw.volume
        : null,
    },
  };
}

/**
 * Clé de déduplication applicative, strictement alignée sur l'index unique
 * `uq_market_ticks_series (symbol, timeframe, ts, source)`.
 *
 * Elle ne REMPLACE pas la contrainte SQL — elle l'anticipe pour éviter
 * d'envoyer deux fois la même ligne dans un même lot. L'unicité reste
 * garantie par PostgreSQL, seul arbitre.
 */
export function dedupKey(symbol: string, timeframe: string, observedAt: string, source: string): string {
  return `${symbol}|${timeframe}|${observedAt}|${source}`;
}
