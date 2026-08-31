-- =====================================================================
--  ALPHA-XAU INSTITUTIONAL TERMINAL
--  database/schema.sql
--  Cible : PostgreSQL 14+ / Supabase (testé sur PostgreSQL 16)
--
--  Ordre d'exécution : ce fichier est idempotent-safe sur une base vierge.
--  Exécution : psql -f database/schema.sql  |  Supabase SQL Editor
--
--  Conventions :
--   - Toutes les dates/heures sont en TIMESTAMPTZ (stockage UTC natif).
--   - Les colonnes horaires métier sont nommées *_ts (`timestamp` est un
--     col_name_keyword PostgreSQL : utilisable mais ambigu en projection).
--   - Les scores normalisés sont en NUMERIC [0..1] sauf mention contraire.
--   - Aucun ORM : le schéma est la source de vérité (contraintes en base).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. EXTENSIONS & RÔLES
-- ---------------------------------------------------------------------
-- Supabase héberge les extensions dans le schéma `extensions`.
-- On le crée pour rester exécutable sur un PostgreSQL vanilla.
CREATE SCHEMA IF NOT EXISTS extensions;

-- pgcrypto : digest() pour le hash de déduplication des news.
-- (gen_random_uuid() est natif au core depuis PostgreSQL 13.)
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

SET search_path = public, extensions;

-- Rôles Supabase. Présents nativement sur Supabase, créés ici pour
-- garantir l'exécution des policies RLS sur un PostgreSQL standard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 1. TYPES ÉNUMÉRÉS
--    Les ENUM natifs évitent les tables de lookup pour des domaines
--    fermés et stables, et sont contrôlés à l'écriture par le planner.
-- ---------------------------------------------------------------------
CREATE TYPE asset_type_t AS ENUM (
  'metal', 'fx', 'index', 'bond', 'energy', 'crypto', 'equity', 'volatility'
);

CREATE TYPE timeframe_t AS ENUM (
  'tick', 'm1', 'm5', 'm15', 'm30', 'h1', 'h4', 'd1', 'w1', 'mn1'
);

CREATE TYPE news_category_t AS ENUM (
  'monetary_policy', 'inflation', 'employment', 'growth', 'fiscal',
  'trade', 'geopolitics', 'central_bank_speech', 'energy',
  'financial_stability', 'other'
);

CREATE TYPE region_t AS ENUM (
  'US', 'EU', 'UK', 'CH', 'JP', 'CN', 'RU', 'MENA', 'EM', 'GLOBAL'
);

-- 'minor' et 'moderate' sont conservés pour compatibilité des données
-- historiques mais ne sont PLUS produits : la spécification ne définit que
-- trois paliers (noise / major / critical). Supprimer une valeur d'ENUM
-- exigerait de réécrire la table ; le classificateur, lui, ne les émet plus.
CREATE TYPE news_class_t AS ENUM (
  'noise', 'minor', 'moderate', 'major', 'critical'
);

CREATE TYPE direction_t AS ENUM ('bullish', 'bearish', 'neutral');

CREATE TYPE market_regime_t AS ENUM (
  'risk_on', 'risk_off', 'reflation', 'stagflation', 'disinflation',
  'crisis', 'range_bound', 'trend_bull', 'trend_bear'
);

-- Horizons d'analyse. H1..H5 = 5 scénarios projetés par run du moteur IA.
CREATE TYPE horizon_t AS ENUM ('H1', 'H2', 'H3', 'H4', 'H5');

CREATE TYPE alert_type_t AS ENUM (
  'price', 'volatility', 'spread', 'liquidity', 'news', 'macro',
  'risk', 'model_drift', 'data_quality', 'system'
);

CREATE TYPE severity_t AS ENUM ('info', 'low', 'medium', 'high', 'critical');

CREATE TYPE alert_status_t AS ENUM (
  'pending', 'triggered', 'acknowledged', 'resolved', 'expired', 'suppressed'
);

-- ---------------------------------------------------------------------
-- 2. FONCTIONS UTILITAIRES
-- ---------------------------------------------------------------------
-- Formule de scoring news, isolée en fonction IMMUTABLE : utilisée à la
-- fois par la colonne générée news_score et par le trigger de
-- classification. Une seule définition => zéro divergence possible.
CREATE OR REPLACE FUNCTION fn_news_score(
  p_macro       NUMERIC,  -- 0-100 : importance économique (§23)
  p_volatility  NUMERIC,  -- 0-100 : capacité à provoquer un mouvement
  p_reliability NUMERIC,  -- 0-100 : fiabilité de la source
  p_surprise    NUMERIC,  -- 0-100 : écart réel vs attentes marché
  p_duration    NUMERIC   -- 0-100 : durée probable de l'impact
) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  -- ==================================================================
  -- FORMULE INSTITUTIONNELLE OFFICIELLE (MASTER SPEC §22)
  -- SOURCE DE VÉRITÉ UNIQUE DU SYSTÈME.
  --
  --   Macro 0.30 + Volatilité 0.20 + Fiabilité 0.15
  --                + Surprise 0.20 + Durée 0.15
  --
  -- ÉCHELLE : composantes 0-100, score 0-100.
  -- ORDRE DES PARAMÈTRES : macro, volatilité, FIABILITÉ, SURPRISE, durée.
  --   L'ordre est porteur de sens : fiabilité et surprise ne portent pas
  --   la même pondération (0.15 vs 0.20). Les intervertir décale le score
  --   sans lever la moindre erreur — c'est précisément le défaut corrigé
  --   ici (P1-5). Tout appelant doit respecter cet ordre.
  --
  -- Ce bloc, database/migrations/0002 et backend/news_engine/ingest.ts
  -- doivent rester rigoureusement identiques. Une divergence est un
  -- défaut de conformité, jamais un choix d'implémentation.
  -- ==================================================================
  SELECT round(
    p_macro       * 0.30 +
    p_volatility  * 0.20 +
    p_reliability * 0.15 +
    p_surprise    * 0.20 +
    p_duration    * 0.15
  , 2);
$$;

