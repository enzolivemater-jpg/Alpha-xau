/**
 * =============================================================================
 *  ALPHA-XAU — backend/news_sources/federal_reserve_raw.ts
 *
 *  Adaptateur d'orchestration RAW : Federal Reserve collector ->
 *  writeRawNewsObservations() -> public.news_articles.
 *
 *  Petit adaptateur volontairement mince : AUCUNE logique métier propre.
 *  Il ne fait qu'appeler collectFederalReserveNews() puis
 *  writeRawNewsObservations(), et agrège un résumé déterministe.
 *
 *  N'IMPORTE JAMAIS backend/ingest.ts (aucune dépendance vers
 *  NormalizedArticle, ScoredEvent, SourceRegistry, scoreArticle,
 *  dispatchActions, news_events, GDELT, NewsAPI, Committee, AI, Event
 *  Cluster). Les observations Fed n'entrent JAMAIS dans le pipeline
 *  legacy — elles vont UNIQUEMENT vers news_articles via le writer RAW.
 * =============================================================================
 */

import {
  collectFederalReserveNews,
  type FederalReserveFeedStatus,
  type FetchLike,
} from './federal_reserve.js';
import {
  writeRawNewsObservations,
  type RawNewsDb,
} from '../shared/raw_news.js';

export interface FederalReserveRawIngestOptions {
  readonly db: RawNewsDb;
  readonly ingestRunId: string;
  readonly observedAt: string;
  readonly fetchFn?: FetchLike;
}

export interface FederalReserveRawIngestResult {
  readonly ok: boolean;
  readonly durationMs: number;

  readonly observations: number;
  readonly collectorRejected: number;

  readonly inserted: number;
  readonly duplicates: number;
  readonly writerRejected: number;
  readonly databaseErrors: number;

  readonly feeds: readonly FederalReserveFeedStatus[];
  readonly errors: readonly string[];
}

/** Borne le nombre de messages représentatifs conservés — jamais un
 *  tableau d'erreurs non borné (voir NEWS-OFFICIAL-005 §5). */
const MAX_REPRESENTATIVE_ERRORS = 5;

/**
 * ok=true UNIQUEMENT si : les deux flux Fed sont status='ok', ET aucun
 * item rejeté par le collecteur, ET aucun rejet côté writer RAW, ET
 * aucune erreur DB. Les doublons sont NORMAUX (idempotence
 * observation_hash) : duplicates > 0 ne rend JAMAIS ok=false.
 */
export async function ingestFederalReserveRaw(
  options: FederalReserveRawIngestOptions,
): Promise<FederalReserveRawIngestResult> {
  const startedAt = Date.now();

  const collected = await collectFederalReserveNews({
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

  const feedsOk = collected.feeds.every((feed) => feed.status === 'ok');
  if (!feedsOk) {
    for (const feed of collected.feeds) {
      if (feed.status === 'failed' && errors.length < MAX_REPRESENTATIVE_ERRORS) {
        errors.push(`feed_failed:${feed.feed}: ${feed.error ?? 'unknown error'}`);
      }
    }
  }

  const collectorRejected = collected.rejectedItems.length;
  // Résumé agrégé uniquement — jamais le détail par item (title/URL) : voir
  // NEWS-OFFICIAL-005 §12, aucune donnée d'article dans les logs/erreurs.
  if (collectorRejected > 0 && errors.length < MAX_REPRESENTATIVE_ERRORS) {
    errors.push(`collector_rejected: ${collectorRejected} item(s)`);
  }

  const ok = feedsOk && collectorRejected === 0 && writerRejected === 0 && databaseErrors === 0;

  return {
    ok,
    durationMs: Date.now() - startedAt,
    observations: collected.observations.length,
    collectorRejected,
    inserted,
    duplicates,
    writerRejected,
    databaseErrors,
    feeds: collected.feeds,
    errors,
  };
}
