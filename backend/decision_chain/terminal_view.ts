/**
 * Local terminal view: a read-only projection of one CHAIN-0 outcome for the
 * static terminal, served only by the local development server.
 *
 * The view never adds a decision. Every stage state and reason code is the
 * CHAIN-0 value; this module only classifies each reason code by the kind of
 * blocker it names, and labels the data origin. Its input is always a local
 * dry run (fixture or local file), so `simulated` is always true and no
 * field is presented as live production data.
 *
 * Not CC-1: CC-1 still requires a reviewed UI mapping, runtime correlation
 * and deployment proof.
 */

import { SYMBOL_RULES } from '../market_engine/validate.js';
import { parseStrictTimestamp } from '../shared/strict_timestamp.js';
import {
  DECISION_CHAIN_STAGES,
  type DecisionChainOutcome,
  type DecisionChainStage,
} from './dry_run.js';

export const TERMINAL_VIEW_SCHEMA_VERSION = 'xau.terminal-local-view.v3' as const;
export const TERMINAL_VIEW_ALGORITHM_VERSION = 'terminal-local-view-3.0.0' as const;

/**
 * A view whose cutoff precedes its generation by more than the spot LIVE
 * window (the existing XAUUSD rule) describes the past: HISTORICAL.
 */
export const TERMINAL_VIEW_CURRENT_WINDOW_SECONDS = SYMBOL_RULES.XAUUSD.liveMaxAgeS;

/**
 * DATA: an input is missing, stale or invalid.
 * UPSTREAM: the stage waits on a stage before it.
 * INTEGRITY: a version or cutoff disagrees between stages (a defect).
 * BUSINESS_DECISION: a method, policy or methodology is not approved.
 * AUTHORIZATION: an operation is not authorized.
 * ENVIRONMENT: a runtime, deployment or connection does not exist.
 */
export type BlockerCategory =
  | 'DATA' | 'UPSTREAM' | 'INTEGRITY' | 'BUSINESS_DECISION' | 'AUTHORIZATION' | 'ENVIRONMENT';

