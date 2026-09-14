-- =====================================================================
--  ALPHA-XAU — database/migrations/0013_event_function_search_path_hardening.sql
--
--  OBJET : corrige les alertes Supabase Security Advisor
--  `function_search_path_mutable` introduites par OPS-023 Phase 1
--  (migration 0012), et UNIQUEMENT celles-ci :
--
--    public.fn_event_schema_append_only()
--    public.fn_check_membership_decision_supersession()
--    public.fn_check_event_version_evidence()
--    public.fn_check_cluster_relation_operation_cardinality()
--
--  MOTIF. Ces quatre fonctions ont été créées (migration 0012) sans
--  `search_path` explicite : leur résolution de noms de relations
--  dépendait donc du search_path courant de la session au moment de
--  l'exécution — un search_path mutable/hérité, potentiellement
--  détournable si un objet de même nom existait dans un schéma résolu
--  plus tôt. La recommandation Supabase actuelle est `SET search_path
--  = ''` (vide) avec qualification complète de schéma sur chaque
--  relation référencée.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - la migration 0012 (fichier immuable, historique appliqué —
--      NON modifiée) ;
--    - toute autre fonction préexistante (fn_news_score,
--      fn_reclaim_stale_runs, fn_news_articles_append_only,
--      fn_check_scenario_probability_sum, fn_news_classify, ...) —
--      hors périmètre de cette tâche, même si le Security Advisor
--      les signale également ;
--    - le comportement, les messages d'erreur, la sémantique de
--      transition, les contraintes, les tables, les grants, la RLS ou
--      les triggers existants — CREATE OR REPLACE FUNCTION préserve le
--      même OID de fonction, donc les triggers qui l'appellent
--      (trg_event_clusters_append_only, etc.) restent valides sans
--      recréation ;
--    - le mode SECURITY (aucune des quatre fonctions ne déclarait
--      SECURITY DEFINER dans la migration 0012 : elles restent
--      SECURITY INVOKER par défaut, inchangé ici).
--
--  CHAQUE FONCTION CI-DESSOUS EST UN CREATE OR REPLACE À L'IDENTIQUE DE
--  SA VERSION 0012, avec exactement deux changements :
--    1. ajout de `SET search_path = ''` ;
--    2. qualification de schéma (`public.`) sur chaque référence de
--       relation dans le corps (`extensions.digest(...)` était déjà
--       qualifiée en 0012 et reste inchangée ; `encode(...)` reste
--       non qualifiée : fonction de pg_catalog, toujours résolvable
--       même avec search_path='' — pg_catalog et pg_temp sont
--       implicitement et systématiquement inclus par PostgreSQL, quel
--       que soit le search_path déclaré).
--
--  ADDITIVE / RÉVERSIBLE. Aucune nouvelle table, aucun nouvel index,
--  aucune nouvelle contrainte. Ne pas appliquer cette migration laisse
--  le système exactement dans l'état de la migration 0012 (fonctionnel,
--  seulement moins durci).
--
--  IDEMPOTENTE : CREATE OR REPLACE FUNCTION — rejouable sans effet si
--  déjà appliquée.
--
--  PRÉREQUIS : migration 0012 (définit les quatre fonctions ci-dessous).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. fn_event_schema_append_only()
--    Aucune référence de relation dans le corps (seulement TG_TABLE_NAME
--    / TG_OP, variables de contexte trigger — jamais résolues via le
--    search_path). Ajout de SET search_path = '' uniquement.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_schema_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    '% est append-only (OPS-023) : % interdit. Une correction doit être insérée comme une NOUVELLE ligne, jamais comme une modification de la ligne existante.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. fn_check_membership_decision_supersession()
--    Référence de relation qualifiée : event_observation_memberships
--    -> public.event_observation_memberships.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_membership_decision_supersession()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_predecessor              RECORD;
  v_expected_relation_key    TEXT;
BEGIN
  IF NEW.decision_type = 'ASSIGN' THEN
    IF NEW.supersedes_decision_id IS NOT NULL THEN
      RAISE EXCEPTION
        'ASSIGN % ne peut pas référencer supersedes_decision_id (%) : une ouverture fraîche ne corrige rien — utiliser AMEND/RETRACT pour corriger une décision existante.',
        NEW.decision_id, NEW.supersedes_decision_id;
    END IF;
    RETURN NEW;
  END IF;

  -- Seules valeurs restantes possibles ici : AMEND, RETRACT (garanti par
  -- le CHECK decision_type de la table).
  IF NEW.supersedes_decision_id IS NULL THEN
    RAISE EXCEPTION
      '% % doit référencer la décision qu''elle corrige/clôture : supersedes_decision_id ne peut pas être NULL.',
      NEW.decision_type, NEW.decision_id;
  END IF;

  SELECT observation_id, relation_key
    INTO v_predecessor
    FROM public.event_observation_memberships
    WHERE decision_id = NEW.supersedes_decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '% % référence une décision antérieure introuvable (supersedes_decision_id=%).',
      NEW.decision_type, NEW.decision_id, NEW.supersedes_decision_id;
  END IF;

  IF v_predecessor.observation_id <> NEW.observation_id THEN
    RAISE EXCEPTION
      '% % : la décision antérieure référencée porte sur une observation différente (attendu %, trouvé %) — une correction ne peut porter que sur la MÊME observation.',
      NEW.decision_type, NEW.decision_id, NEW.observation_id, v_predecessor.observation_id;
  END IF;

  v_expected_relation_key := encode(
    extensions.digest(NEW.observation_id::text || chr(31) || NEW.cluster_id::text, 'sha256'),
    'hex'
  );

  IF v_predecessor.relation_key <> v_expected_relation_key THEN
    RAISE EXCEPTION
      '% % : la décision antérieure référencée porte sur une relation logique différente (relation_key antérieure %, relation_key attendue %) — une correction ne peut porter que sur la MÊME relation (observation, cluster).',
      NEW.decision_type, NEW.decision_id, v_predecessor.relation_key, v_expected_relation_key;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. fn_check_event_version_evidence()
