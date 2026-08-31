-- =====================================================================
--  ALPHA-XAU — database/migrations/0009_news_articles_raw_layer.sql
--
--  OBJET : socle DB de la couche RAW ARTICLE du News/Event Engine V2
--  (design NEWS-RAW-CONTRACT-001, corrections NEWS-RAW-002).
--
--  CONTEXTE. Le pipeline actuel (backend/ingest.ts) écrit directement dans
--  news_events, une table déjà SCORÉE (news_score généré, classification
--  déclenchée) : il n'existe aucune couche "preuve brute" pré-scoring.
--  Les futures sources primaires (fed, ecb, treasury, ofac) ne doivent PAS
--  être branchées sur l'ancien scoring automatique (scoreArticle ->
--  CRITICAL/MAJOR/NOISE -> dispatchActions -> comité) : ce modèle est
--  legacy et ne sera pas l'autorité du News Engine V2.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - news_events, ingestion_runs, data_sources (schéma inchangé) ;
--    - le pipeline GDELT/NewsAPI (aucun code backend touché ici) ;
--    - aucun scoring, classification, direction, magnitude, confidence,
--      pricing, H1-H5, temporal reach — ces propriétés appartiennent au
--      futur EVENT IMPACT, jamais à l'article brut.
--
--  CHAÎNE CIBLE (non implémentée au-delà de cette table) :
--    RAW ARTICLE -> EVENT CLUSTER -> EVENT VERSION -> EVENT IMPACT ->
--    GOLD TRANSMISSION -> H1-H5 -> COMITÉ.
--
--  IDEMPOTENCE. NE PAS mettre de UNIQUE sur (provider, provider_item_id) ni
--  sur (provider, canonical_url) : un upstream peut corriger un item sous
--  le même GUID/URL, et cette nouvelle version doit survivre. L'identité
--  forte est observation_hash (sha256 déterministe de l'observation reçue,
--  PAS de l'événement) : un re-poll exact du même contenu peut être
--  ignoré en conflit ; un contenu modifié sous le même GUID produit un
--  hash différent et une NOUVELLE ligne.
--
--  APPEND-ONLY. Trigger BEFORE UPDATE OR DELETE qui lève systématiquement
--  une exception — y compris pour service_role (BYPASSRLS dispense des
--  policies RLS, pas des triggers). Une correction upstream s'insère
--  comme une NOUVELLE ligne, jamais comme une modification de l'existante.
--
--  PORTÉE. CREATE TABLE + index + trigger + RLS/privilèges. Aucune
--  modification d'une table existante. Aucun backfill (news_events
--  compte 0 ligne au moment de cette migration).
--
--  APPEND-ONLY (fichier) : ne modifie ni ne supprime aucune migration
--  antérieure. IDEMPOTENTE : IF NOT EXISTS / CREATE OR REPLACE / DROP+
--  CREATE TRIGGER — rejouable sans effet si déjà appliquée.
--
--  PRÉREQUIS : migrations 0001-0008 (ingestion_runs, data_sources).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS news_articles (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT (pas SET NULL comme news_events.ingest_run_id) : cette table
  -- est une preuve brute, sa traçabilité vers le run qui l'a produite ne
  -- doit jamais devenir orpheline.
  ingest_run_id           UUID NOT NULL
                            REFERENCES ingestion_runs (id) ON DELETE RESTRICT,

  -- Collecteur ayant observé l'item (fed, ecb, treasury, ofac, gdelt,
  -- newsapi, ...). TEXT libre et non ENUM : le nombre de providers est
  -- amené à croître sans migration de type. Canonique : minuscules et sans
  -- espaces superflus imposés par CHECK, pour qu'un même provider ne se
  -- fragmente jamais en plusieurs identités ('fed' / 'Fed' / ' fed ').
  provider                TEXT NOT NULL
                            CHECK (
                              length(btrim(provider)) > 0
                              AND provider = lower(provider)
                              AND provider = btrim(provider)
                            ),
  provider_item_id        TEXT,
  -- Éditeur/autorité réelle, résolu comme dans news_events (SourceRegistry).
  -- provider != source_code : voir COMMENT ON COLUMN ci-dessous.
  source_code             TEXT NOT NULL
                            REFERENCES data_sources (code)
                            ON UPDATE CASCADE ON DELETE RESTRICT,
  source_domain           TEXT,
  canonical_url           TEXT,

  title                   TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  summary                 TEXT,
  content                 TEXT,
  provider_category       TEXT,

  -- Précision du timestamp amont : jamais d'heure inventée. Si la source ne
  -- fournit qu'une date (ex. OFAC), published_date seul est renseigné.
  published_at            TIMESTAMPTZ,
  published_date          DATE,
  -- Valeur de publication EXACTE reçue du provider avant normalisation,
  -- ex. "Tue, 25 Aug 2026 18:00:00 GMT", "August 28, 2026". published_at/
  -- published_date restent les représentations normalisées ; ce champ est
  -- la preuve brute qui les a produites (ou non, si non-parsable).
  provider_published_raw  TEXT,

  observed_at             TIMESTAMPTZ NOT NULL,
  ingested_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  ingest_quality_state    TEXT NOT NULL DEFAULT 'VALID'
                            CHECK (ingest_quality_state IN ('VALID', 'DEGRADED', 'UNVERIFIED')),
  ingest_quality_reasons  TEXT[] NOT NULL DEFAULT '{}',

  -- Empreinte déterministe de L'OBSERVATION reçue (pas de l'événement réel).
  -- Volontairement PAS de UNIQUE sur (provider, provider_item_id) ni sur
  -- (provider, canonical_url) : un upstream peut corriger un item sous le
  -- même GUID/URL, et cette nouvelle version doit survivre comme une
  -- NOUVELLE ligne. Seule cette empreinte porte la contrainte d'unicité
  -- forte (voir uq_news_articles_observation_hash) : un re-poll exact du
  -- même contenu ET de la même publication raw produit le même hash
  -- (conflit/ignore possible côté appli) ; un contenu modifié OU une
  -- correction de publication upstream sous le même GUID produit un hash
  -- différent (nouvelle ligne conservée). Inclut source_domain et
  -- provider_published_raw (texte brut) : ce sont des données de
  -- provenance/observation, PAS published_at/published_date qui sont des
  -- représentations normalisées et n'entrent jamais dans l'empreinte.
  -- extensions.digest/encode : mêmes fonctions IMMUTABLE que
  -- news_events.dedup_hash (pgcrypto), autorisées en GENERATED COLUMN.
  observation_hash TEXT GENERATED ALWAYS AS (
    encode(
      extensions.digest(
        provider || chr(31) ||
        COALESCE(provider_item_id, '') || chr(31) ||
        COALESCE(source_domain, '') || chr(31) ||
        COALESCE(canonical_url, '') || chr(31) ||
        source_code || chr(31) ||
        title || chr(31) ||
        COALESCE(summary, '') || chr(31) ||
        COALESCE(content, '') || chr(31) ||
        COALESCE(provider_category, '') || chr(31) ||
        COALESCE(provider_published_raw, ''),
        'sha256'
      ),
      'hex'
    )
  ) STORED,

  CONSTRAINT chk_news_articles_published_exclusive
    CHECK (published_at IS NULL OR published_date IS NULL),
  CONSTRAINT chk_news_articles_published_raw_present
    CHECK (
      (published_at IS NULL AND published_date IS NULL)
      OR provider_published_raw IS NOT NULL
    ),
  CONSTRAINT chk_news_articles_provider_published_raw_not_blank
    CHECK (
      provider_published_raw IS NULL
      OR length(btrim(provider_published_raw)) > 0
    ),
  CONSTRAINT chk_news_articles_identity_present
    CHECK (provider_item_id IS NOT NULL OR canonical_url IS NOT NULL),
  CONSTRAINT chk_news_articles_provider_item_id_not_blank
    CHECK (provider_item_id IS NULL OR length(btrim(provider_item_id)) > 0),
  CONSTRAINT chk_news_articles_canonical_url_not_blank
    CHECK (canonical_url IS NULL OR length(btrim(canonical_url)) > 0),
  CONSTRAINT chk_news_articles_canonical_url_scheme
    CHECK (canonical_url IS NULL OR canonical_url ~* '^https?://')
);

