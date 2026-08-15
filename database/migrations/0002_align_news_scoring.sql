-- =====================================================================
--  ALPHA-XAU INSTITUTIONAL TERMINAL
--  database/migrations/0002_align_news_scoring.sql
--
--  MOTIF : le schéma initial (0001) implémentait une pondération
--  0.30/0.25/0.20/0.15/0.10 sur une échelle [0..1] et 5 niveaux de
--  classification. La MASTER SPECIFICATION (§22, §24) impose :
--
--    News Score = (Macro × 0.30) + (Volatilité × 0.20)
--               + (Fiabilité × 0.15) + (Surprise × 0.20)
--               + (Durée × 0.15)
--
--    Variables sur 0-100. Classification à 3 niveaux :
--      >= 80  CATALYST CRITICAL  -> recalcul H1/H2
--      60-79  MAJOR IMPACT       -> réévaluation H3
--      <  60  MARKET NOISE       -> archivage
--
--  Cette migration fait de la spécification la référence unique.
--  Idempotente, transactionnelle, exécutable sur Supabase.
-- =====================================================================

BEGIN;

SET search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 1. NOUVEAUX TYPES (§25 niveau de risque, §24 action déclenchée)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_level_t') THEN
    CREATE TYPE risk_level_t AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'news_action_t') THEN
    -- Action déterminée par le score, exécutée par le pipeline aval.
    CREATE TYPE news_action_t AS ENUM (
      'RECALC_H1_H2',   -- score >= 80
      'REEVALUATE_H3',  -- score 60-79
      'ARCHIVE_ONLY'    -- score < 60
    );
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. BASCULE DE L'ÉCHELLE DES COMPOSANTES : [0..1] -> [0..100]
--    news_score est une colonne générée : elle doit être supprimée
--    avant de modifier le type de ses dépendances, puis recréée.
-- ---------------------------------------------------------------------
-- La vue dépend de news_score : elle est reconstruite en fin de migration.
DROP VIEW IF EXISTS v_news_high_impact;
DROP INDEX IF EXISTS idx_news_events_high_impact;
ALTER TABLE news_events DROP COLUMN IF EXISTS news_score;

ALTER TABLE news_events
  DROP CONSTRAINT IF EXISTS news_events_macro_score_check,
  DROP CONSTRAINT IF EXISTS news_events_volatility_score_check,
  DROP CONSTRAINT IF EXISTS news_events_reliability_score_check,
  DROP CONSTRAINT IF EXISTS news_events_surprise_score_check,
  DROP CONSTRAINT IF EXISTS news_events_duration_score_check;

-- Conversion des valeurs déjà présentes ([0..1] * 100).
ALTER TABLE news_events
  ALTER COLUMN macro_score       TYPE NUMERIC(6,2) USING round(macro_score       * 100, 2),
  ALTER COLUMN volatility_score  TYPE NUMERIC(6,2) USING round(volatility_score  * 100, 2),
  ALTER COLUMN reliability_score TYPE NUMERIC(6,2) USING round(reliability_score * 100, 2),
  ALTER COLUMN surprise_score    TYPE NUMERIC(6,2) USING round(surprise_score    * 100, 2),
  ALTER COLUMN duration_score    TYPE NUMERIC(6,2) USING round(duration_score    * 100, 2);

ALTER TABLE news_events
  ALTER COLUMN macro_score       SET DEFAULT 0,
  ALTER COLUMN volatility_score  SET DEFAULT 0,
  ALTER COLUMN reliability_score SET DEFAULT 50,
  ALTER COLUMN surprise_score    SET DEFAULT 0,
  ALTER COLUMN duration_score    SET DEFAULT 0;

