/**
 * =============================================================================
 *  ALPHA-XAU — backend/news_sources/ofac.ts
 *
 *  Collecteur RAW officiel : Office of Foreign Assets Control — Recent
 *  Actions (https://ofac.treasury.gov/recent-actions). Transforme les
 *  items HTML server-rendered en RawNewsObservationInput
 *  (backend/shared/raw_news.ts) — AUCUNE persistance, AUCUN scoring,
 *  AUCUNE notification comité, AUCUNE logique Event Cluster ici.
 *
 *  Même approche architecturale que backend/news_sources/federal_reserve.ts,
 *  ecb.ts et us_treasury.ts (délibérément dupliquée, pas factorisée :
 *  chaque collecteur officiel reste autonome et lisible isolément).
 *
 *  V1 SCOPE (XAU-V2-NEWS-OFFICIAL-019/022) :
 *    - UN SEUL fetch de la page de listing par invocation ;
 *    - aucune pagination (page 0 uniquement, ~10 items les plus récents,
 *      largement suffisant face à la cadence réelle de publication OFAC
 *      et à la cadence de cron de 15 min — preflight §OFAC_PAGINATION :
 *      aucun recouvrement entre page 0 et page 1) ;
 *    - aucun fetch de page de détail par item ;
 *    - aucun flux RSS (aucun n'est annoncé par la page) ;
 *    - aucun retry ;
 *    - aucune nouvelle dépendance npm.
 *
 *  PRÉCISION DE PUBLICATION : contrairement à Treasury, OFAC n'expose
 *  qu'une date calendaire visible ("September 04, 2026"), sans heure du
 *  jour (preflight §OFAC_DATE_FORMATS). Ce collecteur transmet donc
 *  TOUJOURS publicationPrecision='date' et le texte visible exact, et ne
 *  parse/valide/normalise JAMAIS cette chaîne lui-même (aucun appel de
 *  parsing de date, aucune construction d'objet date, aucun dérivé du
 *  segment YYYYMMDD de l'URL) — le writer RAW (raw_news.ts) reste seul
 *  responsable de la validation/dégradation.
 *
 *  CATÉGORIE : providerCategory préserve le libellé visible exact tel
 *  qu'exposé par la page ("Sanctions List Updates", "General Licenses",
 *  "Enforcement Actions", ...) — jamais de mapping vers un enum interne,
 *  jamais de mise en minuscule, jamais de catégorie inventée (preflight
 *  §OFAC_CATEGORIES_OBSERVED / §5).
 *
 *  NON-BUTS explicites (identiques à federal_reserve.ts / ecb.ts /
 *  us_treasury.ts) :
 *    - pas de fenêtre lookback ;
 *    - pas de retry/backoff ici ;
 *    - pas de fetch de page article : content reste toujours null ;
 *    - pas de correction/parsing de date ou de catégorie malformée ;
 *    - pas d'identifiant natif synthétique (providerItemId reste NULL :
 *      le segment YYYYMMDD de l'URL n'est pas un identifiant indépendant
 *      de la date — l'extraire comme id reviendrait à le synthétiser à
 *      partir de la date, explicitement interdit).
 * =============================================================================
 */

import type { RawNewsObservationInput } from '../shared/raw_news.js';

export interface OfacPageStatus {
  readonly url: string;
  readonly status: 'ok' | 'failed';
  readonly itemsAccepted: number;
  readonly error?: string;
}

export interface OfacRejectedItem {
  readonly reason: string;
  readonly detail?: string;
}