/** Every reason code a CHAIN-0 gate can emit, with the blocker it names. */
export const REASON_CODE_CATEGORY: Readonly<Record<string, BlockerCategory>> = {
  // Market Pricing (MP-0)
  SOURCE_SNAPSHOT_UNAVAILABLE: 'DATA',
  INVALID_KNOWLEDGE_CUTOFF: 'DATA',
  CAPTURED_AT_MISMATCH: 'DATA',
  INVALID_FIELD_CONTRACT: 'DATA',
  OBSERVATION_AFTER_KNOWLEDGE_CUTOFF: 'DATA',
  SPOT_NOT_LIVE: 'DATA',
  BOOK_INVERTED: 'DATA',
  OPTIONAL_FIELD_UNAVAILABLE: 'DATA',
  OPTIONAL_FIELD_STALE: 'DATA',
  HISTORICAL_REPLAY_UNAVAILABLE: 'ENVIRONMENT',
  // Positioning (P-0)
  NO_POSITIONING_EVIDENCE: 'DATA',
  INVALID_EVIDENCE_SHAPE: 'DATA',
  INVALID_EVIDENCE_VALUE: 'DATA',
  EVIDENCE_AFTER_KNOWLEDGE_CUTOFF: 'DATA',
  DUPLICATE_EVIDENCE_KEY: 'DATA',
  METHODOLOGY_NOT_APPROVED: 'BUSINESS_DECISION',
  // Regime (R-0)
  MARKET_PRICING_VERSION_MISMATCH: 'INTEGRITY',
  POSITIONING_VERSION_MISMATCH: 'INTEGRITY',
  UPSTREAM_CUTOFF_MISMATCH: 'INTEGRITY',
  MARKET_PRICING_ABSTAINED: 'UPSTREAM',
  MARKET_PRICING_DEGRADED: 'UPSTREAM',
  POSITIONING_EVIDENCE_ABSTAINED: 'UPSTREAM',
  POSITIONING_SIGNAL_UNAVAILABLE: 'UPSTREAM',
  REGIME_METHODOLOGY_NOT_APPROVED: 'BUSINESS_DECISION',
  // H1-H5 synthesis (S-0)
  EVENT_IMPACT_VERSION_MISMATCH: 'INTEGRITY',
  GOLD_TRANSMISSION_VERSION_MISMATCH: 'INTEGRITY',
  REGIME_VERSION_MISMATCH: 'INTEGRITY',
  HORIZON_CUTOFF_MISMATCH: 'INTEGRITY',
  EVENT_IMPACT_INSUFFICIENT: 'UPSTREAM',
  GOLD_TRANSMISSION_INSUFFICIENT: 'UPSTREAM',
  MARKET_PRICING_NOT_AVAILABLE: 'UPSTREAM',
  REGIME_UNAVAILABLE: 'UPSTREAM',
  HORIZON_METHODOLOGY_NOT_APPROVED: 'BUSINESS_DECISION',
  // AI Committee (C-0)
  HORIZON_VERSION_MISMATCH: 'INTEGRITY',
  HORIZON_SET_MISMATCH: 'INTEGRITY',
  HORIZON_NOT_READY: 'UPSTREAM',
  PROVIDER_NOT_AUTHORIZED: 'AUTHORIZATION',
  COST_NOT_AUTHORIZED: 'AUTHORIZATION',
  COMMITTEE_V2_METHOD_NOT_APPROVED: 'BUSINESS_DECISION',
  // Pre-PM evidence/risk (PMR-0)
  COMMITTEE_VERSION_MISMATCH: 'INTEGRITY',
  COMMITTEE_CUTOFF_MISMATCH: 'INTEGRITY',
  COMMITTEE_NOT_READY: 'UPSTREAM',
  COMMITTEE_PROVIDER_NOT_COMPLETED: 'UPSTREAM',
  EVIDENCE_GRAPH_UNAVAILABLE: 'DATA',
  PRE_PM_METHOD_NOT_APPROVED: 'BUSINESS_DECISION',
  // Portfolio Manager (PM-0)
  PRE_PM_VERSION_MISMATCH: 'INTEGRITY',
  PRE_PM_CUTOFF_MISMATCH: 'INTEGRITY',
  PRE_PM_NOT_READY: 'UPSTREAM',
  PORTFOLIO_POLICY_NOT_APPROVED: 'BUSINESS_DECISION',
  PORTFOLIO_STATE_UNAVAILABLE: 'ENVIRONMENT',
  PORTFOLIO_METHOD_NOT_APPROVED: 'BUSINESS_DECISION',
  // Final Action Risk (FAR-0)
  PORTFOLIO_VERSION_MISMATCH: 'INTEGRITY',
  PORTFOLIO_CUTOFF_MISMATCH: 'INTEGRITY',
  PORTFOLIO_NOT_READY: 'UPSTREAM',
  RISK_POLICY_NOT_APPROVED: 'BUSINESS_DECISION',
  BROKER_CONSTRAINTS_UNAVAILABLE: 'ENVIRONMENT',
  FINAL_RISK_METHOD_NOT_APPROVED: 'BUSINESS_DECISION',
  // Action / Abstention (A-0)
  FINAL_RISK_VERSION_MISMATCH: 'INTEGRITY',
  FINAL_RISK_CUTOFF_MISMATCH: 'INTEGRITY',
  FINAL_RISK_NOT_READY: 'UPSTREAM',
  EXECUTION_NOT_AUTHORIZED: 'AUTHORIZATION',
  BROKER_NOT_CONNECTED: 'ENVIRONMENT',
  ACTION_METHOD_NOT_APPROVED: 'BUSINESS_DECISION',
  // Command Center (CC-0)
  ACTION_VERSION_MISMATCH: 'INTEGRITY',
  ACTION_CUTOFF_MISMATCH: 'INTEGRITY',
  ACTION_NOT_ABSTAINING: 'INTEGRITY',
  RUNTIME_CORRELATION_UNAVAILABLE: 'ENVIRONMENT',
  DEPLOYMENT_NOT_PROVEN: 'ENVIRONMENT',
  COMMAND_CENTER_RUNTIME_NOT_APPROVED: 'AUTHORIZATION',
  // Alerts (AL-0)
  COMMAND_CENTER_VERSION_MISMATCH: 'INTEGRITY',
  COMMAND_CENTER_CUTOFF_MISMATCH: 'INTEGRITY',
  COMMAND_CENTER_NOT_ACTIONABLE: 'UPSTREAM',
  ALERT_POLICY_NOT_APPROVED: 'BUSINESS_DECISION',
  DELIVERY_NOT_AUTHORIZED: 'AUTHORIZATION',
  RECIPIENT_POLICY_UNAVAILABLE: 'BUSINESS_DECISION',
  ALERT_HORIZON_NOT_APPROVED: 'BUSINESS_DECISION',
  ALERT_METHOD_NOT_APPROVED: 'BUSINESS_DECISION',
  // Acceptance (E2E-0)
  ALERT_VERSION_MISMATCH: 'INTEGRITY',
  ALERT_CUTOFF_MISMATCH: 'INTEGRITY',
  ALERT_NOT_DELIVERABLE: 'UPSTREAM',
  REQUIRED_EVIDENCE_MISSING: 'ENVIRONMENT',
  E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED: 'AUTHORIZATION',
};

/**
 * What each reason code means, in plain French, for a reader who does not
 * know the gate. Presentation only: it never changes a category or a state.
 */
