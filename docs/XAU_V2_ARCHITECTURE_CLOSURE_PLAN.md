# XAU V2 — ARCH-CLOSE-1 : intégration architecturale canonique (15 octobre 2026)

> **DRAFT / CI ONLY / NO MERGE / NO PRODUCTION.** Ce document est la
> décision technique proposée pour une **revue**, pas une autorisation
> d'intégration, de changement de schéma ni de trading.

## Objectif de clôture

Arrêter la duplication des orchestrateurs institutionnels, intégrer les
contrats horizontaux qui n'ont pas de conflits de code, puis prouver
que le terminal, les données de marché et les gardes de sécurité
utilisent une **même chaîne de décision** et un cutoff commun.

Base de cette branche d'essai : DATA-2 #136, commit
`fa5fbfe754e283b0f2351d9bcdd3b6bfbdb3930d`.
Provenance des nouveaux modules isolés : ARCH-6 #134, commit
`85274c27bf3cdd1e7b8fdce9cc3e25f454085f25`.
Les 26 fichiers supplémentaires ont été importés par **SHA de blob
Git vérifié**, sans substituer les fichiers préexistants de DATA-2.

## Autorité des modules (proposition)

| Responsabilité | Source canonique candidate | Limite actuelle |
| --- | --- | --- |
| Chaîne décisionnelle 12 étapes | `backend/decision_chain/dry_run.ts` de DATA-2 | Aucun ordre, état HOLD ; pas de seconde implémentation |
| Historique marché as-of et corrections | `backend/market_engine/evidence_archive.ts` + `evidence_capture.ts` | Aucune preuve d'origine fournisseur authentifiée |
| Vue terminal | `backend/decision_chain/terminal_view.ts` de DATA-2 (TV-2 évolué) | Vue locale, pas production |
| Temps/cutoff strict | `backend/shared/temporal_contract.ts` de ARCH-6 | Validation de revendication, non horloge officielle |
| Manifest de provenance | `backend/observability/evidence_manifest.ts` de ARCH-6 | Cohérence structurelle, attestation indisponible |
| Audit de la chaîne | `backend/observability/offline_receipt.ts` de ARCH-6 | Empreinte non signée, non preuve live |
| UI et transport de lecture | `backend/advisory_ui/*` de ARCH-6 | Aucun endpoint ni action négociable |
| Essai combiné | `backend/observability/unified_rehearsal.ts` | Simulé, aucune intégration runtime |
| Politique métier et autorisations | Contrats R-0 / H1–H5 / C-0 / PMR-0 / PM-0 / FAR-0 | Méthodes positives non approuvées |

## Conflits explicitement non résolus par simple copie

Une comparaison des arbres Git DATA-2 et ARCH-6 avec `main` de référence
a identifié **14 chemins modifiés différemment dans les deux branches** :

- `backend/decision_chain/dry_run.ts` et `terminal_view.ts` ;
- `backend/market_engine/providers.ts` ;
- `docs/XAU_V2_TERMINAL_LOCAL_VIEW_CONTRACT.md` ;
- `frontend/index.html`, `frontend/js/dashboard.js`, `frontend/css/style.css` ;
- `scripts/check_terminal_layout.mjs`, `scripts/lib/terminal_scenarios.mjs`,
  `scripts/run_ci_tests.mjs`, `scripts/serve_terminal_local.mjs` ;
- `tests/test_decision_chain_dry_run.mjs`, `tests/test_terminal_local.mjs`,
  `tests/test_terminal_view.mjs`.

**Règle de résolution :** garder DATA-2 comme version de référence de ces
14 chemins, à l'exception de `run_ci_tests.mjs` dont l'inventaire est
étendu sans perdre de tests. Les garanties sécurité d'ARCH-6 doivent être
**revalidées par les tests combinés** ; un test vert individuel sur l'une
des deux branches n'autorise pas un écrasement de l'autre.

## Critères de clôture vérifiables

1. **Une seule chaîne** : le même objet CHAIN-0 sert au terminal, à l'audit et
   au contrôle d'actions ; pas de chemin parallèle qui fabrique un BUY/SELL.
2. **Preuves et temps** : cutoff explicite, pas de données futures, corrections
   versionnées, données manquantes distinguées de zéro, authenticité non simulée.
3. **Sécurité** : ABSTAIN/HOLD/FORBIDDEN, ordre et tailles nulles, livraison
   d'alertes interdite sans méthodes et gates revues.
4. **Compatibilité** : typecheck, tests déterministes, test d'intégration combiné
   et CI PostgreSQL **éphémère** au vert sur le **même commit**.
5. **Gouvernance** : une matrice de choix/renoncements de PR, des versions de
   contrats traçables, aucune PR empilée fusionnée sans ordre et revue.
6. **Qualification future** : provenance réellement vérifiée, REC-1 prouvé
   et conditions production approuvées séparément. Une CI verte ne ferme
   aucun de ces gates.

## Ce qui n'est pas clos par cette PR

- Authenticité des données fournisseurs et droits/licences ;
- calibrage hors échantillon des méthodes régime/horizons, comité IA,
  portefeuille et risque ;
- intégration du runtime Cloudflare/Supabase en production ;
- essai de reprise REC-1, migrations, déploiement, permissions broker,
  émission d'alertes ou ordres.

**Ne pas fusionner.** La sortie attendue est une intégration hors production
reproductible et une liste de décisions humaines résiduelles, pas un état
`LIVE_PROVEN`.
