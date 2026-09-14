// Contrat statique de la RPC de supersession autonome OPS-023 Phase 2
// (migration 0016 : fn_event_supersede_membership — AMEND/RETRACT).
// Analyse le texte SQL de la migration : aucune connexion PostgreSQL
// requise, s'exécute en CI normale. Ne prouve PAS le comportement
// transactionnel réel (verrouillage effectif, atomicité, récupération
// de course, détection réelle de prédécesseur périmé) — une
// vérification live contre Supabase (rollback/probes de non-pollution)
// est effectuée indépendamment, après fusion. Ce fichier prouve
// uniquement que le TEXTE de la migration respecte le contrat gelé.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', '0016_event_membership_supersession_rpc.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0016 existe', existsSync(MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

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
t('migration 0016 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement UNE nouvelle fonction créée', createFunctionCount === 1, `${createFunctionCount} trouvées`);
t('cette fonction est public.fn_event_supersede_membership',
  /CREATE OR REPLACE FUNCTION public\.fn_event_supersede_membership\(/.test(liveSource));
t('fn_event_lock_cluster n\'est PAS redéfinie (réutilisée telle quelle)',
  !/CREATE OR REPLACE FUNCTION public\.fn_event_lock_cluster/.test(liveSource));

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

const fnSrc = extractFunctionSource(liveSource, 'fn_event_supersede_membership');
t('corps de fn_event_supersede_membership extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// 2. Signature, sécurité
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));

  t('RETURNS TABLE(cluster_id, decision_id, superseded_decision_id, decision_type, replayed)',
    /RETURNS TABLE \(\s*cluster_id\s+UUID,\s*decision_id\s+UUID,\s*superseded_decision_id\s+UUID,\s*decision_type\s+TEXT,\s*replayed\s+BOOLEAN/.test(liveSource));

  const REQUIRED_PARAMS = [
    'p_observation_id', 'p_cluster_id', 'p_supersedes_decision_id', 'p_decision_type',
    'p_membership_method', 'p_evidence_digest', 'p_membership_algorithm_version',
    'p_decision_actor', 'p_idempotency_fingerprint', 'p_semantic_state_fingerprint',
  ];
  const OPTIONAL_PARAMS = [
    'p_membership_confidence', 'p_editorial_origin_key', 'p_wire_lineage_key',
    'p_lineage_resolution_method', 'p_lineage_resolution_confidence', 'p_lineage_evidence',
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_supersede_membership\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
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
  // 3. AMEND/RETRACT uniquement, ASSIGN rejeté
  // ---------------------------------------------------------------------
  t('p_decision_type restreint à AMEND/RETRACT (ASSIGN rejeté)',
    /p_decision_type NOT IN \('AMEND', 'RETRACT'\) THEN[\s\S]{0,120}RAISE EXCEPTION/.test(fnSrc));
  t('le message d\'erreur mentionne explicitement qu\'ASSIGN n\'est jamais accepté ici',
    /ASSIGN n''est jamais accepté ici/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 4. Verrouillage : avant mutation, chemin fast-path AVANT le verrou,
  //    re-vérification APRÈS le verrou.
  // ---------------------------------------------------------------------
  t('utilise le primitif de verrou partagé fn_event_lock_cluster',
    /PERFORM public\.fn_event_lock_cluster\(p_cluster_id\);/.test(fnSrc));

  const lockIdx = fnSrc.indexOf('PERFORM public.fn_event_lock_cluster(p_cluster_id);');
  const insertIdx = fnSrc.indexOf('INSERT INTO public.event_observation_memberships');
  t('le verrou est acquis AVANT l\'insertion (mutation)',
    lockIdx > -1 && insertIdx > -1 && lockIdx < insertIdx);

  const idempotencyWhereIndices = [];
  let searchFrom = 0;
  for (;;) {
    const idx = fnSrc.indexOf('WHERE m.idempotency_fingerprint = p_idempotency_fingerprint', searchFrom);
    if (idx === -1) break;
    idempotencyWhereIndices.push(idx);
    searchFrom = idx + 1;
  }
  t('précheck d\'idempotence présent AVANT le verrou (au moins une vérification avant fn_event_lock_cluster)',
    idempotencyWhereIndices.length >= 2 && idempotencyWhereIndices[0] < lockIdx);
  t('re-vérification d\'idempotence présente APRÈS le verrou (au moins une vérification après fn_event_lock_cluster, avant l\'INSERT)',
    idempotencyWhereIndices.some((idx) => idx > lockIdx && idx < insertIdx));

  // ---------------------------------------------------------------------
  // 5. membership_operation_id toujours NULL ; rejet d'un rejeu vers une
  //    décision REASSIGN (membership_operation_id non-NULL).
  // ---------------------------------------------------------------------
  t('la décision insérée porte toujours membership_operation_id = NULL',
    /p_observation_id, p_cluster_id, p_decision_type, p_supersedes_decision_id, NULL,/.test(fnSrc));
  const operationIdGuardCount = (fnSrc.match(/v_existing\.membership_operation_id IS NOT NULL/g) || []).length;
  t('le rejeu rejette une ligne existante dont membership_operation_id IS NOT NULL, dans les 3 sites (précheck, re-check, récupération)',
    operationIdGuardCount === 3);

  // ---------------------------------------------------------------------
  // 6. Validation canonique complète du rejeu (tous les champs requis).
  // ---------------------------------------------------------------------
  const REPLAY_FIELDS = [
    'observation_id', 'cluster_id', 'decision_type', 'supersedes_decision_id',
    'membership_method', 'membership_confidence', 'evidence_digest',
    'editorial_origin_key', 'wire_lineage_key', 'lineage_resolution_method',
    'lineage_resolution_confidence', 'lineage_evidence', 'decision_actor',
    'semantic_state_fingerprint',
  ];
  for (const field of REPLAY_FIELDS) {
    const re = new RegExp(`v_existing\\.${field} IS DISTINCT FROM`);
    const count = (fnSrc.match(re) || []).length;
    t(`validation de rejeu inclut ${field} (au moins 1 occurrence)`, (fnSrc.match(new RegExp(`v_existing\\.${field} IS DISTINCT FROM`, 'g')) || []).length >= 1);
  }
  t('validation de rejeu compare algorithm_version (colonne table) à p_membership_algorithm_version',
    /v_existing\.algorithm_version IS DISTINCT FROM p_membership_algorithm_version/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 7. Validation du prédécesseur : existence, observation/cluster
  //    identiques, prédécesseur périmé (successeur déjà existant).
  // ---------------------------------------------------------------------
  t('rejette un prédécesseur introuvable (NOT FOUND -> RAISE EXCEPTION)',
    /WHERE m\.decision_id = p_supersedes_decision_id;[\s\S]{0,60}IF NOT FOUND THEN[\s\S]{0,60}RAISE EXCEPTION/.test(fnSrc));
  t('rejette un prédécesseur dont observation_id diffère',
    /v_predecessor\.observation_id IS DISTINCT FROM p_observation_id THEN/.test(fnSrc));
  t('rejette un prédécesseur dont cluster_id diffère',
    /v_predecessor\.cluster_id IS DISTINCT FROM p_cluster_id THEN/.test(fnSrc));
  t('détecte explicitement un successeur déjà existant (prédécesseur périmé) via une lecture dédiée, pas seulement via la contrainte UNIQUE',
    /SELECT EXISTS \(\s*\n\s*SELECT 1 FROM public\.event_observation_memberships m\s*\n\s*WHERE m\.supersedes_decision_id = p_supersedes_decision_id\s*\n\s*\) INTO v_successor_exists;/.test(fnSrc)
    && /IF v_successor_exists THEN[\s\S]{0,80}RAISE EXCEPTION/.test(fnSrc));
  t('le commentaire documente explicitement que la contrainte UNIQUE n\'est pas le mécanisme de contrôle de flux normal',
    /d[ée]pendance exclusive[\s\S]{0,20}uq_memberships_supersedes_decision/.test(source));

  // ---------------------------------------------------------------------
  // 8. RETRACT-sur-RETRACT interdit ; AMEND-sur-RETRACT autorisé.
  // ---------------------------------------------------------------------
  t('RETRACT sur un prédécesseur déjà RETRACT est rejeté',
    /p_decision_type = 'RETRACT' AND v_predecessor\.decision_type = 'RETRACT' THEN[\s\S]{0,80}RAISE EXCEPTION/.test(fnSrc));
  t('aucune restriction équivalente n\'existe pour AMEND sur un prédécesseur RETRACT (réouverture autorisée)',
    !/p_decision_type = 'AMEND' AND v_predecessor\.decision_type = 'RETRACT'/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 9. Insertion : alias explicite + RETURNING qualifié (pas de bug 0014).
  // ---------------------------------------------------------------------
  t('l\'INSERT porte un alias de cible explicite (AS m)',
    /INSERT INTO public\.event_observation_memberships AS m \(/.test(fnSrc));
  t('le RETURNING référence l\'alias qualifié (RETURNING m.decision_id INTO v_decision_id)',
    /RETURNING m\.decision_id INTO v_decision_id;/.test(fnSrc));
  t('aucun RETURNING decision_id non qualifié ne subsiste',
    !/(?<!m\.)\bRETURNING decision_id INTO v_decision_id\b/.test(fnSrc));
  // Les colonnes de sortie cluster_id/decision_type ne sont jamais
  // issues d'un SELECT ambigu depuis la table : elles proviennent des
  // paramètres déjà connus (p_cluster_id / p_decision_type), jamais
  // d'un RETURNING supplémentaire.
  t('un seul RETURNING existe dans toute la fonction (cluster_id/decision_type ne sont jamais eux-mêmes RETURNING, seulement decision_id)',
    (fnSrc.match(/RETURNING/g) || []).length === 1);

  // ---------------------------------------------------------------------
  // 10. Récupération scopée sur violation d'unicité.
  // ---------------------------------------------------------------------
  t('récupération EXCEPTION WHEN unique_violation présente',
    /EXCEPTION WHEN unique_violation THEN/.test(fnSrc));
  t('la récupération ne catch QUE uq_memberships_idempotency_fingerprint (GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME), toute autre violation est relevée (RAISE)',
    /GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;\s*\n\s*IF v_constraint_name IS DISTINCT FROM 'uq_memberships_idempotency_fingerprint' THEN\s*\n\s*RAISE;/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 11. Aucune UPDATE/DELETE ; qualification de schéma ; pg_catalog.
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
// 12. Sécurité : EXECUTE révoqué/accordé, table grants/RLS inchangés.
// ---------------------------------------------------------------------
t('REVOKE ALL sur fn_event_supersede_membership de PUBLIC, anon, authenticated',
  /REVOKE ALL ON FUNCTION public\.fn_event_supersede_membership\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_supersede_membership à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_supersede_membership\([\s\S]*?\) TO service_role;/.test(liveSource));
t('aucun GRANT à anon/authenticated/PUBLIC', !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));
t('aucun GRANT/REVOKE sur une TABLE (seulement sur des fonctions)',
  !/(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?event_(?!.*FUNCTION)[a-z_]+\s+(?:TO|FROM)/i.test(liveSource));
t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));
t('aucune nouvelle table créée', !/CREATE TABLE/i.test(liveSource));
t('aucun ALTER TABLE', !/ALTER TABLE/i.test(liveSource));
t('aucun index créé (les invariants d\'unicité restent portés par la migration 0012)', !/CREATE (?:UNIQUE )?INDEX/i.test(liveSource));

// ---------------------------------------------------------------------
// 13. Hors périmètre : migrations antérieures non modifiées, aucune
//     fonctionnalité hors périmètre (REASSIGN/identité/merge/split/
//     version/runtime).
// ---------------------------------------------------------------------
t('migration 0016 ne modifie pas les migrations 0012/0013/0014/0015 (aucune référence à leur nom de fichier)',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening|0014_event_membership_atomic_rpcs|0015_event_membership_returning_ambiguity_fix/.test(source));
t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts/i.test(liveSource));
t('aucune référence au Comité/Anthropic/notification dans la migration',
  !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
t('aucune référence à une future RPC de réassignation/identité/merge/split/version',
  !/fn_event_reassign|fn_event_create_cluster_relation|fn_event_create_event_version|identity_claim|strong_identity/i.test(liveSource));
t('aucun champ analytique EVENT IMPACT introduit (direction/magnitude/pricing/horizon)',
  !/\b(direction|magnitude|pricing_state|horizon)\b/i.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