-- Maintenance automatique de updated_at (audit + cache invalidation front).
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. TABLES DE RÉFÉRENTIEL
--    Normalisation des symboles et des fournisseurs de données :
--    cible des clés étrangères, garantit l'intégrité du market_engine.
-- ---------------------------------------------------------------------
CREATE TABLE instruments (
  symbol          TEXT PRIMARY KEY
                    CHECK (symbol = upper(symbol) AND length(symbol) BETWEEN 2 AND 20),
  display_name    TEXT          NOT NULL,
  asset_type      asset_type_t  NOT NULL,
  quote_currency  CHAR(3)       NOT NULL DEFAULT 'USD',
  tick_size       NUMERIC(12,6) NOT NULL DEFAULT 0.01 CHECK (tick_size > 0),
  price_decimals  SMALLINT      NOT NULL DEFAULT 2
                    CHECK (price_decimals BETWEEN 0 AND 8),
  is_primary      BOOLEAN       NOT NULL DEFAULT false, -- actif principal du terminal
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
COMMENT ON TABLE instruments IS
  'Référentiel des instruments suivis. XAUUSD est l''actif primaire, les autres sont des drivers macro.';

CREATE TABLE data_sources (
  code              TEXT PRIMARY KEY
                      CHECK (code = lower(code)),
  provider_name     TEXT          NOT NULL,
  base_url          TEXT,
  domain            TEXT,              -- news_engine : matching éditeur
  -- Fiabilité par défaut du fournisseur, surchargée au niveau de l'événement.
  reliability_score NUMERIC(4,3)  NOT NULL DEFAULT 0.500
                      CHECK (reliability_score BETWEEN 0 AND 1),
  latency_ms        INTEGER       CHECK (latency_ms IS NULL OR latency_ms >= 0),
  rate_limit_per_min INTEGER      CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min > 0),
  is_market_source  BOOLEAN       NOT NULL DEFAULT false,
  is_news_source    BOOLEAN       NOT NULL DEFAULT false,
  is_active         BOOLEAN       NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
COMMENT ON TABLE data_sources IS
  'Registre des fournisseurs de données. reliability_score alimente le scoring news et le fallback market_engine.';

CREATE TRIGGER trg_instruments_updated_at
  BEFORE UPDATE ON instruments
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_data_sources_updated_at
  BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------
-- 4. MARKET DATA — market_ticks
--    Table time-series à haute cardinalité : partitionnement déclaratif
--    RANGE mensuel sur ts. La clé primaire inclut la clé de partition
--    (contrainte PostgreSQL sur les tables partitionnées).
-- ---------------------------------------------------------------------
CREATE TABLE market_ticks (
  id            UUID          NOT NULL DEFAULT gen_random_uuid(),
  symbol        TEXT          NOT NULL,
  asset_type    asset_type_t  NOT NULL,

  -- Book top-of-book
  bid           NUMERIC(14,5) CHECK (bid IS NULL OR bid > 0),
  ask           NUMERIC(14,5) CHECK (ask IS NULL OR ask > 0),
  -- Spread dérivé : jamais recalculé côté application, jamais désynchronisé.
  spread        NUMERIC(14,5) GENERATED ALWAYS AS (ask - bid) STORED,

  -- OHLCV de la bougie du timeframe considéré
  open          NUMERIC(14,5) CHECK (open IS NULL OR open > 0),
  high          NUMERIC(14,5) CHECK (high IS NULL OR high > 0),
  low           NUMERIC(14,5) CHECK (low  IS NULL OR low  > 0),
  close         NUMERIC(14,5) NOT NULL CHECK (close > 0),
  volume        NUMERIC(20,4) CHECK (volume IS NULL OR volume >= 0),
  timeframe     timeframe_t   NOT NULL DEFAULT 'tick',

  -- Snapshot macro synchrone : évite 5 JOIN temporels à chaque lecture
  -- du terminal. Dénormalisation assumée (pattern institutionnel de
  -- "market context stamping" sur la donnée de prix).
  dxy_value     NUMERIC(10,4) CHECK (dxy_value  IS NULL OR dxy_value > 0),
  us10y_yield   NUMERIC(7,4)  CHECK (us10y_yield IS NULL OR us10y_yield BETWEEN -5 AND 25),
  real_yield    NUMERIC(7,4)  CHECK (real_yield  IS NULL OR real_yield  BETWEEN -10 AND 25),
  vix           NUMERIC(8,4)  CHECK (vix IS NULL OR vix >= 0),
  wti           NUMERIC(10,4) CHECK (wti IS NULL OR wti >= 0),

  source        TEXT          NOT NULL,
  ts            TIMESTAMPTZ   NOT NULL,   -- horodatage marché (UTC)
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(), -- horodatage ingestion

  CONSTRAINT pk_market_ticks PRIMARY KEY (id, ts),

  -- Intégrité du book
  CONSTRAINT chk_market_ticks_book
    CHECK (bid IS NULL OR ask IS NULL OR ask >= bid),
  -- Intégrité OHLC : high/low doivent encadrer open/close/bid/ask
  CONSTRAINT chk_market_ticks_ohlc
    CHECK (
      high IS NULL OR low IS NULL
      OR (high >= low
          AND high >= GREATEST(close, COALESCE(open, close))
          AND low  <= LEAST(close,  COALESCE(open, close)))
    ),
  -- Une bougie agrégée doit porter un OHLC complet ; un tick n'y est pas tenu.
  CONSTRAINT chk_market_ticks_candle_completeness
    CHECK (
      timeframe = 'tick'
      OR (open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL)
    ),
  -- Pas de donnée future : garde-fou contre les horloges désynchronisées
  -- des providers (tolérance 5 min pour le drift NTP).
  CONSTRAINT chk_market_ticks_no_future
    CHECK (ts <= created_at + INTERVAL '5 minutes'),

  CONSTRAINT fk_market_ticks_symbol
    FOREIGN KEY (symbol) REFERENCES instruments (symbol)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_market_ticks_source
    FOREIGN KEY (source) REFERENCES data_sources (code)
    ON UPDATE CASCADE ON DELETE RESTRICT
) PARTITION BY RANGE (ts);

COMMENT ON TABLE market_ticks IS
  'Série temporelle prix + contexte macro. Partitionnée par mois sur ts : purge/archivage par DETACH PARTITION en O(1).';
COMMENT ON COLUMN market_ticks.spread IS
  'Colonne générée (ask - bid). Non insérable.';
COMMENT ON COLUMN market_ticks.real_yield IS
  'Rendement réel US 10Y (TIPS). Driver #1 de la valorisation de l''or.';

-- Unicité fonctionnelle : une seule bougie par (symbole, timeframe, ts, source).
-- Index UNIQUE sur table partitionnée => doit contenir la clé de partition.
CREATE UNIQUE INDEX uq_market_ticks_series
  ON market_ticks (symbol, timeframe, ts, source);

-- Accès terminal temps réel : "dernier prix de X" => Index Only Scan backward.
CREATE INDEX idx_market_ticks_symbol_tf_ts
  ON market_ticks (symbol, timeframe, ts DESC)
  INCLUDE (close, bid, ask);

-- Balayages de plage temporelle multi-symboles. BRIN : ~1000x plus petit
-- qu'un B-tree sur une table insert-only naturellement ordonnée par ts.
CREATE INDEX idx_market_ticks_ts_brin
  ON market_ticks USING BRIN (ts) WITH (pages_per_range = 32);

-- Monitoring de fraîcheur / lag d'ingestion par source.
CREATE INDEX idx_market_ticks_source_created
  ON market_ticks (source, created_at DESC);

-- --- Partitions -------------------------------------------------------
-- Fabrique de partitions mensuelles (appelée par un cron Supabase /
-- un scheduled Worker, un mois d'avance).
CREATE OR REPLACE FUNCTION fn_create_market_ticks_partition(p_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month)::DATE;
  v_end   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::DATE;
  v_name  TEXT := format('market_ticks_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
    RETURN v_name || ' (already exists)';
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF market_ticks FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );
  RETURN v_name || ' (created)';
END;
$$;

-- Partitions courantes + horizon glissant 6 mois.
SELECT fn_create_market_ticks_partition((date_trunc('month', now()) + (n || ' month')::INTERVAL)::DATE)
FROM generate_series(-2, 6) AS n;

-- Filet de sécurité : aucune ingestion ne doit jamais échouer sur un
-- trou de partition. À vider régulièrement (les lignes y sont non triées).
CREATE TABLE market_ticks_default PARTITION OF market_ticks DEFAULT;

-- ---------------------------------------------------------------------
-- 4 BIS. OBSERVABILITÉ DE L'INGESTION — ingestion_runs
--    Correctif fresh-install (NEWS-RAW-002-FIX) : ce contrat existait déjà
--    en production via les migrations 0002 (table) et 0004 (verrou +
--    récupération des verrous abandonnés), mais jamais dans ce fichier —
--    une base vierge ne pouvait donc pas exécuter schema.sql jusqu'au bout
--    dès qu'une FK vers ingestion_runs existait (news_events.ingest_run_id,
--    puis news_articles.ingest_run_id). Reproduit ici à l'identique du
--    contrat live, PAS un second contrat concurrent : toute évolution
--    future de ce contrat doit rester appliquée aux DEUX fichiers (voir
--    migrations 0002/0004 pour l'historique détaillé).
-- ---------------------------------------------------------------------
CREATE TABLE ingestion_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engine            TEXT        NOT NULL DEFAULT 'news_engine',
  trigger_type      TEXT        NOT NULL DEFAULT 'cron'
                      CHECK (trigger_type IN ('cron', 'manual', 'webhook', 'backfill')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  duration_ms       INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status            TEXT        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'success', 'partial', 'failed')),
  fetched_count     INTEGER     NOT NULL DEFAULT 0 CHECK (fetched_count     >= 0),
  rejected_count    INTEGER     NOT NULL DEFAULT 0 CHECK (rejected_count    >= 0),
  duplicate_count   INTEGER     NOT NULL DEFAULT 0 CHECK (duplicate_count   >= 0),
  persisted_count   INTEGER     NOT NULL DEFAULT 0 CHECK (persisted_count   >= 0),
  critical_count    INTEGER     NOT NULL DEFAULT 0 CHECK (critical_count    >= 0),
  major_count       INTEGER     NOT NULL DEFAULT 0 CHECK (major_count       >= 0),
  -- Détail par collecteur : {"gdelt":{"ok":true,"count":112,"retries":1}}
  providers         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  errors            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT chk_ingestion_runs_finish
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);
COMMENT ON COLUMN ingestion_runs.engine IS
  'Moteur émetteur : news_engine | market_engine | ai_committee.';

