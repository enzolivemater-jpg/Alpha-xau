// Contrat statique du socle DB OPS-023 (migration 0012). Analyse le texte
// SQL de la migration : aucune connexion PostgreSQL requise, s'exécute en
// CI normale. Ne remplace pas une application réelle de la migration —
// vérifie que le fichier respecte les invariants architecturaux gelés
// (OPS-023 : sept tables append-only, identité déterministe SHA-256,
// aucune dépendance uuid-ossp, aucune fuite de champs d'analyse
// EVENT IMPACT sur event_versions, aucune altération des tables legacy).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', '0012_event_cluster_version_foundation.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0012 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// Code SQL réellement exécuté : lignes de commentaire ('--...') retirées,
// pour ne jamais faire correspondre du SQL cité en exemple dans le bloc
// de vérification en fin de fichier (commenté).
const liveSource = source
  .split('\n')
  .map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join('\n');

// ---------------------------------------------------------------------
// 1. Les sept tables existent
// ---------------------------------------------------------------------
const TABLES = [
  'event_clusters',
  'event_observation_memberships',
  'event_versions',
  'event_version_evidence',
  'event_cluster_relation_operations',
  'event_cluster_relation_edges',
  'event_cluster_identity_claims',
];

for (const table of TABLES) {
  t(`table ${table} créée (CREATE TABLE IF NOT EXISTS)`,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(liveSource));
}

