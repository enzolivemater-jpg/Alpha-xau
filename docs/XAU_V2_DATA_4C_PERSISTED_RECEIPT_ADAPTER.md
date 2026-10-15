# XAU V2 — DATA-4C : adaptateur pur des reçus PostgreSQL vers DATA-4A

**DRAFT / NO MAIN / NO PRODUCTION / NO RUNTIME CONNECTION.**

Contrat et versions gelées :

- `PERSISTED_CAPTURE_RECEIPTS_SCHEMA_VERSION` :
  `xau.persisted-capture-receipts.v1`
- `PERSISTED_CAPTURE_RECEIPTS_ALGORITHM_VERSION` :
  `persisted-capture-receipts-audit-adapter-1.0.0`

Source : RPC éphémère proposée dans DATA-4B,
`fn_market_capture_receipts_as_of(cutoff,max_rows)`, qui renvoie
l'historique **complet-ou-erreur** dans la limite autorisée. Aucun appel
Postgres n'est ajouté au runtime. Le tableau de résultats est injecté
dans `normalizePersistedCaptureReceipts`.

## Invariants

- Validation stricte de **toutes** les colonnes RPC, de la paire
  fournisseur/série/symbole et de la cohérence succès/échec.
- Les horodatages exigent un ISO-8601 à fuseau explicite ; la date de
  première connaissance pour l'audit est **`recorded_at` de PostgreSQL**,
  jamais `source_received_at` déclaré par le collecteur.
- Toute ligne DB postérieure au cutoff fourni est refusée : le RPC
  n'aurait pas dû l'envoyer. Aucun filtrage silencieux qui ferait passer
  un historique tronqué pour complet.
- Une réponse CAPTURED fournit uniquement un digest SHA-256 de 64
  chiffres hexadécimaux ; FAILED ne fournit **aucun** digest et exige
  un code d'erreur fermé. Aucun texte libre ou URL avec API key.
- Les duplicata de plan/slot, identités divergentes ou champs
  inattendus provoquent un échec explicite, pas de dernier gagnant.
- Les reçus valides sont confiés à la seule fonction canonique
  `auditCaptureContinuity` de DATA-4A. Aucune politique parallèle
  et aucune logique d'activation.
- Le statut `ATTEMPTS_RECORDED` ne prouve ni un plan exhaustif, ni une
  authenticité fournisseur, ni une couverture historique des huit
  champs du Market Pricing. Même résultat : `HOLD / FORBIDDEN`.

## Frontières non franchies

Pas d'appel réseau ou PostgreSQL, pas de scheduler/collector, pas de
secrets, de changement de schéma appliqué, de migration, de production,
d'import de captures réelles, de connexion broker ni de BUY/SELL.

L'intégration future doit vérifier contractuellement l'exhaustivité
des résultats RPC, la fréquence des slots, les droits fournisseurs et
la rétention, et fournir une preuve d'origine indépendante. Toutes ces
activations restent derrière des Human Gates explicites.
