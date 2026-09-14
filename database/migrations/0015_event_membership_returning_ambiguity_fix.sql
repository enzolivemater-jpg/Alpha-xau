-- =====================================================================
--  ALPHA-XAU — database/migrations/0015_event_membership_returning_ambiguity_fix.sql
--
--  OBJET : corrige un bug runtime concret, exposé par vérification live
--  contre Supabase (migration 0014 déjà appliquée en production) :
--
--    ERROR 42702: column reference "decision_id" is ambiguous
--
--  CAUSE. public.fn_event_assign_observation(...) déclare RETURNS
--  TABLE(..., decision_id UUID, ...) — une colonne de sortie PL/pgSQL
--  nommée decision_id. Les deux branches d'INSERT membership de la
--  migration 0014 utilisaient :
--
--    RETURNING decision_id INTO v_decision_id;
--
--  PostgreSQL ne peut alors pas déterminer si `decision_id` désigne la
--  colonne de la table event_observation_memberships ou la colonne de
--  sortie RETURNS TABLE du même nom — d'où l'ambiguïté 42702. Aucune
--  ligne de probe n'a été persistée (event_clusters = 0,
--  event_observation_memberships = 0) : le bug empêche toute écriture
--  réelle, il ne corrompt aucune donnée existante.
--
--  SYNTAXE SÛRE, VÉRIFIÉE INDÉPENDAMMENT EN LIVE SUR CE POSTGRESQL :
--
--    INSERT INTO <table> AS m (...)
--    ...
--    RETURNING m.decision_id
--
--  CETTE MIGRATION NE MODIFIE PAS LA MIGRATION 0014 (fichier immuable,
--  déjà appliqué à l'historique de migration Supabase en production —
--  voir OPS-023, discipline "jamais modifier une migration déjà
--  appliquée"). Elle CREATE OR REPLACE la fonction avec un corps
--  identique à 0014 en tout point, à l'exception des deux clauses
--  RETURNING corrigées ci-dessous. Aucun autre changement :
--
--    - signature (paramètres, ordre, types, défauts) : identique ;
--    - RETURNS TABLE(cluster_id, decision_id, cluster_created_now,
--      replayed) : identique, aucune colonne renommée ;
--    - SECURITY INVOKER, SET search_path = '' : identiques ;
--    - ordre du garde-fou de mode (avant la pré-vérification
--      d'idempotence, point de validation unique, non dupliqué) :
--      identique ;
--    - logique d'idempotence (pré-vérification + récupération sur
--      violation d'unicité scopée à uq_memberships_idempotency_
--      fingerprint), validation ASSIGN autonome
--      (decision_type='ASSIGN' + membership_operation_id IS NULL dans
--      les 3 sites) : identiques ;
--    - comportement de verrouillage advisory (fn_event_lock_cluster,
--      inchangée, non re-définie ici) : identique ;
--    - gestion d'exception (EXCEPTION WHEN unique_violation, GET
--      STACKED DIAGNOSTICS ... CONSTRAINT_NAME) : identique ;
--    - REVOKE/GRANT : identiques, réaffirmés ci-dessous par prudence
--      (CREATE OR REPLACE FUNCTION préserve déjà les grants existants
--      et le commentaire existant — même OID de fonction — mais les
--      réaffirmer documente le contrat attendu sans dépendre d'un
--      comportement implicite, même pattern que la migration 0013).
--
--  fn_event_lock_cluster N'EST PAS TOUCHÉE : son corps ne contient
--  aucune clause RETURNING, aucune ambiguïté possible.
--
--  Aucun pragma de résolution de conflit de variable PL/pgSQL
--  (#variable_conflict) n'est utilisé : l'alias de table explicite est
--  la correction demandée et la plus lisible — elle rend l'intention
--  explicite au niveau de chaque requête plutôt que de changer un
--  comportement de résolution global de la fonction.
--
--  Ne modifie aucune table, contrainte, trigger, policy RLS. Aucun
--  backfill. TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  PRÉREQUIS : migration 0014 (définit fn_event_assign_observation).
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_event_assign_observation(
  -- --- Obligatoires (sans défaut) ---
  p_observation_id                 UUID,
  p_membership_method               TEXT,
  p_evidence_digest                 TEXT,
  p_membership_algorithm_version     TEXT,
  p_decision_actor                   TEXT,
  p_idempotency_fingerprint           TEXT,
  p_semantic_state_fingerprint         TEXT,
  -- --- Optionnels (mode + faits de lignage) ---
  p_cluster_id                     UUID DEFAULT NULL,
  p_cluster_key                     TEXT DEFAULT NULL,
  p_category                         TEXT DEFAULT NULL,
  p_region                           TEXT DEFAULT NULL,
  p_cluster_algorithm_version         TEXT DEFAULT NULL,
  p_membership_confidence           NUMERIC DEFAULT NULL,
  p_editorial_origin_key             TEXT DEFAULT NULL,
  p_wire_lineage_key                 TEXT DEFAULT NULL,
  p_lineage_resolution_method         TEXT DEFAULT NULL,
  p_lineage_resolution_confidence   NUMERIC DEFAULT NULL,
  p_lineage_evidence                 TEXT DEFAULT NULL
)
RETURNS TABLE (
  cluster_id            UUID,
  decision_id           UUID,
  cluster_created_now   BOOLEAN,
  replayed              BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_existing              RECORD;
  v_existing_cluster       RECORD;
  v_new_cluster_id         UUID;
  v_decision_id            UUID;
  v_constraint_name        TEXT;
BEGIN
  IF p_observation_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_assign_observation : p_observation_id ne peut pas être NULL.';
  END IF;

  -- ---------------------------------------------------------------
  -- VALIDATION DE MODE — POINT DE GARDE UNIQUE, EN TOUT PREMIER : avant
  -- même la pré-vérification d'idempotence, avant tout verrou, avant
  -- toute écriture. Une requête ASSIGN_EXISTING dont l'intention est
  -- incohérente (paramètres de fondation de cluster renseignés en même
  -- temps qu'un p_cluster_id existant) doit être rejetée pour TOUTE
  -- exécution — premier appel, rejeu séquentiel, ou retry après réponse
  -- perdue — et ne doit JAMAIS pouvoir retourner replayed=true en
  -- atteignant le chemin rapide d'idempotence avant ce contrôle.
  -- Volontairement non dupliqué plus bas dans la fonction : ce garde-fou
  -- est le seul point de validation du mode.
  -- ---------------------------------------------------------------
  IF p_cluster_id IS NOT NULL THEN
    IF p_cluster_key IS NOT NULL
       OR p_category IS NOT NULL
       OR p_region IS NOT NULL
       OR p_cluster_algorithm_version IS NOT NULL
    THEN
      RAISE EXCEPTION
        'fn_event_assign_observation : ASSIGN_EXISTING (p_cluster_id=%) interdit tout paramètre de fondation de cluster (p_cluster_key/p_category/p_region/p_cluster_algorithm_version) — ces paramètres sont réservés à CREATE_AND_ASSIGN.',
        p_cluster_id;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- Pré-vérification d'idempotence (chemin rapide, avant tout verrou
  -- ou toute écriture). Une empreinte identique ne suffit JAMAIS seule
  -- à justifier un retour silencieux : l'intention canonique complète
  -- est validée contre la ligne déjà commitée.
  -- ---------------------------------------------------------------
  SELECT m.decision_id, m.cluster_id, m.observation_id, m.decision_type,
         m.membership_operation_id,
         m.membership_method, m.membership_confidence, m.evidence_digest,
         m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
         m.lineage_resolution_confidence, m.lineage_evidence,
         m.algorithm_version, m.decision_actor, m.semantic_state_fingerprint
    INTO v_existing
    FROM public.event_observation_memberships m
    WHERE m.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    -- fn_event_assign_observation ne crée JAMAIS que des décisions
    -- ASSIGN autonomes (membership_operation_id NULL). Une ligne portant
    -- ce même idempotency_fingerprint mais issue d'une future opération
    -- REASSIGN (membership_operation_id renseigné, ou decision_type
    -- différent) n'est jamais acceptée comme rejeu de CETTE RPC.
    IF v_existing.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing.decision_type IS DISTINCT FROM 'ASSIGN'
       OR v_existing.membership_operation_id IS NOT NULL
       OR v_existing.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.semantic_state_fingerprint IS DISTINCT FROM p_semantic_state_fingerprint
    THEN
      RAISE EXCEPTION
        'fn_event_assign_observation : idempotency_fingerprint % est déjà lié à une intention canonique différente (decision_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.decision_id;
    END IF;

    IF p_cluster_id IS NOT NULL THEN
      -- ASSIGN_EXISTING : le cluster_id demandé doit correspondre à
      -- celui de la décision déjà commitée.
      IF v_existing.cluster_id IS DISTINCT FROM p_cluster_id THEN
        RAISE EXCEPTION
          'fn_event_assign_observation : idempotency_fingerprint % est déjà lié au cluster % (ASSIGN_EXISTING demandait %) — collision, pas un rejeu.',
          p_idempotency_fingerprint, v_existing.cluster_id, p_cluster_id;
      END IF;
    ELSE
      -- CREATE_AND_ASSIGN : l'intention fondatrice du cluster référencé
      -- doit correspondre exactement à celle de cet appel.
      SELECT c.first_observation_id, c.cluster_key, c.category, c.region, c.algorithm_version
        INTO v_existing_cluster
        FROM public.event_clusters c
        WHERE c.id = v_existing.cluster_id;

      IF NOT FOUND
         OR v_existing_cluster.first_observation_id IS DISTINCT FROM p_observation_id
         OR v_existing_cluster.cluster_key IS DISTINCT FROM p_cluster_key
         OR v_existing_cluster.category IS DISTINCT FROM p_category
         OR v_existing_cluster.region IS DISTINCT FROM p_region
         OR v_existing_cluster.algorithm_version IS DISTINCT FROM p_cluster_algorithm_version
      THEN
        RAISE EXCEPTION
          'fn_event_assign_observation : idempotency_fingerprint % est déjà lié à un cluster (%) dont l''intention fondatrice diffère — collision, pas un rejeu.',
          p_idempotency_fingerprint, v_existing.cluster_id;
      END IF;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.decision_id, false, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- CREATE_AND_ASSIGN : p_cluster_id IS NULL.
  -- ---------------------------------------------------------------
  IF p_cluster_id IS NULL THEN
    IF p_cluster_key IS NULL OR length(btrim(p_cluster_key)) = 0 THEN
      RAISE EXCEPTION
        'fn_event_assign_observation : p_cluster_key est obligatoire et non vide en mode CREATE_AND_ASSIGN.';
    END IF;
    IF p_cluster_algorithm_version IS NULL OR length(btrim(p_cluster_algorithm_version)) = 0 THEN
      RAISE EXCEPTION
        'fn_event_assign_observation : p_cluster_algorithm_version est obligatoire et non vide en mode CREATE_AND_ASSIGN.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.news_articles WHERE id = p_observation_id) THEN
      RAISE EXCEPTION
        'fn_event_assign_observation : observation % introuvable (RAW).',
        p_observation_id;
    END IF;

    -- UUID généré DANS la transaction, avant toute écriture : le verrou
    -- porte sur cet identifiant précis dès sa naissance.
    v_new_cluster_id := pg_catalog.gen_random_uuid();
    PERFORM public.fn_event_lock_cluster(v_new_cluster_id);

    BEGIN
      INSERT INTO public.event_clusters (
        id, cluster_key, category, region, first_observation_id, algorithm_version
      ) VALUES (
        v_new_cluster_id, p_cluster_key, p_category, p_region, p_observation_id, p_cluster_algorithm_version
      );

      -- CORRECTIF 0015 : alias de table explicite (AS m) + RETURNING
      -- qualifié (m.decision_id). Sans cela, PostgreSQL ne peut pas
      -- distinguer la colonne event_observation_memberships.decision_id
      -- de la colonne de sortie RETURNS TABLE(..., decision_id, ...) du
      -- même nom -> ERROR 42702 (column reference "decision_id" is
      -- ambiguous), vérifié en live contre Supabase.
      INSERT INTO public.event_observation_memberships AS m (
        observation_id, cluster_id, decision_type, supersedes_decision_id, membership_operation_id,
        membership_method, membership_confidence, evidence_digest,
        editorial_origin_key, wire_lineage_key, lineage_resolution_method,
        lineage_resolution_confidence, lineage_evidence,
        algorithm_version, decision_actor, idempotency_fingerprint, semantic_state_fingerprint
      ) VALUES (
        p_observation_id, v_new_cluster_id, 'ASSIGN', NULL, NULL,
        p_membership_method, p_membership_confidence, p_evidence_digest,
        p_editorial_origin_key, p_wire_lineage_key, p_lineage_resolution_method,
        p_lineage_resolution_confidence, p_lineage_evidence,
        p_membership_algorithm_version, p_decision_actor, p_idempotency_fingerprint, p_semantic_state_fingerprint
      )
      RETURNING m.decision_id INTO v_decision_id;

      -- Les deux INSERT ci-dessus commitent ensemble ou aucun des deux :
      -- même transaction, aucune écriture intermédiaire visible.
      RETURN QUERY SELECT v_new_cluster_id, v_decision_id, true, false;
      RETURN;

    EXCEPTION WHEN unique_violation THEN
      -- Course concurrente : un autre appel IDENTIQUE (même
      -- idempotency_fingerprint) a commité entre notre pré-vérification
      -- et cet INSERT — possible car deux UUID de cluster générés
      -- indépendamment ne partagent aucun verrou avant que l'un des
      -- deux ne commette. On ne récupère QUE ce cas précis : toute
      -- autre violation d'unicité (ex. collision d'UUID astronomiquement
      -- improbable sur event_clusters.id) est relevée telle quelle.
      -- Le cluster inséré par CETTE tentative perdante est annulé
      -- automatiquement (savepoint implicite du bloc BEGIN/EXCEPTION).
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN
        RAISE;
      END IF;

      SELECT m.decision_id, m.cluster_id, m.observation_id, m.decision_type,
             m.membership_operation_id,
             m.membership_method, m.membership_confidence, m.evidence_digest,
             m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
             m.lineage_resolution_confidence, m.lineage_evidence,
             m.algorithm_version, m.decision_actor, m.semantic_state_fingerprint
        INTO v_existing
        FROM public.event_observation_memberships m
        WHERE m.idempotency_fingerprint = p_idempotency_fingerprint;

      IF NOT FOUND THEN
        RAISE;
      END IF;

      SELECT c.first_observation_id, c.cluster_key, c.category, c.region, c.algorithm_version
        INTO v_existing_cluster
        FROM public.event_clusters c
        WHERE c.id = v_existing.cluster_id;

      -- Même garde qu'au chemin rapide (§ci-dessus) : une ligne issue
      -- d'une future REASSIGN n'est jamais acceptée comme rejeu de cette
      -- RPC, même après une course concurrente.
      IF NOT FOUND
         OR v_existing.decision_type IS DISTINCT FROM 'ASSIGN'
         OR v_existing.membership_operation_id IS NOT NULL
         OR v_existing.observation_id IS DISTINCT FROM p_observation_id
         OR v_existing.membership_method IS DISTINCT FROM p_membership_method
         OR v_existing.membership_confidence IS DISTINCT FROM p_membership_confidence
         OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
         OR v_existing.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
         OR v_existing.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
         OR v_existing.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
         OR v_existing.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
         OR v_existing.lineage_evidence IS DISTINCT FROM p_lineage_evidence
         OR v_existing.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
         OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
         OR v_existing.semantic_state_fingerprint IS DISTINCT FROM p_semantic_state_fingerprint
         OR v_existing_cluster.first_observation_id IS DISTINCT FROM p_observation_id
         OR v_existing_cluster.cluster_key IS DISTINCT FROM p_cluster_key
         OR v_existing_cluster.category IS DISTINCT FROM p_category
         OR v_existing_cluster.region IS DISTINCT FROM p_region
         OR v_existing_cluster.algorithm_version IS DISTINCT FROM p_cluster_algorithm_version
      THEN
        RAISE EXCEPTION
          'fn_event_assign_observation : violation d''unicité sur idempotency_fingerprint % dont l''intention committée diffère de cet appel — collision réelle, pas un rejeu.',
          p_idempotency_fingerprint;
      END IF;

      RETURN QUERY SELECT v_existing.cluster_id, v_existing.decision_id, false, true;
      RETURN;
    END;
  END IF;

  -- ---------------------------------------------------------------
  -- ASSIGN_EXISTING : p_cluster_id IS NOT NULL. N'altère jamais le
  -- cluster référencé (aucun UPDATE nulle part dans cette fonction).
  -- La validation du mode (paramètres de fondation de cluster interdits
  -- ici) a déjà été effectuée EN TOUT PREMIER, avant même la
  -- pré-vérification d'idempotence — voir le garde-fou unique en tête
  -- de fonction. Non dupliquée ici.
  -- ---------------------------------------------------------------
  PERFORM public.fn_event_lock_cluster(p_cluster_id);

  IF NOT EXISTS (SELECT 1 FROM public.event_clusters WHERE id = p_cluster_id) THEN
    RAISE EXCEPTION
      'fn_event_assign_observation : cluster % introuvable (ASSIGN_EXISTING).',
      p_cluster_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.news_articles WHERE id = p_observation_id) THEN
    RAISE EXCEPTION
      'fn_event_assign_observation : observation % introuvable (RAW).',
      p_observation_id;
  END IF;

  BEGIN
    -- CORRECTIF 0015 : même alias/qualification que ci-dessus, pour la
    -- même raison (RETURNS TABLE(..., decision_id, ...) du même nom).
    INSERT INTO public.event_observation_memberships AS m (
      observation_id, cluster_id, decision_type, supersedes_decision_id, membership_operation_id,
      membership_method, membership_confidence, evidence_digest,
      editorial_origin_key, wire_lineage_key, lineage_resolution_method,
      lineage_resolution_confidence, lineage_evidence,
      algorithm_version, decision_actor, idempotency_fingerprint, semantic_state_fingerprint
    ) VALUES (
      p_observation_id, p_cluster_id, 'ASSIGN', NULL, NULL,
      p_membership_method, p_membership_confidence, p_evidence_digest,
      p_editorial_origin_key, p_wire_lineage_key, p_lineage_resolution_method,
      p_lineage_resolution_confidence, p_lineage_evidence,
      p_membership_algorithm_version, p_decision_actor, p_idempotency_fingerprint, p_semantic_state_fingerprint
    )
    RETURNING m.decision_id INTO v_decision_id;

    RETURN QUERY SELECT p_cluster_id, v_decision_id, false, false;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN
      RAISE;
    END IF;

    SELECT m.decision_id, m.cluster_id, m.observation_id, m.decision_type,
           m.membership_operation_id,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor, m.semantic_state_fingerprint
      INTO v_existing
      FROM public.event_observation_memberships m
      WHERE m.idempotency_fingerprint = p_idempotency_fingerprint;

    -- Même garde qu'au chemin rapide : une ligne issue d'une future
    -- REASSIGN n'est jamais acceptée comme rejeu de cette RPC.
    IF NOT FOUND
       OR v_existing.decision_type IS DISTINCT FROM 'ASSIGN'
       OR v_existing.membership_operation_id IS NOT NULL
       OR v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing.semantic_state_fingerprint IS DISTINCT FROM p_semantic_state_fingerprint
    THEN
      RAISE EXCEPTION
        'fn_event_assign_observation : violation d''unicité sur idempotency_fingerprint % dont l''intention committée diffère de cet appel — collision réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.decision_id, false, true;
    RETURN;
  END;