// ---------------------------------------------------------------------
// 2. Aucune dépendance uuid-ossp / uuid_generate_v5
// ---------------------------------------------------------------------
// Recherché dans le SQL réellement exécuté uniquement (liveSource) : les
// commentaires du fichier mentionnent délibérément ces noms pour
// documenter qu'ils ne sont PAS utilisés (voir l'en-tête de la
// migration) — seule une utilisation réelle (appel de fonction /
// CREATE EXTENSION) doit faire échouer ce test.
t('uuid_generate_v5 jamais appelé (aucune dépendance à uuid-ossp)',
  !/uuid_generate_v5\s*\(/i.test(liveSource));
t('extension uuid-ossp jamais créée', !/CREATE EXTENSION[^;]*uuid-ossp/i.test(liveSource));
t('identité déterministe via extensions.digest(...,\'sha256\') (pattern observation_hash)',
  /extensions\.digest\(/.test(liveSource) && /'sha256'/.test(liveSource));
t('gen_random_uuid() utilisé pour les PK (pattern proven)', /gen_random_uuid\(\)/.test(liveSource));

// ---------------------------------------------------------------------
// 3. state_fingerprint / semantic_state_fingerprint : indexés, jamais
//    contraints en unicité (récurrence d'état A -> B -> A représentable)
// ---------------------------------------------------------------------
function extractStatement(re) {
  const m = re.exec(liveSource);
  return m ? m[0] : '';
}

const stateFingerprintIndexStmt = extractStatement(
  /CREATE (?:UNIQUE )?INDEX[^;]*\bstate_fingerprint\b[^;]*;/i,
);
t('un index existe sur event_versions.state_fingerprint',
  stateFingerprintIndexStmt.length > 0, stateFingerprintIndexStmt);
t('cet index n\'est PAS UNIQUE',
  stateFingerprintIndexStmt.length > 0 && !/CREATE UNIQUE INDEX/i.test(stateFingerprintIndexStmt),
  stateFingerprintIndexStmt);

const semanticFingerprintIndexStmt = extractStatement(
  /CREATE (?:UNIQUE )?INDEX[^;]*\bsemantic_state_fingerprint\b[^;]*;/i,
);
t('un index existe sur event_observation_memberships.semantic_state_fingerprint',
  semanticFingerprintIndexStmt.length > 0, semanticFingerprintIndexStmt);
t('cet index n\'est PAS UNIQUE',
  semanticFingerprintIndexStmt.length > 0 && !/CREATE UNIQUE INDEX/i.test(semanticFingerprintIndexStmt),
  semanticFingerprintIndexStmt);

// state_fingerprint/semantic_state_fingerprint ne doivent apparaître dans
// AUCUNE contrainte/index UNIQUE nommé ailleurs dans le fichier.
t('state_fingerprint n\'apparaît dans aucun UNIQUE INDEX',
  !/CREATE UNIQUE INDEX[^;]*\bstate_fingerprint\b/i.test(liveSource));
t('semantic_state_fingerprint n\'apparaît dans aucun UNIQUE INDEX',
  !/CREATE UNIQUE INDEX[^;]*\bsemantic_state_fingerprint\b/i.test(liveSource));

// ---------------------------------------------------------------------
// 4. UNIQUE(cluster_id, version_number)
// ---------------------------------------------------------------------
t('UNIQUE (cluster_id, version_number) sur event_versions',
  /UNIQUE\s*\(\s*cluster_id\s*,\s*version_number\s*\)/i.test(liveSource));

// ---------------------------------------------------------------------
// 5. Unicité des idempotency_fingerprint où requis (4 tables porteuses)
// ---------------------------------------------------------------------
const idempotencyUniqueTargets = [
  ['event_observation_memberships', /CREATE UNIQUE INDEX[^;]*ON event_observation_memberships \(idempotency_fingerprint\)/i],
  ['event_versions', /CREATE UNIQUE INDEX[^;]*ON event_versions \(idempotency_fingerprint\)/i],
  ['event_cluster_relation_operations', /CREATE UNIQUE INDEX[^;]*ON event_cluster_relation_operations \(idempotency_fingerprint\)/i],
  ['event_cluster_identity_claims', /CREATE UNIQUE INDEX[^;]*ON event_cluster_identity_claims \(idempotency_fingerprint\)/i],
];
for (const [table, re] of idempotencyUniqueTargets) {
  t(`idempotency_fingerprint UNIQUE sur ${table}`, re.test(liveSource));
}

// Anti-contradiction : supersedes_* UNIQUE WHERE ... IS NOT NULL, sur les
// trois tables porteuses d'un mécanisme de supersession corrigible.
const supersedesUniqueTargets = [
  ['event_observation_memberships.supersedes_decision_id', /CREATE UNIQUE INDEX[^;]*ON event_observation_memberships \(supersedes_decision_id\)\s*\n\s*WHERE supersedes_decision_id IS NOT NULL/i],
  ['event_cluster_relation_operations.supersedes_operation_id', /CREATE UNIQUE INDEX[^;]*ON event_cluster_relation_operations \(supersedes_operation_id\)\s*\n\s*WHERE supersedes_operation_id IS NOT NULL/i],
  ['event_cluster_identity_claims.supersedes_claim_id', /CREATE UNIQUE INDEX[^;]*ON event_cluster_identity_claims \(supersedes_claim_id\)\s*\n\s*WHERE supersedes_claim_id IS NOT NULL/i],
];
for (const [label, re] of supersedesUniqueTargets) {
  t(`UNIQUE partiel anti-contradiction sur ${label}`, re.test(liveSource));
}

// relation_key : exactement une ouverture ASSIGN par relation logique.
t('UNIQUE partiel sur relation_key WHERE decision_type=\'ASSIGN\'',
  /CREATE UNIQUE INDEX[^;]*ON event_observation_memberships \(relation_key\)\s*\n\s*WHERE decision_type = 'ASSIGN'/i.test(liveSource));

// ---------------------------------------------------------------------
// 6. Append-only : trigger BEFORE UPDATE OR DELETE sur les sept tables,
//    fonction partagée.
// ---------------------------------------------------------------------
t('fonction append-only partagée définie (fn_event_schema_append_only)',
  /CREATE OR REPLACE FUNCTION fn_event_schema_append_only\(\)/.test(liveSource));
t('la fonction append-only rejette inconditionnellement (RAISE EXCEPTION)',
  /RAISE EXCEPTION[\s\S]{0,200}TG_TABLE_NAME, TG_OP/.test(liveSource));

for (const table of TABLES) {
  const re = new RegExp(
    `CREATE TRIGGER trg_${table}_append_only\\s*\\n\\s*BEFORE UPDATE OR DELETE ON ${table}\\s*\\n\\s*FOR EACH ROW EXECUTE FUNCTION fn_event_schema_append_only\\(\\)`,
  );
  t(`trigger append-only (BEFORE UPDATE OR DELETE) sur ${table}`, re.test(liveSource));
}

// Une seule fonction append-only pour les sept tables (pas sept
// fonctions dupliquées) : au plus une définition de fonction dont le nom
// contient "append_only", en excluant la fonction de cardinalité.
const appendOnlyFnDefs = (liveSource.match(/CREATE OR REPLACE FUNCTION \w*append_only\w*\(\)/g) || []);
t('une seule fonction append-only définie (réutilisée, pas dupliquée)', appendOnlyFnDefs.length === 1, `${appendOnlyFnDefs.length} définitions trouvées`);

// ---------------------------------------------------------------------
// 7. Cardinalité MERGE/SPLIT : trigger différé ancré sur l'EN-TÊTE
//    (event_cluster_relation_operations), jamais sur les arêtes seules —
//    condition explicite pour ne pas manquer une opération à zéro arête.
// ---------------------------------------------------------------------
t('trigger de cardinalité DEFERRABLE INITIALLY DEFERRED',
  /CREATE CONSTRAINT TRIGGER trg_cluster_relation_operation_cardinality[\s\S]{0,200}DEFERRABLE INITIALLY DEFERRED/.test(liveSource));
t('trigger de cardinalité ancré sur event_cluster_relation_operations (l\'en-tête), pas sur les arêtes',
  /CREATE CONSTRAINT TRIGGER trg_cluster_relation_operation_cardinality\s*\n\s*AFTER INSERT ON event_cluster_relation_operations/.test(liveSource));
t('la fonction de cardinalité rejette MERGE avec moins de 2 sources ou plus/moins d\'1 destination',
  /v_from_ct < 2 OR v_to_ct <> 1/.test(liveSource));
t('la fonction de cardinalité rejette SPLIT avec plus d\'1 source ou moins de 2 destinations',
  /v_from_ct <> 1 OR v_to_ct < 2/.test(liveSource));
t('la fonction de cardinalité interroge l\'agrégat sans dépendre de la présence d\'une arête (SELECT count ... WHERE operation_id = ...)',
  /SELECT count\(DISTINCT from_cluster_id\), count\(DISTINCT to_cluster_id\)/.test(liveSource));

// Rejeu de la migration (idempotence réelle) : DROP TRIGGER IF EXISTS
// doit précéder CREATE CONSTRAINT TRIGGER, exactement comme pour les
// sept triggers append-only — sinon une seconde application échoue avec
// "trigger already exists".
t('DROP TRIGGER IF EXISTS précède CREATE CONSTRAINT TRIGGER (rejeu sûr de la migration)',
  /DROP TRIGGER IF EXISTS trg_cluster_relation_operation_cardinality\s*\n\s*ON event_cluster_relation_operations;\s*\nCREATE CONSTRAINT TRIGGER trg_cluster_relation_operation_cardinality/.test(liveSource));

// ---------------------------------------------------------------------
// 7bis. Invariants DB de la chaîne de supersession du registre de
//    membership (pas seulement délégués à la future RPC) :
//      ASSIGN -> supersedes_decision_id IS NULL
//      AMEND/RETRACT -> supersedes_decision_id IS NOT NULL, décision
//        antérieure existante, même observation_id, même relation_key.
// ---------------------------------------------------------------------
t('fonction de validation de supersession de membership définie',
  /CREATE OR REPLACE FUNCTION fn_check_membership_decision_supersession\(\)/.test(liveSource));
t('trigger de supersession de membership : DROP IF EXISTS puis CREATE, BEFORE INSERT',
  /DROP TRIGGER IF EXISTS trg_membership_decision_supersession ON event_observation_memberships;\s*\nCREATE TRIGGER trg_membership_decision_supersession\s*\n\s*BEFORE INSERT ON event_observation_memberships/.test(liveSource));
t('ASSIGN rejeté si supersedes_decision_id est renseigné',
  /decision_type = 'ASSIGN' THEN[\s\S]{0,150}NEW\.supersedes_decision_id IS NOT NULL THEN[\s\S]{0,50}RAISE EXCEPTION/.test(liveSource));
t('AMEND/RETRACT rejeté si supersedes_decision_id est NULL',
  /NEW\.supersedes_decision_id IS NULL THEN[\s\S]{0,80}RAISE EXCEPTION/.test(liveSource));
t('la décision antérieure référencée doit exister (NOT FOUND -> RAISE EXCEPTION)',
  /WHERE decision_id = NEW\.supersedes_decision_id;[\s\S]{0,80}IF NOT FOUND THEN[\s\S]{0,80}RAISE EXCEPTION/.test(liveSource));
t('même observation_id exigé entre la décision antérieure et NEW',
  /v_predecessor\.observation_id <> NEW\.observation_id THEN/.test(liveSource));
t('même relation_key exigée (recalculée depuis NEW, jamais lue depuis la colonne GENERATED en BEFORE INSERT)',
  /v_predecessor\.relation_key <> v_expected_relation_key THEN/.test(liveSource)
  && /v_expected_relation_key := encode\(/.test(liveSource));

// ---------------------------------------------------------------------
// 7ter. Invariants DB de event_version_evidence (pas seulement délégués
//    à la future RPC) : version et décision référencées existantes,
//    même cluster, decision_type actif (ASSIGN/AMEND) — jamais RETRACT.
// ---------------------------------------------------------------------
t('fonction de validation cluster/type de l\'evidence définie',
  /CREATE OR REPLACE FUNCTION fn_check_event_version_evidence\(\)/.test(liveSource));
t('trigger de validation d\'evidence : DROP IF EXISTS puis CREATE, BEFORE INSERT',
  /DROP TRIGGER IF EXISTS trg_event_version_evidence_validation ON event_version_evidence;\s*\nCREATE TRIGGER trg_event_version_evidence_validation\s*\n\s*BEFORE INSERT ON event_version_evidence/.test(liveSource));
t('event_version_id référencé doit exister (NOT FOUND -> RAISE EXCEPTION)',
  /WHERE id = NEW\.event_version_id;[\s\S]{0,80}IF NOT FOUND THEN[\s\S]{0,80}RAISE EXCEPTION/.test(liveSource));
t('decision_id référencé doit exister (NOT FOUND -> RAISE EXCEPTION)',
  /WHERE decision_id = NEW\.decision_id;[\s\S]{0,80}IF NOT FOUND THEN[\s\S]{0,80}RAISE EXCEPTION/.test(liveSource));
t('cluster de la décision doit correspondre au cluster de la version (v_membership.cluster_id <> v_version_cluster_id)',
  /v_membership\.cluster_id <> v_version_cluster_id THEN/.test(liveSource));
t('seules ASSIGN/AMEND sont des preuves valides ; RETRACT est explicitement rejetée',
  /v_membership\.decision_type NOT IN \('ASSIGN', 'AMEND'\) THEN/.test(liveSource));

// ---------------------------------------------------------------------
// 8. RLS / grants : posture identique à news_articles (migration 0009)
// ---------------------------------------------------------------------
t('ENABLE ROW LEVEL SECURITY appliqué dynamiquement aux sept tables',
  /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/.test(liveSource));
t('REVOKE ALL FROM anon, authenticated appliqué',
  /REVOKE ALL ON %I FROM anon, authenticated/.test(liveSource));
t('REVOKE ALL FROM service_role puis GRANT SELECT, INSERT (jamais UPDATE/DELETE)',
  /REVOKE ALL ON %I FROM service_role/.test(liveSource)
  && /GRANT SELECT, INSERT ON %I TO service_role/.test(liveSource));
t('la boucle RLS/grants couvre exactement les sept tables',
  TABLES.every((table) => new RegExp(`'${table}'`).test(liveSource)));
t('aucun GRANT à anon ou authenticated', !/GRANT[^;]*TO\s+(anon|authenticated)/i.test(liveSource));
t('aucune policy créée pour anon/authenticated (deny-all par absence de policy)',
  !/CREATE POLICY/i.test(liveSource));

// ---------------------------------------------------------------------
// 9. Provenance : ON DELETE RESTRICT partout (jamais CASCADE ni SET NULL)
// ---------------------------------------------------------------------
t('aucun FK ON DELETE CASCADE introduit', !/ON DELETE CASCADE/i.test(liveSource));
t('aucun FK ON DELETE SET NULL introduit', !/ON DELETE SET NULL/i.test(liveSource));
const fkCount = (liveSource.match(/REFERENCES \w+ \([\w_]+\) ON DELETE RESTRICT/g) || []).length;
t('toutes les FK déclarées utilisent ON DELETE RESTRICT', fkCount >= 12, `${fkCount} FK RESTRICT trouvées`);

// ---------------------------------------------------------------------
// 10. Aucune altération des tables legacy / aucun backfill
// ---------------------------------------------------------------------
const LEGACY_TABLES = ['news_articles', 'news_events', 'ai_events', 'ai_analyses', 'ai_scenarios', 'data_sources', 'ingestion_runs'];
for (const table of LEGACY_TABLES) {
  t(`aucun ALTER TABLE ${table}`, !new RegExp(`ALTER TABLE ${table}\\b`).test(liveSource));
}
t('aucun DROP TABLE (aucune table préexistante supprimée)', !/DROP TABLE/i.test(liveSource));
t('aucun INSERT INTO dans le corps exécuté (aucun backfill)', !/\bINSERT INTO\b/i.test(liveSource));

// ---------------------------------------------------------------------
// 11. Frontière EVENT IMPACT : aucun champ analytique sur event_versions
// ---------------------------------------------------------------------
const eventVersionsBlockMatch = /CREATE TABLE IF NOT EXISTS event_versions \(([\s\S]*?)\n\);/.exec(liveSource);
const eventVersionsBlock = eventVersionsBlockMatch ? eventVersionsBlockMatch[1] : '';
t('le bloc CREATE TABLE event_versions a été extrait pour analyse', eventVersionsBlock.length > 0);

const FORBIDDEN_ANALYTICAL_FIELDS = ['direction', 'magnitude', 'pricing_state', 'horizon'];
for (const field of FORBIDDEN_ANALYTICAL_FIELDS) {
  t(`event_versions ne contient pas de champ "${field}"`,
    !new RegExp(`\\b${field}\\b`, 'i').test(eventVersionsBlock));
}
t('event_versions ne contient pas de champ "confidence" isolé (hors official_confirmation_state/source_independence_state)',
  !/\bconfidence\b/i.test(eventVersionsBlock));
t('event_versions ne référence aucun horizon H1-H5',
  !/\bH[1-5]\b/.test(eventVersionsBlock));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
