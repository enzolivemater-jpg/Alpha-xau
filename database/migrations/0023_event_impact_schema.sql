-- =====================================================================
--  ALPHA-XAU — database/migrations/0023_event_impact_schema.sql
--
--  OBJET : PR-EI-1 — socle DB SCHEMA-ONLY de l'objet EVENT IMPACT,
--  l'étape d'architecture suivant immédiatement le socle EVENT CLUSTER /
--  EVENT VERSION (OPS-023, migrations 0012-0022, implémenté et
--  live-proven en production, manuel uniquement).
--
--    EVENT VERSION (public.event_versions, INCHANGÉE)
--      -> EVENT IMPACT ASSESSMENT      (event_impact_assessments)
--      -> EVENT IMPACT INTERPRETATION  (event_impact_interpretations)
--      -> [FRONTIÈRE — futur domaine déterministe/RPC/runtime EVENT
--          IMPACT, Gold Transmission, Market Pricing, NON implémentés
--          ici]
--
--  CETTE MIGRATION EST SCHEMA-ONLY. Elle N'INTRODUIT AUCUN(E) :
--    - logique domaine Event Impact (processeur déterministe) ;
--    - RPC de persistance atomique (fn_event_impact_create_assessment
--      ou équivalent — future migration séparée, après revue
--      indépendante) ;
--    - route Worker / runtime HTTP authentifié ;
--    - déclenchement planifié récurrent / scheduled() / JobName ;
--    - découverte (discovery) ou backfill automatique ;
--    - intégration Committee, Portfolio Manager, Risk Committee ;
--    - champ Gold Transmission (transmission_channel, real_yield_effect,
--      usd_effect, safe_haven_effect, liquidity_effect, ...) ;
--    - champ Market Pricing / Positioning / Regime au-delà du seul
--      vocabulaire pricing_state figé ci-dessous (aucune table de
--      pricing, aucune inférence) ;
--    - dépendance à un fournisseur LLM externe d'aucune sorte ;
--    - ligne de donnée Event Impact réelle (aucun INSERT ici) ;
--    - application live contre Supabase (DDL de dépôt uniquement — voir
--      §"AUCUNE ACTION LIVE" en pied de fichier).
--
--  CETTE MIGRATION NE TOUCHE NI NE MODIFIE :
--    - les migrations 0001-0022 (fichiers immuables, déjà appliqués —
--      NON modifiées) ;
--    - public.event_clusters / event_observation_memberships /
--      event_versions / event_version_evidence /
--      event_cluster_relation_operations / event_cluster_relation_edges
--      / event_cluster_identity_claims (schéma OPS-023 existant,
--      RÉFÉRENCÉ en lecture seule via FK vers event_versions, jamais
--      modifié) ;
--    - public.fn_event_schema_append_only() (fonction trigger partagée
--      des SEPT tables OPS-023 existantes — son commentaire/contrat
--      documente explicitement ces sept tables ; Event Impact obtient
--      SA PROPRE fonction dédiée, fn_event_impact_append_only(), plutôt
--      que d'étendre implicitement le périmètre documenté de la
--      fonction existante) ;
--    - database/schema.sql. DETTE DE PARITÉ PRÉEXISTANTE ET
--      INDÉPENDANTE DE CETTE PR : ce fichier ne reflète déjà PAS les
--      migrations 0012-0022 (aucune des sept tables Event Cluster/
--      Version n'y figure). Ajouter Event Impact seul à schema.sql
--      produirait une définition fresh-install BRISÉE (FK vers
--      event_versions, table absente de ce fichier). Cette PR
--      n'entreprend PAS de réparation de parité fresh-install — hors
--      périmètre, à traiter par une tâche dédiée et contrôlée séparée ;
--    - le pipeline legacy article-niveau (table news_events et ses
--      colonnes de score/direction/transmission existantes), ni les
--      scénarios Committee (ai_scenarios.direction/probability/
--      target/confidence, ai_analyses.market_regime) — ce sont des
--      précurseurs à des niveaux sémantiques différents (article /
--      scénario-run), jamais copiés ni pontés ici. Event Impact ne
--      référence QUE public.event_versions.
--
--  DEUX TABLES SEULEMENT :
--
--    1. public.event_impact_assessments — UNE enveloppe immuable
--       d'exécution/résultat d'évaluation, rattachée à EXACTEMENT une
--       Event Version. Porte la disponibilité (assessment_status), la
--       provenance (producer_type/producer_actor/algorithm_version), le
--       knowledge_cutoff, les empreintes (input/semantic/idempotency),
--       et la lignée de réévaluation optionnelle
--       (supersedes_assessment_id). NE porte AUCUNE conclusion
--       directionnelle par horizon.
--
--    2. public.event_impact_interpretations — interprétations
--       structurées par horizon, rattachées à UNE évaluation. Une
--       évaluation peut porter plusieurs horizons, avec EXACTEMENT une
--       interprétation PRIMARY par horizon représenté et zéro ou
--       plusieurs interprétations ALTERNATIVE pour ce même horizon —
--       c'est ainsi que les interprétations concurrentes deviennent
--       lisibles par machine plutôt que du texte libre uniquement.
--
--  RÈGLES SÉMANTIQUES CRITIQUES (non négociables, voir revue
--  d'architecture Event Impact) :
--    - NEUTRAL != UNKNOWN pour `direction` : NEUTRAL signale une
--      conclusion directionnelle assumée d'effet or approximativement
--      nul ; UNKNOWN signale que la direction ne peut pas être
--      déterminée de façon défendable. Jamais confondus.
--    - magnitude NULL != magnitude zéro : magnitude_state distingue
--      UNASSESSED (aucune tentative d'évaluation), UNKNOWN (évaluée
--      mais non déterminable de façon défendable), et ESTIMATED (valeur
--      réelle, avec unité et base explicites).
--    - confiance inconnue != confiance zéro : même discipline
--      UNASSESSED / UNKNOWN / ESTIMATED que la magnitude.
--    - pricing_state démarre sémantiquement UNASSESSED : aucun moteur
--      Market Pricing dédié n'existe encore (voir docs/
--      XAU_V2_DAILY_OPERATING_MODEL.md §8) ; cette migration crée
--      UNIQUEMENT le vocabulaire, jamais une inférence ou une table de
--      pricing.
--
--  APPEND-ONLY. Fonction trigger dédiée Event Impact
--  (fn_event_impact_append_only), réutilisée sur les deux tables — même
--  discipline de rejet inconditionnel de UPDATE/DELETE que
--  fn_event_schema_append_only (0012)/fn_news_articles_append_only
--  (0009), effective y compris pour service_role (BYPASSRLS dispense
--  des policies RLS, pas des triggers). Une correction/réévaluation
--  s'insère TOUJOURS comme une NOUVELLE ligne.
--
--  AS-OF / KNOWLEDGE_CUTOFF. knowledge_cutoff N'A PAS DE DEFAULT :
--  jamais l'horloge courante comme état de connaissance analytique.
--  Un trigger BEFORE INSERT impose knowledge_cutoff >= celui de
--  l'Event Version référencée, et — en cas de réévaluation
--  (supersedes_assessment_id) — >= celui du prédécesseur référencé, qui
--  doit exister et porter sur la MÊME event_version_id.
--
--  INVARIANTS DE COMPLÉTUDE TRANSACTIONNELS (CONSTRAINT TRIGGER
--  DEFERRABLE INITIALLY DEFERRED) : permettent à une future persistance
--  atomique d'insérer parent + enfants dans UNE seule transaction sans
--  ordre imposé.
--    - chaque (assessment_id, horizon) représenté doit porter AU MOINS
--      une interprétation PRIMARY à la fin de la transaction (l'index
--      UNIQUE partiel garantit déjà AU PLUS une PRIMARY — ce trigger
--      différé garantit AU MOINS une) ;
--    - une évaluation ASSESSED doit avoir produit AU MOINS une
--      interprétation à la fin de la transaction. La direction inverse
--      (INSUFFICIENT_EVIDENCE / UNAVAILABLE => zéro interprétation) est
--      DÉJÀ garantie immédiatement, pas seulement en différé, par le
--      trigger BEFORE INSERT qui rejette toute interprétation enfant
--      dont le parent n'est pas ASSESSED.
--
--  SÉCURITÉ : SECURITY INVOKER (jamais DEFINER) sur toutes les
--  fonctions introduites ici, SET search_path = '' dès la création,
--  qualification complète de schéma sur chaque référence de relation
--  dans le corps des fonctions — même discipline que 0012/0013/0020.
--  RLS activée sur les deux tables, EXECUTE/DML explicitement révoqué
--  de PUBLIC/anon/authenticated/service_role puis SELECT, INSERT
--  ACCORDÉ à service_role uniquement (jamais UPDATE, jamais DELETE —
--  les triggers append-only restent une défense en profondeur même pour
--  un accès privilégié).
--
--  TRANSACTIONNELLE : BEGIN ... COMMIT. IDEMPOTENTE (fichier) :
--  IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE TRIGGER — rejouable
--  sans effet si déjà appliquée.
--
--  PRÉREQUIS : migration 0012 (public.event_versions).
--
--  AUCUNE ACTION LIVE : cette migration n'est PAS appliquée à Supabase
--  par cette tâche. DDL de dépôt uniquement — l'application live
--  n'intervient qu'après revue indépendante et fusion, dans une tâche
--  contrôlée séparée.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. EVENT_IMPACT_ASSESSMENTS
--    Enveloppe immuable d'exécution/résultat d'évaluation, rattachée à
--    EXACTEMENT une Event Version. Ne porte AUCUNE conclusion
--    directionnelle par horizon — celle-ci vit exclusivement dans
--    event_impact_interpretations (§2 ci-dessous).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_impact_assessments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event Version évaluée. RESTRICT (jamais SET NULL) : une évaluation
  -- ne doit jamais devenir orpheline. C'est la SEULE table amont
  -- référencée par Event Impact — jamais news_events, jamais
  -- ai_analyses/ai_scenarios.
  event_version_id            UUID NOT NULL
                                REFERENCES public.event_versions (id) ON DELETE RESTRICT,

  -- Disponibilité de l'évaluation. Vocabulaire figé EXACT — jamais de
  -- SUCCESS/FAILED générique. ASSESSED = au moins une interprétation
  -- structurée produite. INSUFFICIENT_EVIDENCE = preuve disponible en
  -- quantité suffisante pour tenter l'évaluation, mais insuffisante
  -- pour produire une conclusion défendable. UNAVAILABLE = l'évaluation
  -- n'a pas pu être tentée (capacité/entrée requise indisponible).
  assessment_status            TEXT NOT NULL
                                CHECK (assessment_status IN (
                                  'ASSESSED', 'INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'
                                )),

  -- AUCUN DEFAULT — jamais l'horloge courante comme état de
  -- connaissance analytique. Validé par trigger (>= celui de l'Event
  -- Version référencée, et du prédécesseur en cas de réévaluation).
  knowledge_cutoff             TIMESTAMPTZ NOT NULL,

  -- Provenance UNIQUEMENT — ne rend jamais l'IA obligatoire pour
  -- l'ingestion/l'identité Event, cohérent avec la décision
  -- architecturale figée du registre de ressources.
  producer_type                 TEXT NOT NULL
                                CHECK (producer_type IN ('DETERMINISTIC', 'QUANT', 'AI', 'HUMAN')),
  producer_actor                 TEXT NOT NULL CHECK (length(btrim(producer_actor)) > 0),
  algorithm_version               TEXT NOT NULL CHECK (length(btrim(algorithm_version)) > 0),

  -- Empreintes SHA-256 hexadécimales minuscules, exactement 64
  -- caractères. input_fingerprint représente l'ensemble d'entrées
  -- canoniques consommées. semantic_fingerprint représente UNIQUEMENT
  -- le contenu sémantique de sortie Event Impact — jamais row id,
  -- created_at, clé d'idempotence, identité d'acteur, ni horodatage de
  -- process/run. Volontairement NON UNIQUE : une séquence légitime de
  -- réévaluation A -> B -> A doit rester représentable.
  -- idempotency_fingerprint est l'autorité de rejeu/réponse perdue.
  input_fingerprint                TEXT NOT NULL
                                CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  semantic_fingerprint               TEXT NOT NULL
                                CHECK (semantic_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_fingerprint             TEXT NOT NULL
                                CHECK (idempotency_fingerprint ~ '^[0-9a-f]{64}$'),

  -- Lignée de réévaluation explicite. RESTRICT (jamais SET NULL) : une
  -- évaluation référencée comme prédécesseur ne doit jamais devenir
  -- orpheline. Une réévaluation n'écrase JAMAIS son prédécesseur — voir
  -- index UNIQUE partiel ci-dessous (au plus un successeur direct) et
  -- le trigger de cohérence (même event_version_id, knowledge_cutoff
  -- non régressif).
  supersedes_assessment_id             UUID
                                REFERENCES public.event_impact_assessments (id) ON DELETE RESTRICT,

  created_at                            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_impact_assessments_idempotency
  ON public.event_impact_assessments (idempotency_fingerprint);

-- Au plus un successeur direct par évaluation prédécesseur.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_impact_assessments_supersedes
  ON public.event_impact_assessments (supersedes_assessment_id)
  WHERE supersedes_assessment_id IS NOT NULL;

-- Chemin de requête réel justifié : "dernière(s) évaluation(s) pour
-- cette Event Version", ordre chronologique décroissant.
CREATE INDEX IF NOT EXISTS idx_event_impact_assessments_event_version_created
  ON public.event_impact_assessments (event_version_id, created_at DESC);

COMMENT ON TABLE public.event_impact_assessments IS
  'PR-EI-1 — enveloppe immuable d''exécution/résultat d''évaluation Event Impact, rattachée à EXACTEMENT une public.event_versions. Ne porte aucune conclusion directionnelle par horizon (voir public.event_impact_interpretations). Append-only (fn_event_impact_append_only). Aucune logique domaine, aucune RPC de persistance, aucun runtime introduits par cette migration.';
COMMENT ON COLUMN public.event_impact_assessments.assessment_status IS
  'Vocabulaire figé EXACT : ASSESSED (>=1 interprétation produite), INSUFFICIENT_EVIDENCE (preuve tentée mais non concluante), UNAVAILABLE (évaluation non tentée, capacité/entrée indisponible). Jamais SUCCESS/FAILED génériques.';
COMMENT ON COLUMN public.event_impact_assessments.knowledge_cutoff IS
  'AUCUN DEFAULT — jamais l''horloge courante. Validé par trigger : >= knowledge_cutoff de l''Event Version référencée, et >= celui du prédécesseur si supersedes_assessment_id est renseigné.';
COMMENT ON COLUMN public.event_impact_assessments.semantic_fingerprint IS
  'Empreinte de CONTENU SÉMANTIQUE SEUL (sortie Event Impact), jamais row id/created_at/idempotency_fingerprint/acteur/horodatage de process. Non unique par construction : une séquence légitime A -> B -> A doit rester représentable.';
COMMENT ON COLUMN public.event_impact_assessments.idempotency_fingerprint IS
  'Clé de rejeu/réponse-perdue, calculée côté application (future RPC, non implémentée ici). UNIQUE — voir uq_event_impact_assessments_idempotency.';

-- ---------------------------------------------------------------------
-- 2. EVENT_IMPACT_INTERPRETATIONS
--    Interprétations structurées par horizon, rattachées à UNE
--    évaluation. Les interprétations concurrentes sont représentées
--    structurellement (plusieurs lignes pour le même
--    (assessment_id, horizon)), jamais uniquement en texte libre.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_impact_interpretations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT (jamais SET NULL) : une interprétation ne doit jamais
  -- devenir orpheline. Validée par trigger BEFORE INSERT : le parent
  -- doit exister ET porter assessment_status = 'ASSESSED'.
  assessment_id          UUID NOT NULL
                          REFERENCES public.event_impact_assessments (id) ON DELETE RESTRICT,

  -- Vocabulaire figé EXACT du contrat Event Impact
  -- (docs/XAU_V2_DAILY_OPERATING_MODEL.md §6/§9). Aucun sixième horizon
  -- numéroté au-delà de H5 — au-delà de 30 jours, c'est structural_tail.
  -- N'ÉTEND PAS le type horizon_t existant (H1..H5 uniquement, propre
  -- au contrat de scénario Committee) : structural_tail n'y existe pas,
  -- et Event Impact ne doit dépendre d'aucun type interne au Committee.
  -- Contrat local TEXT + CHECK, délibérément dupliqué plutôt
  -- qu'importé — même discipline que EXPECTED_PROCESSOR_VERSION/
  -- EXPECTED_ORCHESTRATOR_VERSION dupliqués à travers PR4/PR5/PR8.
  horizon                 TEXT NOT NULL
                          CHECK (horizon IN ('H1', 'H2', 'H3', 'H4', 'H5', 'structural_tail')),

  -- Identifiant machine-lisible STABLE de l'interprétation à l'intérieur
  -- de (assessment_id, horizon). Les valeurs concrètes sont un souci de
  -- domaine FUTUR — aucune interprétation n'est codée en dur ici.
  interpretation_key       TEXT NOT NULL CHECK (length(btrim(interpretation_key)) > 0),

  -- Exactement une PRIMARY par (assessment_id, horizon) représenté
  -- (index UNIQUE partiel ci-dessous pour "au plus une" + trigger
  -- différé pour "au moins une"), zéro ou plusieurs ALTERNATIVE.
  interpretation_role       TEXT NOT NULL
                          CHECK (interpretation_role IN ('PRIMARY', 'ALTERNATIVE')),

  -- RÈGLE CRITIQUE : NEUTRAL != UNKNOWN. NEUTRAL = conclusion
  -- directionnelle assumée d'effet or approximativement nul. UNKNOWN =
  -- direction non déterminable de façon défendable. N'ÉTEND/N'IMPORTE
  -- PAS direction_t existant (bullish/bearish/neutral uniquement, sans
  -- état "non déterminé" — insuffisant pour ce contrat).
  direction                 TEXT NOT NULL
                          CHECK (direction IN ('BULLISH', 'BEARISH', 'NEUTRAL', 'UNKNOWN')),

  -- RÈGLE CRITIQUE : magnitude NULL != magnitude zéro. UNASSESSED =
  -- aucune tentative d'évaluation. UNKNOWN = évaluée mais non
  -- déterminable de façon défendable. ESTIMATED = magnitude_value
  -- renseignée avec unité et base explicites (voir CHECK
  -- d'appariement ci-dessous). Aucun vocabulaire magnitude_unit figé
  -- ici — délibérément non défini, jamais supposé être uniquement
  -- USD/oz.
  magnitude_state            TEXT NOT NULL
                          CHECK (magnitude_state IN ('UNASSESSED', 'UNKNOWN', 'ESTIMATED')),
  magnitude_value              NUMERIC,
  magnitude_unit                TEXT,
  magnitude_basis                 TEXT,

  -- Même discipline UNASSESSED/UNKNOWN/ESTIMATED que la magnitude :
  -- confiance inconnue != confiance zéro.
  confidence_state                 TEXT NOT NULL
                          CHECK (confidence_state IN ('UNASSESSED', 'UNKNOWN', 'ESTIMATED')),
  confidence_value                   NUMERIC(5,4),

  -- Aucun moteur Market Pricing dédié n'existe encore
  -- (docs/XAU_V2_DAILY_OPERATING_MODEL.md §8). Cette migration crée
  -- UNIQUEMENT le vocabulaire — jamais une inférence, jamais une table
  -- de pricing. Le futur travail domaine Event Impact V1 doit par
  -- défaut produire UNASSESSED tant qu'une évaluation de pricing réelle
  -- n'existe pas.
  pricing_state                       TEXT NOT NULL
                          CHECK (pricing_state IN (
                            'UNASSESSED', 'UNPRICED', 'PARTIALLY_PRICED',
                            'LARGELY_PRICED', 'UNCERTAIN'
                          )),

  rationale                             TEXT,

  created_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Appariement magnitude : ESTIMATED exige valeur+unité+base non vides
  -- et une valeur >= 0 ; UNASSESSED/UNKNOWN exigent les trois NULL.
  -- Empêche structurellement toute confusion "non évalué" / "évalué à
  -- zéro" / "estimé".
  CONSTRAINT chk_event_impact_interpretations_magnitude_pairing CHECK (
    (
      magnitude_state = 'ESTIMATED'
      AND magnitude_value IS NOT NULL AND magnitude_value >= 0
      AND magnitude_unit IS NOT NULL AND length(btrim(magnitude_unit)) > 0
      AND magnitude_basis IS NOT NULL AND length(btrim(magnitude_basis)) > 0
    )
    OR
    (
      magnitude_state IN ('UNASSESSED', 'UNKNOWN')
      AND magnitude_value IS NULL
      AND magnitude_unit IS NULL
      AND magnitude_basis IS NULL
    )
  ),

  -- Appariement confiance : ESTIMATED exige une valeur dans [0,1] ;
  -- UNASSESSED/UNKNOWN exigent NULL.
  CONSTRAINT chk_event_impact_interpretations_confidence_pairing CHECK (
    (confidence_state = 'ESTIMATED' AND confidence_value IS NOT NULL
       AND confidence_value BETWEEN 0 AND 1)
    OR
    (confidence_state IN ('UNASSESSED', 'UNKNOWN') AND confidence_value IS NULL)
  ),

  -- Identité logique stable à l'intérieur de (évaluation, horizon).
  CONSTRAINT uq_event_impact_interpretations_identity
    UNIQUE (assessment_id, horizon, interpretation_key)
);

-- Au plus une interprétation PRIMARY par (assessment_id, horizon).
-- Le "au moins une" est garanti par le trigger différé plus bas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_impact_interpretations_one_primary_per_horizon
  ON public.event_impact_interpretations (assessment_id, horizon)
  WHERE interpretation_role = 'PRIMARY';

COMMENT ON TABLE public.event_impact_interpretations IS
  'PR-EI-1 — interprétations Event Impact structurées par horizon, rattachées à UNE public.event_impact_assessments. Une évaluation peut porter plusieurs horizons, avec exactement une interprétation PRIMARY par horizon représenté et zéro ou plusieurs ALTERNATIVE — les interprétations concurrentes sont ainsi lisibles par machine, jamais du texte libre uniquement. Append-only (fn_event_impact_append_only).';
COMMENT ON COLUMN public.event_impact_interpretations.horizon IS
  'Vocabulaire figé EXACT : H1, H2, H3, H4, H5, structural_tail. Aucun sixième horizon numéroté au-delà de H5. Contrat local, jamais le type horizon_t existant (H1-H5 uniquement, propre au Committee).';
COMMENT ON COLUMN public.event_impact_interpretations.direction IS
  'BULLISH, BEARISH, NEUTRAL, UNKNOWN. NEUTRAL != UNKNOWN : NEUTRAL est une conclusion assumée d''effet nul, UNKNOWN signale une direction non déterminable. Jamais direction_t existant (sans état UNKNOWN).';
COMMENT ON COLUMN public.event_impact_interpretations.magnitude_state IS
  'UNASSESSED (non tenté), UNKNOWN (tenté, non déterminable), ESTIMATED (valeur+unité+base réelles). NULL magnitude != magnitude zéro.';
COMMENT ON COLUMN public.event_impact_interpretations.pricing_state IS
  'UNASSESSED, UNPRICED, PARTIALLY_PRICED, LARGELY_PRICED, UNCERTAIN. Aucun moteur Market Pricing n''existe encore : cette migration ne crée que le vocabulaire, jamais une inférence.';

-- ---------------------------------------------------------------------
-- 3. APPEND-ONLY — fonction trigger DÉDIÉE Event Impact.
--    NE réutilise PAS fn_event_schema_append_only() (0012) : son
--    commentaire/contrat documente explicitement les sept tables
--    OPS-023 existantes ; Event Impact obtient sa propre fonction
--    plutôt que d'étendre implicitement ce périmètre documenté.
--    Comportement identique : rejette inconditionnellement UPDATE et
--    DELETE, y compris pour service_role.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_impact_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    '% est append-only (Event Impact) : % interdit. Une correction/réévaluation doit être insérée comme une NOUVELLE ligne, jamais comme une modification de la ligne existante.',
    TG_TABLE_NAME, TG_OP;
END;
$$;

COMMENT ON FUNCTION public.fn_event_impact_append_only IS
  'Fonction trigger append-only dédiée aux deux tables Event Impact (event_impact_assessments, event_impact_interpretations) — jamais fn_event_schema_append_only (0012), dont le contrat documente explicitement les sept tables OPS-023 existantes. Rejette inconditionnellement UPDATE/DELETE, y compris pour service_role.';

DROP TRIGGER IF EXISTS trg_event_impact_assessments_append_only
  ON public.event_impact_assessments;
CREATE TRIGGER trg_event_impact_assessments_append_only
  BEFORE UPDATE OR DELETE ON public.event_impact_assessments
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_impact_append_only();

DROP TRIGGER IF EXISTS trg_event_impact_interpretations_append_only
  ON public.event_impact_interpretations;
CREATE TRIGGER trg_event_impact_interpretations_append_only
  BEFORE UPDATE OR DELETE ON public.event_impact_interpretations
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_impact_append_only();

-- ---------------------------------------------------------------------
-- 4. AS-OF / KNOWLEDGE_CUTOFF — validation BEFORE INSERT sur
--    event_impact_assessments.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_event_impact_assessment_cutoff()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_event_version_knowledge_cutoff   TIMESTAMPTZ;
  v_predecessor                       RECORD;
BEGIN
  SELECT ev.knowledge_cutoff
    INTO v_event_version_knowledge_cutoff
    FROM public.event_versions ev
    WHERE ev.id = NEW.event_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'event_impact_assessments : event_version_id % introuvable.',
      NEW.event_version_id;
  END IF;

  IF NEW.knowledge_cutoff < v_event_version_knowledge_cutoff THEN
    RAISE EXCEPTION
      'event_impact_assessments : knowledge_cutoff (%) ne peut pas être antérieur au knowledge_cutoff de l''Event Version référencée (%).',
      NEW.knowledge_cutoff, v_event_version_knowledge_cutoff;
  END IF;

  IF NEW.supersedes_assessment_id IS NOT NULL THEN
    SELECT eia.event_version_id, eia.knowledge_cutoff
      INTO v_predecessor
      FROM public.event_impact_assessments eia
      WHERE eia.id = NEW.supersedes_assessment_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'event_impact_assessments : supersedes_assessment_id % introuvable.',
        NEW.supersedes_assessment_id;
    END IF;

    IF v_predecessor.event_version_id <> NEW.event_version_id THEN
      RAISE EXCEPTION
        'event_impact_assessments : la réévaluation référencée (supersedes_assessment_id=%) porte sur un event_version_id différent (attendu %, trouvé %) — une réévaluation ne peut porter que sur la MÊME Event Version.',
        NEW.supersedes_assessment_id, NEW.event_version_id, v_predecessor.event_version_id;
    END IF;

    IF NEW.knowledge_cutoff < v_predecessor.knowledge_cutoff THEN
      RAISE EXCEPTION
        'event_impact_assessments : knowledge_cutoff (%) ne peut pas être antérieur au knowledge_cutoff de l''évaluation prédécesseur (%).',
        NEW.knowledge_cutoff, v_predecessor.knowledge_cutoff;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_check_event_impact_assessment_cutoff IS
  'BEFORE INSERT sur event_impact_assessments : impose knowledge_cutoff >= celui de l''Event Version référencée, et — en cas de réévaluation (supersedes_assessment_id) — que le prédécesseur existe, porte sur la MÊME event_version_id, et que knowledge_cutoff ne régresse jamais par rapport à lui.';

DROP TRIGGER IF EXISTS trg_event_impact_assessments_check_cutoff
  ON public.event_impact_assessments;
CREATE TRIGGER trg_event_impact_assessments_check_cutoff
  BEFORE INSERT ON public.event_impact_assessments
  FOR EACH ROW EXECUTE FUNCTION public.fn_check_event_impact_assessment_cutoff();

-- ---------------------------------------------------------------------
-- 5. PORTE DE STATUT PARENT — validation BEFORE INSERT sur
--    event_impact_interpretations. Une interprétation structurée ne
--    peut être insérée que pour une évaluation ASSESSED — rejette
--    INSUFFICIENT_EVIDENCE et UNAVAILABLE immédiatement (pas
--    seulement en différé).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_event_impact_interpretation_parent_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_parent_status   TEXT;
BEGIN
  SELECT eia.assessment_status
    INTO v_parent_status
    FROM public.event_impact_assessments eia
    WHERE eia.id = NEW.assessment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'event_impact_interpretations : assessment_id % introuvable.',
      NEW.assessment_id;
  END IF;

  IF v_parent_status <> 'ASSESSED' THEN
    RAISE EXCEPTION
      'event_impact_interpretations : l''évaluation parente % porte le statut % — une interprétation structurée ne peut être insérée que pour une évaluation ASSESSED.',
      NEW.assessment_id, v_parent_status;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_check_event_impact_interpretation_parent_status IS
  'BEFORE INSERT sur event_impact_interpretations : rejette immédiatement toute interprétation dont l''évaluation parente n''est pas ASSESSED. Garantit, sans attendre la fin de transaction, qu''INSUFFICIENT_EVIDENCE/UNAVAILABLE ne peuvent jamais accumuler d''interprétation.';

DROP TRIGGER IF EXISTS trg_event_impact_interpretations_check_parent_status
  ON public.event_impact_interpretations;
CREATE TRIGGER trg_event_impact_interpretations_check_parent_status
  BEFORE INSERT ON public.event_impact_interpretations
  FOR EACH ROW EXECUTE FUNCTION public.fn_check_event_impact_interpretation_parent_status();

-- ---------------------------------------------------------------------
-- 6. INVARIANT DIFFÉRÉ — au moins une interprétation PRIMARY par
--    (assessment_id, horizon) représenté à la fin de la transaction.
--    L'index UNIQUE partiel (§2) garantit déjà "au plus une" ; ce
--    trigger CONSTRAINT DEFERRABLE INITIALLY DEFERRED garantit
--    "au moins une", en autorisant une future persistance atomique à
--    insérer PRIMARY et ALTERNATIVE dans n'importe quel ordre au sein
--    d'une même transaction.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_event_impact_horizon_has_primary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_primary_count   INTEGER;
BEGIN
  SELECT count(*)
    INTO v_primary_count
    FROM public.event_impact_interpretations eii
    WHERE eii.assessment_id = NEW.assessment_id
      AND eii.horizon = NEW.horizon
      AND eii.interpretation_role = 'PRIMARY';

  IF v_primary_count = 0 THEN
    RAISE EXCEPTION
      'event_impact_interpretations : assessment % / horizon % n''a aucune interprétation PRIMARY à la fin de la transaction — chaque horizon représenté doit porter exactement une interprétation PRIMARY.',
      NEW.assessment_id, NEW.horizon;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_check_event_impact_horizon_has_primary IS
  'CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED sur event_impact_interpretations : garantit qu''à la fin de la transaction, chaque (assessment_id, horizon) représenté porte au moins une interprétation PRIMARY. Complète l''index UNIQUE partiel (au plus une) pour obtenir EXACTEMENT une.';

DROP TRIGGER IF EXISTS trg_event_impact_interpretations_require_primary
  ON public.event_impact_interpretations;
CREATE CONSTRAINT TRIGGER trg_event_impact_interpretations_require_primary
  AFTER INSERT ON public.event_impact_interpretations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_check_event_impact_horizon_has_primary();

-- ---------------------------------------------------------------------
-- 7. INVARIANT DIFFÉRÉ — complétude de l'évaluation. ASSESSED doit
--    avoir produit au moins une interprétation à la fin de la
--    transaction. La direction inverse (INSUFFICIENT_EVIDENCE /
--    UNAVAILABLE => zéro interprétation) est DÉJÀ garantie
--    immédiatement par le trigger §5 (porte de statut parent) : une
--    évaluation non-ASSESSED ne peut, à AUCUN moment de sa vie, se voir
--    attacher une interprétation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_check_event_impact_assessment_completeness()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_interpretation_count   INTEGER;
BEGIN
  IF NEW.assessment_status = 'ASSESSED' THEN
    SELECT count(*)
      INTO v_interpretation_count
      FROM public.event_impact_interpretations eii
      WHERE eii.assessment_id = NEW.id;

    IF v_interpretation_count = 0 THEN
      RAISE EXCEPTION
        'event_impact_assessments : % porte assessment_status=ASSESSED mais n''a produit aucune interprétation structurée à la fin de la transaction — ASSESSED exige au moins une interprétation.',
        NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_check_event_impact_assessment_completeness IS
  'CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED sur event_impact_assessments : une évaluation ASSESSED doit avoir produit au moins une interprétation à la fin de la transaction. La direction inverse est déjà garantie immédiatement par fn_check_event_impact_interpretation_parent_status.';

DROP TRIGGER IF EXISTS trg_event_impact_assessments_require_interpretation
  ON public.event_impact_assessments;
CREATE CONSTRAINT TRIGGER trg_event_impact_assessments_require_interpretation
  AFTER INSERT ON public.event_impact_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_check_event_impact_assessment_completeness();

-- ---------------------------------------------------------------------
-- 8. RLS / PRIVILÈGES — deux couches distinctes (RLS + GRANT), même
--    discipline que 0012 : deny-all PUBLIC/anon/authenticated/
--    service_role, puis SELECT, INSERT accordé à service_role
--    UNIQUEMENT. Jamais UPDATE, jamais DELETE — pas de dynamique SQL
--    ici, deux tables seulement, instructions explicites plus
--    lisibles qu'une boucle.
-- ---------------------------------------------------------------------
ALTER TABLE public.event_impact_assessments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_impact_assessments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.event_impact_assessments TO service_role;

ALTER TABLE public.event_impact_interpretations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_impact_interpretations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.event_impact_interpretations TO service_role;

COMMIT;