export const REASON_CODE_PLAIN_FR: Readonly<Record<string, string>> = {
  SOURCE_SNAPSHOT_UNAVAILABLE: 'Aucun instantané de marché n\'a été fourni.',
  INVALID_KNOWLEDGE_CUTOFF: 'L\'heure de cutoff est illisible.',
  CAPTURED_AT_MISMATCH: 'L\'heure de capture du marché contredit ses observations.',
  INVALID_FIELD_CONTRACT: 'Un champ de marché ne respecte pas son contrat.',
  OBSERVATION_AFTER_KNOWLEDGE_CUTOFF: 'Une observation de marché est postérieure au cutoff (anticipation interdite).',
  SPOT_NOT_LIVE: 'Le prix spot n\'était pas frais au cutoff.',
  BOOK_INVERTED: 'Le bid dépasse l\'ask : carnet incohérent.',
  OPTIONAL_FIELD_UNAVAILABLE: 'Un indicateur de marché secondaire manque.',
  OPTIONAL_FIELD_STALE: 'Un indicateur de marché secondaire est périmé.',
  HISTORICAL_REPLAY_UNAVAILABLE: 'Aucun stockage ne permet de rejouer le marché à ce cutoff.',
  NO_POSITIONING_EVIDENCE: 'Aucune preuve de positionnement n\'a été fournie.',
  INVALID_EVIDENCE_SHAPE: 'Une preuve de positionnement est mal formée.',
  INVALID_EVIDENCE_VALUE: 'Une preuve de positionnement porte une valeur invalide.',
  EVIDENCE_AFTER_KNOWLEDGE_CUTOFF: 'Une preuve de positionnement est postérieure au cutoff.',
  DUPLICATE_EVIDENCE_KEY: 'Une preuve de positionnement est en double.',
  METHODOLOGY_NOT_APPROVED: 'La méthode de lecture du positionnement n\'est pas approuvée.',
  MARKET_PRICING_VERSION_MISMATCH: 'Version du prix de marché incohérente entre étages.',
  POSITIONING_VERSION_MISMATCH: 'Version du positionnement incohérente entre étages.',
  UPSTREAM_CUTOFF_MISMATCH: 'Les étages amont n\'ont pas le même cutoff.',
  MARKET_PRICING_ABSTAINED: 'Le prix de marché s\'est abstenu en amont.',
  MARKET_PRICING_DEGRADED: 'Le prix de marché est dégradé en amont.',
  POSITIONING_EVIDENCE_ABSTAINED: 'Les preuves de positionnement se sont abstenues en amont.',
  POSITIONING_SIGNAL_UNAVAILABLE: 'Aucun signal de positionnement n\'existe en amont.',
  REGIME_METHODOLOGY_NOT_APPROVED: 'La méthode de détection du régime n\'est pas approuvée.',
  EVENT_IMPACT_VERSION_MISMATCH: 'Version de l\'impact des événements incohérente.',
  GOLD_TRANSMISSION_VERSION_MISMATCH: 'Version de la transmission vers l\'or incohérente.',
  REGIME_VERSION_MISMATCH: 'Version du régime incohérente.',
  HORIZON_CUTOFF_MISMATCH: 'Les entrées des horizons n\'ont pas le même cutoff.',
  EVENT_IMPACT_INSUFFICIENT: 'L\'impact des événements est insuffisant en amont.',
  GOLD_TRANSMISSION_INSUFFICIENT: 'La transmission vers l\'or est insuffisante en amont.',
  MARKET_PRICING_NOT_AVAILABLE: 'Le prix de marché n\'est pas disponible en amont.',
  REGIME_UNAVAILABLE: 'Le régime n\'est pas disponible en amont.',
  HORIZON_METHODOLOGY_NOT_APPROVED: 'La méthode de synthèse des horizons H1–H5 n\'est pas approuvée.',
  HORIZON_VERSION_MISMATCH: 'Version des horizons incohérente.',
  HORIZON_SET_MISMATCH: 'L\'ensemble des horizons H1–H5 est incomplet ou différent.',
  HORIZON_NOT_READY: 'Les horizons ne sont pas prêts en amont.',
  PROVIDER_NOT_AUTHORIZED: 'Aucun fournisseur d\'IA n\'est autorisé pour le comité.',
  COST_NOT_AUTHORIZED: 'Aucun budget d\'appel au fournisseur n\'est autorisé.',
  COMMITTEE_V2_METHOD_NOT_APPROVED: 'La méthode du comité IA V2 n\'est pas approuvée.',
  COMMITTEE_VERSION_MISMATCH: 'Version du comité incohérente.',
  COMMITTEE_CUTOFF_MISMATCH: 'Le comité n\'a pas le même cutoff que la chaîne.',
  COMMITTEE_NOT_READY: 'Le comité n\'est pas prêt en amont.',
  COMMITTEE_PROVIDER_NOT_COMPLETED: 'Le comité n\'a obtenu aucune réponse du fournisseur.',
  EVIDENCE_GRAPH_UNAVAILABLE: 'Le graphe de preuves n\'a pas été fourni.',
  PRE_PM_METHOD_NOT_APPROVED: 'La méthode de risque avant gérant n\'est pas approuvée.',
  PRE_PM_VERSION_MISMATCH: 'Version du risque avant gérant incohérente.',
  PRE_PM_CUTOFF_MISMATCH: 'Le risque avant gérant n\'a pas le même cutoff.',
  PRE_PM_NOT_READY: 'Le risque avant gérant n\'est pas prêt en amont.',
  PORTFOLIO_POLICY_NOT_APPROVED: 'La politique de portefeuille n\'est pas approuvée.',
  PORTFOLIO_STATE_UNAVAILABLE: 'Aucun état de portefeuille n\'est disponible.',
  PORTFOLIO_METHOD_NOT_APPROVED: 'La méthode du gérant de portefeuille n\'est pas approuvée.',
  PORTFOLIO_VERSION_MISMATCH: 'Version du portefeuille incohérente.',
  PORTFOLIO_CUTOFF_MISMATCH: 'Le portefeuille n\'a pas le même cutoff.',
  PORTFOLIO_NOT_READY: 'Le portefeuille n\'est pas prêt en amont.',
  RISK_POLICY_NOT_APPROVED: 'La politique de risque final n\'est pas approuvée.',
  BROKER_CONSTRAINTS_UNAVAILABLE: 'Les contraintes du courtier ne sont pas disponibles.',
  FINAL_RISK_METHOD_NOT_APPROVED: 'La méthode de risque final n\'est pas approuvée.',
  FINAL_RISK_VERSION_MISMATCH: 'Version du risque final incohérente.',
  FINAL_RISK_CUTOFF_MISMATCH: 'Le risque final n\'a pas le même cutoff.',
  FINAL_RISK_NOT_READY: 'Le risque final n\'est pas prêt en amont.',
  EXECUTION_NOT_AUTHORIZED: 'Aucune exécution n\'est autorisée.',
  BROKER_NOT_CONNECTED: 'Aucun courtier n\'est connecté.',
  ACTION_METHOD_NOT_APPROVED: 'La méthode de décision d\'action n\'est pas approuvée.',
  ACTION_VERSION_MISMATCH: 'Version de l\'action incohérente.',
  ACTION_CUTOFF_MISMATCH: 'L\'action n\'a pas le même cutoff.',
  ACTION_NOT_ABSTAINING: 'L\'action ne s\'abstient pas : sortie interdite.',
  RUNTIME_CORRELATION_UNAVAILABLE: 'Aucune corrélation avec un runtime réel.',
  DEPLOYMENT_NOT_PROVEN: 'Aucun déploiement n\'est prouvé.',
  COMMAND_CENTER_RUNTIME_NOT_APPROVED: 'Le runtime du centre de commande n\'est pas approuvé.',
  COMMAND_CENTER_VERSION_MISMATCH: 'Version du centre de commande incohérente.',
  COMMAND_CENTER_CUTOFF_MISMATCH: 'Le centre de commande n\'a pas le même cutoff.',
  COMMAND_CENTER_NOT_ACTIONABLE: 'Le centre de commande ne propose aucune action en amont.',
  ALERT_POLICY_NOT_APPROVED: 'La politique d\'alerte n\'est pas approuvée.',
  DELIVERY_NOT_AUTHORIZED: 'Aucune livraison d\'alerte n\'est autorisée.',
  RECIPIENT_POLICY_UNAVAILABLE: 'Aucune politique de destinataires n\'est définie.',
  ALERT_HORIZON_NOT_APPROVED: 'Aucun horizon d\'alerte n\'est approuvé.',
  ALERT_METHOD_NOT_APPROVED: 'La méthode d\'alerte n\'est pas approuvée.',
  ALERT_VERSION_MISMATCH: 'Version des alertes incohérente.',
  ALERT_CUTOFF_MISMATCH: 'Les alertes n\'ont pas le même cutoff.',
  ALERT_NOT_DELIVERABLE: 'Aucune alerte n\'est livrable en amont.',
  REQUIRED_EVIDENCE_MISSING: 'Des preuves de recette obligatoires manquent.',
  E2E_ACCEPTANCE_RUN_NOT_AUTHORIZED: 'Aucune recette de bout en bout n\'est autorisée.',
};