export interface OfacCollectorResult {
  readonly observations: readonly RawNewsObservationInput[];
  readonly page: OfacPageStatus;
  readonly rejectedItems: readonly OfacRejectedItem[];
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

export interface CollectOfacNewsOptions {
  readonly ingestRunId: string;
  readonly observedAt: string;
  readonly fetchFn?: FetchLike;
}

const PAGE_TIMEOUT_MS = 15_000;
const LISTING_URL = 'https://ofac.treasury.gov/recent-actions';
const LISTING_HOST = 'ofac.treasury.gov';

/** Décodage en UNE passe : évite tout risque de double-décodage (ex.
 *  "&amp;lt;" ne doit jamais redevenir "<"). Mêmes entités que
 *  federal_reserve.ts / ecb.ts / us_treasury.ts : cinq entités nommées
 *  XML/HTML de base plus les formes numériques décimale et hexadécimale. */
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

/** Extrait la valeur d'un groupe de capture à guillemets alternatifs
 *  (double, simple), ou null si aucun groupe n'a matché. */
function firstGroup(m: RegExpExecArray | null): string | null {
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

const DIV_OPEN_RE = /<div\b([^>]*)>/g;
const CLASS_ATTR_RE = /\bclass=(?:"([^"]*)"|'([^']*)')/i;

/** Vérifie la présence des DEUX jetons de classe complets requis,
 *  indépendamment de l'ordre ou de jetons additionnels. Un
 *  sous-mot-ressemblant ("not-search-result", "views-row-extra") n'est
 *  JAMAIS confondu avec le jeton exact : comparaison par jeton entier
 *  après split sur whitespace, jamais par sous-chaîne. */
function hasResultContainerClasses(classAttrValue: string): boolean {
  const tokens = classAttrValue.trim().split(/\s+/);
  return tokens.includes('search-result') && tokens.includes('views-row');
}

/**
 * Localise le DÉBUT de chaque conteneur de résultat OFAC (une balise
 * <div ...> dont l'attribut class contient les DEUX jetons complets
 * "search-result" et "views-row"). Un seul niveau, pas de motif
 * imbriqué — PAS un parseur HTML générique.
 */
function findResultContainerStarts(html: string): number[] {
  const starts: number[] = [];
  DIV_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIV_OPEN_RE.exec(html)) !== null) {
    const classMatch = CLASS_ATTR_RE.exec(m[1]);
    const classValue = classMatch ? (classMatch[1] ?? classMatch[2] ?? '') : '';
    if (hasResultContainerClasses(classValue)) {
      starts.push(m.index);
    }
  }
  return starts;
}

const DIV_TOKEN_RE = /<\/?div\b[^>]*>/g;

interface ContainerScanResult {
  readonly end: number;
  /** true UNIQUEMENT quand la profondeur retombe génuinement à 0 —
   *  jamais quand le scan s'est arrêté sur la barrière de sécurité ou en
   *  fin de document (XAU-V2-NEWS-OFFICIAL-024 §3). */
  readonly closed: boolean;
}

/**
 * Trouve la fin RÉELLE du conteneur de résultat démarrant à
 * `containerStart`, par comptage de profondeur des balises <div>/</div>
 * rencontrées (scanner de profondeur étroit, PAS un parseur HTML
 * générique) — jamais par un simple "jusqu'au prochain conteneur" (voir
 * XAU-V2-NEWS-OFFICIAL-023 §2/§3) : ce dernier motif laissait le DERNIER
 * item déborder jusqu'à `html.length`, capable d'absorber des ancres de
 * page totalement étrangères (ex. "Filter by Category") si son propre
 * conteneur était malformé.
 *
 * La profondeur démarre à 0 ; la balise d'ouverture du conteneur
 * lui-même (à `containerStart`) l'amène à 1 ; chaque <div> ouvrant
 * l'incrémente, chaque </div> la décrémente ; la fin réelle du
 * conteneur est le point où la profondeur retombe à 0 — c'est le SEUL
 * cas où `closed` vaut true.
 *
 * Barrière de sécurité : si le prochain conteneur de résultat
 * (`boundaryLimit`) est atteint avant que la profondeur ne retombe à 0,
 * OU si la fin du document est atteinte en premier (HTML de fournisseur
 * mal formé / non balancé), le scan s'arrête à cette barrière — la
 * région candidate reste retournée (bornée, pour diagnostic/isolation),
 * MAIS `closed=false` : XAU-V2-NEWS-OFFICIAL-024 exige que cette région
 * ne soit JAMAIS transmise à processItem() comme candidate valide, quel
 * que soit son contenu apparent — l'intégrité structurelle est un
 * prérequis à l'acceptation, pas seulement l'absence de débordement
 * inter-item.
 */
function findContainerEnd(html: string, containerStart: number, boundaryLimit: number): ContainerScanResult {
  DIV_TOKEN_RE.lastIndex = containerStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = DIV_TOKEN_RE.exec(html)) !== null) {
    if (m.index >= boundaryLimit) {
      return { end: boundaryLimit, closed: false };
    }
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return { end: m.index + m[0].length, closed: true };
    }
  }
  return { end: boundaryLimit, closed: false };
}

interface OfacItemCandidate {
  readonly block: string;
  readonly closed: boolean;
}

