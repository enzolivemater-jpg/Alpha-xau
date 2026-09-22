// Contrat statique de la RPC atomique EVENT IMPACT (PR-EI-2, migration
// 0024 : fn_event_impact_create_assessment). Analyse le texte SQL de la
// migration : aucune connexion PostgreSQL requise, s'exécute en CI
// normale. Ne prouve PAS le comportement transactionnel réel (conflit
// d'index UNIQUE concurrent réel, sémantique de rollback réelle, égalité
// JSONB numérique réelle) — une vérification live contre Supabase est
// effectuée indépendamment, après fusion. Ce fichier prouve uniquement
// que le TEXTE de la migration respecte le contrat gelé.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0024_event_impact_atomic_rpc.sql');
const SCHEMA_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0023_event_impact_schema.sql');

let p = 0, f = 0;
const t = (n, c, x = '') => { c ? (p++, console.log(`  OK  ${n}`)) : (f++, console.log(`  FAIL ${n} ${x}`)); };

t('migration 0024 existe', existsSync(MIGRATION_PATH));
t('migration 0023 (prérequis, immuable) existe toujours', existsSync(SCHEMA_MIGRATION_PATH));

const source = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

t('migration 0024 ne référence le nom de fichier d\'aucune migration antérieure',
  !/0012_event_cluster_version_foundation|0013_event_function_search_path_hardening|0014_event_membership_atomic_rpcs|0015_event_membership_returning_ambiguity_fix|0016_event_membership_supersession_rpc|0017_event_membership_reassign_rpc|0018_event_identity_claim_rpc|0019_event_cluster_relation_rpc|0020_event_version_atomic_rpc|0021_event_version_runtime_ambiguity_fix|0022_event_shadow_candidate_discovery/.test(source));

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
t('migration 0024 est transactionnelle (BEGIN ... COMMIT)',
  /^\s*BEGIN;/m.test(liveSource) && /COMMIT;\s*$/m.test(liveSource.trimEnd()));