/** What each blocker category means, in plain French. */
export const BLOCKER_CATEGORY_PLAIN_FR: Readonly<Record<BlockerCategory, string>> = {
  INTEGRITY: 'Incohérences internes à corriger',
  DATA: 'Données manquantes, périmées ou invalides',
  UPSTREAM: 'Conséquences d\'un étage amont',
  BUSINESS_DECISION: 'Méthodes ou politiques non approuvées',
  AUTHORIZATION: 'Autorisations non accordées',
  ENVIRONMENT: 'Runtime, déploiement ou connexions inexistants',
};

const MARKET_STATUS_PLAIN_FR: Readonly<Record<string, string>> = {
  UNAVAILABLE: 'indisponible au cutoff',
  STALE: 'périmé au cutoff',
};

/**
 * OPERATIONAL_LOCAL: runs locally and is tested; nothing simulated.
 * SIMULATED: runs locally on fixture or local-file input, never live data.
 * BLOCKED: the stage abstains; its reasons name the blockers.
 * NOT_VALIDATED: code exists but needs a runtime this view cannot prove.
 */
export type TerminalCapabilityStatus = 'OPERATIONAL_LOCAL' | 'SIMULATED' | 'BLOCKED' | 'NOT_VALIDATED';

export type TerminalDataOrigin = 'GOLDEN_FIXTURE' | 'LOCAL_INPUT_FILE' | 'LOCAL_SCENARIO';

export interface TerminalReason {
  readonly code: string;
  /** null when a code is not classified: shown, never silently dropped. */
  readonly category: BlockerCategory | null;
  /** Plain-French meaning; null for a code this view does not know. */
  readonly plain: string | null;
}

export interface TerminalStageView {
  readonly stage: DecisionChainStage;
  readonly schemaVersion: string;
  readonly algorithmVersion: string;
  readonly state: string;
  readonly capability: TerminalCapabilityStatus;
  readonly reasons: readonly TerminalReason[];
  readonly blockers: readonly BlockerCategory[];
}

export interface TerminalMarketFieldView {
  readonly field: string;
  readonly role: string;
  readonly value: number | null;
  /** Status at the knowledge cutoff, never at the time the page is read. */
  readonly statusAtCutoff: string;
  readonly observedAt: string | null;
  readonly ageSecondsAtCutoff: number | null;
  readonly source: string | null;
}

export interface TerminalCapability {
  readonly id: string;
  readonly status: TerminalCapabilityStatus;
  readonly blockers: readonly BlockerCategory[];
  readonly detail: string;
}

