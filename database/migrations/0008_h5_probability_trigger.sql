-- =====================================================================
--  ALPHA-XAU — database/migrations/0008_h5_probability_trigger.sql
--
--  CONTEXTE. Le runtime (committee_orchestrator.ts) émet désormais 5
--  scénarios par analyse (H1..H5) au lieu de 4. Constaté sur la DB live :
--    - horizon_t contient déjà H1,H2,H3,H4,H5 (ajouté hors migration
--      trackée — ce script ne le retouche PAS pour ne rien supposer sur
--      la manière dont H5 y a été ajouté ; IF NOT EXISTS le rend inerte
--      si c'est déjà le cas, et applicable si un autre environnement n'a
--      jamais reçu cet ajout).
--    - fn_check_scenario_probability_sum() teste encore `v_count = 4` :
--      avec 5 lignes par run, ce nombre n'est plus jamais atteint, donc
--      le garde-fou de somme (probabilités doivent totaliser 1.00) ne se
--      déclenche PLUS DU TOUT. Aucune ligne n'est corrompue par ce bug —
--      c'est un contrôle qui a cessé de contrôler, pas une donnée fausse.
--
--  PORTÉE. Uniquement le nombre d'horizons attendu par le trigger, lu
--  dynamiquement depuis la cardinalité de horizon_t au lieu d'une valeur
--  4 codée en dur. Un futur ajout d'horizon (ALTER TYPE ... ADD VALUE)
--  n'exigera plus de migration sur ce trigger.
--
--  CE QUE CE TRIGGER DÉCLENCHE. Il déclenche lui-même le contrôle de somme
--  uniquement lorsque count(*) pour l'analyse = cardinalité(horizon_t) —
--  c'est-à-dire quand le NOMBRE de lignes atteint le nombre d'horizons
--  possibles. La COMPLÉTUDE des horizons (un exemplaire exact de chacun,
--  pas seulement le bon compte) n'est pas garantie par ce trigger seul,
--  mais par la combinaison de contraintes déjà en place sur ai_scenarios :
--  horizon NOT NULL + type horizon_t + UNIQUE (analysis_id, horizon)
--  (uq_ai_scenarios_horizon) + ce nombre de lignes = cardinalité(horizon_t).
--  Ensemble, elles garantissent qu'un compte égal à la cardinalité
--  correspond nécessairement à exactement un exemplaire de chaque horizon.
--  Le comportement des runs PARTIELS (count < cardinalité) reste inchangé :
--  ce trigger ne valide pas encore la somme dans ce cas.
--
--  DONNÉES. ai_analyses = 0 ligne, ai_scenarios = 0 ligne au moment de
--  cette migration (vérifié en lecture seule) : aucun backfill nécessaire,
--  aucune ligne existante à risque.
--
--  APPEND-ONLY. Ne modifie ni ne supprime aucune migration antérieure.
--  IDEMPOTENTE : ADD VALUE IF NOT EXISTS + CREATE OR REPLACE FUNCTION —
--  rejouable sans effet si déjà appliquée.
--
--  PRÉREQUIS : migrations 0001-0007.
-- =====================================================================

BEGIN;

-- Inerte si H5 est déjà présent (cas de la DB live actuelle) ; applique
-- l'ajout sur tout environnement où horizon_t serait encore H1..H4 seul
-- (ex. DB recréée depuis une ancienne version de schema.sql non à jour).
ALTER TYPE horizon_t ADD VALUE IF NOT EXISTS 'H5';

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
  -- lue dynamiquement plutôt que codée en dur (ancienne valeur : 4).
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

COMMENT ON TABLE ai_scenarios IS
  'Scénarios H1..H5 d''un run. La somme des probabilités d''un run complet (un scénario par valeur de horizon_t) doit valoir 1.';

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application)
--   SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
--     WHERE t.typname = 'horizon_t' ORDER BY e.enumsortorder;
--   -- attendu : H1, H2, H3, H4, H5
--
--   SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--     WHERE p.proname = 'fn_check_scenario_probability_sum';
--   -- attendu : référence v_horizon_ct au lieu du littéral 4
-- =====================================================================
