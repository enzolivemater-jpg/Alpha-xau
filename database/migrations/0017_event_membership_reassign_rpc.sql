-- =====================================================================
--  ALPHA-XAU — database/migrations/0017_event_membership_reassign_rpc.sql
--
--  OBJET : primitif transactionnel OPS-023 Phase 2 (suite) —
--  réassignation atomique d'une observation d'un cluster SOURCE vers un
--  cluster DESTINATION.
--
--  REASSIGN N'EST PAS un decision_type de event_observation_memberships
--  (toujours ASSIGN/AMEND/RETRACT, gelé en 0012). C'est EXACTEMENT UNE
--  opération atomique produisant DEUX décisions corrélées :
--
--    SOURCE      : RETRACT de la décision vivante actuelle sur le
--                  cluster source.
--    DESTINATION : ASSIGN si la relation (observation, cluster
--                  destination) n'a jamais existé, ou AMEND si elle
--                  existe et que sa décision vivante actuelle est un
--                  RETRACT (réouverture intentionnelle).
--
--  Les deux lignes partagent le MÊME membership_operation_id non-NULL
--  (colonne déjà présente depuis 0012, jamais utilisée avant cette
--  migration — 0014/0016 l'écrivent toujours à NULL pour leurs décisions
--  autonomes).
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0012-0016 (fichiers immuables, déjà appliqués —
--      NON modifiées) ;
--    - aucune table, contrainte, trigger, policy RLS existants, aucun
--      grant de table (seuls des GRANT/REVOKE de fonction sont
--      introduits ici) ;
--    - fn_event_lock_cluster (réutilisée telle quelle, non redéfinie).
--
--  VERROUILLAGE À DEUX CLUSTERS (prévention de interblocage) : les deux
--  verrous advisory (fn_event_lock_cluster, inchangée) sont acquis DANS
--  UN ORDRE TRIÉ DÉTERMINISTE — min(source,destination) PUIS
--  max(source,destination) — jamais "source d'abord". Cet ordre est
--  INDÉPENDANT du sens de la réassignation : deux appels concurrents
--  réassignant en sens opposés entre le MÊME couple de clusters
--  acquièrent toujours leurs verrous dans le même ordre, éliminant tout
--  interblocage croisé.
--
--  IDEMPOTENCE (à l'échelle de l'OPÉRATION, pas seulement de la ligne) :
--    - p_membership_operation_id corrèle les deux lignes.
--    - p_source_idempotency_fingerprint / p_destination_idempotency_
--      fingerprint sont deux empreintes DISTINCTES par ligne (chacune
--      unique globalement via uq_memberships_idempotency_fingerprint,
--      héritée de 0012, non dupliquée ici).
--    - PRÉ-vérification (avant tout verrou) : recherche de toute ligne
--      déjà corrélée par membership_operation_id. Zéro ligne -> on
--      continue. Exactement deux lignes formant UNE paire RETRACT +
--      (ASSIGN|AMEND) dont l'intention canonique complète correspond à
--      cet appel -> rejeu (replayed=true). Tout AUTRE compte de lignes,
--      ou une paire dont l'intention diffère (mauvais cluster, mauvaise
--      observation, mauvais type, mauvaise empreinte, mauvais
--      prédécesseur, mauvais état sémantique...) -> corruption/collision
--      d'operation_id, exception explicite, jamais un retour silencieux.
--    - RE-vérification IDENTIQUE après acquisition des DEUX verrous
--      (couvre un appel concurrent identique ayant commité pendant que
--      cet appel attendait les verrous).
--    - Filet de sécurité sur violation d'unicité scopée à
--      uq_memberships_idempotency_fingerprint uniquement (course
--      possible car idempotency_fingerprint est unique GLOBALEMENT, pas
--      par couple de clusters) — toute autre violation est relevée
--      (re-RAISE), jamais interprétée comme un rejeu.
--
--  FRAÎCHEUR ("currentness"), sous les deux verrous :
--    - le prédécesseur SOURCE doit exister, porter sur la MÊME
--      observation ET le MÊME cluster source, avoir decision_type
--      ASSIGN ou AMEND (un tip RETRACT est déjà inactif — REJETÉ
--      explicitement, jamais réassigné), et n'avoir AUCUN successeur
--      déjà commité (détection PRIMAIRE par lecture dédiée
--      WHERE supersedes_decision_id = ..., PAS une dépendance exclusive
--      à uq_memberships_supersedes_decision pour le flux normal).
--    - l'état de la relation DESTINATION (observation, cluster
--      destination) est déterminé en trouvant le tip non-supersédé de
--      cette relation logique (chaîne append-only) — jamais en se
--      fiant à assigned_at seul comme substitut de "currentness" par
--      graphe :
--        aucun tip trouvé            -> Cas A : ASSIGN frais.
--        tip trouvé, decision_type
--          = RETRACT                 -> Cas B : AMEND, supersede ce tip
--                                        (réouverture — permet
--                                        A -> B -> A sans second ASSIGN).
--        tip trouvé, ASSIGN ou AMEND -> Cas C : REJET explicite
--                                        ("relation destination déjà
--                                        active") — jamais converti en
--                                        no-op silencieux.
--
--  ATOMICITÉ : les deux INSERT vivent dans LE MÊME bloc BEGIN/EXCEPTION
--  PL/pgSQL (un seul savepoint implicite) — un échec du second INSERT
--  (destination) annule automatiquement le premier (RETRACT source) via
--  rollback au savepoint du bloc. Aucun RETRACT source ne peut jamais
--  survivre sans sa décision destination correspondante. Aucun UPDATE,
--  aucun DELETE nulle part dans cette fonction.
--
--  AMBIGUÏTÉ RETURNING (leçon de la migration 0015, appliquée dès la
--  création ici) : les deux INSERT utilisent un alias de table explicite
--  qualifié (AS m) et RETURNING m.decision_id INTO <variable dédiée> —
--  jamais un RETURNING non qualifié, même si aucun nom de sortie de
--  RETURNS TABLE ne coïncide littéralement avec "decision_id" ici
--  (source_decision_id / destination_decision_id sont distincts) : la
--  discipline de qualification systématique est appliquée partout, pas
--  seulement là où une collision est démontrée aujourd'hui.
--
--  SÉCURITÉ : SECURITY INVOKER (explicite), SET search_path = '' (durci
--  dès la création), toutes les références de relation qualifiées
--  public./pg_catalog., EXECUTE révoqué de PUBLIC/anon/authenticated
--  puis accordé à service_role uniquement. Aucun code SECURITY DEFINER.
--  Grants et RLS des TABLES existantes strictement inchangés.
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  CREATE OR REPLACE FUNCTION — rejouable sans effet si déjà appliquée.
--
--  VÉRIFICATION TRANSACTIONNELLE RÉELLE : les tests déterministes de ce
--  dépôt (analyse statique du texte SQL, sans PostgreSQL) NE PROUVENT
--  PAS le comportement transactionnel réel (atomicité du savepoint,
--  ordre effectif des verrous, absence d'interblocage). Une vérification
--  live contre Supabase (rollback/probes de non-pollution) sera
--  effectuée indépendamment, APRÈS fusion — hors périmètre de cette
--  migration.
--
--  HORS PÉRIMÈTRE ICI (gelé) : revendications d'identité forte, MERGE,
--  SPLIT, détection de cycle entre clusters, création d'EVENT VERSION,
--  processeur, worker/cron, Comité, Event Impact, Gold Transmission,
--  Silver Edge, notification, legacy, frontend, Cloudflare, Anthropic.
--  Aucune nouvelle table.
--
--  PRÉREQUIS : migrations 0001-0016 (event_clusters,
--  event_observation_memberships, fn_event_lock_cluster).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- public.fn_event_reassign_membership(...) RETURNS TABLE(...)
--
--    Paramètres SCALAIRES explicites (pas de payload JSON opaque).
--    ORDRE DE DÉCLARATION : les paramètres réellement obligatoires
--    (sans défaut) sont déclarés en premier, puis les paramètres
--    optionnels de lignage (DEFAULT NULL) — PostgreSQL l'exige. Cet
--    ordre SQL ne change rien à l'appel via PostgREST
--    (rpc/fn_event_reassign_membership), qui passe les arguments par
--    NOM (corps JSON), pas par position.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_reassign_membership(
  -- --- Obligatoires (sans défaut) ---
  p_observation_id                       UUID,
  p_source_cluster_id                    UUID,
  p_destination_cluster_id               UUID,
  p_source_supersedes_decision_id        UUID,
  p_membership_operation_id              TEXT,
  p_source_idempotency_fingerprint       TEXT,
  p_destination_idempotency_fingerprint  TEXT,
  p_source_semantic_state_fingerprint       TEXT,
  p_destination_semantic_state_fingerprint  TEXT,
  p_membership_method                    TEXT,
  p_evidence_digest                      TEXT,
  p_membership_algorithm_version         TEXT,
  p_decision_actor                       TEXT,
  -- --- Optionnels (métadonnées d'opération partagées par les deux lignes) ---
  p_membership_confidence                NUMERIC DEFAULT NULL,
  p_editorial_origin_key                 TEXT DEFAULT NULL,
  p_wire_lineage_key                     TEXT DEFAULT NULL,
  p_lineage_resolution_method            TEXT DEFAULT NULL,
  p_lineage_resolution_confidence        NUMERIC DEFAULT NULL,
  p_lineage_evidence                     TEXT DEFAULT NULL
)
RETURNS TABLE (
  observation_id            UUID,
  source_cluster_id         UUID,
  destination_cluster_id    UUID,
  source_decision_id        UUID,
  destination_decision_id   UUID,
  destination_decision_type TEXT,
  membership_operation_id   TEXT,
  replayed                  BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_op_row_count                     INTEGER;
  v_existing_source                  RECORD;
  v_existing_destination             RECORD;
  v_lock_first                       UUID;
  v_lock_second                      UUID;
  v_source_predecessor               RECORD;
  v_source_successor_exists          BOOLEAN;
  v_destination_tip                  RECORD;
  v_destination_decision_type        TEXT;
  v_destination_supersedes_decision  UUID;
  v_source_decision_id               UUID;
  v_destination_decision_id          UUID;
  v_constraint_name                  TEXT;
BEGIN
  -- ---------------------------------------------------------------
  -- ÉTAPE 1 — validation scalaire de base (aucune lecture DB).
  -- ---------------------------------------------------------------
  IF p_observation_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_observation_id ne peut pas être NULL.';
  END IF;
  IF p_source_cluster_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_source_cluster_id ne peut pas être NULL.';
  END IF;
  IF p_destination_cluster_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_destination_cluster_id ne peut pas être NULL.';
  END IF;
  IF p_source_cluster_id = p_destination_cluster_id THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_source_cluster_id et p_destination_cluster_id ne peuvent pas être identiques (%) — une réassignation vers le même cluster n''est pas une opération valide.', p_source_cluster_id;
  END IF;
  IF p_source_supersedes_decision_id IS NULL THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_source_supersedes_decision_id (prédécesseur côté source) ne peut pas être NULL.';
  END IF;
  IF p_membership_operation_id IS NULL OR length(btrim(p_membership_operation_id)) = 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_membership_operation_id est obligatoire et non vide.';
  END IF;
  IF p_source_idempotency_fingerprint IS NULL OR length(btrim(p_source_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_source_idempotency_fingerprint est obligatoire et non vide.';
  END IF;
  IF p_destination_idempotency_fingerprint IS NULL OR length(btrim(p_destination_idempotency_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_destination_idempotency_fingerprint est obligatoire et non vide.';
  END IF;
  IF p_source_idempotency_fingerprint = p_destination_idempotency_fingerprint THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_source_idempotency_fingerprint et p_destination_idempotency_fingerprint doivent être DISTINCTES (reçu la même valeur %) — deux lignes distinctes exigent deux empreintes distinctes.', p_source_idempotency_fingerprint;
  END IF;
  IF p_source_semantic_state_fingerprint IS NULL OR length(btrim(p_source_semantic_state_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_source_semantic_state_fingerprint est obligatoire et non vide.';
  END IF;
  IF p_destination_semantic_state_fingerprint IS NULL OR length(btrim(p_destination_semantic_state_fingerprint)) = 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : p_destination_semantic_state_fingerprint est obligatoire et non vide.';
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 2 — pré-vérification d'idempotence À L'ÉCHELLE DE
  -- L'OPÉRATION (chemin rapide, AVANT tout verrou). Recherche de toute
  -- ligne déjà corrélée par ce membership_operation_id.
  -- ---------------------------------------------------------------
  SELECT count(*) INTO v_op_row_count
    FROM public.event_observation_memberships m
    WHERE m.membership_operation_id = p_membership_operation_id;

  IF v_op_row_count = 2 THEN
    SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type,
           m.supersedes_decision_id, m.idempotency_fingerprint, m.semantic_state_fingerprint,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor
      INTO v_existing_source
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id
        AND m.decision_type = 'RETRACT';

    SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type,
           m.supersedes_decision_id, m.idempotency_fingerprint, m.semantic_state_fingerprint,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor
      INTO v_existing_destination
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id
        AND m.decision_type IN ('ASSIGN', 'AMEND');

    IF v_existing_source.decision_id IS NULL OR v_existing_destination.decision_id IS NULL THEN
      RAISE EXCEPTION 'fn_event_reassign_membership : membership_operation_id % corrèle 2 lignes qui ne forment pas exactement une paire RETRACT + (ASSIGN|AMEND) — corruption d''operation_id.', p_membership_operation_id;
    END IF;

    IF v_existing_source.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing_source.cluster_id IS DISTINCT FROM p_source_cluster_id
       OR v_existing_source.supersedes_decision_id IS DISTINCT FROM p_source_supersedes_decision_id
       OR v_existing_source.idempotency_fingerprint IS DISTINCT FROM p_source_idempotency_fingerprint
       OR v_existing_source.semantic_state_fingerprint IS DISTINCT FROM p_source_semantic_state_fingerprint
       OR v_existing_source.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing_source.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing_source.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing_source.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing_source.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing_source.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing_source.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing_source.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing_source.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing_source.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing_destination.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing_destination.cluster_id IS DISTINCT FROM p_destination_cluster_id
       OR v_existing_destination.idempotency_fingerprint IS DISTINCT FROM p_destination_idempotency_fingerprint
       OR v_existing_destination.semantic_state_fingerprint IS DISTINCT FROM p_destination_semantic_state_fingerprint
       OR v_existing_destination.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing_destination.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing_destination.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing_destination.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing_destination.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing_destination.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing_destination.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing_destination.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing_destination.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing_destination.decision_actor IS DISTINCT FROM p_decision_actor
    THEN
      RAISE EXCEPTION 'fn_event_reassign_membership : membership_operation_id % corrèle déjà une paire dont l''intention canonique diffère de cet appel — collision, pas un rejeu.', p_membership_operation_id;
    END IF;

    RETURN QUERY SELECT p_observation_id, p_source_cluster_id, p_destination_cluster_id,
                        v_existing_source.decision_id, v_existing_destination.decision_id,
                        v_existing_destination.decision_type, p_membership_operation_id, true;
    RETURN;
  ELSIF v_op_row_count <> 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : membership_operation_id % corrèle % ligne(s) (attendu 0 ou exactement 2) — opération partielle ou corruption d''operation_id.', p_membership_operation_id, v_op_row_count;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 3 — acquisition des DEUX verrous advisory, DANS UN ORDRE
  -- TRIÉ DÉTERMINISTE (min PUIS max), INDÉPENDANT du sens de la
  -- réassignation — prévention d'interblocage pour tout couple
  -- concurrent d'opérations touchant les MÊMES deux clusters.
  -- ---------------------------------------------------------------
  IF p_source_cluster_id < p_destination_cluster_id THEN
    v_lock_first := p_source_cluster_id;
    v_lock_second := p_destination_cluster_id;
  ELSE
    v_lock_first := p_destination_cluster_id;
    v_lock_second := p_source_cluster_id;
  END IF;

  PERFORM public.fn_event_lock_cluster(v_lock_first);
  PERFORM public.fn_event_lock_cluster(v_lock_second);

  -- ---------------------------------------------------------------
  -- ÉTAPE 4 — RE-vérification d'idempotence À L'ÉCHELLE DE
  -- L'OPÉRATION, APRÈS acquisition des DEUX verrous : couvre un appel
  -- concurrent identique ayant commité PENDANT que cet appel attendait
  -- les verrous (fenêtre entre l'étape 2 et l'étape 3). Logique
  -- identique à l'étape 2.
  -- ---------------------------------------------------------------
  SELECT count(*) INTO v_op_row_count
    FROM public.event_observation_memberships m
    WHERE m.membership_operation_id = p_membership_operation_id;

  IF v_op_row_count = 2 THEN
    SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type,
           m.supersedes_decision_id, m.idempotency_fingerprint, m.semantic_state_fingerprint,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor
      INTO v_existing_source
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id
        AND m.decision_type = 'RETRACT';

    SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type,
           m.supersedes_decision_id, m.idempotency_fingerprint, m.semantic_state_fingerprint,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor
      INTO v_existing_destination
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id
        AND m.decision_type IN ('ASSIGN', 'AMEND');

    IF v_existing_source.decision_id IS NULL OR v_existing_destination.decision_id IS NULL THEN
      RAISE EXCEPTION 'fn_event_reassign_membership : membership_operation_id % corrèle 2 lignes qui ne forment pas exactement une paire RETRACT + (ASSIGN|AMEND) — corruption d''operation_id.', p_membership_operation_id;
    END IF;

    IF v_existing_source.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing_source.cluster_id IS DISTINCT FROM p_source_cluster_id
       OR v_existing_source.supersedes_decision_id IS DISTINCT FROM p_source_supersedes_decision_id
       OR v_existing_source.idempotency_fingerprint IS DISTINCT FROM p_source_idempotency_fingerprint
       OR v_existing_source.semantic_state_fingerprint IS DISTINCT FROM p_source_semantic_state_fingerprint
       OR v_existing_source.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing_source.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing_source.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing_source.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing_source.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing_source.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing_source.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing_source.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing_source.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing_source.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing_destination.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing_destination.cluster_id IS DISTINCT FROM p_destination_cluster_id
       OR v_existing_destination.idempotency_fingerprint IS DISTINCT FROM p_destination_idempotency_fingerprint
       OR v_existing_destination.semantic_state_fingerprint IS DISTINCT FROM p_destination_semantic_state_fingerprint
       OR v_existing_destination.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing_destination.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing_destination.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing_destination.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing_destination.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing_destination.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing_destination.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing_destination.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing_destination.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing_destination.decision_actor IS DISTINCT FROM p_decision_actor
    THEN
      RAISE EXCEPTION 'fn_event_reassign_membership : membership_operation_id % corrèle déjà une paire dont l''intention canonique diffère de cet appel — collision, pas un rejeu.', p_membership_operation_id;
    END IF;

    RETURN QUERY SELECT p_observation_id, p_source_cluster_id, p_destination_cluster_id,
                        v_existing_source.decision_id, v_existing_destination.decision_id,
                        v_existing_destination.decision_type, p_membership_operation_id, true;
    RETURN;
  ELSIF v_op_row_count <> 0 THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : membership_operation_id % corrèle % ligne(s) (attendu 0 ou exactement 2) — opération partielle ou corruption d''operation_id.', p_membership_operation_id, v_op_row_count;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 5 — existence + fraîcheur du prédécesseur SOURCE, SOUS LES
  -- DEUX VERROUS.
  -- ---------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM public.event_clusters WHERE id = p_source_cluster_id) THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : cluster source % introuvable.', p_source_cluster_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.event_clusters WHERE id = p_destination_cluster_id) THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : cluster destination % introuvable.', p_destination_cluster_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.news_articles WHERE id = p_observation_id) THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : observation % introuvable (RAW).', p_observation_id;
  END IF;

  SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type
    INTO v_source_predecessor
    FROM public.event_observation_memberships m
    WHERE m.decision_id = p_source_supersedes_decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : décision prédécesseur source % (p_source_supersedes_decision_id) introuvable.', p_source_supersedes_decision_id;
  END IF;
  IF v_source_predecessor.observation_id IS DISTINCT FROM p_observation_id THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : le prédécesseur source % porte sur une observation différente (attendu %, trouvé %).', p_source_supersedes_decision_id, p_observation_id, v_source_predecessor.observation_id;
  END IF;
  IF v_source_predecessor.cluster_id IS DISTINCT FROM p_source_cluster_id THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : le prédécesseur source % porte sur un cluster différent (attendu %, trouvé %).', p_source_supersedes_decision_id, p_source_cluster_id, v_source_predecessor.cluster_id;
  END IF;
  IF v_source_predecessor.decision_type NOT IN ('ASSIGN', 'AMEND') THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : le prédécesseur source % a decision_type % — seul un tip vivant ASSIGN ou AMEND peut être réassigné (un tip RETRACT est déjà inactif).', p_source_supersedes_decision_id, v_source_predecessor.decision_type;
  END IF;

  -- Fraîcheur explicite : un successeur existe-t-il déjà pour ce
  -- prédécesseur source ? Détection PRIMAIRE par lecture dédiée — pas
  -- une dépendance exclusive à uq_memberships_supersedes_decision.
  -- Ayant déjà écarté un rejeu (étapes 2 et 4), tout successeur trouvé
  -- ici est nécessairement une intention concurrente DIFFÉRENTE.
  SELECT EXISTS (
    SELECT 1 FROM public.event_observation_memberships m
    WHERE m.supersedes_decision_id = p_source_supersedes_decision_id
  ) INTO v_source_successor_exists;

  IF v_source_successor_exists THEN
    RAISE EXCEPTION 'fn_event_reassign_membership : prédécesseur source % périmé — un successeur existe déjà (pas le tip vivant).', p_source_supersedes_decision_id;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 6 — état de la relation DESTINATION, SOUS LES DEUX VERROUS.
  -- Tip = décision non-supersédée pour (observation, cluster
  -- destination). La chaîne est append-only ; on ne se fie jamais à
  -- assigned_at seul comme substitut de "currentness" par graphe.
  -- ---------------------------------------------------------------
  SELECT m.decision_id, m.decision_type
    INTO v_destination_tip
    FROM public.event_observation_memberships m
    WHERE m.observation_id = p_observation_id
      AND m.cluster_id = p_destination_cluster_id
      AND NOT EXISTS (
        SELECT 1 FROM public.event_observation_memberships s
        WHERE s.supersedes_decision_id = m.decision_id
      );

  IF NOT FOUND THEN
    -- Cas A : la relation logique (observation, cluster destination)
    -- n'a jamais existé -> ouverture fraîche.
    v_destination_decision_type := 'ASSIGN';
    v_destination_supersedes_decision := NULL;
  ELSIF v_destination_tip.decision_type = 'RETRACT' THEN
    -- Cas B : la relation existe et son tip vivant est RETRACT ->
    -- réouverture intentionnelle (permet A -> B -> A sans second
    -- ASSIGN sur la relation A).
    v_destination_decision_type := 'AMEND';
    v_destination_supersedes_decision := v_destination_tip.decision_id;
  ELSE
    -- Cas C : la relation destination est déjà active (ASSIGN ou
    -- AMEND vivant) -> REJET explicite, jamais un no-op silencieux.
    RAISE EXCEPTION 'fn_event_reassign_membership : la relation destination (observation %, cluster %) est déjà active (tip vivant % de type %) — la cible d''une réassignation doit être soit nouvelle, soit actuellement RETRACTée.', p_observation_id, p_destination_cluster_id, v_destination_tip.decision_id, v_destination_tip.decision_type;
  END IF;

  -- ---------------------------------------------------------------
  -- ÉTAPE 7 — insertion atomique des DEUX lignes, DANS LE MÊME bloc
  -- BEGIN/EXCEPTION (un seul savepoint implicite) : un échec du second
  -- INSERT (destination) annule automatiquement le premier (RETRACT
  -- source). Alias de table explicite qualifié + RETURNING qualifié
  -- (leçon 0015) sur les deux INSERT.
  -- ---------------------------------------------------------------
  BEGIN
    INSERT INTO public.event_observation_memberships AS m (
      observation_id, cluster_id, decision_type, supersedes_decision_id, membership_operation_id,
      membership_method, membership_confidence, evidence_digest,
      editorial_origin_key, wire_lineage_key, lineage_resolution_method,
      lineage_resolution_confidence, lineage_evidence,
      algorithm_version, decision_actor, idempotency_fingerprint, semantic_state_fingerprint
    ) VALUES (
      p_observation_id, p_source_cluster_id, 'RETRACT', p_source_supersedes_decision_id, p_membership_operation_id,
      p_membership_method, p_membership_confidence, p_evidence_digest,
      p_editorial_origin_key, p_wire_lineage_key, p_lineage_resolution_method,
      p_lineage_resolution_confidence, p_lineage_evidence,
      p_membership_algorithm_version, p_decision_actor, p_source_idempotency_fingerprint, p_source_semantic_state_fingerprint
    )
    RETURNING m.decision_id INTO v_source_decision_id;

    INSERT INTO public.event_observation_memberships AS m (
      observation_id, cluster_id, decision_type, supersedes_decision_id, membership_operation_id,
      membership_method, membership_confidence, evidence_digest,
      editorial_origin_key, wire_lineage_key, lineage_resolution_method,
      lineage_resolution_confidence, lineage_evidence,
      algorithm_version, decision_actor, idempotency_fingerprint, semantic_state_fingerprint
    ) VALUES (
      p_observation_id, p_destination_cluster_id, v_destination_decision_type, v_destination_supersedes_decision, p_membership_operation_id,
      p_membership_method, p_membership_confidence, p_evidence_digest,
      p_editorial_origin_key, p_wire_lineage_key, p_lineage_resolution_method,
      p_lineage_resolution_confidence, p_lineage_evidence,
      p_membership_algorithm_version, p_decision_actor, p_destination_idempotency_fingerprint, p_destination_semantic_state_fingerprint
    )
    RETURNING m.decision_id INTO v_destination_decision_id;

    RETURN QUERY SELECT p_observation_id, p_source_cluster_id, p_destination_cluster_id,
                        v_source_decision_id, v_destination_decision_id,
                        v_destination_decision_type, p_membership_operation_id, false;
    RETURN;

  EXCEPTION WHEN unique_violation THEN
    -- Filet de sécurité : collision GLOBALE d'idempotency_fingerprint
    -- (unique sur TOUTE la table, pas par couple de clusters). Comme
    -- les deux verrous de CE couple sont tenus depuis l'étape 3
    -- jusqu'ici, un appel réellement IDENTIQUE touchant le MÊME couple
    -- de clusters se serait bloqué sur ces verrous, jamais entré en
    -- course ici — le seul scénario réaliste est une empreinte
    -- dupliquée par erreur avec un appel concurrent sur un AUTRE couple
    -- de clusters. On ne récupère QUE cette violation précise : toute
    -- autre (ex. uq_memberships_supersedes_decision,
    -- uq_memberships_relation_key_assign — déjà censées être exclues
    -- par les vérifications explicites de fraîcheur/état ci-dessus,
    -- sous verrou) est relevée telle quelle (re-RAISE).
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN
      RAISE;
    END IF;

    SELECT count(*) INTO v_op_row_count
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id;

    IF v_op_row_count <> 2 THEN
      RAISE EXCEPTION 'fn_event_reassign_membership : violation d''unicité sur idempotency_fingerprint pendant l''opération %, mais membership_operation_id corrèle % ligne(s) (attendu exactement 2) — corruption réelle, pas un rejeu récupérable.', p_membership_operation_id, v_op_row_count;
    END IF;

    SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type,
           m.supersedes_decision_id, m.idempotency_fingerprint, m.semantic_state_fingerprint,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor
      INTO v_existing_source
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id
        AND m.decision_type = 'RETRACT';

    SELECT m.decision_id, m.observation_id, m.cluster_id, m.decision_type,
           m.supersedes_decision_id, m.idempotency_fingerprint, m.semantic_state_fingerprint,
           m.membership_method, m.membership_confidence, m.evidence_digest,
           m.editorial_origin_key, m.wire_lineage_key, m.lineage_resolution_method,
           m.lineage_resolution_confidence, m.lineage_evidence,
           m.algorithm_version, m.decision_actor
      INTO v_existing_destination
      FROM public.event_observation_memberships m
      WHERE m.membership_operation_id = p_membership_operation_id
        AND m.decision_type IN ('ASSIGN', 'AMEND');

    IF v_existing_source.decision_id IS NULL
       OR v_existing_destination.decision_id IS NULL
       OR v_existing_source.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing_source.cluster_id IS DISTINCT FROM p_source_cluster_id
       OR v_existing_source.supersedes_decision_id IS DISTINCT FROM p_source_supersedes_decision_id
       OR v_existing_source.idempotency_fingerprint IS DISTINCT FROM p_source_idempotency_fingerprint
       OR v_existing_source.semantic_state_fingerprint IS DISTINCT FROM p_source_semantic_state_fingerprint
       OR v_existing_source.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing_source.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing_source.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing_source.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing_source.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing_source.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing_source.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing_source.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing_source.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing_source.decision_actor IS DISTINCT FROM p_decision_actor
       OR v_existing_destination.observation_id IS DISTINCT FROM p_observation_id
       OR v_existing_destination.cluster_id IS DISTINCT FROM p_destination_cluster_id
       OR v_existing_destination.idempotency_fingerprint IS DISTINCT FROM p_destination_idempotency_fingerprint
       OR v_existing_destination.semantic_state_fingerprint IS DISTINCT FROM p_destination_semantic_state_fingerprint
       OR v_existing_destination.membership_method IS DISTINCT FROM p_membership_method
       OR v_existing_destination.membership_confidence IS DISTINCT FROM p_membership_confidence
       OR v_existing_destination.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing_destination.editorial_origin_key IS DISTINCT FROM p_editorial_origin_key
       OR v_existing_destination.wire_lineage_key IS DISTINCT FROM p_wire_lineage_key
       OR v_existing_destination.lineage_resolution_method IS DISTINCT FROM p_lineage_resolution_method
       OR v_existing_destination.lineage_resolution_confidence IS DISTINCT FROM p_lineage_resolution_confidence
       OR v_existing_destination.lineage_evidence IS DISTINCT FROM p_lineage_evidence
       OR v_existing_destination.algorithm_version IS DISTINCT FROM p_membership_algorithm_version
       OR v_existing_destination.decision_actor IS DISTINCT FROM p_decision_actor
    THEN
      RAISE EXCEPTION 'fn_event_reassign_membership : violation d''unicité sur idempotency_fingerprint pendant l''opération %, dont la paire committée diffère de cet appel — collision réelle, pas un rejeu.', p_membership_operation_id;
    END IF;

    RETURN QUERY SELECT p_observation_id, p_source_cluster_id, p_destination_cluster_id,
                        v_existing_source.decision_id, v_existing_destination.decision_id,
                        v_existing_destination.decision_type, p_membership_operation_id, true;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_event_reassign_membership(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_event_reassign_membership(
  UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;

COMMENT ON FUNCTION public.fn_event_reassign_membership IS
  'RPC atomique OPS-023 : réassignation d''une observation d''un cluster source vers un cluster destination — EXACTEMENT une opération produisant deux décisions corrélées (RETRACT source + ASSIGN|AMEND destination selon l''état du tip destination), partageant le même membership_operation_id non-NULL. Verrous advisory des deux clusters acquis en ordre trié déterministe (min puis max), indépendant du sens. Idempotente à l''échelle de l''opération (membership_operation_id) : pré-vérification + re-vérification post-verrous + récupération scopée sur violation d''unicité, intention canonique des deux lignes toujours revalidée. Tip source RETRACT rejeté (inactif). Relation destination déjà active (ASSIGN|AMEND) rejetée explicitement, jamais convertie en no-op. Les deux INSERT vivent dans le même bloc BEGIN/EXCEPTION : aucun RETRACT source ne peut survivre sans sa décision destination. N''UPDATE ni ne DELETE jamais rien. N''implémente pas les revendications d''identité forte, MERGE/SPLIT, la détection de cycle, ni la création d''EVENT VERSION.';

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
--      AND p.proname = 'fn_event_reassign_membership';
--   -- attendu : search_path_setting = 'search_path=', prosecdef = false.
--
--   -- Probe de non-pollution (à exécuter en transaction, ROLLBACK
--   -- systématique — ne jamais committer une probe de test). Suppose
--   -- une décision ASSIGN préexistante (créée via fn_event_assign_
--   -- observation, migration 0014/0015) dont le decision_id est
--   -- <assign-decision-id> sur <cluster-source>, et un second cluster
--   -- <cluster-destination> déjà existant sans relation avec
--   -- l'observation :
--   BEGIN;
--     SELECT * FROM fn_event_reassign_membership(
--       p_observation_id := '<uuid observation>',
--       p_source_cluster_id := '<cluster-source>',
--       p_destination_cluster_id := '<cluster-destination>',
--       p_source_supersedes_decision_id := '<assign-decision-id>',
--       p_membership_operation_id := 'probe-op-reassign-001',
--       p_source_idempotency_fingerprint := 'probe-fp-reassign-src-001',
--       p_destination_idempotency_fingerprint := 'probe-fp-reassign-dst-001',
--       p_source_semantic_state_fingerprint := 'probe-sfp-reassign-src-001',
--       p_destination_semantic_state_fingerprint := 'probe-sfp-reassign-dst-001',
--       p_membership_method := 'test_probe_reassign',
--       p_evidence_digest := 'probe',
--       p_membership_algorithm_version := 'probe-v1',
--       p_decision_actor := 'ops023-probe'
--     );
--     -- attendu : une ligne, destination_decision_type='ASSIGN' (cas A),
--     -- replayed=false. Rejouer le même appel : attendu replayed=true,
--     -- aucune nouvelle ligne. Réassigner ensuite <cluster-destination>
--     -- -> <cluster-source> (sens inverse, nouveau membership_operation_id
--     -- et nouvelles empreintes) : attendu destination_decision_type=
--     -- 'AMEND' (cas B, réouverture de la relation A).
--   ROLLBACK;
-- =====================================================================
