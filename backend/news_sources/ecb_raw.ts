/**
 * =============================================================================
 *  ALPHA-XAU — backend/news_sources/ecb_raw.ts
 *
 *  Adaptateur d'orchestration RAW : ECB collector ->
 *  writeRawNewsObservations() -> public.news_articles.
 *
 *  Petit adaptateur volontairement mince : AUCUNE logique métier propre.
 *  Il ne fait qu'appeler collectEcbNews() puis writeRawNewsObservations(),
 *  et agrège un résumé déterministe. Même contrat/forme que
 *  backend/news_sources/federal_reserve_raw.ts (délibérément dupliqué, pas
 *  factorisé — voir XAU-V2-NEWS-OFFICIAL-010 §1 : pas de couplage entre
 *  les deux adaptateurs, pas d'abstraction générique introduite ici).
 *
 *  N'IMPORTE JAMAIS backend/ingest.ts (aucune dépendance vers
 *  NormalizedArticle, ScoredEvent, SourceRegistry, scoreArticle,
 *  dispatchActions, news_events, GDELT, NewsAPI, Committee, AI, Event
 *  Cluster). Les observations ECB n'entrent JAMAIS dans le pipeline
 *  legacy — elles vont UNIQUEMENT vers news_articles via le writer RAW.
 * =============================================================================
 */

import {
  collectEcbNews,
  type EcbFeedStatus,
  type FetchLike,
} from './ecb.js';
import {
  writeRawNewsObservations,
  type RawNewsDb,
} from '../shared/raw_news.js';

export interface EcbRawIngestOptions {
  readonly db: RawNewsDb;
  readonly ingestRunId: string;
  readonly observedAt: string;
  readonly fetchFn?: FetchLike;
}

export interface EcbRawIngestResult {
  readonly ok: boolean;
  readonly durationMs: number;

  readonly observations: number;
  readonly collectorRejected: number;

  readonly inserted: number;
  readonly duplicates: number;
  readonly writerRejected: number;
  readonly databaseErrors: number;

  readonly feeds: readonly EcbFeedStatus[];
  readonly errors: readonly string[];
}

/** Borne le nombre de messages représentatifs conservés — jamais un
 *  tableau d'erreurs non borné (même règle que federal_reserve_raw.ts). */
const MAX_REPRESENTATIVE_ERRORS = 5;

/**
 * ok=true UNIQUEMENT si : les deux flux ECB sont status='ok', ET aucun
 * item rejeté par le collecteur, ET aucun rejet côté writer RAW, ET
 * aucune erreur DB. Les doublons sont NORMAUX (idempotence
 * observation_hash) : duplicates > 0 ne rend JAMAIS ok=false.
 */
export async function ingestEcbRaw(
  options: EcbRawIngestOptions,
): Promise<EcbRawIngestResult> {
  const startedAt = Date.now();

  const collected = await collectEcbNews({
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
  // Résumé agrégé uniquement — jamais le détail par item (title/URL) : même
  // règle que federal_reserve_raw.ts, aucune donnée d'article dans les
  // logs/erreurs.
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