CREATE INDEX idx_ingestion_runs_started
  ON ingestion_runs (started_at DESC);
CREATE INDEX idx_ingestion_runs_failed
  ON ingestion_runs (started_at DESC)
  WHERE status IN ('failed', 'partial');

-- VERROU D'EXÉCUTION (shared/run_lock.ts) : un seul run actif par moteur.
-- Toute tentative concurrente lève 23505, que le moteur interprète comme
-- ALREADY_RUNNING/SKIPPED, pas comme une erreur.
CREATE UNIQUE INDEX uq_ingestion_runs_active
  ON ingestion_runs (engine)
  WHERE status = 'running';
COMMENT ON INDEX uq_ingestion_runs_active IS
  'Verrou anti-concurrence : un seul run actif par moteur. '
  'Une violation 23505 signifie "run déjà en cours", pas une erreur.';

-- RÉCUPÉRATION DES VERROUS ABANDONNÉS : un Worker tué (timeout plateforme,
-- OOM, redéploiement) laisse une ligne 'running' orpheline qui bloquerait
-- le moteur indéfiniment. Appelée par acquireLock() (shared/run_lock.ts)
-- avant chaque tentative d'acquisition.
CREATE OR REPLACE FUNCTION fn_reclaim_stale_runs(
  p_engine              TEXT,
  p_older_than_minutes  INTEGER DEFAULT 15
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reclaimed INTEGER;
BEGIN
  IF p_older_than_minutes IS NULL OR p_older_than_minutes <= 0 THEN
    RAISE EXCEPTION 'p_older_than_minutes doit être strictement positif';
  END IF;

  UPDATE ingestion_runs
     SET status      = 'failed',
         finished_at = now(),
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::INTEGER * 1000),
         errors      = errors || jsonb_build_array(
                         format('Verrou abandonné récupéré après %s minutes.',
                                p_older_than_minutes))
   WHERE engine = p_engine
     AND status = 'running'
     AND started_at < now() - make_interval(mins => p_older_than_minutes);

  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;
  RETURN v_reclaimed;
END;
$$;
COMMENT ON FUNCTION fn_reclaim_stale_runs IS
  'Libère un verrou laissé par un Worker interrompu. Idempotente.';