COMMENT ON TABLE news_articles IS
  'Couche RAW ARTICLE (News/Event Engine V2), append-only, pré-scoring. Une ligne par OBSERVATION (voir observation_hash), pas par événement réel — la déduplication événementielle (novelty/confirmation/reversal) appartient au futur EVENT CLUSTER.';
COMMENT ON COLUMN news_articles.provider IS
  'Collecteur ayant observé l''item. provider indique COMMENT l''item a été observé ; source_code indique QUI l''a publié.';
COMMENT ON COLUMN news_articles.source_code IS
  'Éditeur/autorité réelle (data_sources.code). provider et source_code distincts sont des SIGNAUX DE PROVENANCE, PAS une preuve d''indépendance éditoriale : deux publishers différents peuvent avoir recopié la même dépêche. La détermination INDEPENDENT / SYNDICATED / UNKNOWN appartient au futur EVENT CLUSTER, pas à cette table.';
COMMENT ON COLUMN news_articles.observation_hash IS
  'Empreinte sha256 déterministe de l''observation reçue (provider, identifiants amont, domaine source, source, titre, corps, catégorie, publication brute) — PAS de l''événement réel, et PAS des timestamps normalisés (published_at/published_date n''entrent jamais dans le hash). Un contenu, un domaine source OU une publication upstream modifiée sous le même GUID/URL produit un hash différent : la nouvelle version est conservée comme une NOUVELLE ligne, l''ancienne n''est jamais modifiée.';
