-- =====================================================================
--  ALPHA-XAU — database/migrations/0006_committee_contract.sql
--
--  Ferme P1-1, P1-2, P1-3, P1-4 et P1-6 côté base.
--
--  P1-2  Le verdict du comité et le statut d'exécution deviennent des
--        COLONNES TYPÉES, plus un fragment de JSON. Une analyse rejetée
--        est désormais persistable et devient la plus récente.
--  P1-3  DATA_INSUFFICIENT et CONFLICT entrent dans l'énumération, à
--        égalité avec REJECTED — jamais repliés sur lui.
--  P1-4  activation_condition devient obligatoire sur chaque scénario.
--  P1-6  overall_bias est produit par le Portfolio Manager et stocké ;
--        il n'a plus à être reconstitué par un consommateur.
--
--  PRÉREQUIS : schema.sql, migrations 0002 à 0005.
--  IDEMPOTENTE : réexécutable sans effet de bord.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ÉNUMÉRATIONS DU CONTRAT (P1-3)
--
--    DATA_INSUFFICIENT et CONFLICT sont des causes DISTINCTES de
--    REJECTED. Les confondre rendrait la calibration aveugle : un rejet
--    pour données manquantes se corrige en réparant une source, un rejet
--    pour conflit inter-agents se corrige en révisant des prompts. Ce ne
--    sont pas les mêmes incidents.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_verdict_t') THEN
    CREATE TYPE risk_verdict_t AS ENUM (
      'APPROVED',
      'APPROVED_WITH_CONDITIONS',
      'REJECTED',
      'DATA_INSUFFICIENT',
      'CONFLICT'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'execution_status_t') THEN
    CREATE TYPE execution_status_t AS ENUM ('VALID_SETUP', 'NO_VALID_SETUP');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. ai_analyses — COLONNES DU CONTRAT (P1-1, P1-2, P1-6)
-- ---------------------------------------------------------------------
ALTER TABLE ai_analyses
  ADD COLUMN IF NOT EXISTS risk_verdict      risk_verdict_t,
  ADD COLUMN IF NOT EXISTS execution_status  execution_status_t,
  ADD COLUMN IF NOT EXISTS overall_bias      direction_t,
  ADD COLUMN IF NOT EXISTS confidence_cap    NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS data_quality      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Reprise des analyses antérieures : la valeur est LUE dans macro_context
-- lorsqu'elle y figure, sinon laissée NULL. On ne fabrique aucun verdict
-- rétroactif — une analyse dont le verdict n'a pas été enregistré doit
-- rester identifiable comme telle.
UPDATE ai_analyses
   SET risk_verdict = CASE
         WHEN macro_context ->> 'risk_verdict' IN
              ('APPROVED','APPROVED_WITH_CONDITIONS','REJECTED','DATA_INSUFFICIENT','CONFLICT')
         THEN (macro_context ->> 'risk_verdict')::risk_verdict_t
         ELSE NULL END,
       execution_status = CASE
         WHEN macro_context ->> 'execution_status' IN ('VALID_SETUP','NO_VALID_SETUP')
         THEN (macro_context ->> 'execution_status')::execution_status_t
         ELSE NULL END
 WHERE risk_verdict IS NULL AND execution_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_analyses_confidence_cap') THEN
    EXECUTE 'ALTER TABLE ai_analyses ADD CONSTRAINT chk_ai_analyses_confidence_cap CHECK (confidence_cap IS NULL OR confidence_cap BETWEEN 0 AND 1)';
  END IF;
END;
$$;

-- Un rejet doit être motivé. Sans cela, la persistance d'un rejet
-- n'apporterait aucune information exploitable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_analyses_rejection_motivated') THEN
    EXECUTE 'ALTER TABLE ai_analyses ADD CONSTRAINT chk_ai_analyses_rejection_motivated CHECK (risk_verdict IS NULL OR risk_verdict NOT IN (''REJECTED'',''DATA_INSUFFICIENT'',''CONFLICT'') OR jsonb_array_length(rejection_reasons) > 0)';
  END IF;
END;
$$;

-- Cohérence verdict / statut : un verdict bloquant ne peut pas
-- coexister avec un setup déclaré valide.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_analyses_verdict_status') THEN
    EXECUTE 'ALTER TABLE ai_analyses ADD CONSTRAINT chk_ai_analyses_verdict_status CHECK (risk_verdict IS NULL OR execution_status IS NULL OR NOT (risk_verdict IN (''REJECTED'',''DATA_INSUFFICIENT'',''CONFLICT'') AND execution_status = ''VALID_SETUP''))';
  END IF;
END;
$$;

-- Un setup invalide ne peut pas porter un biais directionnel : afficher
-- « haussier » sur une analyse rejetée serait le pire défaut possible.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_analyses_bias_neutral_when_invalid') THEN
    EXECUTE 'ALTER TABLE ai_analyses ADD CONSTRAINT chk_ai_analyses_bias_neutral_when_invalid CHECK (execution_status IS DISTINCT FROM ''NO_VALID_SETUP'' OR overall_bias IS NULL OR overall_bias = ''neutral'')';
  END IF;
END;
$$;