export interface TerminalRootCause {
  readonly category: BlockerCategory;
  /** Distinct codes in stage order. */
  readonly codes: readonly string[];
  /** The same codes with their plain-French meaning. */
  readonly reasons: readonly { readonly code: string; readonly plain: string | null }[];
  readonly stages: readonly DecisionChainStage[];
}

/**
 * Decision summary for a first reading: the overall state, the main
 * reasons for the HOLD, the missing data and the blocking dependencies.
 * Derived only from the rest of the view; it never adds a decision.
 */
export interface TerminalDecisionSummary {
  readonly decision: 'HOLD';
  readonly execution: 'FORBIDDEN';
  /** BLOCKED: stages abstain; INPUT_REJECTED: no stage ran; INTEGRITY_VIOLATED: a defect. */
  readonly status: 'BLOCKED' | 'INPUT_REJECTED' | 'INTEGRITY_VIOLATED';
  readonly headline: string;
  readonly stageCount: number;
  readonly blockedStageCount: number;
  /** Root-cause categories, most codes first. */
  readonly mainReasons: readonly { readonly category: BlockerCategory; readonly count: number; readonly plain: string }[];
  /** Market fields not fresh at the cutoff, DATA reasons, or input errors. */
  readonly missingData: readonly {
    readonly kind: 'MARKET_FIELD' | 'DATA_REASON' | 'INPUT_ERROR';
    readonly code: string;
    readonly plain: string;
  }[];
  /** Approvals, authorizations and environments the chain waits on. */
  readonly blockingDependencies: readonly {
    readonly category: 'BUSINESS_DECISION' | 'AUTHORIZATION' | 'ENVIRONMENT';
    readonly code: string;
    readonly plain: string;
    readonly stages: readonly DecisionChainStage[];
  }[];
  readonly missingAcceptanceEvidence: number;
}

/**
 * Why the chain holds. Root causes are every classified reason that is not
 * a mere consequence of an upstream stage; inherited reasons are counted.
 */
export interface TerminalHoldRationale {
  readonly firstBlockedStage: DecisionChainStage | null;
  readonly rootCauses: readonly TerminalRootCause[];
  readonly inheritedReasonCount: number;
  readonly unclassifiedCodes: readonly string[];
}

export interface TerminalView {
  readonly schemaVersion: typeof TERMINAL_VIEW_SCHEMA_VERSION;
  readonly algorithmVersion: typeof TERMINAL_VIEW_ALGORITHM_VERSION;
  readonly generatedAt: string;
  readonly origin: { readonly kind: TerminalDataOrigin; readonly label: string };
  readonly simulated: true;
  readonly temporal: {
    readonly classification: 'HISTORICAL' | 'AT_GENERATION' | 'UNKNOWN';
    readonly cutoffAgeSeconds: number | null;
    readonly currentWindowSeconds: number;
  };
  readonly holdRationale: TerminalHoldRationale;
  readonly summary: TerminalDecisionSummary;
  readonly chain: {
    readonly outcome: 'COMPLETED' | 'REJECTED';
    readonly schemaVersion: string;
    readonly algorithmVersion: string;
    readonly chainState: 'HOLD';
    readonly execution: 'FORBIDDEN';
    readonly knowledgeCutoff: string | null;
    readonly integrity: 'CONSISTENT' | 'VIOLATED' | null;
    readonly violations: readonly { readonly stage: string; readonly code: string }[];
    readonly inputFindings: readonly { readonly field: string; readonly code: string }[];
    readonly rejection: { readonly failedAt: string; readonly inputErrors: readonly string[]; readonly stageError: string | null } | null;
    readonly digest: string | null;
  };
  readonly stages: readonly TerminalStageView[];
  readonly market: {
    readonly state: string | null;
    readonly observedThrough: string | null;
    readonly replay: { readonly mode: string; readonly reproducible: boolean; readonly reason: string | null } | null;
    readonly fields: readonly TerminalMarketFieldView[];
  };
  readonly positioning: {
    readonly evidenceState: string | null;
    readonly positioningState: string | null;
    readonly evidenceCount: number;
    readonly sourceAuthorities: readonly string[];
    readonly observedThrough: string | null;
  };
  readonly horizons: readonly { readonly horizon: string; readonly status: string; readonly direction: string }[];
  readonly acceptance: {
    readonly state: string | null;
    readonly productionReadiness: string | null;
    /** As declared in the chain input; for a simulation, a declaration only. */
    readonly evidence: readonly { readonly key: string; readonly declared: boolean }[];
  };
  readonly observability: {
    readonly state: string | null;
    readonly correlationId: string | null;
    readonly deploymentId: string | null;
  };
  readonly capabilities: readonly TerminalCapability[];
}

/** Stage states that report evidence, as opposed to an abstention. */
const INFORMATIONAL_STATES = new Set(['AVAILABLE', 'DEGRADED', 'EVIDENCE_READY', 'READY']);

const BLOCKER_ORDER: readonly BlockerCategory[] = [
  'INTEGRITY', 'DATA', 'UPSTREAM', 'BUSINESS_DECISION', 'AUTHORIZATION', 'ENVIRONMENT',
];

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const plainOf = (code: string): string | null => (own(REASON_CODE_PLAIN_FR, code) ? REASON_CODE_PLAIN_FR[code] : null);
const stageLabel = (stage: string) => stage.replace(/_/g, ' ');