--    Références de relation qualifiées : event_versions ->
--    public.event_versions ; event_observation_memberships ->
--    public.event_observation_memberships.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_event_version_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_version_cluster_id   UUID;
  v_membership           RECORD;
BEGIN
  SELECT cluster_id
    INTO v_version_cluster_id
    FROM public.event_versions
    WHERE id = NEW.event_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'event_version_evidence : event_version_id % introuvable.',
      NEW.event_version_id;
  END IF;

  SELECT cluster_id, decision_type
    INTO v_membership
    FROM public.event_observation_memberships
    WHERE decision_id = NEW.decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'event_version_evidence : decision_id % introuvable.',
      NEW.decision_id;
  END IF;

  IF v_membership.cluster_id <> v_version_cluster_id THEN
    RAISE EXCEPTION
      'event_version_evidence : incohérence de cluster — event_version % porte sur le cluster %, decision % porte sur le cluster % (une preuve ne peut appartenir qu''au même cluster que la version qu''elle étaye).',
      NEW.event_version_id, v_version_cluster_id, NEW.decision_id, v_membership.cluster_id;
  END IF;

  IF v_membership.decision_type NOT IN ('ASSIGN', 'AMEND') THEN
    RAISE EXCEPTION
      'event_version_evidence : decision % n''est pas une preuve valide (decision_type=%, attendu ASSIGN ou AMEND) — une RETRACT ne peut jamais être citée comme preuve d''appartenance : elle atteste au contraire que l''observation n''appartient plus au cluster.',
      NEW.decision_id, v_membership.decision_type;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 4. fn_check_cluster_relation_operation_cardinality()
--    Référence de relation qualifiée : event_cluster_relation_edges ->
--    public.event_cluster_relation_edges.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_cluster_relation_operation_cardinality()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_operation_id    UUID := NEW.operation_id;
  v_operation_type  TEXT := NEW.operation_type;
  v_from_ct         INTEGER;
  v_to_ct           INTEGER;
BEGIN
  SELECT count(DISTINCT from_cluster_id), count(DISTINCT to_cluster_id)
    INTO v_from_ct, v_to_ct
    FROM public.event_cluster_relation_edges
    WHERE operation_id = v_operation_id;

  IF v_operation_type = 'MERGE' THEN
    IF v_from_ct < 2 OR v_to_ct <> 1 THEN
      RAISE EXCEPTION
        'MERGE % invalide : % source(s) distincte(s) (attendu >= 2), % destination(s) distincte(s) (attendu = 1). Une opération sans arête (0/0) échoue également ici.',
        v_operation_id, v_from_ct, v_to_ct;
    END IF;
  ELSIF v_operation_type = 'SPLIT' THEN
    IF v_from_ct <> 1 OR v_to_ct < 2 THEN
      RAISE EXCEPTION
        'SPLIT % invalide : % source(s) distincte(s) (attendu = 1), % destination(s) distincte(s) (attendu >= 2). Une opération sans arête (0/0) échoue également ici.',
        v_operation_id, v_from_ct, v_to_ct;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application)
--   SELECT p.proname, p.prosecdef,
--          (SELECT setting FROM unnest(p.proconfig) AS setting
--             WHERE setting LIKE 'search_path=%') AS search_path_setting
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN (
--        'fn_event_schema_append_only',
--        'fn_check_membership_decision_supersession',
--        'fn_check_event_version_evidence',
--        'fn_check_cluster_relation_operation_cardinality'
--      )
--    ORDER BY p.proname;
--   -- attendu : search_path_setting = 'search_path=' pour les 4 lignes ;
--   -- prosecdef = false (SECURITY INVOKER, inchangé) pour les 4 lignes.
--
--   -- Les triggers existants restent attachés sans recréation (même OID
--   -- de fonction, préservé par CREATE OR REPLACE FUNCTION) :
--   SELECT tgname, tgrelid::regclass
--     FROM pg_trigger
--    WHERE tgfoid IN (
--      'public.fn_event_schema_append_only'::regproc,
--      'public.fn_check_membership_decision_supersession'::regproc,
--      'public.fn_check_event_version_evidence'::regproc,
--      'public.fn_check_cluster_relation_operation_cardinality'::regproc
--    )
--    ORDER BY tgname;
--   -- attendu : les 10 triggers OPS-023 déjà connus (7 append-only + 1
--   -- supersession + 1 evidence + 1 cardinalité différée), inchangés.
-- =====================================================================
