-- =====================================================================
--  ALPHA-XAU — database/migrations/0007_legacy_scenarios_non_tradable.sql
--
--  PHASE 12 — traitement des scénarios antérieurs à la migration 0006.
--
--  PROBLÈME. La migration 0006 a rempli activation_condition des scénarios
--  existants avec un marqueur 'LEGACY: ...'. Ce marqueur fait 88 caractères :
--  il franchit donc le CHECK >= 15 et le garde-fou du frontend, et s'affiche
--  au trader exactement comme une condition d'activation réelle. C'est le
--  défaut le plus dangereux possible sur ce champ.
--
--  OPTIONS EXAMINÉES
--    A. Archiver / masquer  -> rejeté : détruit la traçabilité historique,
--       dont la calibration et l'audit ont besoin.
--    C. Migrer avec une vraie condition -> IMPOSSIBLE sans inventer. La
--       condition n'a jamais été capturée ; aucune donnée ne permet de la
--       reconstituer. Fabriquer un déclencheur serait une hallucination.
--    B. RETENUE — marquer explicitement NON TRADABLE. Le scénario reste
--       lisible et auditable, mais le système le désigne comme
--       non exploitable, et le frontend refuse de l'afficher comme un plan.
--
--  MÉCANISME. Colonne GÉNÉRÉE : la qualification ne peut pas diverger de la
--  donnée, ni être oubliée par un écrivain, ni falsifiée par un appelant.
--
--  PRÉREQUIS : migration 0006. IDEMPOTENTE.
-- =====================================================================

BEGIN;

ALTER TABLE ai_scenarios
  ADD COLUMN IF NOT EXISTS is_tradable BOOLEAN
    GENERATED ALWAYS AS (activation_condition NOT LIKE 'LEGACY:%') STORED;

COMMENT ON COLUMN ai_scenarios.is_tradable IS
  'FALSE pour les scénarios dont la condition d''activation n''a jamais été '
  'enregistrée (antérieurs à 0006). Colonne générée : ne peut ni diverger '
  'de la donnée ni être falsifiée. Le frontend doit refuser de présenter un '
  'scénario is_tradable = FALSE comme un plan exploitable.';

CREATE INDEX IF NOT EXISTS idx_ai_scenarios_non_tradable
  ON ai_scenarios (analysis_id)
  WHERE is_tradable = FALSE;

-- Exposition dans le contrat frontend.
DROP VIEW IF EXISTS v_ai_latest;

CREATE VIEW v_ai_latest AS
SELECT DISTINCT ON (a.symbol)
  a.id, a.symbol, a.model_version, a.market_regime, a.regime_confidence,
  a.spot_reference, a.summary, a.analysis_ts, a.valid_until,
  a.risk_verdict, a.execution_status, a.overall_bias, a.confidence_cap,
  a.data_quality, a.rejection_reasons,
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
          'is_tradable',          s.is_tradable,
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
ORDER BY a.symbol, a.analysis_ts DESC, a.id DESC;

GRANT SELECT ON v_ai_latest TO anon, authenticated, service_role;

COMMIT;

-- =====================================================================
-- VÉRIFICATION
--   SELECT is_tradable, count(*) FROM ai_scenarios GROUP BY 1;
--   SELECT scenarios -> 'H1' ->> 'is_tradable' FROM v_ai_latest;
-- =====================================================================