/**
 * Découpage par PROFONDEUR DE DIV, borné dans tous les cas par le
 * prochain conteneur de résultat (ou la fin du document pour le
 * dernier) : aucun item, y compris le dernier de la page, ne peut
 * jamais lire du HTML situé après son propre conteneur
 * search-result/views-row. Chaque candidat porte son statut `closed` :
 * un conteneur non structurellement fermé doit être rejeté explicitement
 * par l'appelant, jamais analysé comme un item normal.
 */
function extractItemBlocks(html: string): OfacItemCandidate[] {
  const starts = findResultContainerStarts(html);
  const candidates: OfacItemCandidate[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const boundaryLimit = i + 1 < starts.length ? starts[i + 1] : html.length;
    const scan = findContainerEnd(html, begin, boundaryLimit);
    candidates.push({ block: html.slice(begin, scan.end), closed: scan.closed });
  }
  return candidates;
}

/** Vérifie la présence de l'ancre structurelle minimale de la page de
 *  listing OFAC, indépendamment du nombre d'items trouvés. */
function looksLikeOfacListing(html: string): boolean {
  return /\bview-content\b/i.test(html);
}

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/;
const HREF_ATTR_RE = /\bhref=(?:"([^"]*)"|'([^']*)')/i;
/** Chemin daté strict : /recent-actions/YYYYMMDD ou .../YYYYMMDD/ —
 *  exactement 8 chiffres décimaux, rien après. Rejette la racine
 *  /recent-actions/, les URLs de catégorie (slugs non numériques), les
 *  chemins OFAC non liés, et les segments à 7 ou 9+ chiffres. */
const DATED_ACTION_PATH_RE = /^\/recent-actions\/\d{8}\/?$/;

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
 * Intégrité de provenance : un item OFAC ne peut revendiquer
 * sourceCode='ofac' que pour une URL https:// sur ofac.treasury.gov dont
 * le chemin identifie EXACTEMENT une Recent Action datée
 * (/recent-actions/YYYYMMDD[/]). Pas de correspondance floue sur les
 * domaines treasury.gov — un hôte comme "ofac.treasury.gov.evil.example"
 * ou "treasury.gov.evil.example" est rejeté comme externe, jamais
 * accepté par préfixe/suffixe.
 */
function validateOfacUrl(href: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(href, LISTING_URL);
  } catch {
    return { ok: false, reason: 'ofac_item_url_invalid' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ofac_item_url_invalid' };
  }
  if (parsed.hostname.toLowerCase() !== LISTING_HOST) {
    return { ok: false, reason: 'ofac_item_url_external' };
  }
  if (!DATED_ACTION_PATH_RE.test(parsed.pathname)) {
    return { ok: false, reason: 'ofac_item_url_wrong_path' };
  }
  return { ok: true, url: parsed.toString() };
}