REVOKE ALL ON FUNCTION fn_reclaim_stale_runs(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_reclaim_stale_runs(TEXT, INTEGER) TO service_role;

-- Observabilité : dernier run par moteur (parité fresh-install avec
-- migration 0004, NEWS-RAW-002-FIX2). Réservée au service_role et aux
-- utilisateurs authentifiés : l'état d'exploitation interne n'a pas à
-- être public.
CREATE OR REPLACE VIEW v_engine_last_run AS
SELECT DISTINCT ON (engine)
  engine, id AS run_id, trigger_type, status,
  started_at, finished_at, duration_ms,
  fetched_count, rejected_count, persisted_count, duplicate_count,
  providers, errors
FROM ingestion_runs
ORDER BY engine, started_at DESC;

GRANT SELECT ON v_engine_last_run TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. NEWS ENGINE — news_events
--    Scoring multi-facteurs. news_score est calculé EN BASE (colonne
--    générée) : un seul lieu de vérité pour le front, l'IA et les alertes.
-- ---------------------------------------------------------------------
CREATE TABLE news_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                TEXT            NOT NULL CHECK (length(btrim(title)) > 0),
  content              TEXT,
  source               TEXT            NOT NULL,
  source_url           TEXT            CHECK (source_url IS NULL OR source_url ~* '^https?://'),
  category             news_category_t NOT NULL DEFAULT 'other',
  region               region_t        NOT NULL DEFAULT 'GLOBAL',

  -- Tonalité NLP normalisée [-1..+1] (négatif = risk-off).
  sentiment            NUMERIC(4,3)    NOT NULL DEFAULT 0
                         CHECK (sentiment BETWEEN -1 AND 1),
  sentiment_label      TEXT GENERATED ALWAYS AS (
                         CASE
                           WHEN sentiment <= -0.60 THEN 'very_negative'
                           WHEN sentiment <= -0.20 THEN 'negative'
                           WHEN sentiment <   0.20 THEN 'neutral'
                           WHEN sentiment <   0.60 THEN 'positive'
                           ELSE 'very_positive'
                         END
                       ) STORED,

  -- Composantes du score. Toutes normalisées [0..1].
  macro_score          NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (macro_score BETWEEN 0 AND 100),
  volatility_score     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (volatility_score BETWEEN 0 AND 100),

  reliability_score    NUMERIC(6,2) NOT NULL DEFAULT 50 CHECK (reliability_score BETWEEN 0 AND 100),
  surprise_score       NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (surprise_score BETWEEN 0 AND 100),
  duration_score       NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (duration_score BETWEEN 0 AND 100),

  -- Score composite pondéré (0..100). Pondérations figées en base pour
  -- garantir la comparabilité historique des scores (backtest du news_engine).
  news_score           NUMERIC(6,2) GENERATED ALWAYS AS (
                         fn_news_score(macro_score, volatility_score,
                                       reliability_score, surprise_score,
                                       duration_score)
                       ) STORED,

  classification       news_class_t NOT NULL DEFAULT 'noise',
  gold_direction_impact direction_t NOT NULL DEFAULT 'neutral',
  -- Amplitude attendue sur XAUUSD, en USD/oz (signée par direction).
  expected_move_usd    NUMERIC(10,2) CHECK (expected_move_usd IS NULL OR expected_move_usd >= 0),

  ts                   TIMESTAMPTZ NOT NULL,          -- publication (UTC)
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Traçabilité vers le run ayant produit la ligne (parité fresh-install
  -- avec migration 0002 / NEWS-RAW-002-FIX). SET NULL (pas RESTRICT comme
  -- news_articles.ingest_run_id) : news_events est un legacy déjà scoré,
  -- purger un vieux run ne doit pas bloquer sur son historique.
  ingest_run_id        UUID,

  -- Déduplication inter-agrégateurs (le même dépêche arrive par N flux).
  dedup_hash           TEXT GENERATED ALWAYS AS (
                         encode(extensions.digest(lower(btrim(title)), 'sha256'), 'hex')
                       ) STORED,

  CONSTRAINT fk_news_events_source
    FOREIGN KEY (source) REFERENCES data_sources (code)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_news_events_ingest_run
    FOREIGN KEY (ingest_run_id) REFERENCES ingestion_runs (id) ON DELETE SET NULL
);

COMMENT ON TABLE news_events IS
  'Flux news normalisé et scoré. news_score et dedup_hash sont générés en base.';
COMMENT ON COLUMN news_events.news_score IS
  'Score composite 0-100 : macro 30%, volatilité 25%, surprise 20%, fiabilité 15%, durée 10%.';

-- Une seule occurrence d'un titre par fenêtre d'ingestion.
CREATE UNIQUE INDEX uq_news_events_dedup ON news_events (dedup_hash);

-- Flux chronologique du terminal.
CREATE INDEX idx_news_events_ts ON news_events (ts DESC);

-- Requête chaude : "news à fort impact des dernières 24h".
-- Index partiel => ~5% de la table, tient en cache.
CREATE INDEX idx_news_events_high_impact
  ON news_events (ts DESC, news_score DESC)
  WHERE classification IN ('major', 'critical');

CREATE INDEX idx_news_events_category_region ON news_events (category, region, ts DESC);
CREATE INDEX idx_news_events_impact ON news_events (gold_direction_impact, ts DESC);

-- Recherche plein texte (anglais) sur titre + corps.
CREATE INDEX idx_news_events_fts
  ON news_events
  USING GIN (to_tsvector('english', title || ' ' || COALESCE(content, '')));

CREATE TRIGGER trg_news_events_updated_at
  BEFORE UPDATE ON news_events
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Dérivation de la classification depuis news_score si non fournie par
-- le news_engine. Un ENUM ne peut pas être une colonne générée (cast
-- non-immutable), d'où le trigger.
-- ATTENTION : dans un trigger BEFORE, les colonnes générées ne sont pas
-- encore calculées (NEW.news_score est NULL). On recalcule donc le score
-- via fn_news_score() à partir des composantes.
CREATE OR REPLACE FUNCTION fn_news_classify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_score NUMERIC := fn_news_score(
    NEW.macro_score, NEW.volatility_score, NEW.reliability_score,
    NEW.surprise_score, NEW.duration_score
  );
