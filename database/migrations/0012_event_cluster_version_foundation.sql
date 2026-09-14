-- =====================================================================
--  ALPHA-XAU — database/migrations/0012_event_cluster_version_foundation.sql
--
--  OBJET : socle DB de la chaîne EVENT CLUSTER -> EVENT VERSION (OPS-023
--  Phase 1). Sept tables additives, append-only, formant le fondement
--  déterministe-first au-dessus de la couche RAW existante
--  (news_articles, migration 0009) :
--
--    RAW OBSERVATION (news_articles, INCHANGÉE)
--      -> EVENT CLUSTER               (event_clusters)
--      -> MEMBERSHIP DECISION LEDGER  (event_observation_memberships)
--      -> EVENT VERSION                (event_versions)
--      -> EVENT VERSION EVIDENCE       (event_version_evidence)
--      -> CLUSTER RELATION OPERATIONS  (event_cluster_relation_operations
--                                        + event_cluster_relation_edges)
--      -> STRONG IDENTITY CLAIMS       (event_cluster_identity_claims)
--      -> [FRONTIÈRE — futur EVENT IMPACT, NON implémenté ici]
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - news_articles, news_events, data_sources, ingestion_runs,
--      ai_events, ai_analyses, ai_scenarios (schéma inchangé) ;
--    - le pipeline GDELT/NewsAPI/legacy (aucun code backend touché ici) ;
--    - les migrations 0001-0011 (fichiers non modifiés) ;
--    - aucune ligne existante (aucun backfill — sept tables neuves,
--      vides à l'application).
--
--  ADDITIVE / RÉVERSIBLE. Sept tables neuves uniquement : ne pas
--  appliquer cette migration équivaut à ne rien changer au système
--  existant. Aucun DROP, aucun ALTER d'objet préexistant.
--
--  PÉRIMÈTRE EXPLICITEMENT HORS DE CETTE MIGRATION (voir OPS-023 §13,
--  architecture gelée, non implémentée ici) :
--    - le processeur de clustering/versioning lui-même ;
--    - les fonctions RPC atomiques (fn_create_event_version,
--      fn_reassign_membership, fn_create_cluster_relation_operation, ...)
--      et leur discipline de verrous advisory par cluster_id ;
--    - la formule exacte de calcul de idempotency_fingerprint /
--      state_fingerprint / semantic_state_fingerprint (calculée par la
--      future couche applicative — ici, simples colonnes TEXT NOT NULL
--      contraintes en unicité, jamais des colonnes GENERATED, car leur
--      entrée dépend de la requête appelante, pas seulement des colonnes
--      de la ligne) ;
--    - le futur objet EVENT IMPACT (direction/magnitude/confiance/
--      horizon/pricing) — aucun champ analytique de cette nature
--      n'apparaît sur event_versions, par construction du schéma.
--
--  IDENTITÉ DÉTERMINISTE. Même pattern que news_articles.observation_hash
--  (migration 0009) : extensions.digest(..., 'sha256') / encode(...,
--  'hex'), colonnes GENERATED ALWAYS ... STORED. Aucune dépendance à
--  uuid-ossp / uuid_generate_v5 (jamais vérifiée disponible sur ce
--  projet — voir audit d'architecture OPS-023).
--
--  APPEND-ONLY. Une seule fonction trigger réutilisée sur les sept
--  tables (fn_event_schema_append_only) plutôt que sept fonctions
--  dupliquées : même rejet inconditionnel de UPDATE/DELETE que
--  fn_news_articles_append_only (migration 0009), effectif y compris
--  pour service_role (BYPASSRLS dispense des policies RLS, pas des
--  triggers).
--
--  IDEMPOTENTE (fichier) : IF NOT EXISTS / CREATE OR REPLACE / DROP+
--  CREATE TRIGGER — rejouable sans effet si déjà appliquée.
--
--  PRÉREQUIS : migrations 0001-0011 (news_articles, data_sources,
--  ingestion_runs). N'ALTÈRE AUCUNE D'ENTRE ELLES.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. FONCTION APPEND-ONLY PARTAGÉE
--    Réutilisée sur les sept tables ci-dessous. Même contrat que
--    fn_news_articles_append_only (migration 0009) : rejette
--    inconditionnellement UPDATE et DELETE, y compris pour service_role.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_event_schema_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% est append-only (OPS-023) : % interdit. Une correction doit être insérée comme une NOUVELLE ligne, jamais comme une modification de la ligne existante.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

COMMENT ON FUNCTION fn_event_schema_append_only IS
  'Fonction trigger append-only partagée par les sept tables OPS-023 (event_clusters, event_observation_memberships, event_versions, event_version_evidence, event_cluster_relation_operations, event_cluster_relation_edges, event_cluster_identity_claims). Même contrat que fn_news_articles_append_only (migration 0009).';

-- ---------------------------------------------------------------------
-- 1. EVENT_CLUSTERS
--    Identité stable d'UN événement réel. Structurel, append-only,
--    AUCUNE colonne mutable-adjacente : pas de strong_identity_key ici
--    (voir event_cluster_identity_claims, §7) ni de pointeur "version
--    courante" (l'état courant est toujours une requête sur
--    event_versions, jamais une colonne mise en cache).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_clusters (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Empreinte candidate pour le matching flou (tiers 3 de l'identité
  -- déterministe). Volontairement NON UNIQUE : une collision de clé
  -- floue entre deux événements réellement distincts ne doit jamais
  -- forcer une fusion.
  cluster_key           TEXT NOT NULL CHECK (length(btrim(cluster_key)) > 0),
  category               TEXT,
  region                 TEXT,

  -- Observation RAW fondatrice. RESTRICT (jamais SET NULL) : la
  -- provenance d'un cluster ne doit jamais devenir orpheline.
  first_observation_id  UUID NOT NULL
                          REFERENCES news_articles (id) ON DELETE RESTRICT,

  algorithm_version      TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE event_clusters IS
  'Identité stable d''UN événement réel (OPS-023). Append-only, zéro colonne mutable. L''identité forte (strong_identity_key) vit exclusivement dans event_cluster_identity_claims — jamais ici, car une revendication d''identité forte peut arriver après la création du cluster et ce dernier ne peut pas recevoir d''UPDATE.';
COMMENT ON COLUMN event_clusters.cluster_key IS
  'Empreinte de correspondance floue (entité/catégorie/région/fenêtre temporelle normalisées). Indexée pour la recherche de candidats, jamais contrainte en unicité : une collision de clé floue entre deux événements distincts ne doit jamais forcer une fusion.';

-- ---------------------------------------------------------------------
-- 2. EVENT_OBSERVATION_MEMBERSHIPS
--    Registre de décisions immuable. Supporte le many-to-many
--    observation <-> cluster : PK = decision_id (surrogate), PAS
--    observation_id (qui forcerait un cardinalité 1:1). L'identité
--    logique de la relation (observation, cluster) est portée par
--    relation_key, une colonne GENERATED déterministe (même pattern que
--    news_articles.observation_hash) : deux tentatives indépendantes
--    d'ASSIGN sur la même paire calculent la même clé, et
--    UNIQUE(relation_key) WHERE decision_type='ASSIGN' empêche toute
--    ouverture dupliquée.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_observation_memberships (
  decision_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  observation_id                 UUID NOT NULL
                                   REFERENCES news_articles (id) ON DELETE RESTRICT,
  cluster_id                     UUID NOT NULL
                                   REFERENCES event_clusters (id) ON DELETE RESTRICT,

  -- Identité déterministe de la relation logique (observation, cluster).
  -- Même pattern que news_articles.observation_hash (migration 0009) :
  -- extensions.digest(..., 'sha256') / encode(..., 'hex'), colonne
  -- GENERATED STORED. Aucune dépendance à uuid-ossp / uuid_generate_v5.
  relation_key                   TEXT GENERATED ALWAYS AS (
                                    encode(
                                      extensions.digest(
                                        observation_id::text || chr(31) || cluster_id::text,
                                        'sha256'
                                      ),
                                      'hex'
                                    )
                                  ) STORED,

  decision_type                  TEXT NOT NULL
                                   CHECK (decision_type IN ('ASSIGN', 'AMEND', 'RETRACT')),

  -- Décision antérieure corrigée/close par cette ligne (AMEND/RETRACT).
  -- RESTRICT, jamais SET NULL : une décision référencée ne doit jamais
  -- devenir orpheline.
  supersedes_decision_id         UUID
                                   REFERENCES event_observation_memberships (decision_id) ON DELETE RESTRICT,

  -- Corrélateur déterministe (SHA-256, calculé côté application) reliant
  -- les deux décisions d'une réassignation atomique (RETRACT côté
  -- source + ASSIGN/AMEND côté destination). NULL pour une décision
  -- autonome. Non contraint en unicité ici : la même valeur apparaît
  -- délibérément sur exactement deux lignes par construction.
  membership_operation_id        TEXT,

  membership_method              TEXT NOT NULL CHECK (length(btrim(membership_method)) > 0),
  membership_confidence          NUMERIC(5,4)
                                   CHECK (membership_confidence IS NULL
                                          OR membership_confidence BETWEEN 0 AND 1),
  evidence_digest                TEXT NOT NULL CHECK (length(btrim(evidence_digest)) > 0),

  -- Faits de provenance/lignage BRUTS uniquement (jamais de conclusion
  -- relationnelle du type DISTINCT_ORG/WIRE_MATCHED — cette conclusion
  -- appartient exclusivement au résumé figé au niveau EVENT VERSION,
  -- calculé à partir de l'ensemble des preuves connues à cet instant).
  editorial_origin_key           TEXT,
  wire_lineage_key               TEXT,
  lineage_resolution_method      TEXT,
  lineage_resolution_confidence  NUMERIC(5,4)
                                   CHECK (lineage_resolution_confidence IS NULL
                                          OR lineage_resolution_confidence BETWEEN 0 AND 1),
  lineage_evidence               TEXT,

  algorithm_version               TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  decision_actor                  TEXT NOT NULL CHECK (length(btrim(decision_actor)) > 0),

  -- Clé de rejeu idempotent (retry-safe). Calculée côté application à
  -- partir de l'intention canonique de la requête (voir OPS-023,
  -- discipline RPC gelée, non implémentée ici) — jamais une colonne
  -- GENERATED : son entrée dépend de la requête appelante, pas
  -- uniquement des colonnes de cette ligne.
  idempotency_fingerprint         TEXT NOT NULL CHECK (length(btrim(idempotency_fingerprint)) > 0),

  -- Empreinte de contenu SEULE (sémantique, pas de processus). Volon-
  -- tairement NON UNIQUE : une récurrence légitime d'état (A -> B -> A)
  -- doit rester représentable.
  semantic_state_fingerprint      TEXT NOT NULL CHECK (length(btrim(semantic_state_fingerprint)) > 0),

  assigned_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactement une ouverture ASSIGN par relation logique (observation,
-- cluster), à jamais : deux tentatives indépendantes calculent la même
-- relation_key déterministe et la seconde INSERT échoue ici. Un index
-- UNIQUE partiel est la seule forme capable d'exprimer le prédicat
-- WHERE decision_type = 'ASSIGN' — une contrainte UNIQUE de table ne le
-- permet pas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_memberships_relation_key_assign
  ON event_observation_memberships (relation_key)
  WHERE decision_type = 'ASSIGN';

-- Anti-contradiction : deux décisions ne peuvent jamais superseder la
-- même décision antérieure (empêche deux corrections concurrentes
-- contradictoires de coexister comme "vivantes").
CREATE UNIQUE INDEX IF NOT EXISTS uq_memberships_supersedes_decision
  ON event_observation_memberships (supersedes_decision_id)
  WHERE supersedes_decision_id IS NOT NULL;

-- Sécurité de rejeu (retry-safe) : un appel RPC rejoué à l'identique
-- (réponse perdue après commit) ne doit jamais créer une seconde ligne.
CREATE UNIQUE INDEX IF NOT EXISTS uq_memberships_idempotency_fingerprint
  ON event_observation_memberships (idempotency_fingerprint);

COMMENT ON TABLE event_observation_memberships IS
  'Registre de décisions immuable liant une observation RAW à un cluster (OPS-023). Many-to-many par construction : PK = decision_id (surrogate), jamais observation_id. Aucun drapeau is_current mutable — l''état courant est toujours dérivé par requête (décision non supersédée). decision_type ∈ {ASSIGN, AMEND, RETRACT} : REASSIGN n''existe pas au niveau ligne, c''est une opération RPC orchestrant deux décisions atomiques (RETRACT côté source + ASSIGN/AMEND côté destination), corrélées par membership_operation_id.';
COMMENT ON COLUMN event_observation_memberships.relation_key IS
  'Identité déterministe de la relation logique (observation_id, cluster_id) — sha256 hex, GENERATED STORED, même pattern que news_articles.observation_hash. UNIQUE(relation_key) WHERE decision_type=''ASSIGN'' (index partiel ci-dessous) garantit exactement une ouverture par relation, à jamais.';
COMMENT ON COLUMN event_observation_memberships.editorial_origin_key IS
  'Fait de lignage BRUT (identifiant d''organisation éditoriale résolu, si connu). provider/source_code/source_domain (news_articles) ne prouvent JAMAIS à eux seuls l''indépendance éditoriale — cette détermination relationnelle est calculée et figée au niveau EVENT VERSION à partir de l''ensemble des preuves, jamais stockée comme conclusion sur cette ligne.';

-- ---------------------------------------------------------------------
-- 2bis. VALIDATION SÉMANTIQUE DE LA CHAÎNE DE SUPERSESSION
--    Invariant DB, pas seulement applicatif (la future RPC ne doit pas
--    être le seul rempart) :
--      ASSIGN  -> supersedes_decision_id IS NULL (ouverture fraîche)
--      AMEND/RETRACT -> supersedes_decision_id IS NOT NULL, la décision
--        antérieure référencée existe, porte sur la MÊME observation ET
--        la MÊME relation logique (observation, cluster).
--
--    relation_key est une colonne GENERATED : dans un trigger BEFORE
--    INSERT, PostgreSQL ne l'a pas encore calculée pour NEW (les
--    colonnes générées sont produites APRÈS les triggers BEFORE ROW) —
--    NEW.relation_key n'est donc pas fiable ici. On recalcule la même
--    expression déterministe à partir de NEW.observation_id/
--    NEW.cluster_id (colonnes ordinaires, disponibles dès BEFORE INSERT)
--    et on la compare à la valeur RÉELLEMENT matérialisée de la décision
--    antérieure (déjà commitée, donc fiable en lecture).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_membership_decision_supersession()
RETURNS TRIGGER
LANGUAGE plpgsql
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
    FROM event_observation_memberships
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

COMMENT ON FUNCTION fn_check_membership_decision_supersession IS
  'Invariant DB (pas seulement RPC) sur event_observation_memberships : ASSIGN ne supersède jamais rien ; AMEND/RETRACT doivent référencer une décision antérieure existante, portant sur la même observation ET la même relation logique (observation, cluster). relation_key est recalculée depuis NEW.observation_id/NEW.cluster_id, jamais lue depuis NEW.relation_key (colonne GENERATED, non encore calculée en trigger BEFORE INSERT).';

DROP TRIGGER IF EXISTS trg_membership_decision_supersession ON event_observation_memberships;
CREATE TRIGGER trg_membership_decision_supersession
  BEFORE INSERT ON event_observation_memberships
  FOR EACH ROW EXECUTE FUNCTION fn_check_membership_decision_supersession();

-- ---------------------------------------------------------------------
-- 3. EVENT_VERSIONS
--    Instantané immuable de l'état de connaissance matériel d'un
--    cluster à un instant T. N'avance QUE sur changement sémantique
--    matériel (voir OPS-023 : state_fingerprint), jamais une ligne par
--    observation. Aucun champ analytique (direction/magnitude/
--    confiance/pricing/H1-H5) — cette frontière appartient exclusive-
--    ment au futur EVENT IMPACT, non implémenté ici.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_versions (
  id                                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id                              UUID NOT NULL
                                            REFERENCES event_clusters (id) ON DELETE RESTRICT,
  version_number                          INTEGER NOT NULL CHECK (version_number > 0),

  transition_type                         TEXT NOT NULL
                                            CHECK (transition_type IN (
                                              'NOVELTY', 'CONFIRMATION', 'CORRECTION', 'REVERSAL'
                                            )),

  -- Borne de rejeu (replay) : MAX(known_at) de tous les faits consommés
  -- par cette version (observations, décisions de membership, opéra-
  -- tions de relation, revendications d'identité). JAMAIS published_at/
  -- published_date (déclaration de la source, non fiable pour borner ce
  -- que le système savait réellement).
  knowledge_cutoff                        TIMESTAMPTZ NOT NULL,

  effective_time                          TIMESTAMPTZ,
  effective_time_precision                TEXT,

  -- Représentation canonique déterministe-first de CE QUI S'EST PASSÉ
  -- (faits factuels vérifiables), jamais une évaluation d'impact
  -- marché. schema_version distinct pour permettre l'évolution du
  -- vocabulaire par type d'événement sans jamais réécrire les versions
  -- existantes.
  canonical_event_state_schema_version    SMALLINT NOT NULL CHECK (canonical_event_state_schema_version > 0),
  canonical_event_state                   JSONB NOT NULL,

  official_confirmation_state             TEXT NOT NULL
                                            CHECK (official_confirmation_state IN (
                                              'UNCONFIRMED', 'SECONDARY_CONFIRMED',
                                              'OFFICIALLY_CONFIRMED', 'OFFICIALLY_CORRECTED',
                                              'OFFICIALLY_REVERSED'
                                            )),
  source_independence_state               TEXT NOT NULL
                                            CHECK (source_independence_state IN (
                                              'UNKNOWN', 'SINGLE_EDITORIAL_ORIGIN',
                                              'SYNDICATED_ONLY', 'INDEPENDENTLY_CORROBORATED'
                                            )),

  supersedes_version_id                   UUID
                                            REFERENCES event_versions (id) ON DELETE RESTRICT,

  -- Empreinte de contenu SEULE (sémantique, edge-independent : ne
  -- contient JAMAIS transition_type, predecessor id, version_number,
  -- algorithm_version, decision_actor, created_at, ni d'identifiant de
  -- preuve brute). Volontairement NON UNIQUE : une récurrence légitime
  -- d'état (A -> B -> A) doit rester représentable.
  state_fingerprint                       TEXT NOT NULL CHECK (length(btrim(state_fingerprint)) > 0),

  -- Clé de rejeu idempotent (retry-safe), consciente du prédécesseur.
  -- Calculée côté application (future RPC), jamais GENERATED ici.
  idempotency_fingerprint                 TEXT NOT NULL CHECK (length(btrim(idempotency_fingerprint)) > 0),

  algorithm_version                       TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  decision_actor                          TEXT NOT NULL CHECK (length(btrim(decision_actor)) > 0),

  created_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_event_versions_cluster_number UNIQUE (cluster_id, version_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_versions_idempotency_fingerprint
  ON event_versions (idempotency_fingerprint);

COMMENT ON TABLE event_versions IS
  'Instantané immuable de l''état de connaissance matériel d''un cluster (OPS-023). N''avance que sur changement sémantique matériel (state_fingerprint différent du prédécesseur) — jamais une ligne par observation ni par preuve syndiquée. Aucun champ direction/magnitude/confiance/pricing/H1-H5 : cette frontière appartient exclusivement au futur EVENT IMPACT.';
COMMENT ON COLUMN event_versions.knowledge_cutoff IS
  'MAX(known_at) de TOUS les faits consommés par cette version (observation: GREATEST(observed_at,ingested_at) ; décision de membership: assigned_at ; opération de relation: decided_at ; revendication d''identité: asserted_at). Jamais published_at/published_date — ces derniers restent des horodatages événement/source, jamais une preuve de connaissance disponible pour le rejeu.';
COMMENT ON COLUMN event_versions.canonical_event_state IS
  'Faits factuels déterministes-first (event_type, entités, action_state, juridiction/région, attributs normalisés) — jamais une évaluation de direction/magnitude/confiance/pricing pour l''or. canonical_event_state_schema_version gate l''évolution du vocabulaire sans jamais réécrire une version existante.';
COMMENT ON COLUMN event_versions.state_fingerprint IS
  'Empreinte de CONTENU SEUL (canonical_event_state + effective_time + official_confirmation_state + source_independence_state), jamais transition_type ni predecessor id. Non unique par construction : une récurrence légitime d''état (A -> B -> A) doit rester représentable.';

-- ---------------------------------------------------------------------
-- 4. EVENT_VERSION_EVIDENCE
--    Gèle EXACTEMENT l'ensemble de preuves vivantes utilisé par CHAQUE
--    version matérielle. Référence decision_id (pas observation_id
--    directement) : fige à la fois l'observation ET le raisonnement de
--    clustering qui l'a assignée, sans jamais dupliquer de contenu
--    d'article brut.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_version_evidence (
  event_version_id   UUID NOT NULL
                       REFERENCES event_versions (id) ON DELETE RESTRICT,
  decision_id         UUID NOT NULL
                       REFERENCES event_observation_memberships (decision_id) ON DELETE RESTRICT,

  evidence_role       TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (event_version_id, decision_id)
);

COMMENT ON TABLE event_version_evidence IS
  'Gèle EXACTEMENT l''ensemble de preuves vivantes (decision_id, pas observation_id directement) utilisé par chaque EVENT VERSION matérielle, au moment de sa création (OPS-023). Aucun contenu d''article dupliqué. Une version ultérieure du même cluster prend un nouvel instantané complet des preuves alors vivantes — cette table n''implique jamais qu''une version antérieure ait connu une preuve arrivée après elle.';

-- ---------------------------------------------------------------------
-- 4bis. VALIDATION CLUSTER/TYPE DE L'EVIDENCE
--    Invariant DB, pas seulement applicatif : la version et la décision
--    référencées doivent exister, porter sur le MÊME cluster, et la
--    décision doit être d'un type actif comme preuve d'appartenance
--    (ASSIGN ou AMEND). Une RETRACT ne peut jamais être citée comme
--    preuve — elle atteste au contraire que l'observation N'appartient
--    PLUS au cluster à cet instant. Aucun chemin UPDATE n'est requis :
--    la table est append-only (voir §8), donc BEFORE INSERT suffit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_event_version_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_version_cluster_id   UUID;
  v_membership           RECORD;
BEGIN
  SELECT cluster_id
    INTO v_version_cluster_id
    FROM event_versions
    WHERE id = NEW.event_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'event_version_evidence : event_version_id % introuvable.',
      NEW.event_version_id;
  END IF;

  SELECT cluster_id, decision_type
    INTO v_membership
    FROM event_observation_memberships
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

COMMENT ON FUNCTION fn_check_event_version_evidence IS
  'Invariant DB (pas seulement RPC) sur event_version_evidence : la version et la décision référencées doivent exister, porter sur le même cluster, et la décision doit être ASSIGN ou AMEND (jamais RETRACT, qui atteste une non-appartenance).';

DROP TRIGGER IF EXISTS trg_event_version_evidence_validation ON event_version_evidence;
CREATE TRIGGER trg_event_version_evidence_validation
  BEFORE INSERT ON event_version_evidence
  FOR EACH ROW EXECUTE FUNCTION fn_check_event_version_evidence();

-- ---------------------------------------------------------------------
-- 5. EVENT_CLUSTER_RELATION_OPERATIONS + EVENT_CLUSTER_RELATION_EDGES
--    Une décision MERGE/SPLIT = UNE opération atomique (en-tête +
--    arêtes), jamais des faits de relation isolés. Le modèle en-tête +
--    arêtes (plutôt qu'une seule table à plat) évite la duplication
--    d'attributs de décision (decided_at/actor/reason/fingerprint)
--    identiques répétés sur N arêtes, et donne un point unique pour
--    l'empreinte d'idempotence de l'opération entière.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_cluster_relation_operations (
  operation_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  operation_type               TEXT NOT NULL CHECK (operation_type IN ('MERGE', 'SPLIT')),

  decided_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  algorithm_version             TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  decision_actor                TEXT NOT NULL CHECK (length(btrim(decision_actor)) > 0),
  reason                        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),

  supersedes_operation_id       UUID
                                  REFERENCES event_cluster_relation_operations (operation_id) ON DELETE RESTRICT,

  idempotency_fingerprint       TEXT NOT NULL CHECK (length(btrim(idempotency_fingerprint)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cluster_relation_ops_idempotency_fingerprint
  ON event_cluster_relation_operations (idempotency_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cluster_relation_ops_supersedes
  ON event_cluster_relation_operations (supersedes_operation_id)
  WHERE supersedes_operation_id IS NOT NULL;

COMMENT ON TABLE event_cluster_relation_operations IS
  'En-tête d''UNE décision MERGE/SPLIT atomique (OPS-023). Les arêtes membres vivent dans event_cluster_relation_edges, reliées par operation_id. UNIQUE(supersedes_operation_id) WHERE NOT NULL : deux nouvelles opérations ne peuvent jamais superseder la même opération antérieure (anti-contradiction concurrente).';

CREATE TABLE IF NOT EXISTS event_cluster_relation_edges (
  operation_id      UUID NOT NULL
                      REFERENCES event_cluster_relation_operations (operation_id) ON DELETE RESTRICT,
  from_cluster_id    UUID NOT NULL
                      REFERENCES event_clusters (id) ON DELETE RESTRICT,
  to_cluster_id      UUID NOT NULL
                      REFERENCES event_clusters (id) ON DELETE RESTRICT,

  PRIMARY KEY (operation_id, from_cluster_id, to_cluster_id),
  CONSTRAINT chk_cluster_relation_edges_distinct CHECK (from_cluster_id <> to_cluster_id)
);

COMMENT ON TABLE event_cluster_relation_edges IS
  'Arêtes membres d''une opération MERGE/SPLIT (OPS-023). MERGE : plusieurs from_cluster_id distincts -> un seul to_cluster_id. SPLIT : un seul from_cluster_id -> plusieurs to_cluster_id distincts. Cardinalité validée au COMMIT par un trigger différé sur la table d''en-tête (voir §6 ci-dessous) — la validation ne dépend jamais de la présence d''au moins une arête.';

-- ---------------------------------------------------------------------
-- 6. CARDINALITÉ MERGE/SPLIT — TRIGGER DIFFÉRÉ SUR L'EN-TÊTE
--    Même style que fn_check_scenario_probability_sum / trg_ai_scenarios
--    _probability_sum (database/schema.sql) : CONSTRAINT TRIGGER
--    DEFERRABLE INITIALLY DEFERRED, vérifié au COMMIT.
--
--    IMPORTANT (OPS-023) : le trigger est posé sur
--    event_cluster_relation_operations (l'EN-TÊTE), PAS sur
--    event_cluster_relation_edges. Un trigger posé sur la table des
--    arêtes ne se déclencherait JAMAIS pour une opération committée
--    avec ZÉRO arête (aucune ligne = aucun déclenchement) — c'est
--    exactement le trou que ce trigger doit fermer. En l'ancrant sur la
--    ligne d'en-tête (toujours insérée), le contrôle différé s'exécute
--    inconditionnellement au COMMIT, quel que soit le nombre d'arêtes
--    (y compris zéro), et interroge alors l'état final agrégé.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_cluster_relation_operation_cardinality()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation_id    UUID := NEW.operation_id;
  v_operation_type  TEXT := NEW.operation_type;
  v_from_ct         INTEGER;
  v_to_ct           INTEGER;
BEGIN
  SELECT count(DISTINCT from_cluster_id), count(DISTINCT to_cluster_id)
    INTO v_from_ct, v_to_ct
    FROM event_cluster_relation_edges
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

COMMENT ON FUNCTION fn_check_cluster_relation_operation_cardinality IS
  'Contrôle différé (COMMIT) de la cardinalité MERGE/SPLIT, ancré sur event_cluster_relation_operations (en-tête), pas sur les arêtes — ferme le trou "opération à zéro arête" qu''un trigger ancré sur les arêtes manquerait par construction (aucune ligne = aucun déclenchement).';

DROP TRIGGER IF EXISTS trg_cluster_relation_operation_cardinality
  ON event_cluster_relation_operations;
CREATE CONSTRAINT TRIGGER trg_cluster_relation_operation_cardinality
  AFTER INSERT ON event_cluster_relation_operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_cluster_relation_operation_cardinality();

-- ---------------------------------------------------------------------
-- 7. EVENT_CLUSTER_IDENTITY_CLAIMS
--    Découverte tardive d'identité forte. event_clusters est append-
--    only et ne peut donc jamais recevoir de strong_identity_key après
--    coup par UPDATE — cette table porte exclusivement cette
--    revendication, sous forme de ledger append-only séparé.
--    strong_identity_key est un identifiant D'ÉVÉNEMENT namespacé
--    (authority_namespace + identity_type + identity_value), JAMAIS un
--    identifiant d'observation brute (provider_item_id/canonical_url de
--    news_articles) promu automatiquement.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_cluster_identity_claims (
  identity_claim_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id            UUID NOT NULL
                          REFERENCES event_clusters (id) ON DELETE RESTRICT,

  authority_namespace   TEXT NOT NULL CHECK (length(btrim(authority_namespace)) > 0),
  identity_type         TEXT NOT NULL CHECK (length(btrim(identity_type)) > 0),
  identity_value        TEXT NOT NULL CHECK (length(btrim(identity_value)) > 0),

  -- Identité déterministe namespacée. Même pattern SHA-256 que
  -- news_articles.observation_hash et
  -- event_observation_memberships.relation_key. JAMAIS un identifiant
  -- d'observation (provider_item_id/canonical_url) promu automatique-
  -- ment : authority_namespace/identity_type/identity_value sont fournis
  -- par une logique de curation par source, propriété de la future
  -- couche applicative, pas de cette migration.
  strong_identity_key   TEXT GENERATED ALWAYS AS (
                          encode(
                            extensions.digest(
                              authority_namespace || chr(31) || identity_type || chr(31) || identity_value,
                              'sha256'
                            ),
                            'hex'
                          )
                        ) STORED,

  knowledge_cutoff       TIMESTAMPTZ NOT NULL,
  algorithm_version       TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  decision_actor          TEXT NOT NULL CHECK (length(btrim(decision_actor)) > 0),
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) > 0),

  supersedes_claim_id      UUID
                            REFERENCES event_cluster_identity_claims (identity_claim_id) ON DELETE RESTRICT,

  idempotency_fingerprint   TEXT NOT NULL CHECK (length(btrim(idempotency_fingerprint)) > 0),

  asserted_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_claims_idempotency_fingerprint
  ON event_cluster_identity_claims (idempotency_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_claims_supersedes
  ON event_cluster_identity_claims (supersedes_claim_id)
  WHERE supersedes_claim_id IS NOT NULL;

COMMENT ON TABLE event_cluster_identity_claims IS
  'Découverte tardive d''identité forte (OPS-023). event_clusters est append-only et ne peut jamais recevoir de strong_identity_key après coup — cette table porte exclusivement la revendication, en ledger séparé. strong_identity_key est un identifiant D''ÉVÉNEMENT namespacé (authority_namespace + identity_type + identity_value), jamais provider_item_id/canonical_url (identifiants d''OBSERVATION, news_articles) promu automatiquement.';
COMMENT ON COLUMN event_cluster_identity_claims.strong_identity_key IS
  'Identifiant d''événement namespacé et déterministe (sha256 hex, GENERATED STORED). Ne doit être peuplé que pour une source/type d''identité explicitement curé comme correspondant réellement 1:1 à un événement réel — jamais dérivé automatiquement d''un identifiant d''observation.';

-- ---------------------------------------------------------------------
-- 8. APPEND-ONLY : application du trigger partagé aux sept tables
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_event_clusters_append_only ON event_clusters;
CREATE TRIGGER trg_event_clusters_append_only
  BEFORE UPDATE OR DELETE ON event_clusters
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

DROP TRIGGER IF EXISTS trg_event_observation_memberships_append_only ON event_observation_memberships;
CREATE TRIGGER trg_event_observation_memberships_append_only
  BEFORE UPDATE OR DELETE ON event_observation_memberships
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

DROP TRIGGER IF EXISTS trg_event_versions_append_only ON event_versions;
CREATE TRIGGER trg_event_versions_append_only
  BEFORE UPDATE OR DELETE ON event_versions
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

DROP TRIGGER IF EXISTS trg_event_version_evidence_append_only ON event_version_evidence;
CREATE TRIGGER trg_event_version_evidence_append_only
  BEFORE UPDATE OR DELETE ON event_version_evidence
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

DROP TRIGGER IF EXISTS trg_event_cluster_relation_operations_append_only ON event_cluster_relation_operations;
CREATE TRIGGER trg_event_cluster_relation_operations_append_only
  BEFORE UPDATE OR DELETE ON event_cluster_relation_operations
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

DROP TRIGGER IF EXISTS trg_event_cluster_relation_edges_append_only ON event_cluster_relation_edges;
CREATE TRIGGER trg_event_cluster_relation_edges_append_only
  BEFORE UPDATE OR DELETE ON event_cluster_relation_edges
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

DROP TRIGGER IF EXISTS trg_event_cluster_identity_claims_append_only ON event_cluster_identity_claims;
CREATE TRIGGER trg_event_cluster_identity_claims_append_only
  BEFORE UPDATE OR DELETE ON event_cluster_identity_claims
  FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only();

-- ---------------------------------------------------------------------
-- 9. RLS / PRIVILÈGES — même posture que news_articles (migration 0009)
--    sur les sept tables : deny-all anon/authenticated (REVOKE explicite
--    en défense en profondeur), service_role SELECT + INSERT
--    uniquement, jamais UPDATE/DELETE (redondant avec le trigger
--    append-only, défense en profondeur).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'event_clusters',
    'event_observation_memberships',
    'event_versions',
    'event_version_evidence',
    'event_cluster_relation_operations',
    'event_cluster_relation_edges',
    'event_cluster_identity_claims'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    EXECUTE format('REVOKE ALL ON %I FROM service_role', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO service_role', t);
  END LOOP;
END
$$;

-- Aucune POLICY n'est créée pour anon/authenticated : l'absence de
-- policy avec RLS activée équivaut à un refus total (ni anon ni
-- authenticated ne sont BYPASSRLS), exactement le même contrat que
-- news_articles (migration 0009).

-- ---------------------------------------------------------------------
-- 10. INDEX OPÉRATIONNELS
--     Uniquement les index nécessaires aux accès déjà identifiés
--     (candidats de cluster, memberships par cluster/observation/date,
--     versions par cluster+numéro et par knowledge_cutoff, preuves par
--     decision_id, arêtes par cluster, revendications par cluster/clé).
--     Aucun index spéculatif.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_event_clusters_cluster_key
  ON event_clusters (cluster_key);

CREATE INDEX IF NOT EXISTS idx_memberships_cluster_id
  ON event_observation_memberships (cluster_id);
CREATE INDEX IF NOT EXISTS idx_memberships_observation_id
  ON event_observation_memberships (observation_id);
CREATE INDEX IF NOT EXISTS idx_memberships_assigned_at
  ON event_observation_memberships (assigned_at);
CREATE INDEX IF NOT EXISTS idx_memberships_semantic_state_fingerprint
  ON event_observation_memberships (semantic_state_fingerprint);
CREATE INDEX IF NOT EXISTS idx_memberships_operation_id
  ON event_observation_memberships (membership_operation_id)
  WHERE membership_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_versions_cluster_version_desc
  ON event_versions (cluster_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_event_versions_knowledge_cutoff
  ON event_versions (knowledge_cutoff);
CREATE INDEX IF NOT EXISTS idx_event_versions_state_fingerprint
  ON event_versions (state_fingerprint);

CREATE INDEX IF NOT EXISTS idx_event_version_evidence_decision_id
  ON event_version_evidence (decision_id);

CREATE INDEX IF NOT EXISTS idx_cluster_relation_edges_from
  ON event_cluster_relation_edges (from_cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_relation_edges_to
  ON event_cluster_relation_edges (to_cluster_id);

CREATE INDEX IF NOT EXISTS idx_identity_claims_cluster_id
  ON event_cluster_identity_claims (cluster_id);
CREATE INDEX IF NOT EXISTS idx_identity_claims_strong_identity_key
  ON event_cluster_identity_claims (strong_identity_key);

COMMIT;

-- =====================================================================
-- VÉRIFICATION (lecture seule, à exécuter après application)
--   SELECT tablename FROM pg_tables
--     WHERE tablename LIKE 'event_%' ORDER BY tablename;
--   -- attendu (7) : event_cluster_identity_claims, event_cluster_relation_edges,
--   -- event_cluster_relation_operations, event_clusters,
--   -- event_observation_memberships, event_version_evidence, event_versions
--
--   SELECT tgname FROM pg_trigger
--     WHERE tgrelid::regclass::text LIKE 'event_%' ORDER BY tgname;
--   -- attendu : 7 triggers *_append_only (BEFORE UPDATE OR DELETE)
--   --         + 1 trg_membership_decision_supersession (BEFORE INSERT,
--   --           event_observation_memberships)
--   --         + 1 trg_event_version_evidence_validation (BEFORE INSERT,
--   --           event_version_evidence)
--   --         + 1 trg_cluster_relation_operation_cardinality (AFTER
--   --           INSERT, DEFERRABLE INITIALLY DEFERRED,
--   --           event_cluster_relation_operations)
--
--   SELECT grantee, table_name, privilege_type
--     FROM information_schema.role_table_grants
--     WHERE table_name LIKE 'event_%'
--     ORDER BY table_name, grantee;
--   -- attendu service_role : SELECT, INSERT uniquement (pas UPDATE/DELETE)
--   -- attendu anon/authenticated : aucune ligne
--
--   -- Cardinalité MERGE/SPLIT (doit lever une exception au COMMIT) :
--   BEGIN;
--     INSERT INTO event_cluster_relation_operations
--       (operation_type, algorithm_version, decision_actor, reason, idempotency_fingerprint)
--       VALUES ('MERGE', 'test-v1', 'test', 'test sans arête', 'test-fp-zero-edges');
--   COMMIT;
--   -- attendu : ERROR — MERGE ... invalide : 0 source(s) distincte(s)
-- =====================================================================
