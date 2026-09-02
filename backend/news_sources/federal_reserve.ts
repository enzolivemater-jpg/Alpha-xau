/**
 * =============================================================================
 *  ALPHA-XAU — backend/news_sources/federal_reserve.ts
 *
 *  Collecteur RAW officiel : Federal Reserve Board (press_monetary.xml +
 *  speeches.xml). Transforme les items RSS en RawNewsObservationInput
 *  (backend/shared/raw_news.ts) — AUCUNE persistance, AUCUN scoring,
 *  AUCUNE notification comité, AUCUNE logique Event Cluster ici.
 *
 *  NON-BUTS explicites :
 *    - pas de fenêtre lookback : le RAW layer ingère tout ce qu'un flux
 *      RSS fini expose actuellement, l'idempotence appartient à
 *      news_articles.observation_hash / au writer RAW ;
 *    - pas de retry/backoff ici : cette politique appartiendra à une
 *      future orchestration des sources officielles, pas dupliquée dans
 *      chaque collecteur ;
 *    - pas de fetch de page article : content reste toujours null en V1 ;
 *    - pas de correction/parsing de timestamp malformé : providerPublishedRaw
 *      est transmis tel quel, la dégradation de qualité est la
 *      responsabilité du writer RAW (normalizeRawNewsObservation).
 *
 *  Parseur RSS délibérément ÉTROIT (pas un parseur XML générique) : ne
 *  couvre que la forme RSS 2.0 réellement observée sur ces deux flux Fed
 *  (voir NEWS-OFFICIAL-002A). L'extraction d'item utilise une regex non
 *  gourmande et bornée — jamais de motif imbriqué pouvant provoquer un
 *  retour arrière catastrophique.
 * =============================================================================
 */

import type { RawNewsObservationInput } from '../shared/raw_news.js';

export type FederalReserveFeedId = 'press_monetary' | 'speeches';

export interface FederalReserveFeedStatus {
  readonly feed: FederalReserveFeedId;
  readonly url: string;
  readonly status: 'ok' | 'failed';
  readonly itemsAccepted: number;
  readonly error?: string;
}

export interface FederalReserveRejectedItem {
  readonly feed: FederalReserveFeedId;
  readonly reason: string;
  readonly detail?: string;
}

export interface FederalReserveCollectorResult {
  readonly observations: readonly RawNewsObservationInput[];
  readonly feeds: readonly FederalReserveFeedStatus[];
  readonly rejectedItems: readonly FederalReserveRejectedItem[];
}

/** Port structural minimal — pas le type global `fetch` complet : ne
 *  dépend que de ce que ce collecteur utilise réellement, pour rester
 *  facilement injectable dans les tests déterministes. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}
export interface FetchLike {
  (
    url: string,
    init?: {
      readonly method?: string;
      readonly headers?: Record<string, string>;
      readonly signal?: AbortSignal;
    },
  ): Promise<FetchResponseLike>;
}

export interface CollectFederalReserveNewsOptions {
  readonly ingestRunId: string;
  readonly observedAt: string;
  readonly fetchFn?: FetchLike;
}

const FEED_TIMEOUT_MS = 15_000;

interface FeedConfig {
  readonly id: FederalReserveFeedId;
  readonly url: string;
  readonly category: string;
}

const FEEDS: readonly FeedConfig[] = [
  {
    id: 'press_monetary',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    category: 'monetary_policy_press_release',
  },
  {
    id: 'speeches',
    url: 'https://www.federalreserve.gov/feeds/speeches.xml',
    category: 'speech',
  },
];

/** Décodage en UNE passe : évite tout risque de double-décodage (ex.
 *  "&amp;lt;" ne doit jamais redevenir "<"). */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity.charAt(0) === '#') {
      const isHex = entity.charAt(1) === 'x' || entity.charAt(1) === 'X';
      const codePoint = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return match;
    }
  });
}

/** CDATA ou texte XML ordinaire, entités décodées, whitespace de mise en
 *  forme XML (indentation du flux) retiré en bordure — jamais de
 *  troncature, jamais de nettoyage HTML (pas de cleanText). */
function decodeXmlText(raw: string): string {
  const trimmed = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  const inner = cdata ? cdata[1] : trimmed;
  return decodeXmlEntities(inner).trim();
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return null;
  const text = decodeXmlText(m[1]);
  return text.length > 0 ? text : null;
}

/** Extraction bornée, non gourmande : un seul niveau, pas de motif
 *  imbriqué — pas un parseur XML générique, seulement une extraction de
 *  blocs <item> pour la forme RSS 2.0 Fed connue. */
function extractItemBlocks(xml: string): string[] {
  const matches = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/g);
  return matches ?? [];
}

function looksLikeRss(xml: string): boolean {
  return /<rss[\s>]/i.test(xml) && /<channel[\s>]/i.test(xml);
}