COMMENT ON COLUMN news_articles.published_at IS
  'Horodatage de publication si la source fournit une heure fiable. Mutuellement exclusif avec published_date (chk_news_articles_published_exclusive) : jamais les deux, jamais inventé.';
COMMENT ON COLUMN news_articles.published_date IS
  'Date de publication si la source ne fournit qu''une date (ex. OFAC). Mutuellement exclusif avec published_at.';
COMMENT ON COLUMN news_articles.provider_published_raw IS
  'Valeur de publication EXACTE reçue du provider avant normalisation (ex. "Tue, 25 Aug 2026 18:00:00 GMT"). Obligatoire dès que published_at OU published_date est renseigné (chk_news_articles_published_raw_present) ; entre dans observation_hash, contrairement à published_at/published_date qui sont des représentations dérivées.';
COMMENT ON COLUMN news_articles.observed_at IS
  'Heure réelle à laquelle le collecteur a observé l''item — distincte de published_at/published_date ET de ingested_at.';
COMMENT ON COLUMN news_articles.ingested_at IS
  'Heure de persistance en base (peut différer de observed_at en cas de retry/backoff).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_news_articles_observation_hash
  ON news_articles (observation_hash);

-- Indices de provenance amont, PAS des contraintes d'unicité : voir
-- COMMENT ON COLUMN news_articles.observation_hash.
CREATE INDEX IF NOT EXISTS idx_news_articles_provider_item
  ON news_articles (provider, provider_item_id)
  WHERE provider_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_articles_provider_url
  ON news_articles (provider, canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_articles_published
  ON news_articles (published_at DESC)
  WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_articles_published_date
  ON news_articles (published_date DESC)
  WHERE published_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_articles_provider_observed
  ON news_articles (provider, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_ingest_run
  ON news_articles (ingest_run_id);

COMMENT ON INDEX idx_news_articles_provider_item IS
  'Indice de provenance amont, PAS une contrainte d''unicité : un upstream peut corriger un item sous le même GUID (idempotence réelle = observation_hash).';
COMMENT ON INDEX idx_news_articles_provider_url IS
  'Indice de provenance amont, PAS une contrainte d''unicité (même rationale que idx_news_articles_provider_item).';

-- ---------------------------------------------------------------------
-- APPEND-ONLY : bloque tout UPDATE/DELETE, y compris pour service_role
-- (BYPASSRLS dispense des policies RLS, pas des triggers). Une correction
-- upstream s'insère comme une NOUVELLE ligne (nouveau observation_hash),
-- l'ancienne n'est jamais modifiée ni supprimée.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_news_articles_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'news_articles est append-only : % interdit. Une correction upstream doit être insérée comme une NOUVELLE ligne, jamais comme une modification de la ligne existante.',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_news_articles_append_only ON news_articles;
CREATE TRIGGER trg_news_articles_append_only
  BEFORE UPDATE OR DELETE ON news_articles
  FOR EACH ROW EXECUTE FUNCTION fn_news_articles_append_only();

-- ---------------------------------------------------------------------
-- RLS / PRIVILÈGES : couche de preuve brute, non vetted pour consommation
-- directe (contrairement à news_events). Aucun accès client, écriture
-- backend seule, jamais UPDATE/DELETE.
-- ---------------------------------------------------------------------
ALTER TABLE news_articles ENABLE ROW LEVEL SECURITY;

-- Pas de policy = deny-all pour anon/authenticated (ni l'un ni l'autre
-- n'est BYPASSRLS). REVOKE explicite en défense en profondeur, au cas où
-- un GRANT ALL ON ALL TABLES antérieur se serait déjà appliqué.
REVOKE ALL ON news_articles FROM anon, authenticated;

-- service_role : SELECT + INSERT uniquement, jamais UPDATE/DELETE.
REVOKE ALL ON news_articles FROM service_role;
GRANT SELECT, INSERT ON news_articles TO service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application)
--   \d news_articles
--   SELECT indexname FROM pg_indexes WHERE tablename = 'news_articles';
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'news_articles'::regclass;
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'news_articles';
--   -- attendu service_role : SELECT, INSERT uniquement (pas UPDATE/DELETE)
--   -- attendu anon/authenticated : aucune ligne
-- =====================================================================