function classify(codes: readonly string[]): { reasons: TerminalReason[]; blockers: BlockerCategory[] } {
  const reasons = codes.map((code) => ({
    code,
    category: own(REASON_CODE_CATEGORY, code) ? REASON_CODE_CATEGORY[code] : null,
    plain: plainOf(code),
  }));
  const present = new Set(reasons.map((reason) => reason.category));
  return { reasons, blockers: BLOCKER_ORDER.filter((category) => present.has(category)) };
}

function union(lists: readonly (readonly BlockerCategory[])[]): BlockerCategory[] {
  const present = new Set(lists.flat());
  return BLOCKER_ORDER.filter((category) => present.has(category));
}

/**
 * Capabilities the terminal sections rely on. A section reported as
 * OPERATIONAL_LOCAL is one this repository runs and tests without any
 * external system; every other status names why it is not.
 */
function capabilities(stages: readonly TerminalStageView[], completed: boolean): TerminalCapability[] {
  const byStage = new Map(stages.map((stage) => [stage.stage, stage]));
  const stageCapability = (id: string, stage: DecisionChainStage, detail: string): TerminalCapability => {
    const view = byStage.get(stage);
    if (!view) return { id, status: 'BLOCKED', blockers: ['INTEGRITY'], detail: 'Chaîne rejetée avant cet étage.' };
    return { id, status: view.capability, blockers: view.blockers, detail };
  };
  const blockedIfRejected = (status: TerminalCapabilityStatus): TerminalCapabilityStatus =>
    completed ? status : 'BLOCKED';
  return [
    { id: 'CHAIN_DRY_RUN', status: blockedIfRejected('OPERATIONAL_LOCAL'), blockers: completed ? [] : ['DATA'],
      detail: 'CHAIN-0 exécutée localement : douze étages, HOLD, exécution interdite.' },
    { id: 'REPLAY_DIGEST', status: blockedIfRejected('OPERATIONAL_LOCAL'), blockers: completed ? [] : ['DATA'],
      detail: 'Empreinte SHA-256 canonique, indépendante de la machine.' },
    { id: 'INTEGRITY_CHECK', status: blockedIfRejected('OPERATIONAL_LOCAL'), blockers: completed ? [] : ['DATA'],
      detail: 'Vérification des versions, cutoffs et sorties positives interdites.' },
    stageCapability('MARKET_PRICING', 'MARKET_PRICING', 'Prix et drivers au cutoff, provenance et fraîcheur par champ.'),
    stageCapability('POSITIONING', 'POSITIONING', 'Preuves de positionnement normalisées ; aucun signal directionnel.'),
    stageCapability('REGIME', 'REGIME', 'Porte de dépendances R-0 ; aucune méthode de régime approuvée.'),
    { id: 'EVENT_IMPACT_GOLD_TRANSMISSION', status: 'BLOCKED', blockers: ['BUSINESS_DECISION', 'AUTHORIZATION'],
      detail: 'Agrégation EIA-0 : insuffisance seule ; combinaison positive et ensemble d\'événements non définis ; consensus non autorisé.' },
    stageCapability('HORIZON_SYNTHESIS', 'HORIZON_SYNTHESIS', 'H1–H5 : cinq abstentions explicites.'),
    stageCapability('SCENARIO_TREE', 'HORIZON_SYNTHESIS', 'Arbre de scénarios V2 indisponible tant que S-1 n\'est pas approuvé.'),
    stageCapability('AI_COMMITTEE', 'AI_COMMITTEE', 'Comité V2 : appel fournisseur interdit.'),
    stageCapability('PRE_PM_RISK', 'PRE_PM', 'Preuves et risque avant PM : verdict nul.'),
    stageCapability('PORTFOLIO_MANAGER', 'PORTFOLIO_MANAGER', 'Recommandation, allocation et taille nulles.'),
    stageCapability('FINAL_ACTION_RISK', 'FINAL_ACTION_RISK', 'Perte maximale, taille et stop nuls.'),
    stageCapability('ACTION', 'ACTION', 'Abstention consultative ; aucun ordre.'),
    stageCapability('COMMAND_CENTER', 'COMMAND_CENTER', 'Projection en lecture seule ; aucun ticket.'),
    stageCapability('ALERTS', 'ALERT', 'Alertes supprimées ; aucune livraison.'),
    stageCapability('ACCEPTANCE', 'ACCEPTANCE', 'Recette de bout en bout non acceptée.'),
    { id: 'EXECUTION', status: 'BLOCKED', blockers: ['AUTHORIZATION', 'ENVIRONMENT'],
      detail: 'Aucune autorité d\'exécution ni connexion courtier.' },
    { id: 'LEGACY_V1_FEED', status: 'NOT_VALIDATED', blockers: ['ENVIRONMENT'],
      detail: 'Panneaux V1 (prix, macro, news, analyse) : nécessitent Supabase ; non connectés en local.' },
  ];
}

function temporalOf(knowledgeCutoff: string | null, generatedAt: string): TerminalView['temporal'] {
  const cutoffMs = parseStrictTimestamp(knowledgeCutoff);
  const generatedMs = parseStrictTimestamp(generatedAt);
  if (cutoffMs === null || generatedMs === null) {
    return { classification: 'UNKNOWN', cutoffAgeSeconds: null, currentWindowSeconds: TERMINAL_VIEW_CURRENT_WINDOW_SECONDS };
  }
  const cutoffAgeSeconds = Math.floor((generatedMs - cutoffMs) / 1000);
  return {
    classification: cutoffAgeSeconds > TERMINAL_VIEW_CURRENT_WINDOW_SECONDS ? 'HISTORICAL' : 'AT_GENERATION',
    cutoffAgeSeconds,
    currentWindowSeconds: TERMINAL_VIEW_CURRENT_WINDOW_SECONDS,
  };
}

