# XAU V2 — DATA-4E : plan de collecte explicitement déclaré (hors ligne)

Statut : **BROUILLON / CI SEULEMENT / INTERDIT EN PRODUCTION**.

Contrat de compilation versionné :

- `CAPTURE_SCHEDULE_SCHEMA_VERSION` : `xau.capture-schedule-policy.v1`
- `CAPTURE_SCHEDULE_ALGORITHM_VERSION` : `capture-schedule-explicit-utc-1.0.0`

## Objectif

Un plan de collecte ne doit pas déduire que le marché est couvert simplement
parce qu'une suite de requêtes a réussi. DATA-4E contrôle **avant tout
collecteur** des créneaux précis fournis par un opérateur, et produit uniquement
le contrat canonique `CaptureContinuityPlan` de DATA-4A.

Ce module est volontairement **une compilation de créneaux déclarés**,
pas une source autorisée de jours ouvrés, d'horaires FRED, d'ouvertures du spot
XAUUSD ou de quotas Twelve Data.

Le manifeste d'entrée doit définir :

- Une identité de plan, une fenêtre temporelle bornée à **sept jours maximum**,
  et les créneaux `earliestAt` / `deadlineAt` de **chaque** requête prévue.
- Un couple fournisseur/symbole/série connu du registre DATA-2 `CAPTURE_SERIES`.
  Toute série déclarée doit avoir au moins un créneau.
- Un plafond explicite de requêtes **par fournisseur pour ce plan**.
  Ce plafond est un garde-fou interne : ce n'est **pas** le quota commercial
  confirmé par le fournisseur.
- Des instants strictement UTC, à la milliseconde (`YYYY-MM-DDTHH:mm:ss.sssZ`).
  Aucune règle de fuseau local, heure d'été, jour férié ou date de publication
  n'est extrapolée.

Le compilateur interdit les identités ou slots dupliqués, les créneaux
chevauchants pour une même série, les horaires hors fenêtre et les budgets
dépassés. Il plafonne à 512 créneaux pour empêcher un plan déraisonnable
ou des résultats de tests non bornés. Il ordonne de manière déterministe les
slots sans dépendre de l'ordre du fichier fourni.

## Place dans XAU V2

- **DATA-2/3** : seuls détenteurs de la sémantique de réponse fournisseur.
- **DATA-4A** : seul auditeur canonique de présence/retard/échec des reçus.
- **DATA-4B** : proposition de persistance PostgreSQL, uniquement
  `database/proposals`, jamais une migration autorisée.
- **DATA-4C/4D** : seul adaptateur de reçus persistés avec plan_id et cutoff.
- **DATA-4E** : compilation stricte du plan sans déclencher d'exécution.

L'état retourné ne peut **jamais** prétendre être une approbation :
`calendarCompleteness: NOT_PROVEN`,
`supplierQuotaApproval: NOT_PROVEN`,
`providerAuthenticity: NOT_PROVEN`,
`archiveCoverage: NOT_ESTABLISHED`,
`authorization: OFFLINE_ONLY`,
`decision: HOLD`, `execution: FORBIDDEN`.

Même lorsque DATA-4A déclare `ATTEMPTS_RECORDED`, cela n'établit
ni la continuité de l'ensemble de l'historique, ni la date véritable de
publication FRED, ni une donnée XAUUSD microstructure authentifiée.
Ne pas attribuer de bid/ask ou DXY à un fournisseur qui n'en donne pas.

## Gates non franchies

Avant une vraie collecte récurrente, il faut des décisions distinctes :
calendrier et source d'autorité pour chaque série, périodes d'indisponibilité
attendues, budgets commerciaux et quotas, licences de conservation des octets,
gestion des secrets, droits réseau, chiffrement/sauvegarde, mécanisme de reprise,
journal inviolable de l'exécution et validation des données observées.

DATA-4E ne définit aucun horaire officiel, n'introduit aucune boucle
de polling et ne crée aucun accès réseau. Aucune migration n'est appliquée,
aucune méthode de trading n'est activée, aucune modification de `main`
ou du freeze REC-1 n'est autorisée.
