/**
 * =============================================================================
 *  ALPHA-XAU — backend/news_sources/us_treasury.ts
 *
 *  Collecteur RAW officiel : U.S. Department of the Treasury — Press
 *  Releases (https://home.treasury.gov/news/press-releases). Transforme
 *  les items HTML server-rendered en RawNewsObservationInput
 *  (backend/shared/raw_news.ts) — AUCUNE persistance, AUCUN scoring,
 *  AUCUNE notification comité, AUCUNE logique Event Cluster ici.
 *
 *  Même approche architecturale que backend/news_sources/federal_reserve.ts
 *  et backend/news_sources/ecb.ts (délibérément dupliquée, pas factorisée :
 *  chaque collecteur officiel reste autonome et lisible isolément).
 *
 *  V1 SCOPE (XAU-V2-NEWS-OFFICIAL-019/020) :
 *    - UN SEUL fetch de la page de listing par invocation ;
 *    - aucun usage du manifest JSON (/news-data/press-releases/manifest.json)
 *      ni des shards annuels — ce chemin existe (référencé explicitement
 *      par la page live elle-même) mais introduit une pollution d'items
 *      d'auto-référence de catégorie (testimonies/statements-remarks/
 *      readouts) qui exigerait un filtrage supplémentaire hors scope V1 ;
 *    - aucun fetch de page de détail par item ;
 *    - aucune pagination (page 1 uniquement, ~10 items les plus récents,
 *      largement suffisant face à la cadence réelle de publication
 *      Treasury et à la cadence de cron de 15 min) ;
 *    - aucun flux RSS (aucun n'est annoncé par la page) ;
 *    - aucun retry ;
 *    - aucune nouvelle dépendance npm.
 *
 *  PRÉCISION DE PUBLICATION : Treasury expose un timestamp machine réel
 *  (<time datetime="2026-09-04T14:30:00Z">), avec heure du jour non
 *  triviale — confirmé par preflight (XAU-V2-NEWS-OFFICIAL-019 §2). Ce
 *  collecteur transmet donc TOUJOURS publicationPrecision='timestamp' et
 *  la valeur brute exacte de l'attribut datetime, JAMAIS la forme
 *  d'affichage humaine, et ne parse/valide/normalise JAMAIS cette chaîne
 *  lui-même (aucun appel de parsing de date, aucune construction d'objet
 *  date) — le writer RAW
 *  (raw_news.ts) reste seul responsable de la validation/dégradation.
 *
 *  NON-BUTS explicites (identiques à federal_reserve.ts / ecb.ts) :
 *    - pas de fenêtre lookback ;
 *    - pas de retry/backoff ici ;
 *    - pas de fetch de page article : content reste toujours null ;
 *    - pas de correction/parsing de timestamp malformé ;
 *    - pas d'identifiant natif synthétique (providerItemId reste NULL :
 *      aucun id/nid/uuid/guid n'est exposé par la page, le slug d'URL
 *      n'est pas un identifiant fiable — cf. preflight §TREASURY_NATIVE_ITEM_ID).
 * =============================================================================
 */

import type { RawNewsObservationInput } from '../shared/raw_news.js';

export interface TreasuryPageStatus {
  readonly url: string;
  readonly status: 'ok' | 'failed';
  readonly itemsAccepted: number;
  readonly error?: string;
}

export interface TreasuryRejectedItem {
  readonly reason: string;
  readonly detail?: string;
}

export interface TreasuryCollectorResult {
  readonly observations: readonly RawNewsObservationInput[];
  readonly page: TreasuryPageStatus;
  readonly rejectedItems: readonly TreasuryRejectedItem[];
}

/** Port structural minimal — pas le type global `fetch` complet : ne
 *  dépend que de ce que ce collecteur utilise réellement. */
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

export interface CollectTreasuryNewsOptions {
  readonly ingestRunId: string;
  readonly observedAt: string;
  readonly fetchFn?: FetchLike;
}

const PAGE_TIMEOUT_MS = 15_000;
const LISTING_URL = 'https://home.treasury.gov/news/press-releases';
const LISTING_HOST = 'home.treasury.gov';
const LISTING_PATH_PREFIX = '/news/press-releases/';

/** Décodage en UNE passe : évite tout risque de double-décodage (ex.
 *  "&amp;lt;" ne doit jamais redevenir "<"). Mêmes entités que
 *  federal_reserve.ts / ecb.ts : cinq entités nommées XML/HTML de base
 *  plus les formes numériques décimale et hexadécimale. */
