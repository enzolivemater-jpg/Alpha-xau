/**
 * =============================================================================
 *  ALPHA-XAU — backend/news_sources/ofac_raw.ts
 *
 *  Adaptateur d'orchestration RAW : OFAC Recent Actions collector ->
 *  writeRawNewsObservations() -> public.news_articles.
 *
 *  Petit adaptateur volontairement mince : AUCUNE logique métier propre.
 *  Il ne fait qu'appeler collectOfacNews() puis
 *  writeRawNewsObservations(), et agrège un résumé déterministe. Même
 *  contrat/forme que backend/news_sources/federal_reserve_raw.ts,
 *  ecb_raw.ts et us_treasury_raw.ts (délibérément dupliqué, pas
 *  factorisé — Treasury et OFAC gardent des contrats de provenance
 *  distincts, pas d'abstraction générique introduite ici). Ne
 *  réinterprète JAMAIS le HTML ou les champs OFAC (catégorie/date
 *  restent entièrement possédés par le collecteur — voir
 *  XAU-V2-NEWS-OFFICIAL-026 §12).
 *
 *  N'IMPORTE JAMAIS backend/ingest.ts (aucune dépendance vers
 *  NormalizedArticle, ScoredEvent, SourceRegistry, scoreArticle,
 *  dispatchActions, news_events, GDELT, NewsAPI, Committee, AI, Event
 *  Cluster). Les observations OFAC n'entrent JAMAIS dans le pipeline
 *  legacy — elles vont UNIQUEMENT vers news_articles via le writer RAW.
 * =============================================================================
 */

import {
  collectOfacNews,
  type OfacPageStatus,
  type FetchLike,
} from './ofac.js';
import {
  writeRawNewsObservations,
  type RawNewsDb,
} from '../shared/raw_news.js';

export interface OfacRawIngestOptions {
  readonly db: RawNewsDb;
  readonly ingestRunId: string;
  readonly observedAt: string;
  readonly fetchFn?: FetchLike;
}

export interface OfacRawIngestResult {
  readonly ok: boolean;
  readonly durationMs: number;

  readonly observations: number;
  readonly collectorRejected: number;

  readonly inserted: number;
  readonly duplicates: number;
  readonly writerRejected: number;
  readonly databaseErrors: number;

  readonly page: OfacPageStatus;
  readonly errors: readonly string[];
}

/** Borne le nombre de messages représentatifs conservés — jamais un
 *  tableau d'erreurs non borné (même règle que federal_reserve_raw.ts /
 *  ecb_raw.ts / us_treasury_raw.ts). */
const MAX_REPRESENTATIVE_ERRORS = 5;

/**
 * ok=true UNIQUEMENT si : la page OFAC est status='ok' (ce qui inclut le
 * cas d'un document globalement non balancé — le collecteur échoue alors
 * closed, zéro observation), ET aucun item rejeté par le collecteur, ET
 * aucun rejet côté writer RAW, ET aucune erreur DB. Les doublons sont
 * NORMAUX (idempotence observation_hash) : duplicates > 0 ne rend JAMAIS
 * ok=false.
 */
export async function ingestOfacRaw(
  options: OfacRawIngestOptions,
): Promise<OfacRawIngestResult> {
  const startedAt = Date.now();

  const collected = await collectOfacNews({
    ingestRunId: options.ingestRunId,
    observedAt: options.observedAt,
    fetchFn: options.fetchFn,
  });

  const writeResults = await writeRawNewsObservations(options.db, collected.observations);

  let inserted = 0;
  let duplicates = 0;
  let writerRejected = 0;
  let databaseErrors = 0;
  const errors: string[] = [];

  for (const result of writeResults) {
    switch (result.outcome) {
      case 'inserted':
        inserted += 1;
        break;
      case 'duplicate':
        duplicates += 1;
        break;
      case 'rejected':
        writerRejected += 1;
        if (errors.length < MAX_REPRESENTATIVE_ERRORS) {
          errors.push(`writer_rejected: ${result.reason}`);
        }
        break;
      case 'database_error':
        databaseErrors += 1;
        if (errors.length < MAX_REPRESENTATIVE_ERRORS) {
          errors.push(`database_error: ${result.error}`);
        }
        break;
    }
  }

  const pageOk = collected.page.status === 'ok';
  if (!pageOk && errors.length < MAX_REPRESENTATIVE_ERRORS) {
    errors.push(`page_failed: ${collected.page.error ?? 'unknown error'}`);
  }

  const collectorRejected = collected.rejectedItems.length;
  // Résumé agrégé uniquement — jamais le détail par item (title/URL/
  // category) : même règle que federal_reserve_raw.ts, aucune donnée
  // d'article dans les logs/erreurs.
  if (collectorRejected > 0 && errors.length < MAX_REPRESENTATIVE_ERRORS) {
    errors.push(`collector_rejected: ${collectorRejected} item(s)`);
  }

  const ok = pageOk && collectorRejected === 0 && writerRejected === 0 && databaseErrors === 0;

  return {
    ok,
    durationMs: Date.now() - startedAt,
    observations: collected.observations.length,
    collectorRejected,
    inserted,
    duplicates,
    writerRejected,
    databaseErrors,
    page: collected.page,
    errors,
  };
}