BEGIN
  -- 'noise' = valeur par défaut : on ne dérive que si le news_engine
  -- n'a pas imposé explicitement une classification.
  IF NEW.classification = 'noise' THEN
    -- Trois paliers, conformes à la spécification :
    --   >= 80        CATALYST CRITICAL
    --   60 .. 79.99  MAJOR IMPACT
    --   < 60         MARKET NOISE
    -- La comparaison porte sur v_score DÉJÀ arrondi à 2 décimales par
    -- fn_news_score : 79.995 devient 80.00 et bascule en 'critical' de façon
    -- déterministe, identiquement en SQL et en TypeScript.
    NEW.classification := CASE
      WHEN v_score >= 80 THEN 'critical'
      WHEN v_score >= 60 THEN 'major'
      ELSE 'noise'
    END::news_class_t;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_news_events_classify
  BEFORE INSERT ON news_events
  FOR EACH ROW EXECUTE FUNCTION fn_news_classify();

-- ---------------------------------------------------------------------
-- 5 BIS. NEWS ENGINE V2 — news_articles (couche RAW, append-only)
--    Preuve brute pré-scoring : RAW ARTICLE -> (futur) EVENT CLUSTER ->
--    EVENT VERSION -> EVENT IMPACT -> GOLD TRANSMISSION -> H1-H5 -> COMITÉ.
--    Ne contient AUCUN scoring/classification/direction/magnitude/
--    confidence/H1-H5 : ces propriétés appartiennent au futur EVENT IMPACT,
--    pas à l'article brut. Aucun trigger vers le comité.
-- ---------------------------------------------------------------------
CREATE TABLE news_articles (
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

CREATE UNIQUE INDEX uq_news_articles_observation_hash
  ON news_articles (observation_hash);

-- Indices de provenance amont, PAS des contraintes d'unicité : voir
-- COMMENT ON COLUMN news_articles.observation_hash.
CREATE INDEX idx_news_articles_provider_item
  ON news_articles (provider, provider_item_id)
  WHERE provider_item_id IS NOT NULL;
CREATE INDEX idx_news_articles_provider_url
  ON news_articles (provider, canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX idx_news_articles_published
  ON news_articles (published_at DESC)
  WHERE published_at IS NOT NULL;
CREATE INDEX idx_news_articles_published_date
  ON news_articles (published_date DESC)
  WHERE published_date IS NOT NULL;
CREATE INDEX idx_news_articles_provider_observed
  ON news_articles (provider, observed_at DESC);
CREATE INDEX idx_news_articles_ingest_run
  ON news_articles (ingest_run_id);

COMMENT ON INDEX idx_news_articles_provider_item IS
  'Indice de provenance amont, PAS une contrainte d''unicité : un upstream peut corriger un item sous le même GUID (idempotence réelle = observation_hash).';
COMMENT ON INDEX idx_news_articles_provider_url IS
  'Indice de provenance amont, PAS une contrainte d''unicité (même rationale que idx_news_articles_provider_item).';

-- Protection append-only minimale : bloque tout UPDATE/DELETE, y compris
-- pour service_role (BYPASSRLS dispense des policies RLS, pas des triggers).
-- Une correction upstream s'insère comme une NOUVELLE ligne (nouveau
-- observation_hash), l'ancienne n'est jamais modifiée ni supprimée.
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

CREATE TRIGGER trg_news_articles_append_only
  BEFORE UPDATE OR DELETE ON news_articles
  FOR EACH ROW EXECUTE FUNCTION fn_news_articles_append_only();

-- ---------------------------------------------------------------------
-- 6. AI ENGINE — ai_analyses + ai_scenarios
--    Modèle en-tête / détail. Les 5 scénarios H1..H5 sont des LIGNES,
--    pas des colonnes plates : requêtable, agrégeable, backtestable.
-- ---------------------------------------------------------------------
CREATE TABLE ai_analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version     TEXT           NOT NULL
                      CHECK (model_version ~ '^[a-zA-Z0-9._-]+$'),
  market_regime     market_regime_t NOT NULL,
  regime_confidence NUMERIC(5,4)   NOT NULL DEFAULT 0.5
                      CHECK (regime_confidence BETWEEN 0 AND 1),

  symbol            TEXT           NOT NULL DEFAULT 'XAUUSD',
  spot_reference    NUMERIC(14,5)  NOT NULL CHECK (spot_reference > 0),

  -- Ancrage sur le tick exact ayant servi d'input : reproductibilité
  -- totale du run (audit interne / post-mortem de trade).
  reference_tick_id UUID,
  reference_tick_ts TIMESTAMPTZ,

  summary           TEXT,
  macro_context     JSONB          NOT NULL DEFAULT '{}'::jsonb,
  input_features    JSONB          NOT NULL DEFAULT '{}'::jsonb,
  latency_ms        INTEGER        CHECK (latency_ms IS NULL OR latency_ms >= 0),

  analysis_ts       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  valid_until       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT chk_ai_analyses_validity
    CHECK (valid_until IS NULL OR valid_until > analysis_ts),
  -- Les deux colonnes de la FK composite sont fournies ensemble ou pas du tout.
  CONSTRAINT chk_ai_analyses_tick_pair
    CHECK (num_nonnulls(reference_tick_id, reference_tick_ts) <> 1),

  CONSTRAINT fk_ai_analyses_symbol
    FOREIGN KEY (symbol) REFERENCES instruments (symbol)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  -- FK composite vers la table partitionnée (la PK inclut la clé de partition).
  CONSTRAINT fk_ai_analyses_tick
    FOREIGN KEY (reference_tick_id, reference_tick_ts)
    REFERENCES market_ticks (id, ts)
    ON UPDATE CASCADE ON DELETE SET NULL
);

COMMENT ON TABLE ai_analyses IS
  'En-tête d''un run du moteur IA : régime de marché détecté + contexte. Les scénarios sont dans ai_scenarios.';

