# XAU V2 — architecture réelle et frontières institutionnelles (ARCH-1)

**État :** référence architecturale du code, sans activation opérationnelle.
**Périmètre audité :** `main` à `ec9cde542d6b51b68391462ee8fa474e650b389f`, consulté le 2026-10-13.
**Portée de cette modification :** documentation et vérification statique CI uniquement ; aucune migration, exécution, collecte, connexion broker ou modification de production.

> Ce document décrit le **dépôt constaté** et sépare explicitement code disponible, contrat de sécurité, cible future et preuve de production. Il ne remplace ni les contrats spécialisés sous `docs/XAU_V2_*_CONTRACT.md`, ni le tableau de complétion (qui exige une réconciliation indépendante pour chaque état live). L'ancienne arborescence illustrative dans `ARCHITECTURE.md` n'est **pas** la structure effective du monorepo.

## 1. Topologie déployable constatée

| Zone | Points d'entrée / fichiers existants | Responsabilité | Limite de preuve |
| --- | --- | --- | --- |
| Terminal web | `frontend/index.html`, `frontend/js/dashboard.js`, `frontend/css/style.css` | Affichage historique statique ; aucune clé de provider dans le client | Ne prouve pas l'intégration des contrats institutionnels |
| Entrée HTTP et cron | `backend/worker.ts`, `wrangler.toml` | Dispatcher Cloudflare : marché, news, Committee historique ; routes manuelles exactes Event/Impact/Transmission | Une route dans le code ne prouve pas son déploiement |
| Ingestion prix et macro | `backend/market_engine/*` | Collecte, validation, instantané marché | L'enveloppe MP-0 `institutional_snapshot.ts` est séparée des lectures historiques persistées/as-of |
| Ingestion news | `backend/ingest.ts`, `backend/news_sources/*`, `backend/shared/raw_news.ts` | Flux news historique et collecte officielle RAW | Collecte RAW ≠ preuve factuelle institutionnelle autorisée |
| Événements officiels | `backend/event_engine/*`, `backend/event_facts/*` | Clustering, versions, parsing de faits sourcés | Les chemins contrôlés et les consommateurs typés n'impliquent pas une production CES V2 activée |
| Analyse événement → or | `backend/event_impact/*`, `backend/gold_transmission/*` | Évaluation déterministe et preuves d'insuffisance | Les règles positives/consensus restent soumises à approbation |
| Gouvernance des données | `database/schema.sql`, `database/migrations/*`, `docs/XAU_V2_*_CONTRACT.md` | Contrats de persistance, historique, migrations, droits | Des migrations versionnées ne sont pas des migrations appliquées |
| Vérification | `scripts/run_ci_tests.mjs`, `tests/*`, `.github/workflows/quality-gate.yml` | Contrats déterministes, typecheck, PostgreSQL éphémère CI | CI n'est ni un essai de reprise REC-1 ni une preuve live |

Le Worker historique déclenche seulement `market_engine`, `news_engine` et `ai_committee` par cron. La chaîne V2 ci-dessous **n'est pas** son pipeline métier activé. Ses modules restent distincts du Committee historique (`backend/ai_engine/committee_orchestrator.ts`), qui possède déjà son propre Risk Committee et Portfolio Manager internes. Ne jamais compter ces contrôles historiques comme la preuve des gates V2 indépendants.

## 2. Graphe des dépendances institutionnelles, dans le dépôt

```text
Official RAW → Event Cluster / Version → Event Facts
                                   ├─→ Event Impact (EI)
                                   └─→ Gold Transmission (GT)

Market Pricing (MP-0 / MP-1 / MP-2) ─┐
Positioning (P-0 / P-1) ───────────────┼─→ Regime R-0
                                     │
EI + GT + Market Pricing + Positioning + Regime
                         ↓
               H1–H5 Synthesis S-0
                         ↓
                 AI Committee C-0
                         ↓
            Pre-PM Evidence/Risk PMR-0
                         ↓
                Portfolio Manager PM-0
                         ↓
               Final Action Risk FAR-0
                         ↓
               Action / Abstention A-0
                         ↓
             Command Center CC-0 (lecture seule)
                         ↓
               Alert Suppression AL-0
                         ↓
            Institutional Acceptance E2E-0
```

**Nuance importante :** le graphe est une carte des *contrats et dépendances* ; ce n'est pas un orchestrateur V2 live. Les contrats sont implémentés dans :

- `backend/regime_engine/contract.ts` : consomme Market Pricing et Positioning.
- `backend/horizon_engine/contract.ts` : consomme EI, GT, Market Pricing, Positioning et Regime ; fournit exactement H1, H2, H3, H4, H5.
- `backend/ai_engine/v2_committee_contract.ts` → `backend/risk_engine/pre_pm_contract.ts` → `backend/portfolio_engine/contract.ts`.
- `backend/risk_engine/final_action_contract.ts` → `backend/action_engine/contract.ts` → `backend/command_center/contract.ts`.
- `backend/alert_engine/contract.ts` → `backend/acceptance_engine/contract.ts`.

Les dépendances précises et versions gelées sont définies par chaque `contract.ts` ; ne pas les recopier manuellement dans un second moteur de vérité.

## 3. Contrats transversaux non négociables