function processItem(
  block: string,
  ingestRunId: string,
  observedAt: string,
): { observation: RawNewsObservationInput } | { rejected: OfacRejectedItem } {
  // Titre + URL : la PREMIÈRE ancre du bloc (structurellement, l'ancre du
  // titre précède toujours le bloc date/catégorie dans la forme OFAC
  // observée). Extrait indépendamment de la présence d'un href, pour ne
  // jamais confondre "titre absent" et "href absent" (même principe que
  // us_treasury.ts).
  const titleAnchorMatch = ANCHOR_RE.exec(block);

  const rawTitleHtml = titleAnchorMatch ? titleAnchorMatch[2] : null;
  const title = rawTitleHtml !== null ? decodeHtmlEntities(rawTitleHtml).trim() : '';
  if (title.length === 0) {
    return { rejected: { reason: 'ofac_item_title_missing' } };
  }

  const anchorAttrs = titleAnchorMatch ? titleAnchorMatch[1] : '';
  const rawHref = firstGroup(HREF_ATTR_RE.exec(anchorAttrs));
  if (rawHref === null || rawHref.trim().length === 0) {
    return { rejected: { reason: 'ofac_item_url_missing' } };
  }
  const href = decodeHtmlEntities(rawHref).trim();

  const validated = validateOfacUrl(href);
  if (!validated.ok) {
    return { rejected: { reason: validated.reason, detail: href } };
  }

  // Région "métadonnées" : tout ce qui suit la fermeture de l'ancre de
  // titre, TOUJOURS bornée par la fin du bloc lui-même (déjà borné par
  // le prochain conteneur de résultat) — la catégorie de l'item suivant
  // ne peut donc jamais être confondue avec celle de l'item courant.
  const metadataStart = titleAnchorMatch ? titleAnchorMatch.index + titleAnchorMatch[0].length : 0;
  const metadataRegion = block.slice(metadataStart);

  // Catégorie : la PREMIÈRE ancre trouvée dans la région métadonnées
  // (jamais l'ancre de titre elle-même, exclue par construction ci-dessus
  // — voir XAU-V2-NEWS-OFFICIAL-022 §8, l'ancre de catégorie ne peut
  // jamais être confondue avec l'ancre d'item daté).
  const categoryAnchorMatch = ANCHOR_RE.exec(metadataRegion);
  const rawCategoryHtml = categoryAnchorMatch ? categoryAnchorMatch[2] : null;
  const category = rawCategoryHtml !== null ? decodeHtmlEntities(rawCategoryHtml).trim() : '';

  // Date : le texte (balises retirées) précédant l'ancre de catégorie
  // (ou toute la région métadonnées si aucune catégorie n'est trouvée),
  // débarrassé du séparateur " - " terminal puis trimé aux seules
  // bordures — AUCUN décodage d'entités, AUCUN parsing, conformément à
  // XAU-V2-NEWS-OFFICIAL-022 §9 (fidélité RAW stricte, comme le
  // datetime Treasury durci en §021).
  const preCategoryRaw = categoryAnchorMatch
    ? metadataRegion.slice(0, categoryAnchorMatch.index)
    : metadataRegion;
  const dateTextNoTags = preCategoryRaw.replace(/<[^>]*>/g, '');
  const providerPublishedRaw = dateTextNoTags.replace(/\s*-\s*$/, '').trim();

  if (providerPublishedRaw.length === 0) {
    return { rejected: { reason: 'ofac_item_publication_missing' } };
  }
  if (category.length === 0) {
    return { rejected: { reason: 'ofac_item_category_missing' } };
  }

  const observation: RawNewsObservationInput = {
    ingestRunId,
    provider: 'ofac',
    providerItemId: null,
    sourceCode: 'ofac',
    sourceDomain: LISTING_HOST,
    canonicalUrl: validated.url,
    title,
    summary: null,
    content: null,
    providerCategory: category,
    providerPublishedRaw,
    publicationPrecision: 'date',
    observedAt,
    ingestQualityState: 'VALID',
    ingestQualityReasons: [],
  };

  return { observation };
}

/**
 * Collecte la page de listing OFAC (un seul fetch, aucune pagination).
 * La page est en échec (status='failed') si : HTTP non-2xx, timeout,
 * corps vide, structure de listing OFAC absente, zéro conteneur de
 * résultat trouvé, OU zéro observation acceptée après analyse (tous les
 * items rejetés) — cette dernière garde est OBLIGATOIRE : une page
 * structurellement valide mais entièrement dégradée ne doit jamais être
 * rapportée comme un succès silencieux.
 */
export async function collectOfacNews(
  options: CollectOfacNewsOptions,
): Promise<OfacCollectorResult> {
  const fetchImpl: FetchLike = options.fetchFn ?? fetch;

  const observations: RawNewsObservationInput[] = [];
  const rejectedItems: OfacRejectedItem[] = [];
  let page: OfacPageStatus;

  try {
    const body = await fetchListingBody(fetchImpl, LISTING_URL);

    if (!looksLikeOfacListing(body)) {
      throw new Error('malformed page: missing expected OFAC listing structure');
    }

    const itemBlocks = extractItemBlocks(body);
    if (itemBlocks.length === 0) {
      throw new Error('malformed page: zero result-container blocks found');
    }

    for (const candidate of itemBlocks) {
      // Une région dont le conteneur n'est pas structurellement fermé
      // n'est JAMAIS transmise à processItem() — l'intégrité structurelle
      // est un prérequis, pas seulement l'absence de débordement
      // inter-item (XAU-V2-NEWS-OFFICIAL-024 §3/§4). Un item ne doit
      // jamais être accepté simplement parce que des chaînes ressemblant
      // à un titre/URL/date/catégorie existent dans sa région bornée.
      if (!candidate.closed) {
        rejectedItems.push({ reason: 'ofac_item_container_unbalanced' });
        continue;
      }
      try {
        const result = processItem(candidate.block, options.ingestRunId, options.observedAt);
        if ('observation' in result) {
          observations.push(result.observation);
        } else {
          rejectedItems.push(result.rejected);
        }
      } catch {
        rejectedItems.push({ reason: 'ofac_item_parse_failed' });
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