const createFunctionCount = (liveSource.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
t('exactement UNE fonction créée (une seule RPC)', createFunctionCount === 1, `${createFunctionCount} trouvées`);
t('cette fonction est public.fn_event_impact_create_assessment',
  /CREATE OR REPLACE FUNCTION public\.fn_event_impact_create_assessment\(/.test(liveSource));
t('aucune seconde RPC de mutation (update/delete/discovery/runtime)',
  !/fn_event_impact_update|fn_event_impact_delete|fn_event_impact_discover|fn_event_impact_process/i.test(liveSource));
t('aucune nouvelle table créée', !/CREATE TABLE/i.test(liveSource));
t('aucun nouvel index créé', !/CREATE (?:UNIQUE )?INDEX/i.test(liveSource));
t('la migration 0023 n\'est PAS modifiée par ce fichier (aucun ALTER/DROP sur ses objets ici)',
  !/ALTER TABLE public\.event_impact_assessments|ALTER TABLE public\.event_impact_interpretations|DROP TABLE/i.test(liveSource));

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

const fnSrc = extractFunctionSource(liveSource, 'fn_event_impact_create_assessment');
t('corps de fn_event_impact_create_assessment extrait pour analyse', fnSrc !== null);

// ---------------------------------------------------------------------
// 2. Signature, sécurité, contrat de retour
// ---------------------------------------------------------------------
if (fnSrc !== null) {
  t('SECURITY INVOKER explicite', /SECURITY INVOKER/.test(fnSrc));
  t('SECURITY DEFINER absent', !/SECURITY DEFINER/.test(fnSrc));
  t('SET search_path = \'\' présent', /SET search_path = ''/.test(fnSrc));
  t('LANGUAGE plpgsql', /LANGUAGE plpgsql/.test(liveSource));

  t('RETURNS TABLE(assessment_id, replayed, interpretation_count)',
    /RETURNS TABLE \(\s*assessment_id\s+UUID,\s*replayed\s+BOOLEAN,\s*interpretation_count\s+INTEGER/.test(liveSource));

  const REQUIRED_PARAMS = [
    ['p_event_version_id', 'UUID'], ['p_assessment_status', 'TEXT'], ['p_knowledge_cutoff', 'TIMESTAMPTZ'],
    ['p_producer_type', 'TEXT'], ['p_producer_actor', 'TEXT'], ['p_algorithm_version', 'TEXT'],
    ['p_input_fingerprint', 'TEXT'], ['p_semantic_fingerprint', 'TEXT'], ['p_idempotency_fingerprint', 'TEXT'],
    ['p_interpretations', 'JSONB'],
  ];
  const signatureMatch = /CREATE OR REPLACE FUNCTION public\.fn_event_impact_create_assessment\(([\s\S]*?)\)\s*\nRETURNS TABLE/.exec(liveSource);
  const signature = signatureMatch ? signatureMatch[1] : '';
  t('signature extraite', signature.length > 0);

  for (const [param, type] of REQUIRED_PARAMS) {
    const re = new RegExp(`${param}\\s+${type}(?!\\s+DEFAULT)`);
    t(`paramètre obligatoire ${param} présent, sans DEFAULT`, re.test(signature));
  }
  t('paramètre optionnel p_supersedes_assessment_id présent avec DEFAULT NULL',
    /p_supersedes_assessment_id\s+UUID\s+DEFAULT NULL/.test(signature));
  const optionalIdx = signature.search(/p_supersedes_assessment_id\s+UUID\s+DEFAULT NULL/);
  t('aucun paramètre obligatoire déclaré après le paramètre optionnel (ordre PostgreSQL valide)',
    optionalIdx > -1 && REQUIRED_PARAMS.every(([param]) => signature.indexOf(param) < optionalIdx));
  t('l\'appelant ne fournit jamais d\'UUID d\'évaluation (aucun p_assessment_id/p_id dans la signature)',
    !/p_assessment_id\b|(?<!p_supersedes_)\bp_id\b/.test(signature));

  // ---------------------------------------------------------------------
  // 3. Validation scalaire de base.
  // ---------------------------------------------------------------------
  t('rejette p_event_version_id NULL', /IF p_event_version_id IS NULL THEN/.test(fnSrc));
  t('rejette p_assessment_status NULL', /IF p_assessment_status IS NULL THEN/.test(fnSrc));
  t('rejette p_knowledge_cutoff NULL', /IF p_knowledge_cutoff IS NULL THEN/.test(fnSrc));
  t('rejette p_producer_type NULL', /IF p_producer_type IS NULL THEN/.test(fnSrc));
  t('rejette p_producer_actor NULL/vide', /p_producer_actor IS NULL OR length\(btrim\(p_producer_actor\)\) = 0/.test(fnSrc));
  t('rejette p_algorithm_version NULL/vide', /p_algorithm_version IS NULL OR length\(btrim\(p_algorithm_version\)\) = 0/.test(fnSrc));
  t('rejette p_input_fingerprint NULL/vide', /p_input_fingerprint IS NULL OR length\(btrim\(p_input_fingerprint\)\) = 0/.test(fnSrc));
  t('rejette p_semantic_fingerprint NULL/vide', /p_semantic_fingerprint IS NULL OR length\(btrim\(p_semantic_fingerprint\)\) = 0/.test(fnSrc));
  t('rejette p_idempotency_fingerprint NULL/vide', /p_idempotency_fingerprint IS NULL OR length\(btrim\(p_idempotency_fingerprint\)\) = 0/.test(fnSrc));
  t('rejette p_interpretations NULL explicitement (jamais une absorption silencieuse en tableau vide)',
    /IF p_interpretations IS NULL THEN\s*\n\s*RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS/.test(fnSrc));

  t('ne duplique aucun vocabulaire figé 0023 (aucun NOT IN sur assessment_status/producer_type/horizon/direction/magnitude_state/confidence_state/pricing_state)',
    !/p_assessment_status NOT IN/.test(fnSrc)
    && !/p_producer_type NOT IN/.test(fnSrc)
    && !/horizon NOT IN/.test(fnSrc)
    && !/direction NOT IN/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 4. Contrat JSON enfant : tableau obligatoire, objets obligatoires,
  //    clés exactement autorisées, rejet explicite.
  // ---------------------------------------------------------------------
  t('EVENT_IMPACT_INVALID_INTERPRETATIONS : racine non-tableau rejetée',
    /IF jsonb_typeof\(p_interpretations\) <> 'array' THEN\s*\n\s*RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS/.test(fnSrc));
  t('EVENT_IMPACT_INVALID_INTERPRETATIONS : membre non-objet rejeté',
    /IF jsonb_typeof\(v_item\) <> 'object' THEN\s*\n\s*RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS/.test(fnSrc));
  t('itère chaque élément via jsonb_array_elements', /FOR v_item IN SELECT value FROM jsonb_array_elements\(p_interpretations\)/.test(fnSrc));

  const ALLOWED_KEYS = [
    'horizon', 'interpretation_key', 'interpretation_role', 'direction',
    'magnitude_state', 'magnitude_value', 'magnitude_unit', 'magnitude_basis',
    'confidence_state', 'confidence_value', 'pricing_state', 'rationale',
  ];
  const allowedKeysBlockMatch = /WHERE key NOT IN \(([\s\S]*?)\);/.exec(fnSrc);
  t('bloc de clés autorisées extrait pour analyse', allowedKeysBlockMatch !== null);
  if (allowedKeysBlockMatch !== null) {
    const allowedKeysBlock = allowedKeysBlockMatch[1];
    for (const key of ALLOWED_KEYS) {
      t(`clé autorisée "${key}" présente dans le contrat`, allowedKeysBlock.includes(`'${key}'`));
    }
    const foundKeys = [...allowedKeysBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    t('EXACTEMENT les 12 clés autorisées, aucune de plus',
      foundKeys.length === ALLOWED_KEYS.length, `trouvé ${foundKeys.length}: ${foundKeys.join(',')}`);
  }
  t('rejette explicitement toute clé inconnue (EVENT_IMPACT_INVALID_INTERPRETATIONS, jamais une absorption silencieuse)',
    /IF v_unknown_keys IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'EVENT_IMPACT_INVALID_INTERPRETATIONS/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 5. Cohérence statut/enfants (ASSESSED >= 1, non-ASSESSED == 0).
  // ---------------------------------------------------------------------
  t('EVENT_IMPACT_STATUS_CHILD_CONFLICT : ASSESSED exige au moins une interprétation',
    /IF p_assessment_status = 'ASSESSED' THEN\s*\n\s*IF jsonb_array_length\(p_interpretations\) = 0 THEN\s*\n\s*RAISE EXCEPTION 'EVENT_IMPACT_STATUS_CHILD_CONFLICT/.test(fnSrc));
  t('EVENT_IMPACT_STATUS_CHILD_CONFLICT : INSUFFICIENT_EVIDENCE/UNAVAILABLE exigent zéro interprétation',
    /ELSIF p_assessment_status IN \('INSUFFICIENT_EVIDENCE', 'UNAVAILABLE'\) THEN\s*\n\s*IF jsonb_array_length\(p_interpretations\) <> 0 THEN\s*\n\s*RAISE EXCEPTION 'EVENT_IMPACT_STATUS_CHILD_CONFLICT/.test(fnSrc));

  // ---------------------------------------------------------------------
  // 6. Normalisation canonique déterministe.
  // ---------------------------------------------------------------------
  const CANONICAL_FIELDS = [
    'horizon', 'interpretation_key', 'interpretation_role', 'direction',
    'magnitude_state', 'magnitude_value', 'magnitude_unit', 'magnitude_basis',
    'confidence_state', 'confidence_value', 'pricing_state', 'rationale',
  ];
  const canonicalBuildOccurrences = (fnSrc.match(/jsonb_build_object\(\s*\n\s*'horizon',/g) || []).length;
  t('construit la forme canonique via jsonb_build_object avec les 12 champs Event Impact, au moins 3 fois (candidat, existant-précheck, existant-post-conflit)',
    canonicalBuildOccurrences >= 3, `trouvé ${canonicalBuildOccurrences}`);
  for (const field of CANONICAL_FIELDS) {
    const occurrences = (fnSrc.match(new RegExp(`'${field}',`, 'g')) || []).length;
    t(`le champ canonique "${field}" apparaît dans chaque construction canonique (>= 3 occurrences)`,
      occurrences >= 3, `trouvé ${occurrences}`);
  }
  t('tri déterministe par (horizon, interpretation_key, interpretation_role), au moins 3 fois',
    (fnSrc.match(/ORDER BY (?:norm|eii)\.horizon, (?:norm|eii)\.interpretation_key, (?:norm|eii)\.interpretation_role/g) || []).length >= 3);
  t('extraction via l\'opérateur ->> (équivalence clé-absente / null explicite automatique)',
    /item ->> 'horizon'/.test(fnSrc) && /item ->> 'interpretation_key'/.test(fnSrc));
  t('magnitude_value/confidence_value castés en NUMERIC depuis le texte JSON',
    /\(item ->> 'magnitude_value'\)::NUMERIC/.test(fnSrc) && /\(item ->> 'confidence_value'\)::NUMERIC/.test(fnSrc));
  t('confiance canonique à la précision NUMERIC(5,4) de la colonne (rejeu après arrondi)',
    /\(item ->> 'confidence_value'\)::NUMERIC\(5,4\)/.test(fnSrc));
  t('forme canonique par défaut un tableau JSON vide (COALESCE(..., \'[]\'::jsonb)), au moins 3 fois',
    (fnSrc.match(/COALESCE\(jsonb_agg\(/g) || []).length >= 3
    && (fnSrc.match(/'\[\]'::jsonb\)/g) || []).length >= 3);

  // ---------------------------------------------------------------------
  // 7. Idempotence DB-backed : ON CONFLICT DO NOTHING, jamais un
  //    pré-check non protégé.
  // ---------------------------------------------------------------------
  t('utilise INSERT ... ON CONFLICT (idempotency_fingerprint) DO NOTHING comme autorité d\'unicité',
    /ON CONFLICT \(idempotency_fingerprint\) DO NOTHING/.test(fnSrc));
  t('capture l\'id généré via RETURNING qualifié (eia.id) dans v_assessment_id',
    /RETURNING eia\.id INTO v_assessment_id;/.test(fnSrc));
  t('branche sur v_assessment_id IS NOT NULL pour distinguer créé vs conflit (jamais une dépendance à une exception unique_violation)',
    /IF v_assessment_id IS NOT NULL THEN/.test(fnSrc));
  t('aucun pré-check non protégé ne remplace la protection ON CONFLICT (le pré-check ÉTAPE 5 précède l\'INSERT, mais l\'INSERT reste protégé par ON CONFLICT)',
    (() => {
      const precheckIdx = fnSrc.indexOf('WHERE eia.idempotency_fingerprint = p_idempotency_fingerprint');
      const insertIdx = fnSrc.indexOf('INSERT INTO public.event_impact_assessments AS eia (');
      const onConflictIdx = fnSrc.indexOf('ON CONFLICT (idempotency_fingerprint) DO NOTHING');
      return precheckIdx > -1 && insertIdx > -1 && onConflictIdx > -1
        && precheckIdx < insertIdx && insertIdx < onConflictIdx;
    })());

  const idempotencyWhereIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf('WHERE eia.idempotency_fingerprint = p_idempotency_fingerprint', searchFrom);
      if (idx === -1) break;
      idempotencyWhereIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('exactement 2 lookups par idempotency_fingerprint (précheck, récupération post-conflit)',
    idempotencyWhereIndices.length === 2, `trouvé ${idempotencyWhereIndices.length}`);

  // ---------------------------------------------------------------------
  // 8. Parent avant enfants, atomicité, jamais de persistance
  //    enfant-d'abord.
  // ---------------------------------------------------------------------
  const insertParentIdx = fnSrc.indexOf('INSERT INTO public.event_impact_assessments AS eia (');
  const insertChildIdx = fnSrc.indexOf('INSERT INTO public.event_impact_interpretations (');
  t('un seul INSERT parent (event_impact_assessments)',
    (fnSrc.match(/INSERT INTO public\.event_impact_assessments/g) || []).length === 1);
  t('un seul INSERT enfants en bulk (event_impact_interpretations)',
    (fnSrc.match(/INSERT INTO public\.event_impact_interpretations/g) || []).length === 1);
  t('INVARIANT CRITIQUE : le parent est TOUJOURS inséré avant les enfants (ordre textuel)',
    insertParentIdx > -1 && insertChildIdx > -1 && insertParentIdx < insertChildIdx);
  t('les enfants sont insérés uniquement dans la branche v_assessment_id IS NOT NULL (jamais si le parent n\'a pas été créé/retrouvé)',
    (() => {
      const branchIdx = fnSrc.indexOf('IF v_assessment_id IS NOT NULL THEN');
      return branchIdx > -1 && insertChildIdx > branchIdx;
    })());
  t('les enfants sont insérés depuis la forme canonique via jsonb_to_recordset(v_canonical_interpretations)',
    /FROM jsonb_to_recordset\(v_canonical_interpretations\) AS norm\(/.test(fnSrc));
  t('vérifie que le nombre d\'enfants insérés égale la longueur du tableau canonique (GET DIAGNOSTICS ROW_COUNT)',
    /GET DIAGNOSTICS v_inserted_interpretation_count = ROW_COUNT;/.test(fnSrc)
    && /IF v_inserted_interpretation_count <> jsonb_array_length\(v_canonical_interpretations\) THEN/.test(fnSrc));
  t('aucun UPDATE contre une table event_impact', !/UPDATE\s+public\.event_impact_/i.test(fnSrc));
  t('aucun DELETE contre une table event_impact', !/DELETE\s+FROM\s+public\.event_impact_/i.test(fnSrc));
  t('aucune tentative de persistance enfant-d\'abord (aucun INSERT interpretations avant tout INSERT assessments dans le texte)',
    insertChildIdx > insertParentIdx);

  // ---------------------------------------------------------------------
  // 9. Chemin de rejeu (précheck + récupération post-conflit) et
  //    conflit d'idempotence — jamais un rejeu silencieux en cas de
  //    divergence.
  // ---------------------------------------------------------------------
  const REPLAY_TRUE_RETURN_MARKER = 'RETURN QUERY SELECT v_existing.id, true,';
  const replayTrueReturnIndices = [];
  {
    let searchFrom = 0;
    for (;;) {
      const idx = fnSrc.indexOf(REPLAY_TRUE_RETURN_MARKER, searchFrom);
      if (idx === -1) break;
      replayTrueReturnIndices.push(idx);
      searchFrom = idx + 1;
    }
  }
  t('exactement 2 retours replayed=true (précheck, récupération post-conflit)',
    replayTrueReturnIndices.length === 2, `trouvé ${replayTrueReturnIndices.length}`);
  t('exactement 1 retour replayed=false (chemin créé-maintenant)',
    (fnSrc.match(/RETURN QUERY SELECT v_assessment_id, false,/g) || []).length === 1);

  const conflictRaiseCount = (fnSrc.match(/RAISE EXCEPTION\s*\n\s*'EVENT_IMPACT_IDEMPOTENCY_CONFLICT/g) || []).length;
  t('EVENT_IMPACT_IDEMPOTENCY_CONFLICT levée exactement 2 fois (précheck, récupération post-conflit), jamais un rejeu silencieux',
    conflictRaiseCount === 2, `trouvé ${conflictRaiseCount}`);

  const PARENT_COMPARISON_FIELDS = [
    'v_existing.event_version_id IS DISTINCT FROM p_event_version_id',
    'v_existing.assessment_status IS DISTINCT FROM p_assessment_status',
    'v_existing.knowledge_cutoff IS DISTINCT FROM p_knowledge_cutoff',
    'v_existing.producer_type IS DISTINCT FROM p_producer_type',
    'v_existing.producer_actor IS DISTINCT FROM p_producer_actor',
    'v_existing.algorithm_version IS DISTINCT FROM p_algorithm_version',
    'v_existing.input_fingerprint IS DISTINCT FROM p_input_fingerprint',
    'v_existing.semantic_fingerprint IS DISTINCT FROM p_semantic_fingerprint',
    'v_existing.supersedes_assessment_id IS DISTINCT FROM p_supersedes_assessment_id',
  ];
  for (const snippet of PARENT_COMPARISON_FIELDS) {
    t(`la comparaison de rejeu vérifie "${snippet}", exactement 2 fois`,
      (fnSrc.split(snippet).length - 1) === 2);
  }
  t('la comparaison de rejeu compare les enfants canoniques (v_existing_canonical_interpretations IS DISTINCT FROM v_canonical_interpretations), exactement 2 fois',
    (fnSrc.match(/v_existing_canonical_interpretations IS DISTINCT FROM v_canonical_interpretations/g) || []).length === 2);

  // ---------------------------------------------------------------------
  // 10. Réponse perdue / concurrence : structure garantissant qu'un
  //     rejeu exact retourne replayed=true sans nouvelle ligne, et
  //     qu'un rollback laisse le second appelant devenir créateur.
  // ---------------------------------------------------------------------
  t('aucun mutex applicatif ni verrou global introduit (pas de pg_advisory_lock/pg_try_advisory_lock ici — repose sur l\'index UNIQUE existant)',
    !/pg_advisory_lock|pg_try_advisory_lock/.test(fnSrc));
  t('ne redéfinit aucun primitif de verrouillage partagé existant',
    !/CREATE OR REPLACE FUNCTION public\.fn_event_lock_cluster/.test(liveSource));

  // ---------------------------------------------------------------------
  // 11. Qualification de schéma.
  // ---------------------------------------------------------------------
  const RELATION_TABLES = ['event_impact_assessments', 'event_impact_interpretations'];
  for (const tbl of RELATION_TABLES) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${tbl}\\b`);
    t(`toute référence à ${tbl} est qualifiée public.${tbl}`, !unqualified.test(fnSrc));
  }
}

// ---------------------------------------------------------------------
// 12. Sécurité : EXECUTE révoqué/accordé (trois couches, comme 0023),
//     aucun grant de table touché.
// ---------------------------------------------------------------------
t('REVOKE ALL sur fn_event_impact_create_assessment de PUBLIC, anon, authenticated, service_role',
  /REVOKE ALL ON FUNCTION public\.fn_event_impact_create_assessment\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role;/.test(liveSource));
t('GRANT EXECUTE sur fn_event_impact_create_assessment à service_role uniquement',
  /GRANT EXECUTE ON FUNCTION public\.fn_event_impact_create_assessment\([\s\S]*?\) TO service_role;/.test(liveSource));
t('aucun GRANT à anon/authenticated/PUBLIC', !/GRANT[^;]*TO\s+(anon|authenticated|PUBLIC)\b/i.test(liveSource));
t('aucun GRANT/REVOKE sur une TABLE (seulement sur la fonction)',
  !/(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?event_impact_(?:assessments|interpretations)\s+(?:TO|FROM)/i.test(liveSource));
t('aucune policy RLS créée/modifiée', !/CREATE POLICY|ALTER TABLE[^;]*ROW LEVEL SECURITY/i.test(liveSource));
t('aucun ALTER TABLE', !/ALTER TABLE/i.test(liveSource));

// ---------------------------------------------------------------------
// 13. Hors périmètre : aucune fonctionnalité hors périmètre.
// ---------------------------------------------------------------------
t('aucune référence à worker.ts/wrangler/cron dans la migration', !/wrangler|cron|worker\.ts/i.test(liveSource));
t('aucune référence au Comité/Anthropic/notification dans la migration',
  !/anthropic|committee|notifyAiEngine|ai_events/i.test(liveSource));
t('aucune référence à news_events (pipeline legacy) dans la migration', !/news_events/i.test(liveSource));
t('aucune référence à expected_move_usd/gold_direction_impact/news_score (mapping legacy)',
  !/expected_move_usd|gold_direction_impact|news_score/i.test(liveSource));
t('aucune référence à une future RPC de runtime/discovery Event Impact',
  !/fn_event_impact_discover|fn_event_impact_backfill|fn_event_impact_process/i.test(liveSource));
t('aucune modification de backend/frontend/wrangler.toml référencée dans la migration',
  !/backend\/|frontend\/|wrangler\.toml/i.test(liveSource));

console.log(`\nRESULT: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