CREATE INDEX idx_ai_analyses_ts ON ai_analyses (analysis_ts DESC);
CREATE INDEX idx_ai_analyses_symbol_ts ON ai_analyses (symbol, analysis_ts DESC);
CREATE INDEX idx_ai_analyses_model ON ai_analyses (model_version, analysis_ts DESC);
CREATE INDEX idx_ai_analyses_regime ON ai_analyses (market_regime, analysis_ts DESC);
CREATE INDEX idx_ai_analyses_macro_gin ON ai_analyses USING GIN (macro_context jsonb_path_ops);
-- Analyses encore valides : le terminal ne lit quasiment que celles-là.
-- now() n'est pas IMMUTABLE donc interdit en prédicat d'index : on indexe
-- valid_until pour permettre le filtre par intervalle au runtime.
CREATE INDEX idx_ai_analyses_live
  ON ai_analyses (symbol, valid_until DESC NULLS FIRST, analysis_ts DESC);

CREATE TRIGGER trg_ai_analyses_updated_at
  BEFORE UPDATE ON ai_analyses
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE ai_scenarios (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id    UUID       NOT NULL,
  horizon        horizon_t  NOT NULL,
  -- Fenêtre temporelle réelle du scénario (H1 = 1h, H2 = 4h, ...).
  horizon_window INTERVAL   NOT NULL,

  direction      direction_t   NOT NULL,
  probability    NUMERIC(5,4)  NOT NULL CHECK (probability BETWEEN 0 AND 1),
  target         NUMERIC(14,5) NOT NULL CHECK (target > 0),
  invalidation   NUMERIC(14,5) NOT NULL CHECK (invalidation > 0),
  confidence     NUMERIC(5,4)  NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reasoning      TEXT          NOT NULL CHECK (length(btrim(reasoning)) >= 10),

  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Un seul scénario par horizon et par run.
  CONSTRAINT uq_ai_scenarios_horizon UNIQUE (analysis_id, horizon),
  -- Cohérence géométrique du setup : un scénario haussier ne peut pas
  -- avoir sa cible sous son invalidation.
  CONSTRAINT chk_ai_scenarios_geometry CHECK (
    (direction = 'bullish' AND target > invalidation) OR
    (direction = 'bearish' AND target < invalidation) OR
    (direction = 'neutral')
  ),
  CONSTRAINT fk_ai_scenarios_analysis
    FOREIGN KEY (analysis_id) REFERENCES ai_analyses (id) ON DELETE CASCADE
);

COMMENT ON TABLE ai_scenarios IS
  'Scénarios H1..H5 d''un run. La somme des probabilités d''un run complet (un scénario par valeur de horizon_t) doit valoir 1.';

CREATE INDEX idx_ai_scenarios_analysis ON ai_scenarios (analysis_id, horizon);
CREATE INDEX idx_ai_scenarios_direction ON ai_scenarios (direction, probability DESC);

-- Distribution de probabilité valide : contrainte inter-lignes, donc
-- CONSTRAINT TRIGGER différé (vérifié au COMMIT, pas à chaque INSERT).
CREATE OR REPLACE FUNCTION fn_check_scenario_probability_sum()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_analysis    UUID := COALESCE(NEW.analysis_id, OLD.analysis_id);
  v_count       INTEGER;
  v_sum         NUMERIC;
  v_horizon_ct  INTEGER;
BEGIN
  SELECT count(*), COALESCE(sum(probability), 0)
    INTO v_count, v_sum
    FROM ai_scenarios WHERE analysis_id = v_analysis;

  -- Nombre d'horizons attendu par run complet = cardinalité de horizon_t,
  -- lue dynamiquement plutôt que codée en dur : un ajout futur d'horizon
  -- (ALTER TYPE ... ADD VALUE) n'exige plus de migration sur ce trigger.
  SELECT count(*) INTO v_horizon_ct FROM pg_enum WHERE enumtypid = 'horizon_t'::regtype;

  -- Ce trigger déclenche lui-même le contrôle de somme uniquement quand le
  -- NOMBRE de lignes atteint la cardinalité de horizon_t. La complétude des
  -- horizons (un exemplaire exact de chacun, pas juste le bon compte) est
  -- garantie par la combinaison de contraintes du schéma, pas par ce
  -- trigger : horizon NOT NULL + type horizon_t (ai_scenarios.horizon) +
  -- UNIQUE (analysis_id, horizon) (uq_ai_scenarios_horizon) + ce nombre de
  -- lignes = cardinalité(horizon_t). Un run partiel (v_count < v_horizon_ct)
  -- n'est pas encore contraint par ce trigger.
  IF v_count = v_horizon_ct AND abs(v_sum - 1) > 0.01 THEN
    RAISE EXCEPTION
      'Distribution invalide pour analysis %: somme des probabilités = % (attendu 1.00 +/- 0.01)',
      v_analysis, v_sum;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_ai_scenarios_probability_sum
  AFTER INSERT OR UPDATE OR DELETE ON ai_scenarios
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_scenario_probability_sum();

-- Traçabilité : quelles news ont nourri quelle analyse (explicabilité).
CREATE TABLE ai_analysis_news (
  analysis_id UUID NOT NULL REFERENCES ai_analyses (id) ON DELETE CASCADE,
  news_id     UUID NOT NULL REFERENCES news_events (id) ON DELETE CASCADE,
  weight      NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (weight BETWEEN 0 AND 1),
  PRIMARY KEY (analysis_id, news_id)
);
CREATE INDEX idx_ai_analysis_news_news ON ai_analysis_news (news_id);

COMMENT ON TABLE ai_analysis_news IS
  'Table de jonction : inputs news d''un run IA, pondérés. Support de l''explicabilité front.';

-- ---------------------------------------------------------------------
-- 7. PERFORMANCE — performance_scorecard
--    Évaluation périodique du modèle. Sans cette table, le moteur IA
--    n'est pas auditable et le drift passe inaperçu.
-- ---------------------------------------------------------------------
CREATE TABLE performance_scorecard (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version         TEXT NOT NULL CHECK (model_version ~ '^[a-zA-Z0-9._-]+$'),
  evaluation_window     timeframe_t NOT NULL DEFAULT 'd1',
  horizon               horizon_t,          -- NULL = agrégé tous horizons

  -- Métriques normalisées [0..1]
  prediction_accuracy   NUMERIC(5,4) NOT NULL CHECK (prediction_accuracy   BETWEEN 0 AND 1),
  direction_accuracy    NUMERIC(5,4) NOT NULL CHECK (direction_accuracy    BETWEEN 0 AND 1),
  -- Écart |probabilité annoncée - fréquence réalisée| (0 = parfaitement calibré).
  probability_calibration NUMERIC(5,4) NOT NULL CHECK (probability_calibration BETWEEN 0 AND 1),
  timing_accuracy       NUMERIC(5,4) NOT NULL CHECK (timing_accuracy       BETWEEN 0 AND 1),
  risk_accuracy         NUMERIC(5,4) NOT NULL CHECK (risk_accuracy         BETWEEN 0 AND 1),
  brier_score           NUMERIC(5,4) CHECK (brier_score IS NULL OR brier_score BETWEEN 0 AND 1),
  -- Dérive vs fenêtre précédente : > 0.15 déclenche une alerte model_drift.
  model_drift           NUMERIC(6,4) NOT NULL DEFAULT 0
                          CHECK (model_drift BETWEEN -1 AND 1),

  sample_size           INTEGER NOT NULL CHECK (sample_size >= 0),
  evaluation_date       DATE    NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Une seule scorecard par (modèle, fenêtre, horizon, jour) : réévaluation
  -- idempotente via ON CONFLICT DO UPDATE.
  CONSTRAINT uq_performance_scorecard
    UNIQUE (model_version, evaluation_window, horizon, evaluation_date)
);