function holdRationaleOf(stages: readonly TerminalStageView[]): TerminalHoldRationale {
  const groups = new Map<BlockerCategory, { codes: string[]; stages: DecisionChainStage[] }>();
  let inheritedReasonCount = 0;
  const unclassified: string[] = [];
  for (const stage of stages) {
    for (const reason of stage.reasons) {
      if (reason.category === null) {
        if (!unclassified.includes(reason.code)) unclassified.push(reason.code);
        continue;
      }
      if (reason.category === 'UPSTREAM') {
        inheritedReasonCount += 1;
        continue;
      }
      const group = groups.get(reason.category) ?? { codes: [], stages: [] };
      if (!group.codes.includes(reason.code)) group.codes.push(reason.code);
      if (!group.stages.includes(stage.stage)) group.stages.push(stage.stage);
      groups.set(reason.category, group);
    }
  }
  return {
    firstBlockedStage: stages.find((stage) => stage.capability === 'BLOCKED')?.stage ?? null,
    rootCauses: BLOCKER_ORDER.filter((category) => groups.has(category)).map((category) => {
      const { codes, stages: causeStages } = groups.get(category)!;
      return { category, codes, reasons: codes.map((code) => ({ code, plain: plainOf(code) })), stages: causeStages };
    }),
    inheritedReasonCount,
    unclassifiedCodes: unclassified,
  };
}

const DEPENDENCY_CATEGORIES = ['BUSINESS_DECISION', 'AUTHORIZATION', 'ENVIRONMENT'] as const;
const OPTIONAL_FIELD_CODES = new Set(['OPTIONAL_FIELD_UNAVAILABLE', 'OPTIONAL_FIELD_STALE']);

function summaryOf(
  stages: readonly TerminalStageView[],
  rationale: TerminalHoldRationale,
  integrityViolated: boolean,
  fields: readonly TerminalMarketFieldView[],
  evidence: readonly { readonly declared: boolean }[],
): TerminalDecisionSummary {
  const blocked = stages.filter((stage) => stage.capability === 'BLOCKED').length;
  const mainReasons = rationale.rootCauses
    .map((cause) => ({ category: cause.category, count: cause.codes.length, plain: BLOCKER_CATEGORY_PLAIN_FR[cause.category] }))
    .sort((a, b) => b.count - a.count || BLOCKER_ORDER.indexOf(a.category) - BLOCKER_ORDER.indexOf(b.category));
  const missingData: TerminalDecisionSummary['missingData'][number][] = fields
    .filter((field) => field.statusAtCutoff !== 'LIVE')
    .map((field) => ({
      kind: 'MARKET_FIELD' as const,
      code: field.field,
      plain: `${field.field.toUpperCase()} ${MARKET_STATUS_PLAIN_FR[field.statusAtCutoff] ?? `${field.statusAtCutoff} au cutoff`}.`,
    }));
  // An optional-field reason only repeats the fields already listed.
  const listed = missingData.length > 0;
  for (const cause of rationale.rootCauses.filter((c) => c.category === 'DATA')) {
    for (const reason of cause.reasons) {
      if (listed && OPTIONAL_FIELD_CODES.has(reason.code)) continue;
      missingData.push({ kind: 'DATA_REASON', code: reason.code, plain: reason.plain ?? reason.code });
    }
  }
  const blockingDependencies: TerminalDecisionSummary['blockingDependencies'][number][] = [];
  for (const category of DEPENDENCY_CATEGORIES) {
    for (const code of rationale.rootCauses.find((cause) => cause.category === category)?.codes ?? []) {
      blockingDependencies.push({
        category,
        code,
        plain: plainOf(code) ?? code,
        stages: stages.filter((stage) => stage.reasons.some((reason) => reason.code === code)).map((stage) => stage.stage),
      });
    }
  }
  const first = rationale.firstBlockedStage;
  return {
    decision: 'HOLD',
    execution: 'FORBIDDEN',
    status: integrityViolated ? 'INTEGRITY_VIOLATED' : 'BLOCKED',
    headline: integrityViolated
      ? 'HOLD : une incohérence interne rend la chaîne inexploitable.'
      : `HOLD : ${blocked} étage(s) sur ${stages.length} bloqué(s)${first ? `, le premier à ${stageLabel(first)}` : ''}. `
        + 'Aucune décision positive n\'est approuvée.',
    stageCount: stages.length,
    blockedStageCount: blocked,
    mainReasons,
    missingData,
    blockingDependencies,
    missingAcceptanceEvidence: evidence.filter((item) => !item.declared).length,
  };
}

const errorText = (error: { readonly path: string; readonly code: string }) =>
  `${error.path === '' ? '<input>' : error.path}: ${error.code}`;

