// Contrat statique de la RPC de réassignation atomique OPS-023 Phase 2
// (migration 0017 : fn_event_reassign_membership — RETRACT source +
// ASSIGN|AMEND destination, corrélées par membership_operation_id).
// Analyse le texte SQL de la migration : aucune connexion PostgreSQL
// requise, s'exécute en CI normale. Ne prouve PAS le comportement
// transactionnel réel (verrouillage effectif des deux clusters, ordre
// réel d'acquisition, atomicité du savepoint, absence réelle
// d'interblocage, récupération de course) — une vérification live contre
// Supabase (rollback/probes de non-pollution) est effectuée
// indépendamment, après fusion. Ce fichier prouve uniquement que le
// TEXTE de la migration respecte le contrat gelé.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0017_event_membership_reassign_rpc.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0017 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

// ---------------------------------------------------------------------
// 0. Immutabilité des migrations 0012-0016 (déjà appliquées à Supabase
//    en production) : empreintes SHA-256 exactes, jamais modifiées par
//    cette migration.
// ---------------------------------------------------------------------
const PRIOR_MIGRATIONS_EXPECTED_SHA256 = {
  '0012_event_cluster_version_foundation.sql':
    '4d339f2f1a1e674a05ff11a204cc5caaf468639abb88ade84e379760046ee4ee'.length === 64
      ? '4d339f2f1a1e674a05ff11a204cc5caaf468639abb88ade84e379760046ee4ee'
      : '',
  '0013_event_function_search_path_hardening.sql':
    '6ecef76c10422b992f02cec5277fcb2e29f7744594ec06b9b099f5f3ae79527e',
  '0014_event_membership_atomic_rpcs.sql':
    'ae670a1b610ee28e8a7baac900d29caff91b368b0c3f5c4d5591ab3c75468d73',
  '0015_event_membership_returning_ambiguity_fix.sql':
    '4d358832443b3ecdbc1ae795bc6f911db8428ea96d755248c982e68d5aa10e8c',
  '0016_event_membership_supersession_rpc.sql':
    'e9b51396822e525dbec3cb6d2b057d033e28724409da4de35bcac4a0de3db10a',
};

for (const [fileName, expectedSha] of Object.entries(PRIOR_MIGRATIONS_EXPECTED_SHA256)) {
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const priorSource = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const actualSha = priorSource.length > 0 ? createHash('sha256').update(priorSource).digest('hex') : '';
  t(`migration ${fileName} reste inchangée (empreinte SHA-256 identique)`,
    actualSha === expectedSha, `attendu ${expectedSha}, trouvé ${actualSha}`);
}

t('migration 0017 ne référence le nom de fichier d\'aucune migration antérieure',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening|0014_event_membership_atomic_rpcs|0015_event_membership_returning_ambiguity_fix|0016_event_membership_supersession_rpc/.test(source));

// Code SQL réellement exécuté : lignes de commentaire ('--...') retirées.
const liveSource = source
  .split('\n')
  .map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join('\n');

// ---------------------------------------------------------------------
// 1. Transactionnalité et périmètre
// ---------------------------------------------------------------------
t('migration 0017 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement UNE nouvelle fonction créée', createFunctionCount === 1, `${createFunctionCount} trouvées`);
t('cette fonction est public.fn_event_reassign_membership',
  /CREATE OR REPLACE FUNCTION public\.fn_event_reassign_membership\(/.test(liveSource));
t('fn_event_lock_cluster n\'est PAS redéfinie (réutilisée telle quelle)',
  !/CREATE OR REPLACE FUNCTION public\.fn_event_lock_cluster/.test(liveSource));
t('aucune nouvelle table créée', !/CREATE TABLE/i.test(liveSource));

function extractFunctionSource(src, fnName) {
  const startRe = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnName}\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  const asIdx = src.indexOf('AS $$', startMatch.index);
  if (asIdx === -1) return null;
  const endIdx = src.indexOf('\n$$;', asIdx);
  if (endIdx === -1) return null;
  return src.slice(startMatch.index, endIdx + 4);
}