COMMENT ON TABLE performance_scorecard IS
  'Scorecard d''évaluation du moteur IA par version/fenêtre/horizon. Source du monitoring de drift.';

CREATE INDEX idx_performance_scorecard_date ON performance_scorecard (evaluation_date DESC);
CREATE INDEX idx_performance_scorecard_model
  ON performance_scorecard (model_version, evaluation_date DESC);
-- Détection de dégradation : index partiel sur les scorecards dégradées.
CREATE INDEX idx_performance_scorecard_drift
  ON performance_scorecard (evaluation_date DESC, model_drift)
  WHERE abs(model_drift) > 0.15;

-- ---------------------------------------------------------------------
-- 8. ALERTS
--    Cycle de vie complet : pending -> triggered -> acknowledged -> resolved.
-- ---------------------------------------------------------------------
CREATE TABLE alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type       alert_type_t  NOT NULL,
  severity         severity_t    NOT NULL DEFAULT 'info',

  -- Condition déclenchante, structurée et rejouable par le moteur d'alertes.
  -- Ex: {"metric":"close","op":"<","value":3200,"symbol":"XAUUSD"}
  "trigger"        JSONB         NOT NULL,
  message          TEXT          NOT NULL CHECK (length(btrim(message)) > 0),
  status           alert_status_t NOT NULL DEFAULT 'pending',

  symbol           TEXT,
  news_id          UUID,
  analysis_id      UUID,
  -- Clé d'anti-spam : une seule alerte active par condition métier.
  dedup_key        TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  triggered_at     TIMESTAMPTZ,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  UUID,                     -- auth.users.id côté Supabase
  resolved_at      TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cohérence de la machine à états.
  CONSTRAINT chk_alerts_lifecycle CHECK (
    (status <> 'triggered'    OR triggered_at    IS NOT NULL) AND
    (status <> 'acknowledged' OR acknowledged_at IS NOT NULL) AND
    (status <> 'resolved'     OR resolved_at     IS NOT NULL)
  ),
  CONSTRAINT chk_alerts_chronology CHECK (
    (triggered_at    IS NULL OR triggered_at    >= created_at) AND
    (acknowledged_at IS NULL OR acknowledged_at >= created_at) AND
    (resolved_at     IS NULL OR resolved_at     >= created_at)
  ),
  CONSTRAINT chk_alerts_trigger_object
    CHECK (jsonb_typeof("trigger") = 'object'),

  CONSTRAINT fk_alerts_symbol
    FOREIGN KEY (symbol) REFERENCES instruments (symbol)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_alerts_news
    FOREIGN KEY (news_id) REFERENCES news_events (id) ON DELETE SET NULL,
  CONSTRAINT fk_alerts_analysis
    FOREIGN KEY (analysis_id) REFERENCES ai_analyses (id) ON DELETE SET NULL
);

COMMENT ON TABLE alerts IS
  'Alertes du terminal, tous moteurs confondus. La colonne trigger stocke la condition rejouable.';

-- File de travail du dispatcher : index partiel sur les alertes ouvertes.
CREATE INDEX idx_alerts_open
  ON alerts (severity DESC, created_at DESC)
  WHERE status IN ('pending', 'triggered');

CREATE INDEX idx_alerts_created ON alerts (created_at DESC);
CREATE INDEX idx_alerts_type_status ON alerts (alert_type, status, created_at DESC);
CREATE INDEX idx_alerts_symbol ON alerts (symbol, created_at DESC) WHERE symbol IS NOT NULL;
CREATE INDEX idx_alerts_trigger_gin ON alerts USING GIN ("trigger" jsonb_path_ops);

