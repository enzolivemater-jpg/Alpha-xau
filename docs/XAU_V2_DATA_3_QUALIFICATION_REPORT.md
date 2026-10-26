# XAU V2 — DATA-3 OFFLINE : rapport de qualification

Date : 2026-10-25. Agent : XAU V2 — LOCAL DEVELOPMENT. Statut :
**QUALIFICATION LOGICIELLE LOCALE, AUCUNE DONNÉE VERIFIED**.

Aucun push, merge, déploiement ni migration. `main` inchangée. REC-1 gelé ;
HOLD / FORBIDDEN partout. Un test au vert n'est pas une validation financière.
Ce rapport ne contient aucune valeur de marché ni CFTC réelle.

## 1. Ce qui a été qualifié

| Lot | Commit | Ce qu'il change |
| --- | --- | --- |
| DATA-3 L1 (PR #164) | `16469a7` | replay 1.1.0 : une couverture déclarée n'est pas une preuve (`DECLARED_FIELD_NOT_OBSERVED`) ; validateur non vide |
| Revue croisée A1, A2 | `df5750b`, `f8634d4` | la page refuse VERIFIED contredit par ses raisons ; vue 4.9.0 |
| Garde anti-dérive | `a78b99f` | la liste des raisons de la page est vérifiée contre le moteur |
| Continuité | `1ddcf1b` (reprise à l'identique de `e019282`) | audit de continuité par série dans le validateur |
| L1b | `c95b392` | replay 1.2.0 : `freshnessProof` FRESH / STALE / NOT_EVALUATED ; vue 4.10.0 |
| Affichage de la continuité | `ea32697` | résumé par champ et par série dans `terminal:check-data`, le catalogue et la page |

Arbre combiné de qualification (#161 + #162 + #163 + #164 + tous les lots
ci-dessus, dates fixées au 2026-10-25T00:00:00Z) : `13fa09c`, 26 commits
au-dessus de `c817c85`.

## 2. Les captures réelles locales

Point de vocabulaire : « 119 » est le nombre de **contrôles** du validateur,
pas de captures. Les données réelles sont :

| Élément | Valeur |
| --- | --- |
| Journaux de capture (`~/.local/share/xau-v2/evidence/`) | 3, tous `CAPTURED` |
| Réponses de fournisseur capturées | 5 |
| Enregistrements | 39 (29 + 9 + 1), aucune révision |
| Contrôles du validateur DATA-3 | 119/119 PASS |
| Scénarios de replay de la fusion | 12, tous `INCOMPLETE` / `HISTORICAL_UNVERIFIED` |
| Fichiers sources | inchangés (sha256 de tout `~/.local/share/xau-v2` identiques avant et après) |

### État par journal (replay 1.2.0 à la dernière réception)

| Journal | Champs déclarés | Fenêtre déclarée | Replay | Continuité par champ |
| --- | --- | --- | --- | --- |
| lot FRED (DFII10, VIXCLS, DCOILWTICO) | realYield, vix, wti | 2,5 s | `INCOMPLETE` : `FIELDS_NOT_COVERED`, `DECLARED_FIELD_STALE` | 3 × `HOLES_DETECTED` |
| FRED DGS10 | us10y | un instant | `INCOMPLETE` : `FIELDS_NOT_COVERED` | `NO_HOLE_DETECTED` (continuité non démontrée) |
| Twelve Data XAU/USD | spot | 0,5 s | `INCOMPLETE` : `FIELDS_NOT_COVERED` | `HOLES_DETECTED` |
| fusion | aucune (par construction) | étendue des réceptions, ~2 h | `INCOMPLETE` : `COVERAGE_NOT_DECLARED` | 4 × `HOLES_DETECTED`, us10y `NO_HOLE_DETECTED` |

`PROVENANCE_INCOMPLETE` est présent partout (`publishedAt` inconnu), sans
effet sur le statut.

### Blocages réels, par cause

1. **Champs jamais capturables** (`FIELDS_NOT_COVERED`) : aucune série ne
   fournit `dxy`, `bid` ni `ask` (G1). Bloque VERIFIED pour tout journal.
2. **Fraîcheur DXY non évaluable** : aucune règle approuvée (G2). Depuis 1.2.0,
   un DXY couvert rend `DECLARED_FIELD_FRESHNESS_NOT_EVALUATED` : **aucun
   replay ne peut être VERIFIED**, même synthétique.
3. **Valeur expirée** (`DECLARED_FIELD_STALE`, nouveau en 1.2.0) : dans le lot
   FRED, la dernière observation WTI dépasse déjà, à la capture, le seuil de
   6 jours de la règle runtime. Sous 1.1.0, ce cas n'était pas signalé.
4. **Lacunes dans les fenêtres déclarées** : chaque fenêtre commence à la
   création du journal, quelques dixièmes de seconde à quelques secondes
   avant la première capture ; WTI est indisponible sur toute sa fenêtre.
   Dans la fusion, spot et WTI sont indisponibles sur toute l'étendue des
   réceptions (≈ 2 h), realYield et vix pendant ≈ 17 min.
5. **Écarts entre observations quotidiennes** : uniquement des
   samedis/dimanches, plus une date de semaine manquante sur DGS10 et DFII10.
   Fermeture ou jour férié : `NOT_EVALUATED` (aucun calendrier approuvé).
6. **Fenêtres de quelques secondes** : aucune histoire continue n'existe ;
   la source prévue (table MP-2, collecteur) n'est pas branchée (G3, G4).

Aucune de ces données n'est VERIFIED, et aucune ne peut l'être en l'état.

## 3. Garanties vérifiées par les tests

| Garantie | Preuve |
| --- | --- |
| Un champ couvert expiré ou sans règle n'est jamais VERIFIED | bornes exactes (FRESH à `staleMaxAgeS`, STALE 1 s après), balayage de 7 jours contre `classifyFreshness` |
| Aucune observation postérieure au cutoff | une valeur plus fraîche ingérée 1 ms après le cutoff ne change rien ; utilisée dès son ingestion |
| « Aucun trou détecté » ≠ « continuité démontrée » | `continuity: NOT_ATTESTED` toujours ; libellé imposé ; la page refuse toute autre valeur |
| Moteur, API et terminal identiques | le catalogue égale `summarizeContinuity(auditCaptureContinuity(archive))` ; la page affiche ces statuts |
| La continuité n'entre dans aucune décision | la vue ne la porte pas ; HOLD / FORBIDDEN |
| Page et moteur d'accord sur les raisons qui interdisent VERIFIED | test anti-dérive (`a78b99f`) |
| Mutation | continuité 14/14, L1b 9/9, affichage 6/6 mutants tués |

## 4. Reproduire

Dans le worktree de la tête, avec Node 22 :

```
node node_modules/typescript/bin/tsc --noEmit
node scripts/run_ci_tests.mjs                       # 158/158 sur la branche, 160/160 combiné
node scripts/validate_evidence_captures.mjs --out "$TMPDIR/xau-data3"   # 119/119, lecture seule
npm run terminal:check-data                         # sortie 0, continuité par champ et par série
```

## 5. Décisions humaines ouvertes

1. DXY : source (licence ICE) et règle de fraîcheur (G1, G2). Sans elles,
   VERIFIED reste inatteignable.
2. bid / ask : source avec carnet ou exclusion contractuelle (G1).
3. Lecture L1b à confirmer : un champ `NOT_EVALUATED` bloque VERIFIED (choix
   actuel) ou seule une expiration démontrée bloque.
4. Calendriers de marché et tolérances d'écart, par série, pour évaluer les
   écarts aujourd'hui `NOT_EVALUATED`.
5. Décisions DATA-3 n° 1 à 3 : autorisation de capture, stockage brut
   (migration), confiance MP-0.
6. Push des branches de revue (section 6).

## 6. Branches de revue empilées

| Ordre | Branche | Tête | Base | Périmètre |
| --- | --- | --- | --- | --- |
| 1 | `fix/data-3-l1-coverage` (PR #164, publiée) | `16469a7` | #161 | DATA-3 L1 |
| 2 | `fix/terminal-reason-list-drift` | `a78b99f` | 1 | revue A1, A2 et garde anti-dérive (3 commits) |
| 3 | `review/data-3-continuity` | `1ddcf1b` | 2 | audit de continuité (1 commit) |
| 4 | `fix/data-3-l1b-replay-freshness` | `c95b392` | 3 | replay 1.2.0 (1 commit) |
| 5 | `feat/data-3-continuity-check-data` | tête de branche | 4 | affichage et ce rapport |

Indépendantes de cette pile : #162 puis `fix/cftc-publication-instant-basis`
(`6514c0b`) ; #163 (DXY BCE). La branche d'origine
`feat/data-3-capture-continuity` (`e019282`, posée sur #164) est conservée
mais ne doit pas être publiée en plus de la n° 3.
