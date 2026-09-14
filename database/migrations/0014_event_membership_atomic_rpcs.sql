-- =====================================================================
--  ALPHA-XAU — database/migrations/0014_event_membership_atomic_rpcs.sql
--
--  OBJET : premier primitif transactionnel OPS-023 Phase 2.
--
--    RAW observation (news_articles)
--      -> créer/réutiliser EVENT CLUSTER
--      -> ASSIGN membership atomique
--
--  N'IMPLÉMENTE PAS ENCORE la création d'EVENT VERSION (voir plan
--  Phase 2, PR-3). Cette migration établit uniquement :
--    1. la discipline de verrou advisory par cluster, partagée par
--       toutes les futures RPC de mutation OPS-023 ;
--    2. l'opération ASSIGN atomique (création-ou-réutilisation de
--       cluster + membership), rejouable sans effet de bord (retry-safe).
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0012/0013 (fichiers immuables — NON modifiées) ;
--    - aucune table existante, aucune contrainte, aucun trigger, aucune
--      policy RLS, aucun grant de table (seuls des GRANT/REVOKE de
--      fonction sont introduits ici) ;
--    - le pipeline legacy GDELT/NewsAPI/Comité, worker.ts, wrangler.toml,
--      le frontend, ou toute configuration Cloudflare — hors périmètre
--      de cette tâche.
--
--  DISCIPLINE DE VERROU (gelée par l'audit d'architecture OPS-023) :
--  chaque mutation touchant un cluster C prend UN verrou advisory de
--  transaction, dérivé de manière déterministe et stable de C, via
--  fn_event_lock_cluster ci-dessous — jamais un verrou sur l'ensemble
--  des clusters impliqués, jamais une coordination côté Worker/appelant.
--  Les futures RPC multi-cluster (réassignation, fusion/scission)
--  appelleront ce même helper une fois par cluster_id, dans un ordre
--  trié déterministe.
--
--  IDEMPOTENCE (à deux niveaux, tous deux requis) :
--    1. pré-vérification explicite par idempotency_fingerprint AVANT
--       toute tentative d'écriture (chemin rapide, évite une écriture
--       vouée à l'échec dans le cas séquentiel courant) ;
--    2. récupération sur violation d'unicité (filet de sécurité pour la
--       course concurrente : deux appels identiques peuvent tous deux
--       franchir la pré-vérification avant qu'aucun des deux n'ait
--       commité, car leurs UUID de cluster nouvellement générés ne
--       partagent aucun verrou). Seule la violation portant précisément
--       sur uq_memberships_idempotency_fingerprint déclenche la
--       récupération — toute autre violation d'unicité est relevée
--       (re-RAISE) sans être interprétée comme un rejeu.
--    Dans les deux cas, l'intention canonique de l'appel est validée
--    contre la ligne déjà commitée avant de la renvoyer : une empreinte
--    identique ne suffit jamais seule à justifier un retour silencieux.
--
--  SÉCURITÉ : les deux fonctions sont SECURITY INVOKER (comportement
--  par défaut, rendu explicite), SET search_path = '' (durci dès la
--  création, pas en correctif ultérieur — voir OPS-023-SECURITY-
--  HARDENING-001), et EXECUTE est explicitement révoqué de PUBLIC/anon/
--  authenticated puis accordé à service_role uniquement. Les grants et
--  la RLS des TABLES existantes restent strictement inchangés.
--
--  INVARIANTS DÉJÀ PORTÉS PAR LA MIGRATION 0012, NON DUPLIQUÉS ICI :
--  unicité de la relation ASSIGN, unicité d'idempotency_fingerprint,
--  protection append-only, intégrité FK, bornes de
--  membership_confidence, CHECK decision_type, protection de
--  supersession. Ces fonctions AJOUTENT une orchestration transactionnelle
--  et un comportement de rejeu — elles ne créent aucun modèle
--  d'invariant concurrent.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  VÉRIFICATION TRANSACTIONNELLE RÉELLE : les tests déterministes de ce
--  dépôt (analyse statique du texte SQL, sans PostgreSQL) NE PROUVENT
--  PAS le comportement transactionnel réel. Une vérification live contre
--  Supabase (rollback/probes de non-pollution) sera effectuée
--  indépendamment, APRÈS fusion — hors périmètre de cette migration.
--
--  PRÉREQUIS : migrations 0001-0013 (event_clusters,
--  event_observation_memberships, extensions.digest, gen_random_uuid).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. fn_event_lock_cluster(p_cluster_id UUID) RETURNS void
--
--    Verrou advisory de transaction, namespace/dérivation STABLE et
--    PARTAGÉE par toutes les futures RPC de mutation OPS-023 — un seul
--    verrou par cluster_id, jamais un hachage de l'ensemble des
--    clusters impliqués (pas de "whole-set lock").
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_lock_cluster(p_cluster_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_cluster_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_lock_cluster : p_cluster_id ne peut pas être NULL.';
  END IF;

  -- Dérivation canonique, déterministe entre sessions/processus : même
  -- cluster_id -> même clé de verrou, toujours. hashtextextended(...,0)
  -- retourne un bigint, seed fixe 0 pour la stabilité inter-appels.
  -- pg_advisory_xact_lock est scopé à la transaction courante : il se
  -- libère automatiquement au COMMIT ou ROLLBACK, jamais besoin d'un
  -- déverrouillage explicite.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xau_v2:event_cluster:' || p_cluster_id::text, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_lock_cluster(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_event_lock_cluster(UUID) TO service_role;

COMMENT ON FUNCTION public.fn_event_lock_cluster IS
  'Verrou advisory de transaction partagé par toutes les RPC de mutation OPS-023 (namespace xau_v2:event_cluster:<uuid>, hashtextextended/pg_advisory_xact_lock). Un seul cluster_id par appel — les futures RPC multi-cluster appellent ce helper une fois par cluster_id, en ordre trié déterministe. Jamais un verrou sur l''ensemble des clusters impliqués.';

-- ---------------------------------------------------------------------
-- 2. fn_event_assign_observation(...) RETURNS TABLE(...)
--
--    Deux modes, sélectionnés par la présence/absence de p_cluster_id :
--      CREATE_AND_ASSIGN (p_cluster_id IS NULL) : crée un nouveau
--        cluster et sa première décision ASSIGN, dans UNE transaction.
--      ASSIGN_EXISTING (p_cluster_id IS NOT NULL) : ajoute une décision
--        ASSIGN sur un cluster déjà existant, sans jamais le modifier.
--
--    Paramètres SCALAIRES explicites (pas de payload JSON opaque).
--    ORDRE DE DÉCLARATION : PostgreSQL exige que tout paramètre suivant
--    un paramètre à valeur par défaut ait lui aussi une valeur par
--    défaut — les 7 paramètres réellement obligatoires sont donc
--    déclarés en premier, puis les 11 paramètres optionnels. Cet ordre
--    de déclaration SQL ne change rien à l'appel via PostgREST
--    (rpc/fn_event_assign_observation), qui passe les arguments par NOM
--    (corps JSON), pas par position.
-- ---------------------------------------------------------------------
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

      INSERT INTO public.event_observation_memberships (
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
      RETURNING decision_id INTO v_decision_id;

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
  --
  -- Les paramètres de FONDATION de cluster (CREATE_AND_ASSIGN
  -- uniquement) sont rejetés explicitement s'ils sont renseignés ici :
  -- jamais ignorés silencieusement. Passer p_cluster_key/p_category/
  -- p_region/p_cluster_algorithm_version en même temps qu'un
  -- p_cluster_id existant est une intention incohérente de l'appelant,
  -- pas une variante tolérée de ce mode.
  -- ---------------------------------------------------------------
  IF p_cluster_key IS NOT NULL
     OR p_category IS NOT NULL
     OR p_region IS NOT NULL
     OR p_cluster_algorithm_version IS NOT NULL
  THEN
    RAISE EXCEPTION
      'fn_event_assign_observation : ASSIGN_EXISTING (p_cluster_id=%) interdit tout paramètre de fondation de cluster (p_cluster_key/p_category/p_region/p_cluster_algorithm_version) — ces paramètres sont réservés à CREATE_AND_ASSIGN.',
      p_cluster_id;
  END IF;

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
    INSERT INTO public.event_observation_memberships (
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
    RETURNING decision_id INTO v_decision_id;

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

REVOKE ALL ON FUNCTION public.fn_event_assign_observation(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_assign_observation(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;

COMMENT ON FUNCTION public.fn_event_assign_observation IS
  'RPC atomique OPS-023 : ASSIGN membership, avec création-ou-réutilisation de cluster (CREATE_AND_ASSIGN si p_cluster_id IS NULL, sinon ASSIGN_EXISTING). Idempotente par idempotency_fingerprint (pré-vérification + récupération sur violation d''unicité, intention canonique toujours revalidée). N''UPDATE ni ne DELETE jamais rien. N''implémente pas la création d''EVENT VERSION (Phase 2 PR-3).';

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
--      AND p.proname IN ('fn_event_lock_cluster', 'fn_event_assign_observation')
--    ORDER BY p.proname;
--   -- attendu : search_path_setting = 'search_path=' et prosecdef = false
--   -- (SECURITY INVOKER) pour les deux lignes.
--
--   SELECT grantee, routine_name, privilege_type
--     FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('fn_event_lock_cluster', 'fn_event_assign_observation')
--    ORDER BY routine_name, grantee;
--   -- attendu : service_role EXECUTE uniquement ; aucune ligne pour
--   -- anon/authenticated/PUBLIC.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique — ne jamais committer une probe de test) :
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