function decodeHtmlEntities(text: string): string {
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

/**
 * Ancre de DÉBUT d'item Treasury observée : <span class=date-format>.
 * Tolère guillemets doubles, simples, ou absence de guillemets sur
 * l'attribut class, conformément à la forme réellement observée (non
 * quotée) sans figer un format d'attribut unique.
 */
const DATE_FORMAT_START_RE = /<span\s+class=(?:"date-format"|'date-format'|date-format)>/g;

/**
 * Découpage par INDEX, PAS par recherche d'un terminateur `</h3>` (voir
 * XAU-V2-NEWS-OFFICIAL-021 §2, P1 corrigé ici) : la région candidate d'un
 * item Treasury s'arrête TOUJOURS AVANT le prochain marqueur
 * date-format, quel que soit son contenu interne. Un item A dont le
 * titre/h3 est absent ou malformé ne peut donc JAMAIS "déborder" sur le
 * `</h3>` de l'item B suivant et produire une association croisée
 * DATE_A + TITRE_B + URL_B — l'ancien motif
 * `<span class=date-format>[\s\S]*?</h3>` souffrait exactement de ce
 * défaut : en l'absence de </h3> propre à l'item A, la recherche non
 * gourmande continuait jusqu'au PROCHAIN </h3> rencontré, qui pouvait
 * appartenir à l'item B, absorbant B entier dans le bloc "A" et le
 * faisant disparaître comme entrée indépendante.
 *
 * PAS un parseur HTML générique : un seul niveau, une seule ancre de
 * début recherchée, un slicing borné et déterministe — pas de
 * `<div>...[\s\S]*?</div>` naïf (dangereux en présence de divs imbriqués).
 */
function extractItemBlocks(html: string): string[] {
  const starts: number[] = [];
  DATE_FORMAT_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_FORMAT_START_RE.exec(html)) !== null) {
    starts.push(m.index);
  }

  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : html.length;
    blocks.push(html.slice(begin, end));
  }
  return blocks;
}

/** Vérifie la présence des ancres structurelles minimales de la page de
 *  listing Treasury, indépendamment du nombre d'items trouvés. */
function looksLikeTreasuryListing(html: string): boolean {
  return /data-news-list\b/i.test(html) || /featured-stories\b/i.test(html);
}

const TIME_DATETIME_RE = /<time\b[^>]*\bdatetime=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i;
const HEADLINE_RE =
  /<h3\s+class=(?:"featured-stories__headline"|'featured-stories__headline'|featured-stories__headline)>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h3>/i;
const HREF_ATTR_RE = /\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Extrait la valeur d'un groupe de capture à guillemets alternatifs
 *  (double, simple, absent), déjà décodée et bornée-triméé. */