ALTER TABLE news_events
  ADD CONSTRAINT chk_news_macro_range       CHECK (macro_score       BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_news_volatility_range  CHECK (volatility_score  BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_news_reliability_range CHECK (reliability_score BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_news_surprise_range    CHECK (surprise_score    BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_news_duration_range    CHECK (duration_score    BETWEEN 0 AND 100);

-- ---------------------------------------------------------------------
-- 3. FORMULE DE SCORING — SPEC §22
--    Fonction IMMUTABLE : source unique de la formule, partagée par la
--    colonne générée, le trigger de classification et le backtest.
-- ---------------------------------------------------------------------
-- L'ancienne version avait l'ordre (macro, vol, surprise, reliability,
-- duration) et d'autres pondérations. CREATE OR REPLACE ne peut pas
-- renommer un paramètre : on supprime puis on recrée. La suppression
-- n'est possible qu'après le DROP COLUMN news_score de l'étape 2
-- (la colonne générée créait une dépendance forte).
DROP FUNCTION IF EXISTS fn_news_score(NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC);

CREATE FUNCTION fn_news_score(
  p_macro       NUMERIC,  -- 0-100 : importance économique (§23)
  p_volatility  NUMERIC,  -- 0-100 : capacité à provoquer un mouvement
  p_reliability NUMERIC,  -- 0-100 : fiabilité de la source
  p_surprise    NUMERIC,  -- 0-100 : écart réel vs attentes marché
  p_duration    NUMERIC   -- 0-100 : durée probable de l'impact
) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT round(
    p_macro       * 0.30 +
    p_volatility  * 0.20 +
    p_reliability * 0.15 +
    p_surprise    * 0.20 +
    p_duration    * 0.15
  , 2);
$$;

COMMENT ON FUNCTION fn_news_score IS
  'MASTER SPEC §22. Pondérations figées : toute modification invalide la comparabilité historique des scores et impose une nouvelle model_version.';

-- Recréation de la colonne générée sur la nouvelle formule.
ALTER TABLE news_events
  ADD COLUMN news_score NUMERIC(6,2) GENERATED ALWAYS AS (
    fn_news_score(macro_score, volatility_score, reliability_score,
                  surprise_score, duration_score)
  ) STORED;

COMMENT ON COLUMN news_events.news_score IS
  'Score composite 0-100 (SPEC §22) : macro 30%, volatilité 20%, fiabilité 15%, surprise 20%, durée 15%.';

-- ---------------------------------------------------------------------
-- 4. COLONNES SPEC §25 / §26 / §64
--    Traçabilité du raisonnement : canal de transmission, durée,
--    facteurs annulants, hypothèses assumées, qualité de la donnée.
-- ---------------------------------------------------------------------
ALTER TABLE news_events
  ADD COLUMN IF NOT EXISTS action        news_action_t NOT NULL DEFAULT 'ARCHIVE_ONLY',
  ADD COLUMN IF NOT EXISTS risk_level    risk_level_t,
  -- {"channel":"Risk -> Safe Haven -> Gold","duration":"short_term",
  --  "cancelling_factors":["real yield spike"]}  (§26)
  ADD COLUMN IF NOT EXISTS transmission  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Hypothèses explicites du scoring. SPEC §2.2 : ne jamais inventer une
  -- donnée, séparer faits et hypothèses.
  ADD COLUMN IF NOT EXISTS assumptions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Fraîcheur + complétude + fiabilité source (§64).
  ADD COLUMN IF NOT EXISTS quality_score NUMERIC(6,2) NOT NULL DEFAULT 100
    CHECK (quality_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS ingest_run_id UUID;

COMMENT ON COLUMN news_events.assumptions IS
  'SPEC §2.2 : liste des variables estimées faute de donnée réelle (ex. surprise sans consensus publié).';

-- ---------------------------------------------------------------------
-- 5. CLASSIFICATION — SPEC §24 (3 niveaux)
--    'minor' et 'moderate' restent dans l'ENUM (un type ne peut pas
--    perdre une valeur) mais ne sont plus produits par le moteur.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_news_classify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  -- Dans un trigger BEFORE, les colonnes générées ne sont pas encore
  -- calculées : NEW.news_score est NULL. On recalcule via fn_news_score.
  v_score NUMERIC := fn_news_score(
    NEW.macro_score, NEW.volatility_score, NEW.reliability_score,
    NEW.surprise_score, NEW.duration_score
  );
BEGIN
  -- 'noise' = défaut : on ne dérive que si le news_engine n'a pas
  -- imposé explicitement une classification.
  IF NEW.classification = 'noise' THEN
    NEW.classification := CASE
      WHEN v_score >= 80 THEN 'critical'   -- CATALYST CRITICAL
      WHEN v_score >= 60 THEN 'major'      -- MAJOR IMPACT
      ELSE 'noise'                         -- MARKET NOISE
    END::news_class_t;
  END IF;

  -- Action aval déduite du score (§24). Jamais laissée à l'appelant :
  -- une seule source de vérité pour le routage du pipeline.
  NEW.action := CASE
    WHEN v_score >= 80 THEN 'RECALC_H1_H2'
    WHEN v_score >= 60 THEN 'REEVALUATE_H3'
    ELSE 'ARCHIVE_ONLY'
  END::news_action_t;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. OBSERVABILITÉ DE L'INGESTION (§62, §100)
--    Sans journal d''exécution, une source morte passe inaperçue.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_runs (
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

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_started
  ON ingestion_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_failed
  ON ingestion_runs (started_at DESC)
  WHERE status IN ('failed', 'partial');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_news_events_ingest_run'
  ) THEN
    ALTER TABLE news_events
      ADD CONSTRAINT fk_news_events_ingest_run
      FOREIGN KEY (ingest_run_id) REFERENCES ingestion_runs (id) ON DELETE SET NULL;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 7. INDEX ALIGNÉS SUR LES NOUVEAUX SEUILS
-- ---------------------------------------------------------------------
-- Requête chaude du terminal : catalyseurs des dernières 24h.
CREATE INDEX idx_news_events_high_impact
  ON news_events (ts DESC, news_score DESC)
  WHERE classification IN ('major', 'critical');

-- File de travail du moteur IA : news exigeant un recalcul.
CREATE INDEX IF NOT EXISTS idx_news_events_action
  ON news_events (action, ts DESC)
  WHERE action <> 'ARCHIVE_ONLY';

CREATE INDEX IF NOT EXISTS idx_news_events_risk_level
  ON news_events (risk_level, ts DESC)
  WHERE risk_level IN ('HIGH', 'CRITICAL');

-- ---------------------------------------------------------------------
-- 8. RÉFÉRENTIEL SOURCES : échelle 0-100 + fiabilités SPEC §23
--    Institutionnelles 95-100 / reconnues 70-90 / secondaires 40-70.
-- ---------------------------------------------------------------------
ALTER TABLE data_sources
  DROP CONSTRAINT IF EXISTS data_sources_reliability_score_check;

ALTER TABLE data_sources
  ALTER COLUMN reliability_score TYPE NUMERIC(6,2)
    USING round(reliability_score * 100, 2),
  ALTER COLUMN reliability_score SET DEFAULT 50;

ALTER TABLE data_sources
  ADD CONSTRAINT chk_data_sources_reliability
    CHECK (reliability_score BETWEEN 0 AND 100);

-- Agrégateurs utilisés par ingest.ts. Un article conserve la fiabilité
-- de son ÉDITEUR (domain), pas celle de l'agrégateur qui l'a transporté.
INSERT INTO data_sources (code, provider_name, base_url, domain, reliability_score, is_news_source) VALUES
  ('newsapi', 'NewsAPI.org', 'https://newsapi.org/v2', 'newsapi.org', 60.00, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO data_sources (code, provider_name, base_url, domain, reliability_score, is_news_source) VALUES
  ('ap',            'Associated Press',              NULL, 'apnews.com',       95.00, true),
  ('afp',           'Agence France-Presse',          NULL, 'afp.com',          93.00, true),
  ('ft',            'Financial Times',               NULL, 'ft.com',           92.00, true),
  ('wsj',           'The Wall Street Journal',       NULL, 'wsj.com',          92.00, true),
  ('cnbc',          'CNBC',                          NULL, 'cnbc.com',         82.00, true),
  ('marketwatch',   'MarketWatch',                   NULL, 'marketwatch.com',  78.00, true),
  ('kitco',         'Kitco News',                    NULL, 'kitco.com',        75.00, true),
  ('investing_com', 'Investing.com',                 NULL, 'investing.com',    70.00, true),
  ('bis',           'Bank for International Settlements', 'https://www.bis.org', 'bis.org', 98.00, true),
  ('imf',           'International Monetary Fund',   'https://www.imf.org', 'imf.org', 98.00, true),
  ('boj',           'Bank of Japan',                 'https://www.boj.or.jp', 'boj.or.jp', 100.00, true),
  ('boe',           'Bank of England',               'https://www.bankofengland.co.uk', 'bankofengland.co.uk', 100.00, true),
  ('snb',           'Swiss National Bank',           'https://www.snb.ch', 'snb.ch', 100.00, true),
  ('pboc',          'People''s Bank of China',       'http://www.pbc.gov.cn', 'pbc.gov.cn', 95.00, true),
  ('us_treasury',   'US Department of the Treasury', 'https://home.treasury.gov', 'treasury.gov', 100.00, true),
  ('bea',           'US Bureau of Economic Analysis','https://www.bea.gov', 'bea.gov', 100.00, true),
  ('eia',           'US Energy Information Administration', 'https://www.eia.gov', 'eia.gov', 98.00, true),
  ('wgc',           'World Gold Council',            'https://www.gold.org', 'gold.org', 90.00, true),
  ('cftc',          'Commodity Futures Trading Commission', 'https://www.cftc.gov', 'cftc.gov', 100.00, true),
  ('unknown_source','Unclassified publisher',        NULL, NULL, 40.00, true)
ON CONFLICT (code) DO NOTHING;

-- Réalignement des fiabilités du seed initial sur le barème §23.
UPDATE data_sources SET reliability_score = 100.00 WHERE code IN ('federalreserve', 'bls', 'ecb', 'fred');
UPDATE data_sources SET reliability_score =  95.00 WHERE code IN ('reuters', 'bloomberg');
UPDATE data_sources SET reliability_score =  70.00 WHERE code = 'gdelt';

-- ---------------------------------------------------------------------
-- 9. RLS SUR LES NOUVEAUX OBJETS
-- ---------------------------------------------------------------------
ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_ingestion_runs_read ON ingestion_runs;
CREATE POLICY p_ingestion_runs_read
  ON ingestion_runs FOR SELECT TO authenticated USING (true);

GRANT SELECT ON ingestion_runs TO authenticated;
GRANT ALL    ON ingestion_runs TO service_role;

-- ---------------------------------------------------------------------
-- 10. VUE DE ROUTAGE — consommée par ai_engine
--     Les news exigeant une action, non encore traitées.
-- ---------------------------------------------------------------------
-- Reconstruction de la vue supprimée à l'étape 2, enrichie des colonnes
-- de transmission et de qualité.
CREATE VIEW v_news_high_impact AS
SELECT id, title, source, source_url, category, region, sentiment,
       news_score, classification, action, gold_direction_impact,
       risk_level, transmission, expected_move_usd, quality_score, ts
FROM news_events
WHERE classification IN ('major', 'critical')
  AND ts > now() - INTERVAL '48 hours'
ORDER BY ts DESC;

GRANT SELECT ON v_news_high_impact TO anon, authenticated, service_role;

CREATE OR REPLACE VIEW v_news_actionable AS
SELECT
  n.id, n.title, n.source, n.source_url, n.category, n.region,
  n.sentiment, n.news_score, n.classification, n.action,
  n.gold_direction_impact, n.risk_level, n.transmission,
  n.assumptions, n.quality_score, n.ts
FROM news_events n
WHERE n.action <> 'ARCHIVE_ONLY'
  AND n.ts > now() - INTERVAL '24 hours'
ORDER BY n.news_score DESC, n.ts DESC;

GRANT SELECT ON v_news_actionable TO authenticated, service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION POST-MIGRATION
--   SELECT fn_news_score(100, 90, 100, 80, 70);  -- attendu : 89.50
-- =====================================================================