export function buildTerminalView(
  outcome: DecisionChainOutcome,
  digest: string | null,
  origin: { readonly kind: TerminalDataOrigin; readonly label: string },
  generatedAt: string,
): TerminalView {
  const base = {
    schemaVersion: TERMINAL_VIEW_SCHEMA_VERSION,
    algorithmVersion: TERMINAL_VIEW_ALGORITHM_VERSION,
    generatedAt,
    origin: { kind: origin.kind, label: origin.label },
    simulated: true as const,
  };
  if (outcome.kind === 'REJECTED') {
    return {
      ...base,
      temporal: temporalOf(null, generatedAt),
      holdRationale: { firstBlockedStage: null, rootCauses: [], inheritedReasonCount: 0, unclassifiedCodes: [] },
      summary: {
        decision: 'HOLD',
        execution: 'FORBIDDEN',
        status: 'INPUT_REJECTED',
        headline: 'HOLD : l\'entrée a été rejetée ; aucun étage de la chaîne n\'a été évalué.',
        stageCount: 0,
        blockedStageCount: 0,
        mainReasons: [],
        missingData: outcome.inputErrors.map((error) => ({
          kind: 'INPUT_ERROR' as const, code: errorText(error), plain: `Entrée invalide : ${errorText(error)}.`,
        })),
        blockingDependencies: [],
        missingAcceptanceEvidence: 0,
      },
      chain: {
        outcome: 'REJECTED',
        schemaVersion: outcome.schemaVersion,
        algorithmVersion: outcome.algorithmVersion,
        chainState: 'HOLD',
        execution: 'FORBIDDEN',
        knowledgeCutoff: null,
        integrity: null,
        violations: [],
        inputFindings: [],
        rejection: {
          failedAt: outcome.failedAt,
          inputErrors: outcome.inputErrors.map(errorText),
          stageError: outcome.stageError,
        },
        digest: null,
      },
      stages: [],
      market: { state: null, observedThrough: null, replay: null, fields: [] },
      positioning: { evidenceState: null, positioningState: null, evidenceCount: 0, sourceAuthorities: [], observedThrough: null },
      horizons: [],
      acceptance: { state: null, productionReadiness: null, evidence: [] },
      observability: { state: null, correlationId: null, deploymentId: null },
      capabilities: capabilities([], false),
    };
  }

  const { result } = outcome;
  const violatedStages = new Set(result.violations.map((violation) => violation.stage));
  const stages: TerminalStageView[] = result.trace.map((entry) => {
    const { reasons, blockers } = classify(entry.reasonCodes);
    const violated = violatedStages.has(entry.stage) || violatedStages.has('CHAIN');
    const capability: TerminalCapabilityStatus = violated || !INFORMATIONAL_STATES.has(entry.state)
      ? 'BLOCKED' : 'SIMULATED';
    return {
      stage: entry.stage,
      schemaVersion: entry.schemaVersion,
      algorithmVersion: entry.algorithmVersion,
      state: entry.state,
      capability,
      reasons,
      blockers: violated ? union([['INTEGRITY'], blockers]) : blockers,
    };
  });

  const pricing = result.stages.marketPricing;
  const positioning = result.stages.positioning;
  const holdRationale = holdRationaleOf(stages);
  const fields: TerminalMarketFieldView[] = Object.entries(pricing.fields).map(([field, value]) => ({
    field,
    role: value.role,
    value: value.value,
    statusAtCutoff: value.status,
    observedAt: value.observedAt,
    ageSecondsAtCutoff: value.ageSeconds,
    source: value.source,
  }));
  const evidence = Object.entries(result.stages.acceptance.evidence).map(([key, declared]) => ({ key, declared: declared === true }));
  return {
    ...base,
    temporal: temporalOf(result.knowledgeCutoff, generatedAt),
    holdRationale,
    summary: summaryOf(stages, holdRationale, result.integrity !== 'CONSISTENT', fields, evidence),
    chain: {
      outcome: 'COMPLETED',
      schemaVersion: result.schemaVersion,
      algorithmVersion: result.algorithmVersion,
      chainState: 'HOLD',
      execution: 'FORBIDDEN',
      knowledgeCutoff: result.knowledgeCutoff,
      integrity: result.integrity,
      violations: result.violations.map(({ stage, code }) => ({ stage, code })),
      inputFindings: result.inputFindings.map(({ field, code }) => ({ field, code })),
      rejection: null,
      digest,
    },
    stages,
    market: {
      state: pricing.state,
      observedThrough: pricing.observedThrough,
      replay: { mode: pricing.replay.mode, reproducible: pricing.replay.reproducible, reason: pricing.replay.reason },
      fields,
    },
    positioning: {
      evidenceState: positioning.evidenceState,
      positioningState: positioning.positioningState,
      evidenceCount: positioning.evidence.length,
      sourceAuthorities: [...positioning.sourceAuthorities],
      observedThrough: positioning.observedThrough,
    },
    horizons: result.stages.horizonSynthesis.scenarios.map(({ horizon, status, direction }) => ({ horizon, status, direction })),
    acceptance: {
      state: result.stages.acceptance.acceptanceState,
      productionReadiness: result.stages.acceptance.productionReadiness,
      evidence,
    },
    observability: {
      state: result.stages.commandCenter.observability.state,
      correlationId: result.stages.commandCenter.observability.correlationId,
      deploymentId: result.stages.commandCenter.observability.deploymentId,
    },
    capabilities: capabilities(stages, true),
  };
}

/** Stage order of the view; equal to CHAIN-0's. */
export const TERMINAL_VIEW_STAGES = DECISION_CHAIN_STAGES.map(({ stage }) => stage);