END;
$$;

-- Réaffirmation explicite des grants existants (migration 0014) : un
-- CREATE OR REPLACE FUNCTION ne les retire pas en pratique (même OID de
-- fonction), mais les redéclarer ici documente le contrat attendu sans
-- dépendre d'un comportement implicite — même pattern que la migration
-- 0013 (voir OPS-023-SECURITY-HARDENING-001).
REVOKE ALL ON FUNCTION public.fn_event_assign_observation(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_assign_observation(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;

-- Le commentaire de fonction posé par la migration 0014 reste attaché
-- automatiquement (même OID, non affecté par CREATE OR REPLACE) — non
-- réaffirmé ici, aucun changement de son contenu.

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application — hors
-- périmètre de cette tâche, effectuée indépendamment après fusion)
--
--   SELECT p.proname, p.prosecdef,
--          (SELECT setting FROM unnest(p.proconfig) AS setting
--             WHERE setting LIKE 'search_path=%') AS search_path_setting
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname = 'fn_event_assign_observation';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false
--   -- (inchangés depuis 0014).
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique — ne jamais committer une probe de test). Reproduit
--   -- EXACTEMENT le probe qui a exposé l'erreur 42702 sous 0014 :
--   BEGIN;
--     SELECT * FROM fn_event_assign_observation(
--       p_observation_id := '<uuid existant dans news_articles>',
--       p_membership_method := 'test_probe',
--       p_evidence_digest := 'probe',
--       p_membership_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe',
--       p_idempotency_fingerprint := 'probe-fp-001',
--       p_semantic_state_fingerprint := 'probe-sfp-001',
--       p_cluster_key := 'probe-cluster-key',
--       p_cluster_algorithm_version := 'probe-v1'
--     );
--     -- attendu : une ligne, cluster_created_now=true, replayed=false,
--     -- decision_id/cluster_id non NULL. Aucune erreur 42702.
--     SELECT count(*) FROM event_clusters; -- attendu : 1 (dans la transaction)
--     SELECT count(*) FROM event_observation_memberships; -- attendu : 1
--
--     -- rejouer le même appel : attendu replayed = true, aucune
--     -- nouvelle ligne créée.
--     SELECT * FROM fn_event_assign_observation(
--       p_observation_id := '<même uuid>',
--       p_membership_method := 'test_probe',
--       p_evidence_digest := 'probe',
--       p_membership_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe',
--       p_idempotency_fingerprint := 'probe-fp-001',
--       p_semantic_state_fingerprint := 'probe-sfp-001',
--       p_cluster_key := 'probe-cluster-key',
--       p_cluster_algorithm_version := 'probe-v1'
--     );
--   ROLLBACK;
-- =====================================================================
