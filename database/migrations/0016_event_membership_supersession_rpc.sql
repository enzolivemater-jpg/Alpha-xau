-- =====================================================================
--  ALPHA-XAU — database/migrations/0016_event_membership_supersession_rpc.sql
--
--  OBJET : primitif transactionnel OPS-023 Phase 2 (suite) — correction
--  autonome (AMEND / RETRACT) d'une décision de membership existante.
--
--    event_observation_memberships (décision existante, vivante)
--      -> AMEND (métadonnées corrigées, même relation logique)
--      -> RETRACT (relation logique close, plus considérée active)
--
--  N'IMPLÉMENTE PAS REASSIGN (verrouillage multi-cluster trié +
--  orchestration atomique à deux lignes — PR séparée, plus complexe).
--  N'IMPLÉMENTE PAS les revendications d'identité forte, MERGE/SPLIT, la
--  détection de cycle, la création d'EVENT VERSION, le processeur, ni
--  aucune intégration worker/cron/Comité/Event Impact/Gold Transmission/
--  Silver Edge/notification/legacy/frontend/Cloudflare/Anthropic.
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0012/0013/0014/0015 (fichiers immuables, déjà
--      appliqués — NON modifiées) ;
--    - aucune table, contrainte, trigger, policy RLS existants, aucun
--      grant de table (seuls des GRANT/REVOKE de fonction sont
--      introduits ici) ;
--    - fn_event_lock_cluster (réutilisée telle quelle, non redéfinie).
--
--  FAITS DB GELÉS RÉUTILISÉS (migration 0012, non dupliqués ici) :
--  event_observation_memberships est append-only ; decision_type ∈
--  {ASSIGN, AMEND, RETRACT} ; AMEND/RETRACT doit superseder une décision
--  sur la MÊME observation + MÊME relation logique (déjà protégé par le
--  trigger fn_check_membership_decision_supersession, BEFORE INSERT,
--  0012 — NON dupliqué ni remplacé ici, seulement complété par des
--  validations RPC explicites en amont pour des messages d'erreur plus
--  clairs) ; uq_memberships_supersedes_decision empêche deux successeurs
--  du même prédécesseur ; idempotency_fingerprint est globalement
--  unique ; membership_operation_id est NULL pour une décision de
--  membership autonome — une valeur non-NULL est réservée aux
--  opérations composées atomiques futures (REASSIGN).
--
--  IDEMPOTENCE (trois niveaux, tel que gelé pour cette RPC) :
--    1. pré-vérification par idempotency_fingerprint AVANT tout verrou
--       (évite de verrouiller le cluster pour un rejeu évident) ;
--    2. RE-vérification par idempotency_fingerprint APRÈS acquisition du
--       verrou (couvre un appel concurrent identique ayant commité
--       PENDANT que cet appel attendait le verrou) ;
--    3. récupération scopée sur violation d'unicité (filet de sécurité
--       pour une collision globale d'idempotency_fingerprint provenant
--       d'un appel concurrent touchant un AUTRE cluster_id, donc non
--       bloqué par le verrou de CE cluster — idempotency_fingerprint
--       est unique GLOBALEMENT, pas par cluster). Seule la violation
--       portant précisément sur uq_memberships_idempotency_fingerprint
--       déclenche la récupération — toute autre violation est relevée
--       (re-RAISE) sans être interprétée comme un rejeu.
--    Dans les trois cas, l'intention canonique complète est validée
--    contre la ligne déjà commitée avant tout retour : une empreinte
--    identique ne suffit jamais seule à justifier un retour silencieux.
--
--  FRAÎCHEUR DU PRÉDÉCESSEUR (« currentness »), sous verrou : détection
--  EXPLICITE d'un successeur déjà existant via une lecture dédiée
--  (SELECT ... WHERE supersedes_decision_id = p_supersedes_decision_id),
--  PAS en s'appuyant uniquement sur uq_memberships_supersedes_decision
--  pour le flux de contrôle normal — cette contrainte reste un filet de
--  sécurité déclaratif, la détection primaire produit un message
--  d'erreur explicite (« prédécesseur périmé »).
--
--  SÉMANTIQUE RETRACT/AMEND :
--    - RETRACT peut superseder un ASSIGN ou un AMEND actif ;
--    - RETRACT NE PEUT PAS superseder un état déjà RETRACT comme
--      nouvelle opération sémantique (un rejeu identique est géré par
--      l'idempotence, jamais par l'insertion d'un second RETRACT) ;
--    - AMEND peut superseder ASSIGN ou AMEND ;
--    - AMEND PEUT superseder RETRACT pour rouvrir une relation logique
--      historique — volontaire et nécessaire pour que A -> B -> A reste
--      représentable sans réinsertion d'un second ASSIGN sur l'ancienne
--      relation.
--
--  SÉCURITÉ : SECURITY INVOKER (explicite), SET search_path = '' (durci
--  dès la création), toutes les références de relation qualifiées
--  public./pg_catalog., EXECUTE révoqué de PUBLIC/anon/authenticated
--  puis accordé à service_role uniquement. Aucun code SECURITY DEFINER.
--  Grants et RLS des TABLES existantes strictement inchangés.
--
--  AMBIGUÏTÉ RETURNING (leçon de la migration 0015, appliquée dès la
--  création ici, pas en correctif ultérieur) : RETURNS TABLE(...,
--  cluster_id, decision_id, ..., decision_type, ...) porte des noms de
--  colonnes de sortie identiques à des colonnes réelles de
--  event_observation_memberships. Le seul RETURNING de cette migration
--  cible exclusivement decision_id (les autres colonnes de sortie sont
--  déjà connues des paramètres d'entrée, jamais issues d'un RETURNING)
--  et utilise un alias de table explicite qualifié :
--    INSERT INTO public.event_observation_memberships AS m (...)
--    ...
--    RETURNING m.decision_id INTO v_decision_id;
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
--  PRÉREQUIS : migrations 0001-0015 (event_clusters,
--  event_observation_memberships, fn_event_lock_cluster).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- public.fn_event_supersede_membership(...) RETURNS TABLE(...)
--
--    Décisions autonomes UNIQUEMENT : AMEND ou RETRACT. ASSIGN est
--    explicitement rejeté (voir fn_event_assign_observation, migration
--    0014/0015, pour l'ouverture d'une relation fraîche). Les lignes
--    insérées ici portent TOUJOURS membership_operation_id = NULL — une
--    future RPC REASSIGN (hors périmètre ici) produira des décisions
--    corrélées par un membership_operation_id non-NULL, et cette RPC
--    rejette explicitement tout rejeu prétendant correspondre à une
--    telle décision.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_supersede_membership(
  -- --- Obligatoires (sans défaut) ---
  p_observation_id                 UUID,
  p_cluster_id                     UUID,
  p_supersedes_decision_id         UUID,
  p_decision_type                   TEXT,
  p_membership_method               TEXT,
  p_evidence_digest                 TEXT,
  p_membership_algorithm_version     TEXT,
  p_decision_actor                   TEXT,
  p_idempotency_fingerprint           TEXT,
  p_semantic_state_fingerprint         TEXT,
  -- --- Optionnels (faits de lignage) ---
  p_membership_confidence           NUMERIC DEFAULT NULL,
  p_editorial_origin_key             TEXT DEFAULT NULL,
  p_wire_lineage_key                 TEXT DEFAULT NULL,
  p_lineage_resolution_method         TEXT DEFAULT NULL,
  p_lineage_resolution_confidence   NUMERIC DEFAULT NULL,
  p_lineage_evidence                 TEXT DEFAULT NULL
)
RETURNS TABLE (
  cluster_id               UUID,
  decision_id               UUID,
  superseded_decision_id   UUID,
  decision_type             TEXT,
  replayed                   BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_existing              RECORD;
  v_predecessor            RECORD;
  v_decision_id            UUID;
  v_constraint_name        TEXT;
  v_successor_exists       BOOLEAN;
BEGIN
  -- ---------------------------------------------------------------
  -- ÉTAPE 1 — validation scalaire de base (aucune lecture DB).
  -- ---------------------------------------------------------------
  IF p_observation_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_supersede_membership : p_observation_id ne peut pas être NULL.';
  END IF;
  IF p_cluster_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_supersede_membership : p_cluster_id ne peut pas être NULL.';
  END IF;
  IF p_supersedes_decision_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_supersede_membership : p_supersedes_decision_id ne peut pas être NULL.';
  END IF;
  IF p_decision_type NOT IN ('AMEND', 'RETRACT') THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : p_decision_type doit être AMEND ou RETRACT (reçu %) — ASSIGN n''est jamais accepté ici (voir fn_event_assign_observation).',
      p_decision_type;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 2 — pré-vérification d'idempotence (chemin rapide, AVANT tout
  -- verrou). Une empreinte identique ne suffit JAMAIS seule à justifier
  -- un retour silencieux : l'intention canonique complète est validée.
  -- ---------------------------------------------------------------
  SELECT m.decision_id, m.cluster_id, m.observation_id, m.decision_type,
         m.supersedes_decision_id, m.membership_operation_id,
         m.membership_method, m.membership_confidence, m.evidence_digest,
         m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
         m.lineage_resolution_confidence, m.lineage_evidence,
         m.algorithm_version, m.decision_actor, m.semantic_state_fingerprint
    INTO v_existing
    FROM public.event_observation_memberships m
    WHERE m.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    IF v_existing.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.decision_type IS DISTINCT FROM p_decision_type
       OR v_existing.supersedes_decision_id IS DISTINCT FROM p_supersedes_decision_id
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
        'fn_event_supersede_membership : idempotency_fingerprint % est déjà lié à une intention canonique différente (decision_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.decision_id;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.decision_id, v_existing.supersedes_decision_id, v_existing.decision_type, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 3 — acquisition du verrou advisory partagé.
  -- ---------------------------------------------------------------
  PERFORM public.fn_event_lock_cluster(p_cluster_id);

  -- ---------------------------------------------------------------
  -- ÉTAPE 4 — RE-vérification d'idempotence APRÈS le verrou : couvre un
  -- appel concurrent identique ayant commité PENDANT que cet appel
  -- attendait le verrou (fenêtre entre l'étape 2 et l'étape 3).
  -- ---------------------------------------------------------------
  SELECT m.decision_id, m.cluster_id, m.observation_id, m.decision_type,
         m.supersedes_decision_id, m.membership_operation_id,
         m.membership_method, m.membership_confidence, m.evidence_digest,
         m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
         m.lineage_resolution_confidence, m.lineage_evidence,
         m.algorithm_version, m.decision_actor, m.semantic_state_fingerprint
    INTO v_existing
    FROM public.event_observation_memberships m
    WHERE m.idempotency_fingerprint = p_idempotency_fingerprint;

  IF FOUND THEN
    IF v_existing.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.decision_type IS DISTINCT FROM p_decision_type
       OR v_existing.supersedes_decision_id IS DISTINCT FROM p_supersedes_decision_id
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
        'fn_event_supersede_membership : idempotency_fingerprint % est déjà lié à une intention canonique différente (decision_id=%) — collision, pas un rejeu.',
        p_idempotency_fingerprint, v_existing.decision_id;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.decision_id, v_existing.supersedes_decision_id, v_existing.decision_type, true;
    RETURN;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 5 — validation du prédécesseur / fraîcheur, SOUS VERROU.
  -- ---------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM public.event_clusters WHERE id = p_cluster_id) THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : cluster % introuvable.',
      p_cluster_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.news_articles WHERE id = p_observation_id) THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : observation % introuvable (RAW).',
      p_observation_id;
  END IF;

  SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type
    INTO v_predecessor
    FROM public.event_observation_memberships m
    WHERE m.decision_id = p_supersedes_decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : décision antérieure % (p_supersedes_decision_id) introuvable.',
      p_supersedes_decision_id;
  END IF;
  IF v_predecessor.observation_id IS DISTINCT FROM p_observation_id THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : la décision antérieure % porte sur une observation différente (attendu %, trouvé %) — une correction ne peut porter que sur la MÊME observation.',
      p_supersedes_decision_id, p_observation_id, v_predecessor.observation_id;
  END IF;
  IF v_predecessor.cluster_id IS DISTINCT FROM p_cluster_id THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : la décision antérieure % porte sur un cluster différent (attendu %, trouvé %) — une correction ne peut porter que sur la MÊME relation logique.',
      p_supersedes_decision_id, p_cluster_id, v_predecessor.cluster_id;
  END IF;

  -- Fraîcheur explicite : un successeur existe-t-il déjà pour cette
  -- décision antérieure ? Détection PRIMAIRE par lecture dédiée — pas
  -- une dépendance exclusive à uq_memberships_supersedes_decision pour
  -- le flux de contrôle normal (cette contrainte reste un filet de
  -- sécurité déclaratif). Ayant déjà écarté un rejeu (étapes 2 et 4),
  -- tout successeur trouvé ici est nécessairement une intention
  -- concurrente DIFFÉRENTE, jamais notre propre appel.
  SELECT EXISTS (
    SELECT 1 FROM public.event_observation_memberships m
    WHERE m.supersedes_decision_id = p_supersedes_decision_id
  ) INTO v_successor_exists;

  IF v_successor_exists THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : décision antérieure % périmée — un successeur existe déjà (prédécesseur non vivant).',
      p_supersedes_decision_id;
  END IF;

  -- RETRACT-sur-RETRACT interdit comme nouvelle opération sémantique :
  -- un rejeu identique est géré par l'idempotence (étapes 2/4), jamais
  -- par l'insertion d'un second RETRACT. AMEND-sur-RETRACT reste
  -- explicitement autorisé (réouverture intentionnelle de la relation).
  IF p_decision_type = 'RETRACT' AND v_predecessor.decision_type = 'RETRACT' THEN
    RAISE EXCEPTION
      'fn_event_supersede_membership : RETRACT ne peut pas superseder une décision déjà RETRACT (%) — un rejeu identique est géré par idempotency_fingerprint, jamais par un second RETRACT.',
      p_supersedes_decision_id;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 6 — insertion. membership_operation_id TOUJOURS NULL (décision
  -- autonome). Alias de table explicite + RETURNING qualifié (leçon
  -- 0015) : RETURNS TABLE(..., decision_id, ..., decision_type, ...)
  -- porte des noms identiques à de vraies colonnes de la table.
  -- ---------------------------------------------------------------
  BEGIN
    INSERT INTO public.event_observation_memberships AS m (
      observation_id, cluster_id, decision_type, supersedes_decision_id, membership_operation_id,
      membership_method, membership_confidence, evidence_digest,
      editorial_origin_key, wire_lineage_key, lineage_resolution_method,
      lineage_resolution_confidence, lineage_evidence,
      algorithm_version, decision_actor, idempotency_fingerprint, semantic_state_fingerprint
    ) VALUES (
      p_observation_id, p_cluster_id, p_decision_type, p_supersedes_decision_id, NULL,
      p_membership_method, p_membership_confidence, p_evidence_digest,
      p_editorial_origin_key, p_wire_lineage_key, p_lineage_resolution_method,
      p_lineage_resolution_confidence, p_lineage_evidence,
      p_membership_algorithm_version, p_decision_actor, p_idempotency_fingerprint, p_semantic_state_fingerprint
    )
    RETURNING m.decision_id INTO v_decision_id;

    RETURN QUERY SELECT p_cluster_id, v_decision_id, p_supersedes_decision_id, p_decision_type, false;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    -- Filet de sécurité : collision GLOBALE d'idempotency_fingerprint
    -- provenant d'un appel concurrent touchant un AUTRE cluster_id (donc
    -- non bloqué par le verrou de CE cluster — idempotency_fingerprint
    -- est unique globalement, pas par cluster). On ne récupère QUE ce
    -- cas précis : toute autre violation d'unicité (ex.
    -- uq_memberships_supersedes_decision si la détection de fraîcheur
    -- ci-dessus avait raté une course, ou uq_memberships_relation_key_
    -- assign — sans objet ici, ASSIGN n'est jamais inséré par cette RPC)
    -- est relevée telle quelle.
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN
      RAISE;
    END IF;

    SELECT m.decision_id, m.cluster_id, m.observation_id, m.decision_type,
           m.supersedes_decision_id, m.membership_operation_id,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor, m.semantic_state_fingerprint
      INTO v_existing
      FROM public.event_observation_memberships m
      WHERE m.idempotency_fingerprint = p_idempotency_fingerprint;

    IF NOT FOUND
       OR v_existing.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_existing.decision_type IS DISTINCT FROM p_decision_type
       OR v_existing.supersedes_decision_id IS DISTINCT FROM p_supersedes_decision_id
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
        'fn_event_supersede_membership : violation d''unicité sur idempotency_fingerprint % dont l''intention committée diffère de cet appel — collision réelle, pas un rejeu.',
        p_idempotency_fingerprint;
    END IF;

    RETURN QUERY SELECT v_existing.cluster_id, v_existing.decision_id, v_existing.supersedes_decision_id, v_existing.decision_type, true;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_supersede_membership(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_supersede_membership(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;

COMMENT ON FUNCTION public.fn_event_supersede_membership IS
  'RPC atomique OPS-023 : correction autonome (AMEND/RETRACT) d''une décision de membership existante. ASSIGN rejeté (voir fn_event_assign_observation). membership_operation_id toujours NULL (réservé aux futures opérations composées comme REASSIGN). Idempotente par idempotency_fingerprint (pré-vérification + re-vérification post-verrou + récupération scopée sur violation d''unicité), intention canonique toujours revalidée. Détection explicite de prédécesseur périmé (successeur déjà existant). RETRACT ne supersède jamais un RETRACT ; AMEND peut superseder RETRACT (réouverture). N''UPDATE ni ne DELETE jamais rien. N''implémente pas REASSIGN, les revendications d''identité forte, MERGE/SPLIT, ni la création d''EVENT VERSION.';

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
--      AND p.proname = 'fn_event_supersede_membership';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique — ne jamais committer une probe de test). Suppose
--   -- une décision ASSIGN préexistante (créée via fn_event_assign_
--   -- observation, migration 0014/0015) dont le decision_id est
--   -- <assign-decision-id> et le cluster <cluster-id> :
--   BEGIN;
--     SELECT * FROM fn_event_supersede_membership(
--       p_observation_id := '<uuid observation>',
--       p_cluster_id := '<cluster-id>',
--       p_supersedes_decision_id := '<assign-decision-id>',
--       p_decision_type := 'AMEND',
--       p_membership_method := 'test_probe_amend',
--       p_evidence_digest := 'probe',
--       p_membership_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe',
--       p_idempotency_fingerprint := 'probe-fp-amend-001',
--       p_semantic_state_fingerprint := 'probe-sfp-amend-001'
--     );
--     -- attendu : une ligne, decision_type='AMEND', replayed=false.
--     -- Rejouer le même appel : attendu replayed=true, aucune nouvelle
--     -- ligne.
--     -- Puis RETRACT sur la nouvelle décision AMEND, puis tenter un
--     -- second RETRACT sur la MÊME décision AMEND avec un idempotency_
--     -- fingerprint DIFFÉRENT : attendu une exception explicite
--     -- (prédécesseur périmé), jamais une insertion silencieuse.
--   ROLLBACK;
-- =====================================================================
