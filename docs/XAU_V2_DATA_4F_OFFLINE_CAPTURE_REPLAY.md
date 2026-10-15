# XAU V2 — DATA-4F : simulation déterministe des collectes (sans réseau)

Statut : **PR BROUILLON / HORS PRODUCTION / SIMULATION UNIQUEMENT**.

Contrats gelés :

- `OFFLINE_CAPTURE_REPLAY_SCHEMA_VERSION` : `xau.offline-capture-replay.v1`
- `OFFLINE_CAPTURE_REPLAY_ALGORITHM_VERSION` : `offline-capture-replay-transition-1.0.0`

## Frontières canoniques

DATA-4F n'est ni un nouveau collecteur, ni un autre planificateur, ni un journal
authentifié. Il dépend exclusivement de :

- DATA-4E `compileCaptureSchedule` pour les créneaux UTC explicites.
- DATA-4A `auditCaptureContinuity` pour évaluer les reçus simulés.
- DATA-2 `CAPTURE_SERIES` via le plan compilé. Aucune nouvelle nomenclature.

Les événements sont **des résultats fictifs fournis au simulateur**.
Un événement `CAPTURED` contient un digest de forme SHA-256, **pas des octets
fournisseur réellement téléchargés**. Un digest présent dans une simulation
n'est ni une capture authentique, ni une attestation de provenance.

## Machine d'état

Pour chaque slot déclaratif, DATA-4F accepte des événements explicites
`attempt` (1 à 5), `at` (UTC strict), `outcome` et `failureCode`
(code fermé : TIMEOUT/QUOTA/HTTP_ERROR/TRANSPORT_ERROR/PARSE_REJECTED/OTHER).

- `CAPTURED` : terminé, un reçu simulé est émis, aucun retry possible.
- `FAILED` : échec terminal explicite, un reçu simulé d'échec est émis.
- `RETRYABLE_FAILURE` : un retry explicite ultérieur est possible, pas
  de reçu terminal synthétique inventé. Les tentatives successives
  doivent respecter le délai minimal et la fenêtre de collecte.
- Un même (slot, numéro de tentative) retransmis avec des octets de
  déclaration identiques est idempotent ; une divergence échoue.
- Numérotation non contiguë, retry après terminal, retry trop tôt,
  événement hors créneau, quota simulé dépassé, données invalides ou
  message d'erreur libre : refus explicite.

Le simulateur rejoue la trace depuis zéro à chaque cutoff, sans état global,
horloge ni accès réseau. Les tentatives postérieures au cutoff ne peuvent pas
faire apparaître une réussite historique prématurée. Les résultats restent
déterministes à l'ordre d'entrée près.

## Bornes et limites de sécurité

- Maximum 2048 événements de trace, 5 tentatives par slot et 2048 tentatives
  par fournisseur ; minimum de backoff : 1 seconde, maximum : 1 heure.
- Les plafonds de retry sont **des budgets locaux de simulation**.
  Ils ne sont PAS des quotas FRED ou Twelve Data approuvés.
- Les identités, créneaux et plafonds initiaux restent contrôlés par DATA-4E.
- Aucune lecture de clé, aucune construction d'URL, aucun appel HTTP, aucune
  boucle réseau, aucune migration ou DB, aucune écriture sur disque.
- Les reçus du résultat sont nommés `simulatedReceipts` et le résultat est
  marqué `simulationOnly: true`. Ils ne doivent **jamais** alimenter la
  persistance DATA-4B comme des preuves réelles.

Tous les résultats exposent `providerAuthenticity: NOT_PROVEN`,
`archiveCoverage: NOT_ESTABLISHED`, `authorization: OFFLINE_ONLY`,
`decision: HOLD` et `execution: FORBIDDEN`.
Même `ATTEMPTS_RECORDED` de DATA-4A ne prouve qu'une **simulation complète
des slots déclarés**, jamais une collecte continue authentifiée.

## Activation réelle : Human Gates séparées

Validation des calendriers, quotas/contrats API, gestion des secrets,
politique de rétention et chiffrement, journal durable append-only,
reprise après panne réelle, contrôles de provenance, sécurité du
collecteur, autorisation de migration/deploy et levée du gel de production.
Aucune de ces décisions n'est prise par DATA-4F.

`main`, REC-1, le terminal live, MP-0, CHAIN-0 et l'exécution de trading
restent inchangés. **Ne pas merger cette PR**.
