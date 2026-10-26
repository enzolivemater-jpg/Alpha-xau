# XAU V2 — Critères quantitatifs de qualification des moteurs

Date : 2026-10-25. Auteur : XAU V2 — LOCAL DEVELOPMENT (agent C, validation
financière). Statut : **PROPOSITION, AUCUNE APPROBATION**.

Ce document n'est **ni une validation financière ni une approbation** d'un
moteur, d'une méthode ou d'une source. Il dit ce qui doit être mesuré, sur
quelle preuve, et avec quel seuil : un seuil n'apparaît ici que s'il existe
déjà dans le code et ses contrats (`SYMBOL_RULES`, contrats MP-0 / MP-1 /
DATA-1). Tout autre seuil est marqué **À DÉCIDER**, avec qui décide. REC-1
reste gelé ; HOLD / FORBIDDEN reste vrai quel que soit le résultat.

Périmètre : replay DATA-1 (`market-evidence-replay-1.2.0`), MP-1
(`market-pricing-as-of-selector-1.0.0`), MP-0
(`market-pricing-envelope-1.0.0`), pont CHAIN-0
(`evaluateDecisionChainOnMarketEvidence`) et vue terminal
(`terminal-local-view-4.11.0`).

## 1. Dépendances DATA-3 → moteurs (état mesuré)

| Sortie du replay | Consommateur | Effet |
| --- | --- | --- |
| `selection` (MP-1) | replay lui-même | `ABSTAIN` pour une raison contractuelle → replay `INVALID`, instantané vide |
| `marketSnapshot` (statuts `LIVE` / `STALE` / `UNAVAILABLE`) | MP-0 via le pont | seul champ remplacé dans l'entrée CHAIN-0 |
| `status`, `freshnessProof`, raisons | terminal, validateur DATA-3 | affichage et contrôles ; **aucun moteur ne les lit** |
| état MP-0 | régime (`buildRegimeAssessmentContract`) | lit l'**état** seul, jamais les valeurs |

MP-0 reste `LATEST_ONLY`, non reproductible, avec `HISTORICAL_REPLAY_UNAVAILABLE`
sur tous les chemins : un replay, même parfait, n'élève jamais sa confiance.

## 2. Critères et preuves

Chaque critère est binaire (PASS / FAIL). Les preuves « hors dépôt » sont des sondes locales de cette session, à intégrer au dépôt avant toute qualification formelle.
« Taux cible 100 % » signifie : aucun contre-exemple sur l'ensemble testé.

| # | Critère | Mesure | Seuil | Preuve exigée | État au 2026-10-25 |
| --- | --- | --- | --- | --- | --- |
| Q1 | Aucune exécution | part des chemins (matrice, fuzz, scénarios) où chaîne = HOLD, exécution = FORBIDDEN, ACTION = ABSTAIN | 100 % | sonde locale de transitions (720 replays) et fuzz (4 000 + 4 000), hors dépôt ; suites `test_market_*` | PASS |
| Q2 | Aucune anticipation | sélection identique quand on retire tout enregistrement ingéré après le cutoff ; correction utilisée à son instant d'ingestion, pas 1 ms avant | 100 % | `test_market_pricing_as_of_contract`, `test_market_evidence_replay`, sonde de transitions (I12) | PASS |
| Q3 | Fraîcheur aux bornes | LIVE ≤ `liveMaxAgeS`, utilisable ≤ `staleMaxAgeS`, retirée au-delà ; même résultat que le pilote runtime | seuils `SYMBOL_RULES` existants (XAUUSD 360 s / 3 j ; FRED 36 h / 6 j) | `test_market_pricing_institutional_contract` (bornes 360 / 361 s, 3 j / 3 j + 1 s), test d'égalité runtime (25 bornes) | PASS à la seconde ; sous la seconde, même classe sur ingestion, lecture runtime, replay et CHAIN-0 (matrice de 240 cellules, `test_freshness_edge_matrix`) : PASS sur `fix/a-c3-exact-runtime-staleness` (avec A-C2), non intégré |
| Q4 | VERIFIED jamais sans preuve | aucun replay VERIFIED avec champ couvert non observé, expiré ou sans règle | 0 cas | `test_market_evidence_replay` § 8b, sonde de transitions (I4, I9 à I11) ; validateur `VERIFIED_WITHOUT_FRESHNESS_PROOF` | PASS (VERIFIED inatteignable sans règle DXY) |
| Q5 | Échec fermé sur la provenance | archive avec unité, chronologie, empreinte brute ou révision invalide → `INVALID`, aucune valeur jusqu'à MP-0 | 100 % | `test_market_evidence_replay` (19 défauts), `test_market_pricing_institutional_contract` | PASS |
| Q6 | Ambiguïté | deux sources, même instant, valeurs différentes → MP-1 `ABSTAIN`, replay `INVALID` | 100 % | `test_market_pricing_as_of_contract` | PASS |
| Q7 | Historique défectueux | un défaut connu seulement plus tard ne produit jamais une valeur différente à un cutoff antérieur (au pire, abstention) | 100 % | `test_market_pricing_as_of_contract` | PASS |
| Q8 | Affichage sans anticipation | une valeur observée après le cutoff n'est jamais affichée ni dite fraîche | 100 % | `test_terminal_view`, `test_terminal_local` (vue 4.11.0) | PASS depuis `7935ac7` (anomalie A-C1) |
| Q9 | Déterminisme | même archive et cutoff → même empreinte, quels que soient ordre, fuseau, locale | 100 % | `test_market_evidence_replay` §2 | PASS |
| Q10 | Mutation | part des mutants tués sur la logique de décision et de fraîcheur | 100 % des mutants listés | scripts de mutation du rapport (continuité 14/14, L1b 9/9, affichage 6/6, vue 4.11.0 5/5, moteurs 6/6) | PASS |
| Q11 | Couverture continue démontrée | intervalle de couverture sans lacune selon un calendrier et une tolérance approuvés | **À DÉCIDER** (responsable données + responsable risque) | audit de continuité DATA-3 ; aujourd'hui `continuity: NOT_ATTESTED` | BLOQUÉ |
| Q12 | Exactitude des prix | écart à une référence officielle (ICE DXY, carnet bid/ask) | **À DÉCIDER** (responsable données ; licence) | séries officielles sous licence ; le proxy BCE n'en est pas une | BLOQUÉ |
| Q13 | Fraîcheur DXY | seuils LIVE / utilisable pour DXY | **À DÉCIDER** (responsable données) | règle ajoutée à `SYMBOL_RULES` avec sa source | BLOQUÉ (G2) |
| Q14 | Granularité des âges | bornes en millisecondes ou en secondes entières | **À DÉCIDER** (responsable risque ; versions replay et CHAIN-0) | test aux bornes à ± 1 ms | instant exact proposé : `fix/a-c2-millisecond-freshness` (replay, CHAIN-0) et `fix/a-c3-exact-runtime-staleness` (ingestion, vue, lecture runtime) |
| Q15 | Confiance MP-0 dans un replay | conditions pour quitter `LATEST_ONLY` | **À DÉCIDER** (décision DATA-3 n° 3) | critères MP-0 du document DATA-3 (§ 4), chacun rouge puis vert | BLOQUÉ |
| Q16 | Performance financière d'un moteur | toute mesure de rendement, précision directionnelle ou risque | **À DÉCIDER** (comité ; hors périmètre OFFLINE) | historique authentique VERIFIED, période hors échantillon, méthode approuvée | NON APPLICABLE tant que Q11 à Q15 ne sont pas levés |