const fnSrc = extractFunctionSource(liveSource, 'fn_event_reassign_membership');
t('corps de fn_event_reassign_membership extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// 2. Signature, sécurité
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));

  t('RETURNS TABLE(observation_id, source_cluster_id, destination_cluster_id, source_decision_id, destination_decision_id, destination_decision_type, membership_operation_id, replayed)',
    /RETURNS TABLE \(\s*observation_id\s+UUID,\s*source_cluster_id\s+UUID,\s*destination_cluster_id\s+UUID,\s*source_decision_id\s+UUID,\s*destination_decision_id\s+UUID,\s*destination_decision_type\s+TEXT,\s*membership_operation_id\s+TEXT,\s*replayed\s+BOOLEAN/.test(liveSource));

  const REQUIRED_PARAMS = [
    'p_observation_id', 'p_source_cluster_id', 'p_destination_cluster_id',
    'p_source_supersedes_decision_id', 'p_membership_operation_id',
    'p_source_idempotency_fingerprint', 'p_destination_idempotency_fingerprint',
    'p_source_semantic_state_fingerprint', 'p_destination_semantic_state_fingerprint',
    'p_membership_method', 'p_evidence_digest', 'p_membership_algorithm_version',
    'p_decision_actor',
  ];
  const OPTIONAL_PARAMS = [
    'p_membership_confidence', 'p_editorial_origin_key', 'p_wire_lineage_key',
    'p_lineage_resolution_method', 'p_lineage_resolution_confidence', 'p_lineage_evidence',
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_reassign_membership\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
  const signature = signatureMatch ? signatureMatch[1] : '';
  t('signature extraite', signature.length > 0);

  for (const param of REQUIRED_PARAMS) {
    const re = new RegExp(`${param}\\s+(UUID|TEXT)(?!\\s+DEFAULT)`);
    t(`paramètre obligatoire ${param} présent, sans DEFAULT`, re.test(signature));
  }
  for (const param of OPTIONAL_PARAMS) {
    const re = new RegExp(`${param}\\s+(TEXT|NUMERIC)\\s+DEFAULT NULL`);
    t(`paramètre optionnel ${param} présent avec DEFAULT NULL`, re.test(signature));
  }
  const firstOptionalIdx = signature.search(/p_membership_confidence\s+NUMERIC\s+DEFAULT NULL/);
  t('aucun paramètre obligatoire déclaré après le premier paramètre optionnel (ordre PostgreSQL valide)',
    firstOptionalIdx > -1 && REQUIRED_PARAMS.every((param) => signature.indexOf(param) < firstOptionalIdx));

  // ---------------------------------------------------------------------
  // 3. Validation scalaire de base.
  // ---------------------------------------------------------------------
  t('rejette p_source_cluster_id = p_destination_cluster_id (source != destination)',
    /IF p_source_cluster_id = p_destination_cluster_id THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('rejette p_source_supersedes_decision_id NULL (prédécesseur source obligatoire)',
    /IF p_source_supersedes_decision_id IS NULL THEN/.test(fnSrc));
  t('rejette p_membership_operation_id NULL/vide (opération partagée obligatoire)',
    /IF p_membership_operation_id IS NULL OR length\(btrim\(p_membership_operation_id\)\) = 0 THEN/.test(fnSrc));
  t('rejette p_source_idempotency_fingerprint NULL/vide',
    /IF p_source_idempotency_fingerprint IS NULL OR length\(btrim\(p_source_idempotency_fingerprint\)\) = 0 THEN/.test(fnSrc));
  t('rejette p_destination_idempotency_fingerprint NULL/vide',
    /IF p_destination_idempotency_fingerprint IS NULL OR length\(btrim\(p_destination_idempotency_fingerprint\)\) = 0 THEN/.test(fnSrc));
  t('rejette p_source_idempotency_fingerprint = p_destination_idempotency_fingerprint (deux empreintes DISTINCTES requises)',
    /IF p_source_idempotency_fingerprint = p_destination_idempotency_fingerprint THEN/.test(fnSrc));
  t('rejette p_source_semantic_state_fingerprint NULL/vide',
    /IF p_source_semantic_state_fingerprint IS NULL OR length\(btrim\(p_source_semantic_state_fingerprint\)\) = 0 THEN/.test(fnSrc));
  t('rejette p_destination_semantic_state_fingerprint NULL/vide',
    /IF p_destination_semantic_state_fingerprint IS NULL OR length\(btrim\(p_destination_semantic_state_fingerprint\)\) = 0 THEN/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 4. Verrouillage à deux clusters : ordre trié déterministe,
  //    indépendant du sens, AVANT toute mutation.
  // ---------------------------------------------------------------------
  t('calcule un ordre de verrouillage trié (min puis max), indépendant du sens',
    /IF p_source_cluster_id < p_destination_cluster_id THEN\s*\n\s*v_lock_first := p_source_cluster_id;\s*\n\s*v_lock_second := p_destination_cluster_id;\s*\n\s*ELSE\s*\n\s*v_lock_first := p_destination_cluster_id;\s*\n\s*v_lock_second := p_source_cluster_id;\s*\n\s*END IF;/.test(fnSrc));
  t('acquiert le verrou v_lock_first PUIS v_lock_second (jamais source verrouillé inconditionnellement en premier)',
    (() => {
      const firstLockIdx = fnSrc.indexOf('PERFORM public.fn_event_lock_cluster(v_lock_first);');
      const secondLockIdx = fnSrc.indexOf('PERFORM public.fn_event_lock_cluster(v_lock_second);');
      return firstLockIdx > -1 && secondLockIdx > -1 && firstLockIdx < secondLockIdx;
    })());
  t('n\'appelle jamais fn_event_lock_cluster directement sur p_source_cluster_id/p_destination_cluster_id (toujours via v_lock_first/v_lock_second triés)',
    !/PERFORM public\.fn_event_lock_cluster\(p_source_cluster_id\)/.test(fnSrc)
    && !/PERFORM public\.fn_event_lock_cluster\(p_destination_cluster_id\)/.test(fnSrc));

  const lastLockIdx = fnSrc.lastIndexOf('PERFORM public.fn_event_lock_cluster(v_lock_second);');
  const firstInsertIdx = fnSrc.indexOf('INSERT INTO public.event_observation_memberships');
  t('les DEUX verrous sont acquis AVANT toute mutation (INSERT)',
    lastLockIdx > -1 && firstInsertIdx > -1 && lastLockIdx < firstInsertIdx);

  // ---------------------------------------------------------------------
  // 5. Idempotence À L'ÉCHELLE DE L'OPÉRATION : précheck avant verrous,
  //    recheck après verrous, comptage 0 ou exactement 2.
  // ---------------------------------------------------------------------
  const opScopeWhereIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf('WHERE m.membership_operation_id = p_membership_operation_id', searchFrom);
      if (idx === -1) break;
      opScopeWhereIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  const firstLockIdx = fnSrc.indexOf('PERFORM public.fn_event_lock_cluster(v_lock_first);');
  t('précheck d\'idempotence à l\'échelle de l\'opération présent AVANT tout verrou',
    opScopeWhereIndices.length > 0 && firstLockIdx > -1 && opScopeWhereIndices[0] < firstLockIdx);
  t('re-vérification d\'idempotence à l\'échelle de l\'opération présente APRÈS les deux verrous, avant toute mutation',
    opScopeWhereIndices.some((idx) => idx > lastLockIdx && idx < firstInsertIdx));
  t('exactement 2 lignes -> chemin de rejeu ; tout autre compte non-nul -> exception de corruption d\'opération',
    (fnSrc.match(/IF v_op_row_count = 2 THEN/g) || []).length >= 2
    && (fnSrc.match(/ELSIF v_op_row_count <> 0 THEN\s*\n\s*RAISE EXCEPTION/g) || []).length >= 2);

  // ---------------------------------------------------------------------
  // 5bis. VALIDATION STRUCTURELLE DU PRÉDÉCESSEUR SOUS LES TROIS SITES DE
  //    REJEU (précheck avant verrous, recheck après verrous, récupération
  //    sur violation d'unicité) : un simple match d'idempotency_
  //    fingerprint / IS DISTINCT FROM ne prouve pas que la paire
  //    committée représente encore une opération REASSIGN canonique — il
  //    faut aussi prouver la forme du graphe de prédécesseurs.
  //
  //    v_replay_source_predecessor / v_replay_destination_predecessor
  //    déclarées, et CHAQUE bloc de validation ci-dessous doit apparaître
  //    EXACTEMENT 3 fois (une fois par site de rejeu) et, pour chaque
  //    site, AVANT son propre retour replayed=true (jamais après).
  // ---------------------------------------------------------------------
  t('v_replay_source_predecessor déclarée (RECORD)',
    /v_replay_source_predecessor\s+RECORD;/.test(liveSource));
  t('v_replay_destination_predecessor déclarée (RECORD)',
    /v_replay_destination_predecessor\s+RECORD;/.test(liveSource));

  const REPLAY_PREDECESSOR_CHECKS = [
    ['prédécesseur SOURCE existe (v_replay_source_predecessor.decision_id IS NULL testé)',
      'IF v_replay_source_predecessor.decision_id IS NULL'],
    ['prédécesseur SOURCE porte sur la MÊME observation',
      'OR v_replay_source_predecessor.observation_id IS DISTINCT FROM p_observation_id'],
    ['prédécesseur SOURCE porte sur le MÊME cluster source',
      'OR v_replay_source_predecessor.cluster_id IS DISTINCT FROM p_source_cluster_id'],
    ['prédécesseur SOURCE a decision_type ASSIGN ou AMEND (jamais RETRACT)',
      "OR v_replay_source_predecessor.decision_type NOT IN ('ASSIGN', 'AMEND')"],
    ['branche destination ASSIGN identifiée explicitement',
      "IF v_existing_destination.decision_type = 'ASSIGN' THEN"],
    ['ASSIGN rejoué => supersedes_decision_id DOIT être NULL',
      'IF v_existing_destination.supersedes_decision_id IS NOT NULL THEN'],
    ['branche destination AMEND identifiée explicitement',
      "ELSIF v_existing_destination.decision_type = 'AMEND' THEN"],
    ['AMEND rejoué => supersedes_decision_id DOIT être NON-NULL',
      'IF v_existing_destination.supersedes_decision_id IS NULL THEN'],
    ['prédécesseur AMEND (destination) existe (v_replay_destination_predecessor.decision_id IS NULL testé)',
      'IF v_replay_destination_predecessor.decision_id IS NULL'],
    ['prédécesseur AMEND (destination) porte sur la MÊME observation',
      'OR v_replay_destination_predecessor.observation_id IS DISTINCT FROM p_observation_id'],
    ['prédécesseur AMEND (destination) porte sur le MÊME cluster destination',
      'OR v_replay_destination_predecessor.cluster_id IS DISTINCT FROM p_destination_cluster_id'],
    ['prédécesseur AMEND (destination) a decision_type RETRACT (preuve de réouverture réelle)',
      "OR v_replay_destination_predecessor.decision_type IS DISTINCT FROM 'RETRACT'"],
  ];

  for (const [label, snippet] of REPLAY_PREDECESSOR_CHECKS) {
    const count = fnSrc.split(snippet).length - 1;
    t(`validation de rejeu : ${label} — présente aux 3 sites de rejeu`, count === 3, `trouvé ${count} occurrence(s)`);
  }

  const REPLAY_RETURN_MARKER =
    'RETURN QUERY SELECT p_observation_id, p_source_cluster_id, p_destination_cluster_id,\n' +
    '                        v_existing_source.decision_id, v_existing_destination.decision_id,\n' +
    '                        v_existing_destination.decision_type, p_membership_operation_id, true;';
  const replayReturnIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf(REPLAY_RETURN_MARKER, searchFrom);
      if (idx === -1) break;
      replayReturnIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('exactement 3 retours replayed=true trouvés (précheck, recheck, récupération)',
    replayReturnIndices.length === 3, `trouvé ${replayReturnIndices.length}`);

  if (replayReturnIndices.length === 3) {
    let prevEnd = 0;
    replayReturnIndices.forEach((returnIdx, siteIndex) => {
      const segment = fnSrc.slice(prevEnd, returnIdx);
      for (const [label, snippet] of REPLAY_PREDECESSOR_CHECKS) {
        t(`site de rejeu #${siteIndex + 1} : "${label}" précède ce retour replayed=true (jamais après)`,
          segment.includes(snippet));
      }
      prevEnd = returnIdx;
    });
  }

  // ---------------------------------------------------------------------
  // 6. Prédécesseur source : existence, observation/cluster identiques,
  //    tip vivant ASSIGN/AMEND uniquement (RETRACT rejeté), fraîcheur
  //    explicite (successeur déjà existant).
  // ---------------------------------------------------------------------
  t('rejette un prédécesseur source introuvable (NOT FOUND -> RAISE EXCEPTION)',
    /WHERE m\.decision_id = p_source_supersedes_decision_id;[\s\S]{0,80}IF NOT FOUND THEN[\s\S]{0,80}RAISE EXCEPTION/.test(fnSrc));
  t('rejette un prédécesseur source dont observation_id diffère',
    /v_source_predecessor\.observation_id IS DISTINCT FROM p_observation_id THEN/.test(fnSrc));
  t('rejette un prédécesseur source dont cluster_id diffère',
    /v_source_predecessor\.cluster_id IS DISTINCT FROM p_source_cluster_id THEN/.test(fnSrc));
  t('rejette un tip source RETRACT (inactif) : seul ASSIGN/AMEND peut être réassigné',
    /IF v_source_predecessor\.decision_type NOT IN \('ASSIGN', 'AMEND'\) THEN\s*\n\s*RAISE EXCEPTION/.test(fnSrc));
  t('détecte explicitement un successeur source déjà existant (fraîcheur) via une lecture dédiée, pas seulement via la contrainte UNIQUE',
    /SELECT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_observation_memberships m\s*\n\s*WHERE m\.supersedes_decision_id = p_source_supersedes_decision_id\s*\n\s*\) INTO v_source_successor_exists;/.test(fnSrc)
    && /IF v_source_successor_exists THEN[\s\S]{0,80}RAISE EXCEPTION/.test(fnSrc));
  t('le commentaire documente explicitement que la contrainte UNIQUE n\'est pas le mécanisme de contrôle de flux normal',
    /d[ée]pendance exclusive[\s\S]{0,20}uq_memberships_supersedes_decision/.test(source));

  // ---------------------------------------------------------------------
  // 7. État de la relation DESTINATION : tip par chaîne append-only
  //    (jamais assigned_at seul), Cas A/B/C.
  // ---------------------------------------------------------------------
  t('détermine le tip destination via NOT EXISTS (aucun successeur) sur (observation, cluster destination) — jamais assigned_at seul',
    /WHERE m\.observation_id = p_observation_id\s*\n\s*AND m\.cluster_id = p_destination_cluster_id\s*\n\s*AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_observation_memberships s\s*\n\s*WHERE s\.supersedes_decision_id = m\.decision_id\s*\n\s*\)/.test(fnSrc));
  t('ne substitue jamais assigned_at à la détection de currentness par graphe pour la destination',
    !/ORDER BY\s+assigned_at/i.test(fnSrc));
  t('Cas A (aucun tip) -> destination_decision_type = ASSIGN, supersedes = NULL',
    /IF NOT FOUND THEN[\s\S]{0,40}v_destination_decision_type := 'ASSIGN';\s*\n\s*v_destination_supersedes_decision := NULL;/.test(fnSrc));
  t('Cas B (tip destination = RETRACT) -> destination_decision_type = AMEND, supersedes = tip destination (réouverture)',
    /ELSIF v_destination_tip\.decision_type = 'RETRACT' THEN[\s\S]{0,60}v_destination_decision_type := 'AMEND';\s*\n\s*v_destination_supersedes_decision := v_destination_tip\.decision_id;/.test(fnSrc));
  t('Cas C (tip destination actif ASSIGN/AMEND) -> REJET explicite, jamais un no-op silencieux',
    /ELSE[\s\S]{0,150}RAISE EXCEPTION[\s\S]{0,300}déjà active/.test(fnSrc));
  t('destination_decision_type n\'est JAMAIS assigné à RETRACT',
    !/v_destination_decision_type := 'RETRACT'/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 8. Contenu des deux lignes : source toujours RETRACT, opération
  //    partagée non-NULL sur les deux INSERT.
  // ---------------------------------------------------------------------
  t('la ligne SOURCE insérée porte toujours decision_type = RETRACT',
    /p_observation_id, p_source_cluster_id, 'RETRACT', p_source_supersedes_decision_id, p_membership_operation_id,/.test(fnSrc));
  t('la ligne DESTINATION insérée porte v_destination_decision_type (jamais un littéral figé)',
    /p_observation_id, p_destination_cluster_id, v_destination_decision_type, v_destination_supersedes_decision, p_membership_operation_id,/.test(fnSrc));
  const membershipOperationIdInsertCount = (fnSrc.match(/, p_membership_operation_id,/g) || []).length;
  t('les DEUX INSERT portent p_membership_operation_id (même opération partagée sur les deux lignes)',
    membershipOperationIdInsertCount >= 2);

  // ---------------------------------------------------------------------
  // 9. Atomicité : les deux INSERT vivent dans LE MÊME bloc
  //    BEGIN/EXCEPTION (un seul savepoint implicite).
  // ---------------------------------------------------------------------
  const beginBlockIdx = fnSrc.search(/\n\s*BEGIN\s*\n\s*INSERT INTO public\.event_observation_memberships AS m/);
  const secondInsertIdx = fnSrc.indexOf('INSERT INTO public.event_observation_memberships', firstInsertIdx + 1);
  const exceptionIdx = fnSrc.indexOf('EXCEPTION WHEN unique_violation THEN');
  t('un seul bloc BEGIN...EXCEPTION englobe les DEUX INSERT (même savepoint implicite)',
    beginBlockIdx > -1 && secondInsertIdx > -1 && exceptionIdx > -1
    && beginBlockIdx < firstInsertIdx && firstInsertIdx < secondInsertIdx && secondInsertIdx < exceptionIdx);
  t('le premier INSERT (source RETRACT) n\'a pas son propre RETURN avant le second INSERT (aucun commit intermédiaire séparé)',
    !/RETURNING m\.decision_id INTO v_source_decision_id;\s*\n\s*RETURN QUERY/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 10. Alias explicites + RETURNING qualifié sur les DEUX INSERT (leçon
  //     0015, appliquée même sans collision démontrée).
  // ---------------------------------------------------------------------
  const insertAsMCount = (fnSrc.match(/INSERT INTO public\.event_observation_memberships AS m \(/g) || []).length;
  t('les DEUX INSERT portent un alias de cible explicite (AS m)', insertAsMCount === 2);
  t('RETURNING m.decision_id INTO v_source_decision_id (qualifié)',
    /RETURNING m\.decision_id INTO v_source_decision_id;/.test(fnSrc));
  t('RETURNING m.decision_id INTO v_destination_decision_id (qualifié)',
    /RETURNING m\.decision_id INTO v_destination_decision_id;/.test(fnSrc));
  t('aucun RETURNING decision_id non qualifié ne subsiste',
    !/(?<!m\.)\bRETURNING decision_id INTO\b/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 11. Récupération scopée sur violation d'unicité.
  // ---------------------------------------------------------------------
  t('récupération EXCEPTION WHEN unique_violation présente',
    /EXCEPTION WHEN unique_violation THEN/.test(fnSrc));
  t('la récupération ne catch QUE uq_memberships_idempotency_fingerprint (GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME), toute autre violation est relevée (RAISE)',
    /GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;\s*\n\s*IF v_constraint_name IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN\s*\n\s*RAISE;/.test(fnSrc));
  t('après récupération, revalide la paire canonique complète avant de retourner replayed=true',
    (() => {
      if (exceptionIdx === -1) return false;
      const recoveryTail = fnSrc.slice(exceptionIdx);
      const rowCountGuardIdx = recoveryTail.indexOf('IF v_op_row_count <> 2 THEN');
      const sourceNullCheckIdx = recoveryTail.indexOf('v_existing_source.decision_id IS NULL');
      const destNullCheckIdx = recoveryTail.indexOf('v_existing_destination.decision_id IS NULL');
      const replayedTrueIdx = recoveryTail.lastIndexOf('true;');
      return rowCountGuardIdx > -1 && sourceNullCheckIdx > -1 && destNullCheckIdx > -1 && replayedTrueIdx > -1
        && rowCountGuardIdx < sourceNullCheckIdx
        && sourceNullCheckIdx < destNullCheckIdx
        && destNullCheckIdx < replayedTrueIdx;
    })());

  // ---------------------------------------------------------------------
  // 12. Aucune UPDATE/DELETE ; qualification de schéma ; pg_catalog.
  // ---------------------------------------------------------------------
  t('aucun UPDATE contre une table d\'événement OPS-023', !/UPDATE\s+public\.event_/i.test(fnSrc));
  t('aucun DELETE contre une table d\'événement OPS-023', !/DELETE\s+FROM\s+public\.event_/i.test(fnSrc));

  const RELATION_TABLES = ['event_clusters', 'event_observation_memberships', 'news_articles'];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`toute référence à ${tbl} est qualifiée public.${tbl}`, !unqualified.test(fnSrc));
  }
  t('fn_event_lock_cluster est appelée qualifiée public.',
    /public\.fn_event_lock_cluster\(/.test(fnSrc));
}

// ---------------------------------------------------------------------
// 13. Sécurité : EXECUTE révoqué/accordé, table grants/RLS inchangés.
// ---------------------------------------------------------------------
t('REVOKE ALL sur fn_event_reassign_membership de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_reassign_membership\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_reassign_membership à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_reassign_membership\([\s\S]*?\) TO service_role;/.test(liveSource));
t('aucun GRANT à anon/authenticated/PUBLIC', !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));
t('aucun GRANT/REVOKE sur une TABLE (seulement sur des fonctions)',
  !/(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?event_(?!.*FUNCTION)[a-z_]+\s+(?:TO|FROM)/i.test(liveSource));
t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));
t('aucun ALTER TABLE', !/ALTER TABLE/i.test(liveSource));
t('aucun index créé (les invariants d\'unicité restent portés par la migration 0012)', !/CREATE (?:UNIQUE )?INDEX/i.test(liveSource));

// ---------------------------------------------------------------------
// 14. Hors périmètre : aucune fonctionnalité hors périmètre (identité
//     forte/merge/split/cycle/version/processeur/runtime/legacy).
// ---------------------------------------------------------------------
t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts/i.test(liveSource));
t('aucune référence au Comité/Anthropic/notification dans la migration',
  !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
t('aucune référence à une future RPC d\'identité/merge/split/version/cycle',
  !/fn_event_create_cluster_relation|fn_event_create_event_version|identity_claim|strong_identity|fn_event_merge|fn_event_split|cycle_prevention/i.test(liveSource));
t('aucun champ analytique EVENT IMPACT introduit (direction/magnitude/pricing/horizon)',
  !/\b(direction|magnitude|pricing_state|horizon)\b/i.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