function firstGroup(m: RegExpExecArray | null): string | null {
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

async function fetchListingBody(fetchImpl: FetchLike, url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'text/html' },
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
      throw new Error(`timeout after ${PAGE_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Intégrité de provenance : un item Treasury ne peut revendiquer
 * sourceCode='us_treasury' que pour une URL https:// sur home.treasury.gov
 * dont le chemin identifie un item SOUS /news/press-releases/ (jamais la
 * racine de listing elle-même). Pas de correspondance floue sur les
 * domaines treasury.gov — un hôte comme
 * "home.treasury.gov.evil.example" ou "treasury.gov.evil.example" est
 * rejeté comme externe, jamais accepté par préfixe/suffixe.
 */
function validateTreasuryUrl(href: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(href, LISTING_URL);
  } catch {
    return { ok: false, reason: 'treasury_item_url_invalid' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'treasury_item_url_invalid' };
  }
  if (parsed.hostname.toLowerCase() !== LISTING_HOST) {
    return { ok: false, reason: 'treasury_item_url_external' };
  }
  if (!parsed.pathname.startsWith(LISTING_PATH_PREFIX)) {
    return { ok: false, reason: 'treasury_item_url_wrong_path' };
  }
  // Rien après le préfixe => c'est la racine de listing elle-même, pas un item.
  if (parsed.pathname.length === LISTING_PATH_PREFIX.length) {
    return { ok: false, reason: 'treasury_item_url_wrong_path' };
  }
  return { ok: true, url: parsed.toString() };
}

function processItem(
  block: string,
  ingestRunId: string,
  observedAt: string,
): { observation: RawNewsObservationInput } | { rejected: TreasuryRejectedItem } {
  const headlineMatch = HEADLINE_RE.exec(block);

  // Titre : extrait indépendamment de la présence d'un href, pour ne
  // jamais confondre "titre absent" et "href absent" (deux rejets
  // distincts — voir XAU-V2-NEWS-OFFICIAL-020 §8 tests K et M).
  const rawTitleHtml = headlineMatch ? headlineMatch[2] : null;
  const title = rawTitleHtml !== null ? decodeHtmlEntities(rawTitleHtml).trim() : '';
  if (title.length === 0) {
    return { rejected: { reason: 'treasury_item_title_missing' } };
  }

  const anchorAttrs = headlineMatch ? headlineMatch[1] : '';
  const rawHref = firstGroup(HREF_ATTR_RE.exec(anchorAttrs));
  if (rawHref === null || rawHref.trim().length === 0) {
    return { rejected: { reason: 'treasury_item_url_missing' } };
  }
  const href = decodeHtmlEntities(rawHref).trim();

  const validated = validateTreasuryUrl(href);
  if (!validated.ok) {
    return { rejected: { reason: validated.reason, detail: href } };
  }

  // Fidélité RAW stricte (XAU-V2-NEWS-OFFICIAL-021 §4) : le contenu brut
  // de l'attribut datetime est persisté EXACTEMENT tel qu'extrait — .trim()
  // sert UNIQUEMENT au test de non-vacuité ci-dessous, jamais à la valeur
  // transmise. Aucun décodage d'entités HTML n'est appliqué à cette
  // valeur (contrairement au titre et au href) : le writer RAW est seul
  // responsable de la validation/dégradation du timestamp fournisseur.
  const rawDatetime = firstGroup(TIME_DATETIME_RE.exec(block));
  if (rawDatetime === null || rawDatetime.trim().length === 0) {
    return { rejected: { reason: 'treasury_item_publication_missing' } };
  }
  const providerPublishedRaw = rawDatetime;

  const observation: RawNewsObservationInput = {
    ingestRunId,
    provider: 'us_treasury',
    providerItemId: null,
    sourceCode: 'us_treasury',
    sourceDomain: LISTING_HOST,
    canonicalUrl: validated.url,
    title,
    summary: null,
    content: null,
    providerCategory: 'press_release',
    // precision='timestamp' toujours : Treasury expose un <time
    // datetime="..."> machine réel (preuve live, preflight §2). Ce
    // collecteur ne parse ni ne "corrige" jamais cette chaîne — même si
    // elle est non vide mais malformée, elle est transmise telle quelle
    // (le writer RAW seul décide de la dégrader).
    providerPublishedRaw,
    publicationPrecision: 'timestamp',
    observedAt,
    ingestQualityState: 'VALID',
    ingestQualityReasons: [],
  };

  return { observation };
}

/**
 * Collecte la page de listing Treasury (un seul fetch, aucune
 * pagination). La page est en échec (status='failed') si : HTTP non-2xx,
 * timeout, corps vide, structure de listing Treasury absente, zéro bloc
 * d'item trouvé, OU zéro observation acceptée après analyse (tous les
 * items rejetés) — cette dernière garde est OBLIGATOIRE : une page
 * structurellement valide mais entièrement dégradée ne doit jamais être
 * rapportée comme un succès silencieux (XAU-V2-NEWS-OFFICIAL-020 §9).
 */
export async function collectTreasuryNews(
  options: CollectTreasuryNewsOptions,
): Promise<TreasuryCollectorResult> {
  const fetchImpl: FetchLike = options.fetchFn ?? fetch;

  const observations: RawNewsObservationInput[] = [];
  const rejectedItems: TreasuryRejectedItem[] = [];
  let page: TreasuryPageStatus;

  try {
    const body = await fetchListingBody(fetchImpl, LISTING_URL);

    if (!looksLikeTreasuryListing(body)) {
      throw new Error('malformed page: missing expected Treasury listing structure');
    }

    const itemBlocks = extractItemBlocks(body);
    if (itemBlocks.length === 0) {
      throw new Error('malformed page: zero item blocks found');
    }

    for (const block of itemBlocks) {
      try {
        const result = processItem(block, options.ingestRunId, options.observedAt);
        if ('observation' in result) {
          observations.push(result.observation);
        } else {
          rejectedItems.push(result.rejected);
        }
      } catch {
        rejectedItems.push({ reason: 'treasury_item_parse_failed' });
      }
    }

    if (observations.length === 0) {
      throw new Error(
        `zero accepted observations after parsing (${itemBlocks.length} item(s) rejected)`,
      );
    }

    page = { url: LISTING_URL, status: 'ok', itemsAccepted: observations.length };
  } catch (err) {
    page = {
      url: LISTING_URL,
      status: 'failed',
      itemsAccepted: observations.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { observations, page, rejectedItems };
}