-- Anti-doublon : une seule alerte vivante par dedup_key.
CREATE UNIQUE INDEX uq_alerts_active_dedup
  ON alerts (dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('pending', 'triggered', 'acknowledged');

CREATE TRIGGER trg_alerts_updated_at
  BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------
-- 9. VUES DE LECTURE (consommées par le frontend via PostgREST)
-- ---------------------------------------------------------------------
-- Dernier prix connu par instrument.
CREATE VIEW v_market_latest AS
SELECT DISTINCT ON (symbol)
  symbol, asset_type, bid, ask, spread, close, volume, timeframe,
  dxy_value, us10y_yield, real_yield, vix, wti, source, ts,
  EXTRACT(EPOCH FROM (now() - ts))::INTEGER AS staleness_seconds
FROM market_ticks
ORDER BY symbol, ts DESC;

COMMENT ON VIEW v_market_latest IS
  'Dernier tick par instrument + indicateur de fraîcheur pour le badge LIVE/STALE du terminal.';

-- Dernière analyse valide par instrument, scénarios agrégés en JSON.
CREATE VIEW v_ai_latest AS
SELECT
  a.id, a.symbol, a.model_version, a.market_regime, a.regime_confidence,
  a.spot_reference, a.summary, a.analysis_ts, a.valid_until,
  COALESCE(
    jsonb_object_agg(
      s.horizon,
      jsonb_build_object(
        'direction',    s.direction,
        'probability',  s.probability,
        'target',       s.target,
        'invalidation', s.invalidation,
        'confidence',   s.confidence,
        'reasoning',    s.reasoning
      )
    ) FILTER (WHERE s.id IS NOT NULL),
    '{}'::jsonb
  ) AS scenarios
FROM ai_analyses a
LEFT JOIN ai_scenarios s ON s.analysis_id = a.id
WHERE a.valid_until IS NULL OR a.valid_until > now()
GROUP BY a.id;

-- Flux news à impact élevé sur 48h.
CREATE VIEW v_news_high_impact AS
SELECT id, title, source, source_url, category, region, sentiment,
       news_score, classification, gold_direction_impact, expected_move_usd, ts
FROM news_events
WHERE classification IN ('major', 'critical')
  AND ts > now() - INTERVAL '48 hours'
ORDER BY ts DESC;

-- ---------------------------------------------------------------------
-- 10. ROW LEVEL SECURITY (Supabase)
--     Modèle : lecture publique sur la donnée de marché/analyse,
--     écriture réservée au service_role (workers backend).
--     service_role est BYPASSRLS : aucune policy d'écriture n'est requise.
-- ---------------------------------------------------------------------
ALTER TABLE instruments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sources          ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_ticks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_articles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analyses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_scenarios          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analysis_news      ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_scorecard ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts                ENABLE ROW LEVEL SECURITY;

-- Lecture publique (terminal en GitHub Pages, clé anon).
CREATE POLICY p_instruments_read   ON instruments      FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY p_market_ticks_read  ON market_ticks     FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY p_news_events_read   ON news_events      FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY p_ai_analyses_read   ON ai_analyses      FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY p_ai_scenarios_read  ON ai_scenarios     FOR SELECT TO anon, authenticated USING (true);

-- Données internes : réservées aux utilisateurs authentifiés.
CREATE POLICY p_data_sources_read  ON data_sources          FOR SELECT TO authenticated USING (true);
CREATE POLICY p_ingestion_runs_read ON ingestion_runs       FOR SELECT TO authenticated USING (true);
CREATE POLICY p_ai_news_read       ON ai_analysis_news      FOR SELECT TO authenticated USING (true);
CREATE POLICY p_perf_read          ON performance_scorecard FOR SELECT TO authenticated USING (true);
CREATE POLICY p_alerts_read        ON alerts                FOR SELECT TO authenticated USING (true);

-- Seul acte d'écriture autorisé au client : acquitter une alerte.
CREATE POLICY p_alerts_acknowledge ON alerts
  FOR UPDATE TO authenticated
  USING (status IN ('pending', 'triggered'))
  WITH CHECK (status = 'acknowledged');

-- Privilèges de base (PostgREST applique ensuite les policies).
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT UPDATE ON alerts TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- news_articles : surcharge des privilèges par défaut ci-dessus. Couche de
-- preuve brute, non vetted pour consommation directe (contrairement à
-- news_events) : aucun accès client, écriture backend seule, jamais
-- UPDATE/DELETE (append-only — voir aussi trg_news_articles_append_only).
REVOKE ALL ON news_articles FROM anon, authenticated;
REVOKE ALL ON news_articles FROM service_role;
GRANT SELECT, INSERT ON news_articles TO service_role;

-- ---------------------------------------------------------------------
-- 11. SEED RÉFÉRENTIEL
--     Instruments et fournisseurs réellement exploités par le terminal.
-- ---------------------------------------------------------------------
INSERT INTO instruments (symbol, display_name, asset_type, quote_currency, tick_size, price_decimals, is_primary) VALUES
  ('XAUUSD', 'Gold Spot / US Dollar',        'metal',      'USD', 0.01,   2, true),
  ('XAGUSD', 'Silver Spot / US Dollar',      'metal',      'USD', 0.001,  3, false),
  ('DXY',    'US Dollar Index',              'index',      'USD', 0.001,  3, false),
  ('US10Y',  'US Treasury 10Y Yield',        'bond',       'USD', 0.001,  3, false),
  ('US10YR', 'US 10Y Real Yield (TIPS)',     'bond',       'USD', 0.001,  3, false),
  ('VIX',    'CBOE Volatility Index',        'volatility', 'USD', 0.01,   2, false),
  ('WTI',    'WTI Crude Oil',                'energy',     'USD', 0.01,   2, false),
  ('EURUSD', 'Euro / US Dollar',             'fx',         'USD', 0.00001,5, false),
  ('USDJPY', 'US Dollar / Japanese Yen',     'fx',         'JPY', 0.001,  3, false),
  ('BTCUSD', 'Bitcoin / US Dollar',          'crypto',     'USD', 0.01,   2, false);

INSERT INTO data_sources (code, provider_name, base_url, domain, reliability_score, is_market_source, is_news_source) VALUES
  ('fred',          'Federal Reserve Economic Data', 'https://api.stlouisfed.org/fred', 'stlouisfed.org', 0.990, true,  false),
  ('stooq',         'Stooq',                          'https://stooq.com/q/l/',          'stooq.com',      0.850, true,  false),
  ('yahoo_finance', 'Yahoo Finance',                  'https://query1.finance.yahoo.com','finance.yahoo.com', 0.800, true, false),
  ('twelve_data',   'Twelve Data',                    'https://api.twelvedata.com',      'twelvedata.com', 0.880, true,  false),
  ('finnhub',       'Finnhub',                        'https://finnhub.io/api/v1',       'finnhub.io',     0.870, true,  true),
  ('gdelt',         'GDELT Project',                  'https://api.gdeltproject.org',    'gdeltproject.org',0.700, false, true),
  ('reuters',       'Reuters',                        NULL,                              'reuters.com',    0.950, false, true),
  ('bloomberg',     'Bloomberg',                      NULL,                              'bloomberg.com',  0.950, false, true),
  ('federalreserve','Board of Governors of the Fed',  'https://www.federalreserve.gov',  'federalreserve.gov', 1.000, false, true),
  ('bls',           'US Bureau of Labor Statistics',  'https://api.bls.gov',             'bls.gov',        1.000, false, true),
  ('ecb',           'European Central Bank',          'https://data.ecb.europa.eu',      'ecb.europa.eu',  1.000, false, true);

COMMIT;

-- =====================================================================
-- FIN DU SCHÉMA
-- Maintenance recommandée (cron Supabase / scheduled Worker) :
--   SELECT fn_create_market_ticks_partition((now() + interval '2 month')::date);
--   ALTER TABLE market_ticks DETACH PARTITION market_ticks_YYYY_MM;  -- archivage
-- =====================================================================
