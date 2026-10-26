# XAU V2 — DATA-3 : ce qui empêche VERIFIED

Status: **ANALYSE / AUCUNE APPROBATION**. Base : `c817c85` (tête de la PR #161).
Auteur : XAU V2 — LOCAL DEVELOPMENT, 2026-10-24. HOLD / FORBIDDEN inchangé ;
REC-1 gelé. Rien ici n'est implémenté ni approuvé : chaque point marqué
**DÉCISION** attend un humain.

## 1. Ce que VERIFIED exige (code, pas intention)

`replayMarketEvidence` (`backend/market_engine/evidence_archive.ts`) rend
`VERIFIED` seulement si l'archive est valide et que **toutes** ces conditions
tiennent :

1. une couverture est déclarée (sinon `COVERAGE_NOT_DECLARED`) ;
2. le cutoff est dans `[coverage.from, coverage.to]` (sinon
   `CUTOFF_OUTSIDE_COVERAGE`) ;
3. `coverage.fields` contient les huit champs MP-0 : `spot`, `bid`, `ask`,
   `dxy`, `us10y`, `realYield`, `vix`, `wti` (sinon `FIELDS_NOT_COVERED`) ;
4. l'empreinte épinglée correspond, si elle est donnée.

`HISTORICAL_VERIFIED` exige en plus une archive `CAPTURED` et que chaque
valeur sélectionnée soit relue depuis ses octets bruts (`RAW_VERIFIED`).

## 2. État des captures réelles locales (relu le 2026-10-24)

`scripts/validate_evidence_captures.mjs` à `c817c85` sur les trois journaux de
`~/.local/share/xau-v2/evidence/` (lecture seule, sha256 de chaque fichier
identiques avant et après) : **115/115 contrôles PASS**, 3 journaux `CAPTURED`,
39 enregistrements, `publishedAt` absent sur les 39.

| Journal | Champs déclarés | Fenêtre de couverture | Replay |
| --- | --- | --- | --- |
| `fred-dgs10-validation` | `us10y` | un instant | `INCOMPLETE` (`FIELDS_NOT_COVERED`) |
| `fred-batch-validation` | `realYield`, `vix`, `wti` | ~3 s | `INCOMPLETE` (`FIELDS_NOT_COVERED`) |
| `twelve-xau-validation` | `spot` | < 1 s | `INCOMPLETE` (`FIELDS_NOT_COVERED`) |
| fusion DATA-3 | aucune (par construction) | aucune | `INCOMPLETE` (`COVERAGE_NOT_DECLARED`) |

Chaque journal ne déclare honnêtement que ce qu'il a capturé. Les valeurs ne
sont pas reproduites ici : ce sont des données de tiers, jamais versionnées.

## 3. Les manques, et seulement eux

### G1 — Aucune source pour `dxy`, `bid`, `ask` (bloquant)
`CAPTURE_SERIES` (`evidence_capture.ts`) ne connaît que cinq séries :
FRED DGS10, DFII10, VIXCLS, DCOILWTICO et Twelve Data XAU/USD. Aucune ne
produit `dxy`, `bid` ni `ask` ; une couverture honnête ne peut donc jamais
contenir les huit champs.

- **DXY** : la seule source conforme au contrat (`instrument: 'DXY'`) est
  l'ICE U.S. Dollar Index, sous licence payante. Le proxy BCE
  (`DXY_PROXY_RECONSTRUCTED_ECB_DAILY`, branche
  `feat/dxy-ecb-daily-proxy-offline`) **ne la remplace pas** : autre
  instrument, aucun instant de publication prouvé
  (`lookaheadSafeForReplay: false`), et le code le tient hors de tout chemin
  d'exécution (test statique).
- **bid / ask** : Twelve Data ne fournit pas de carnet. Candidat documenté :
  OANDA v20 (compte requis, conditions non revues).
- **DÉCISION** : budget et licence ICE ; ouverture d'un compte bid/ask ; ou
  bien redéfinir VERIFIED sur un sous-ensemble de champs (changement de
  contrat MP-0/MP-1, du digest de référence et probablement du schéma SQL).

### G2 — `dxy` n'a pas de règle de fraîcheur (bloquant même avec une source)
`MARKET_EVIDENCE_FIELD_SPEC.dxy.freshnessSymbol` vaut `null` et `SYMBOL_RULES`
(`validate.ts`) n'a pas d'entrée DXY : un enregistrement DXY serait
`FRESHNESS_RULE_UNAVAILABLE`, donc indisponible au cutoff.
- **DÉCISION** : seuils LIVE / STALE et bornes de plausibilité pour DXY.

### G3 — La couverture est auto-déclarée (bloquant pour un VERIFIED crédible)
La fusion DATA-3 ne déclare aucune couverture : elle est `INCOMPLETE` par
construction. Un journal isolé couvre au mieux une fenêtre de quelques
secondes. La source de couverture prouvable prévue (table MP-2 append-only et
RPC « complet ou erreur ») n'est pas branchée.
- **DÉCISION** (déjà ouverte, décisions DATA-3 n° 1 et 3) : autorisation de
  capture ; journal écrit par le collecteur seulement, ou attestation de
  l'opérateur acceptée pour `CAPTURED`.

**Audit de continuité (rapport seul, 2026-10-25).**
`scripts/lib/capture_continuity.mjs`, appelé par
`validate_evidence_captures.mjs` sur chaque journal source (fenêtre =
couverture déclarée) et sur la fusion (fenêtre = étendue des réceptions,
sans prétention). Par série (`champ|source|identifiant`), il produit :
- les écarts entre temps d'observation consécutifs (début, fin, durée) ;
  pour une série quotidienne, le nombre de dates UTC manquantes, réparties
  en jours de semaine et samedis/dimanches ;
- les intervalles où la série n'est tenue ni fraîche (`UNAVAILABLE`) ni
  LIVE, selon la règle de fraîcheur runtime que le replay applique déjà
  (`SYMBOL_RULES`), une valeur n'étant tenue qu'à partir de son ingestion ;
- les doublons d'instant d'observation qui ne sont pas une révision liée,
  les ajouts hors ordre de réception et les observations reçues après une
  plus récente ;
- avec `cutoff`, seulement ce qui était ingéré au cutoff.

Rien n'est inventé : fermeture de marché, jour non ouvré et tolérance
d'écart restent `NOT_EVALUATED` (aucun calendrier source ni seuil approuvé).
Le rapport porte toujours `continuity: NOT_ATTESTED`, même sans trou
détecté. Le validateur échoue si un replay `VERIFIED` repose sur une fenêtre
déclarée où un champ couvert est indisponible. Le replay n'est pas modifié.

### L1b — VERIFIED avec un champ trop ancien pour être tenu (constat, replay inchangé)
Le replay 1.1.0 garde dans `observations` une valeur sélectionnée dont la
fraîcheur au cutoff est `UNAVAILABLE` ; `DECLARED_FIELD_NOT_OBSERVED` ne se
déclenche donc pas. Sur une archive synthétique déclarant les huit champs, un
cutoff où toutes les valeurs ont dépassé leur seuil rend `VERIFIED`,
`reproducible: true` avec `marketSnapshot.available: false`. Inatteignable
sur des captures réelles aujourd'hui (`FIELDS_NOT_COVERED`, L1). Le
validateur le refuse désormais (`VERIFIED_WITH_FIELD_UNAVAILABLE`).
- **DÉCISION** : faire rendre `INCOMPLETE` au replay dans ce cas (nouvelle
  version d'algorithme), ou statu quo documenté.

### G4 — Stockage brut côté runtime (bloquant pour une histoire continue)
L'ingestion runtime jette les corps ; `official_source_artifacts` est limitée
à BLS CPI par un CHECK. Les deux options sont des changements de schéma, donc
une migration, non autorisée.
- **DÉCISION** (décision DATA-3 n° 2) : extension de table ou nouvelle table
  `market_provider_responses`.

### L1 — Faille : sur-déclaration de couverture — **CORRIGÉE** (replay 1.1.0, branche `fix/data-3-l1-coverage`)

Correction : couverture impossible refusée à la création, champ couvert non observé → `INCOMPLETE` ; voir `XAU_V2_MARKET_EVIDENCE_REPLAY_CONTRACT.md` § DATA-3 L1. Constat d'origine :
Sonde locale (non versionnée, données synthétiques) : un journal `CAPTURED`
créé avec les huit champs déclarés mais ne contenant que les cinq séries
capturables rend **`VERIFIED`, `HISTORICAL_VERIFIED`, `reproducible: true`**,
alors que `dxy`, `bid` et `ask` y sont `UNAVAILABLE`. Or
`scripts/market_evidence_capture.mjs init` déclare justement les huit champs
en dur, et des tests (`test_market_evidence_capture.mjs`) affirment ce
comportement. VERIFIED y signifie « couverture déclarée complète », pas
« données complètes ».

Les deux options proposées ont été appliquées ensemble, à la demande
explicite de l'opérateur (2026-10-24) : (a) une couverture qu'aucune série ne
peut remplir est refusée à `createEvidenceArchive` ; (b) un champ couvert sans
valeur détenue au cutoff rend le replay `INCOMPLETE`
(`DECLARED_FIELD_NOT_OBSERVED`). VERIFIED reste donc inatteignable pour un
journal de capture tant que G1 et G2 ne sont pas levés : c'est l'état honnête,
pas une régression.

### Non bloquant pour VERIFIED, mais à garder en vue
- `publishedAt` absent partout : `PROVENANCE_INCOMPLETE` est signalé, pas
  bloquant. La sélection repose sur `observedAt` et `ingestedAt`.
- WTI ressort `UNAVAILABLE` dès sa capture : l'observation FRED est plus
  ancienne que `staleMaxAgeS` (6 jours). C'est le comportement attendu, pas
  un défaut.

## 4. Préparation MP-0 (aucune approbation)

MP-0 (`institutional_snapshot.ts`) ajoute toujours
`HISTORICAL_REPLAY_UNAVAILABLE` et reste en mode `LATEST_ONLY`. Avant que
quiconque l'autorise à faire confiance à un replay, ces critères devraient
être vérifiés, chacun par un test rouge puis vert :

1. G1, G2, G3 levés **ou** VERIFIED redéfini par décision écrite ;
2. L1 : corrigé (replay 1.1.0) ;
3. le replay est `VERIFIED` **et** `HISTORICAL_VERIFIED`, pas seulement
   `VERIFIED` ;
4. une empreinte d'archive épinglée est fournie et vérifiée ;
5. le mode MP-0 devient explicite (`AS_OF_REPLAY` à côté de `LATEST_ONLY`),
   sans que le chemin `LATEST_ONLY` change d'un octet de sortie ;
6. un replay `INCOMPLETE` ou `INVALID` garde exactement le comportement
   actuel (abstention ou dégradation) ;
7. HOLD / FORBIDDEN reste vrai dans tous les cas : la confiance dans les
   données n'approuve aucune méthode.

## 5. Règles anti-lookahead (existantes et proposées)

En place et testées :
- un enregistrement n'est utilisable au cutoff que s'il est observé **et**
  ingéré au plus tard au cutoff (MP-1). Un test prouve que retirer tout
  enregistrement ingéré plus tard ne change pas la sélection ;
- le validateur DATA-3 vérifie le déterminisme à chaque instant de capture et
  une milliseconde avant ;
- CFTC : une valeur n'est servie qu'après son `publishedAt` déclaré (vue
  4.8.0), qui ne peut pas précéder la fin du jour du rapport (adaptateur
  1.4.0 et suivants) ;
- proxy BCE : `lookaheadSafeForReplay: false` sur chaque observation.

Proposées, non implémentées, à valider :
- R1 : toute série ajoutée à `CAPTURE_SERIES` porte une règle de fraîcheur
  dans le même changement (évite une nouvelle forme de G2) ;
- R2 : une source sans instant de publication prouvé (par exemple le proxy
  BCE) ne peut pas dépasser `INCOMPLETE` ;
- R3 : rejouer à un cutoff plus tardif ne modifie jamais le résultat d'un
  replay antérieur (le replay est une fonction pure de l'archive et du
  cutoff) ; un test de non-régression le figerait.