## 3. Anomalies relevées par cette qualification

- **A-C1 (moyenne, corrigée, `7935ac7`)** : un document d'entrée dont une
  valeur de marché est observée après le cutoff faisait bien abstenir MP-0,
  mais la vue copiait le champ, et le terminal affichait cette valeur
  « FRAIS AU CUTOFF ». Vue 4.11.0 : `OBSERVED_AFTER_CUTOFF`, sans valeur ni
  âge ; la page refuse toute vue qui en afficherait une. Aucune décision
  n'était touchée (le régime lit l'état seul) ; c'était une fuite d'affichage.
- **A-C2 (faible, correctif proposé, À DÉCIDER)** : l'âge au cutoff était
  calculé en secondes entières (`Math.floor`) puis classé. Jusqu'à 999 ms
  au-delà d'un seuil, une valeur restait servie (`STALE` au lieu de retirée)
  et sa preuve était `FRESH`. Correctif sur la branche isolée
  `fix/a-c2-millisecond-freshness` : le replay (1.3.0) et CHAIN-0 (1.1.0)
  classent l'âge exact à la nanoseconde (`classifyFreshnessExact`) ; MP-1 et
  ses empreintes ne changent pas (il ne classe pas la fraîcheur) ; l'âge
  affiché reste en secondes écoulées. Le condensat de référence CHAIN-0
  change avec la version seulement. Non intégré à la pile qualifiée.
- **A-C3 (faible, correctif proposé, À DÉCIDER)** : le runtime arrondissait
  l'âge à la seconde la plus proche (ingestion `Math.round`, vue
  `::INTEGER`) : seuil franchi à + 500 ms, et garde anti-futur applicative
  plus laxiste que la contrainte SQL. Correctif sur
  `fix/a-c3-exact-runtime-staleness` (sur A-C2) : âge exact à l'ingestion,
  colonne `staleness_us` (migration additive et réversible, non appliquée),
  lecture runtime sur l'âge exact. Audit, compatibilité et preuves :
  `docs/XAU_V2_FRESHNESS_TIME_QUALIFICATION.md`.

## 4. Reproduire

```
node node_modules/typescript/bin/tsc --noEmit
node scripts/run_ci_tests.mjs
node tests/test_market_pricing_as_of_contract.mjs
node tests/test_market_pricing_institutional_contract.mjs
node tests/test_terminal_view.mjs
```

Toutes les données de ces tests sont synthétiques. Aucune valeur de marché ou
CFTC réelle n'y figure.