async function fetchFeedBody(fetchImpl: FetchLike, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.text();
    if (body.trim().length === 0) {
      throw new Error('empty response body');
    }
    return body;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`timeout after ${FEED_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Intégrité de provenance (§8) : un item Fed ne peut revendiquer
 *  sourceCode='federalreserve' que pour une URL https:// sur
 *  federalreserve.gov ou un sous-domaine *.federalreserve.gov. */
function validateFedUrl(link: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return { ok: false, reason: 'fed_item_url_invalid' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'fed_item_url_invalid' };
  }
  const host = parsed.hostname.toLowerCase();
  const isFedHost = host === 'federalreserve.gov' || host.endsWith('.federalreserve.gov');
  if (!isFedHost) {
    return { ok: false, reason: 'fed_item_url_external' };
  }
  return { ok: true };
}

function processItem(
  feedId: FederalReserveFeedId,
  category: string,
  block: string,
  ingestRunId: string,
  observedAt: string,
): { observation: RawNewsObservationInput } | { rejected: FederalReserveRejectedItem } {
  const title = extractTag(block, 'title');
  if (title === null) {
    return { rejected: { feed: feedId, reason: 'fed_item_title_missing' } };
  }

  const guid = extractTag(block, 'guid');
  const link = extractTag(block, 'link');

  if (guid === null && link === null) {
    return { rejected: { feed: feedId, reason: 'fed_item_identity_missing' } };
  }

  let canonicalUrl: string | null = null;
  if (link !== null) {
    const validation = validateFedUrl(link);
    if (!validation.ok) {
      return { rejected: { feed: feedId, reason: validation.reason, detail: link } };
    }
    canonicalUrl = link;
  }

  const description = extractTag(block, 'description');
  const pubDate = extractTag(block, 'pubDate');

  const observation: RawNewsObservationInput = {
    ingestRunId,
    provider: 'federal_reserve',
    providerItemId: guid,
    sourceCode: 'federalreserve',
    sourceDomain: 'federalreserve.gov',
    canonicalUrl,
    title,
    summary: description,
    content: null,
    providerCategory: category,
    providerPublishedRaw: pubDate,
    // precision='timestamp' quand pubDate est présent : le RAW writer est
    // seul responsable de valider/dégrader un pubDate malformé — ce
    // collecteur ne parse ni ne "corrige" jamais cette chaîne.
    publicationPrecision: pubDate !== null ? 'timestamp' : 'none',
    observedAt,
    ingestQualityState: 'VALID',
    ingestQualityReasons: [],
  };

  return { observation };
}

async function collectSingleFeed(
  feedConfig: FeedConfig,
  fetchImpl: FetchLike,
  ingestRunId: string,
  observedAt: string,
): Promise<{
  status: FederalReserveFeedStatus;
  observations: RawNewsObservationInput[];
  rejected: FederalReserveRejectedItem[];
}> {
  const body = await fetchFeedBody(fetchImpl, feedConfig.url);

  if (!looksLikeRss(body)) {
    throw new Error('malformed feed: missing rss/channel structure');
  }

  const itemBlocks = extractItemBlocks(body);
  if (itemBlocks.length === 0) {
    throw new Error('malformed feed: no item blocks');
  }

  const observations: RawNewsObservationInput[] = [];
  const rejected: FederalReserveRejectedItem[] = [];

  for (const block of itemBlocks) {
    try {
      const result = processItem(feedConfig.id, feedConfig.category, block, ingestRunId, observedAt);
      if ('observation' in result) {
        observations.push(result.observation);
      } else {
        rejected.push(result.rejected);
      }
    } catch {
      rejected.push({ feed: feedConfig.id, reason: 'fed_item_parse_failed' });
    }
  }

  return {
    status: {
      feed: feedConfig.id,
      url: feedConfig.url,
      status: 'ok',
      itemsAccepted: observations.length,
    },
    observations,
    rejected,
  };
}

/**
 * Collecte les deux flux Fed CONCURREMMENT (Promise.allSettled : les deux
 * fetch() partent avant que l'un ou l'autre ne se résolve). Un flux en
 * échec ne fait jamais perdre les observations de l'autre. Aucun DB,
 * aucun scoring, aucun accès réseau vers autre chose que ces deux URLs.
 */
export async function collectFederalReserveNews(
  options: CollectFederalReserveNewsOptions,
): Promise<FederalReserveCollectorResult> {
  const fetchImpl: FetchLike = options.fetchFn ?? fetch;

  const settled = await Promise.allSettled(
    FEEDS.map((feedConfig) => collectSingleFeed(feedConfig, fetchImpl, options.ingestRunId, options.observedAt)),
  );

  const observations: RawNewsObservationInput[] = [];
  const rejectedItems: FederalReserveRejectedItem[] = [];
  const feeds: FederalReserveFeedStatus[] = [];

  settled.forEach((result, index) => {
    const feedConfig = FEEDS[index];
    if (result.status === 'fulfilled') {
      feeds.push(result.value.status);
      observations.push(...result.value.observations);
      rejectedItems.push(...result.value.rejected);
    } else {
      feeds.push({
        feed: feedConfig.id,
        url: feedConfig.url,
        status: 'failed',
        itemsAccepted: 0,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { observations, feeds, rejectedItems };
}