COMMENT ON COLUMN ai_analyses.risk_verdict IS
  'Verdict du Risk Committee. DATA_INSUFFICIENT et CONFLICT sont des '
  'causes distinctes de REJECTED et ne doivent jamais y être repliées.';
COMMENT ON COLUMN ai_analyses.overall_bias IS
  'Biais produit par le Portfolio Manager sous contrainte du Risk '
  'Committee. Aucun consommateur ne doit le recalculer (P1-6).';

CREATE INDEX IF NOT EXISTS idx_ai_analyses_symbol_ts
  ON ai_analyses (symbol, analysis_ts DESC);

-- ---------------------------------------------------------------------
-- 3. ai_scenarios — CONDITION D'ACTIVATION (P1-4)
--
--    Une cible et une invalidation disent OÙ va le scénario et où il
--    meurt. Elles ne disent pas QUAND il commence à exister. Sans cette
--    troisième borne, un scénario est une opinion, pas un plan.
-- ---------------------------------------------------------------------
ALTER TABLE ai_scenarios
  ADD COLUMN IF NOT EXISTS activation_condition TEXT;

-- Reprise des scénarios antérieurs : marqueur de provenance explicite.
-- Ce n'est PAS une condition fabriquée — c'est la déclaration que la
-- donnée n'a pas été capturée, et elle reste distinguable à la lecture.
UPDATE ai_scenarios
   SET activation_condition =
       'LEGACY: condition d''activation non enregistrée (analyse antérieure à la migration 0006).'
 WHERE activation_condition IS NULL;

-- L'UPDATE ci-dessus arme le CONSTRAINT TRIGGER DEFERRED de somme des
-- probabilités. PostgreSQL refuse un ALTER TABLE tant que des événements
-- de trigger sont en attente : on les force à s'exécuter maintenant.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE ai_scenarios
  ALTER COLUMN activation_condition SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_scenarios_activation_substantive') THEN
    EXECUTE 'ALTER TABLE ai_scenarios ADD CONSTRAINT chk_ai_scenarios_activation_substantive CHECK (length(btrim(activation_condition)) >= 15)';
  END IF;
END;
$$;

COMMENT ON COLUMN ai_scenarios.activation_condition IS
  'Condition de déclenchement du scénario (§34). Obligatoire : un '
  'scénario n''est pas exploitable du seul fait qu''il porte une cible '
  'et une invalidation.';

-- ---------------------------------------------------------------------
-- 4. v_ai_latest — VUE DU CONTRAT FRONTEND (P1-1, P1-2, P1-6)
--
--    DISTINCT ON (symbol) : la vue ne retourne QUE l'analyse la plus
--    récente. C'est le mécanisme unique qui garantit qu'une analyse
--    rejetée efface l'affichage d'une analyse approuvée antérieure —
--    aucune colonne `is_current` redondante n'est introduite, le
--    couple (analysis_ts, valid_until) suffit.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_ai_latest;

CREATE VIEW v_ai_latest AS
SELECT DISTINCT ON (a.symbol)
  a.id, a.symbol, a.model_version, a.market_regime, a.regime_confidence,
  a.spot_reference, a.summary, a.analysis_ts, a.valid_until,
  a.risk_verdict, a.execution_status, a.overall_bias, a.confidence_cap,
  a.data_quality, a.rejection_reasons,
  -- Exposition explicite des listes produites par le Portfolio Manager.
  COALESCE(a.macro_context -> 'drivers',       '[]'::jsonb) AS drivers,
  COALESCE(a.macro_context -> 'risks',         '[]'::jsonb) AS risks,
  COALESCE(a.macro_context -> 'invalidations', '[]'::jsonb) AS invalidations,
  COALESCE(
    (
      SELECT jsonb_object_agg(
        s.horizon,
        jsonb_build_object(
          'direction',            s.direction,
          'probability',          s.probability,
          'target',               s.target,
          'invalidation',         s.invalidation,
          'activation_condition', s.activation_condition,
          'confidence',           s.confidence,
          'reasoning',            s.reasoning
        )
      )
      FROM ai_scenarios s
      WHERE s.analysis_id = a.id
    ),
    '{}'::jsonb
  ) AS scenarios
FROM ai_analyses a
WHERE a.valid_until IS NULL OR a.valid_until > now()
-- Départage déterministe : deux analyses ne peuvent pas partager le même
-- analysis_ts en production (le verrou du comité sérialise les runs), mais
-- un ordre ambigu dans une vue est un défaut latent. `id DESC` le lève.
ORDER BY a.symbol, a.analysis_ts DESC, a.id DESC;

COMMENT ON VIEW v_ai_latest IS
  'Analyse courante par instrument. DISTINCT ON garantit qu''une '
  'analyse rejetée supplante immédiatement toute analyse approuvée '
  'antérieure (P1-2).';

GRANT SELECT ON v_ai_latest TO anon, authenticated, service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION POST-MIGRATION
--   SELECT risk_verdict, execution_status, overall_bias FROM v_ai_latest;
--   SELECT scenarios -> 'H1' ->> 'activation_condition' FROM v_ai_latest;
-- =====================================================================