1. **Un seul instant de connaissance `knowledgeCutoff` explicite** pour une évaluation. Pas d'horloge locale cachée pour reconstituer un historique. La version du schéma **et** celle de l'algorithme de chaque amont doivent être comparées à l'identité attendue.
2. **Aucun futur dans les preuves.** Chaque observation, publication, correction et persistance as-of doit être admissible au cutoff ; un prix `latest` ne vaut pas preuve de replay historique.
3. **Fail closed.** Manque de source, preuve, autorisation, méthode, identité, cutoff ou état prêt => abstention et raisons ordonnées. Une absence ne devient jamais un `0`, une probabilité, un biais neutre, un SL ou une taille de position inventés.
4. **La présentation n'autorise jamais l'action.** `A-0` force `ABSTAIN / FORBIDDEN` et `order=null`. `CC-0` affiche `HOLD`, est en lecture seule et ne crée pas de ticket. `AL-0` est supprimée (pas de destinataire, livraison ni escalade).
5. **Le Committee historique n'est pas C-0.** Aucun résultat LLM historique ne satisfait implicitement les identités, autorisations et politiques de la chaîne institutionnelle.
6. **Frontière de capacité.** Aucun module institutionnel de conseil ne détient de secret, d'adaptateur broker ni de primitive d'ordre. L'autorisation de conception n'autorise ni coût de provider, ni déploiement, ni envoi d'alerte, ni trading.
7. **Évidence avant statut.** `CONTRACT_CI_PROVEN`, `STAGING_PROVEN` et `LIVE_PROVEN` ont des sens différents ; un test local ou une PR n'atteste pas la production.

## 4. Frontières de confiance et points d'arrêt

| Frontière | Flux accepté aujourd'hui | Flux interdit sans autorisation distincte |
| --- | --- | --- |
| Navigateur → backend/base | Lectures du terminal selon la surface autorisée | Appels directs du navigateur à des providers privés et secrets client |
| Sources externes → RAW | Collecteurs existants, validation, provenance, journalisation | Source implicite, synthèse sans artefact/vintage ou consensus supposé |
| RAW → faits → EI/GT | Transformations déterministes et insuffisance explicite | Interprétation positive sans règles, références et autorisation |
| Données institutionnelles → C-0 | Vérification pure des contrats et abstention | Invocation LLM V2 payante non autorisée |
| PMR/PM/FAR → A-0 | Veto, sortie consultative de non-action | Politique portefeuille/risque inventée, connexion broker, création d'ordre |
| A-0 → CC-0/AL-0 | Projection HOLD et suppression déterministe | Ticket, notification distribuée, escalade ou faux statut `READY` |
| AL-0 → E2E-0 | Manifeste des preuves manquantes | Acceptance run ou proclamation `production ready` |
| GitHub → environnement | PR brouillon, contrôles CI sans secrets réels | Merge, migration, déploiement, restauration, modification live |

**REC-1 :** demeure un Human Gate autonome ; sa reprise depuis backup chiffré, les paramètres managés PostgreSQL et toute action sur une cible exigent des autorisations séparées. Le présent chantier ne modifie ni le kit ni les migrations REC-1.

## 5. Découpage de la suite des travaux (ordre proposé)

| Phase | Livrable | Test d'acceptation | Prérequis |
| --- | --- | --- | --- |
| ARCH-1 (présente) | Carte réelle du dépôt, frontière runtime V1/V2, test de topologie dans la CI | Fichiers présents, imports attendus, aucun branchement accidentel du Worker historique à la V2 | Aucun accès production |
| CHAIN-0 | Assembler les sorties de contrats sur **un même cutoff**, sans saisies divergentes ni faux READY | Cas nominal HOLD et mutations : cutoff différent, mauvaise version, entrée absente ; résultats déterministes | Réutiliser le travail local `feat/chain-0-decision-chain-dry-run` **si/une fois partagé** ; éviter une seconde implémentation |
| OBS-0 | Manifeste reproductible `input artifact → release/vintage → module/version → reasons` | Rejouer la même entrée produit le même résultat, sans donnée future ni identifiant synthétique prétendu live | CHAIN-0 + contrats actuels |
| UI-0 | Projection consultative explicite et testable `HOLD` / preuves insuffisantes | Aucune action ni ticket, écran dégradé compréhensible | CC-0 + accord d'interface |
| ACT-1 (futur, non autorisé) | Méthodes positives, providers et politiques explicites | Corpus indépendant, tests de sécurité, Human Gates nommés | Évidence, politiques et décisions formalisées |

**Critère de sortie architecturale :** un contrat purement déterministe a des entrées/sorties versionnées, un cutoff explicite, un domaine de responsabilité unique, des raisons d'abstention contrôlables et une dépendance directionnelle sans cycle. Les chemins live et historiques ne deviennent interopérables qu'à travers une frontière explicitement approuvée.

## 6. Règles de changement et réconciliation

- Ne pas déplacer les moteurs pour « correspondre » à l'ancienne arborescence `backend/src/*` : elle n'est pas celle du dépôt.
- Modifier les contrats spécialisés **à leur source**, pas par duplication dans une nouvelle couche architecturale.
- Garder les tests existants ; étendre le test de topologie lorsque l'on ajoute **volontairement** une dépendance inter-moteurs. Un échec est un signal de revue, pas une justification pour désactiver la garde.
- Avant toute activité de production, relire la tête actuelle de `main`, PR ouvertes, CI, état Supabase, migrations et Human Gates. L'instantané de ce document n'est pas un état production à perpétuité.
- Conserver `main` et REC-1 gelés pour cette intervention ; le seul artefact GitHub admissible ici est une PR de préparation **non fusionnée**.
