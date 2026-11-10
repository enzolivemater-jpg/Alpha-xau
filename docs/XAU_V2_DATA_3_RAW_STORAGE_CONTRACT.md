# XAU V2 — DATA-3 : contrat de stockage brut et d'attestation des captures

Statut : **CONTRAT HORS LIGNE, SANS MIGRATION, AUCUNE PREUVE D'ORIGINE**.
2026-10-25, XAU V2 — LOCAL DEVELOPMENT. Répond aux manques G3 (couverture
auto-déclarée) et G4 (stockage brut) de `XAU_V2_DATA_3_VERIFIED_GAPS.md` pour
les journaux locaux. Le stockage côté runtime (table, migration) reste une
**DÉCISION** (DATA-3 n° 2) : rien ici ne la prend. HOLD / FORBIDDEN inchangé.

## 1. Ce qu'une capture doit porter

Une capture est une réponse de fournisseur conservée dans un journal
(`rawPayloads[<sha256>]`) et les enregistrements qui la nomment.

| Élément | Où | Vérifiable par le journal seul |
| --- | --- | --- |
| Octets exacts de la réponse | `rawPayloads[d].body` | oui : présents |
| Empreinte SHA-256 des octets (UTF-8) | clé `d` = `sha256:<hex>` | oui : recalculée |
| Identité de la requête | `parser` + `symbol` du corps, `source` + `sourceRecordId` + `field` des enregistrements | oui : doit être une série de `CAPTURE_SERIES` |
| Instant de réception | `ingestedAt` des enregistrements | oui : un seul instant par capture, lisible selon la règle stricte du dépôt (date civile réelle, fuseau explicite autre que `-00:00`), comparé à la nanoseconde ; l'outil de capture le garde à la milliseconde et refuse un instant plus fin (`INVALID_INGESTED_AT`) au lieu de l'arrondir |
| Ajout uniquement | ordre des enregistrements | oui : captures dans l'ordre de réception ; aucun octet sans enregistrement, aucun enregistrement sans octets |
| Valeurs relues depuis les octets | parseurs runtime | oui (replay, `RAW_VERIFIED`) |
| Qui atteste la capture | `provenanceClass: CAPTURED` (+ `--attest-captured`) | **non** : déclaration de l'opérateur |
| Identité et version du collecteur | manifeste d'attestation | **non** : déclarée, non vérifiée |
| Licence, redistribution, conservation | manifeste d'attestation | **non** : déclarées, non vérifiées |
| Signature du collecteur | — | **inexistante** |

## 2. Manifeste d'attestation (facultatif)

`attestation.json`, à côté de `archive.json`, format
`xau.capture-attestation-manifest.v1`, clés exactes :

```json
{
  "schemaVersion": "xau.capture-attestation-manifest.v1",
  "archiveId": "<archiveId du journal>",
  "attestedBy": { "kind": "OPERATOR", "name": "<qui atteste>" },
  "collector": { "name": "<outil>", "version": "<version ou commit>" },
  "licence": { "termsReference": "<conditions du fournisseur>", "redistribution": "NOT_ALLOWED | ALLOWED | UNKNOWN", "retention": "<durée de conservation>" },
  "captures": [{ "rawPayloadDigest": "sha256:…", "receivedAt": "<instant ISO avec fuseau>" }]
}
```

`collector` et `licence` peuvent être `null`. Chaque capture n'y figure
qu'une fois (`MANIFEST_CAPTURE_DUPLICATED` sinon) ; `receivedAt` suit la même
règle stricte que le journal. Le manifeste est une **seconde
déclaration** : il peut contredire le journal (capture absente, inconnue,
autre instant de réception), jamais le promouvoir. Il est refusé s'il est
illisible, d'un autre format, d'un autre journal, s'il porte une clé
inconnue, ou s'il affirme plus que ce qui peut être vérifié : attestation
`COLLECTOR`, champ `signature`, ou les mots VERIFIED, CERTIFIED, SIGNED,
PROVEN, AUTHENTICATED (`MANIFEST_CLAIM_EXCEEDS_PROOF`).

## 3. Vérification

`scripts/lib/capture_attestation.mjs` (pur, hors ligne), appelé par
`validate_evidence_captures.mjs` pour chaque journal :
- par capture : octets `KEPT` / `MISSING`, empreinte `MATCH` / `MISMATCH`,
  requête `KNOWN_SERIES` / `NOT_ESTABLISHED`, instant de réception ;
- par journal : `attestedBy` (`OPERATOR_DECLARED`, `NOT_CAPTURED`),
  `collector` et `licence` (`NOT_RECORDED`, `DECLARED_UNVERIFIED`) ;
- `receivedAt` rapporté : l'instant comparé, chiffres au-delà de la
  milliseconde compris (rapport `capture-attestation-1.2.0`) ;
- `outcome` : `BYTES_CONSISTENT` (ce que le journal peut montrer tient) ou
  `CONTRACT_BROKEN` ;
- toujours `attestation: NOT_PROVEN` et `upgradesReplay: false`.

Le validateur échoue sur un contrat rompu (octets modifiés ou absents,
enregistrement sans octets, octets orphelins, captures hors ordre, capture
reçue à plusieurs instants, octets partagés par deux séries, série inconnue)
et sur un manifeste refusé ou contredit. Un collecteur ou une licence non
enregistrés sont signalés, sans échec : aucun registre n'existe encore. Le
rapport n'est lu par aucun replay ni aucune décision.

### Capture sans valeur nouvelle

L'outil de capture (`appendProviderCapture`) ne garde des octets que si au
moins un enregistrement les nomme. Une réponse dont toutes les valeurs sont
déjà au journal (par exemple une réponse FRED dont seule la date de
millésime change) n'ajoute rien : issue `NO_NEW_VALUE`, journal inchangé,
octets non conservés, couverture non prolongée. Avant, l'outil gardait ces
octets sans enregistrement (issue `APPENDED`), ce que ce contrat refuse
(`ORPHAN_RAW_PAYLOAD`), et la fusion les refusait
(`CAPTURE_TIME_OR_SERIES_AMBIGUOUS`). Conséquence : le journal ne garde
aucune trace d'une telle capture ; l'audit de continuité n'en voit pas.
Conserver ces octets demanderait un enregistrement de capture sans valeur
(changement de contrat) et une revue des droits de conservation du
fournisseur (décision n° 4 ci-dessous) : non fait. Les journaux qui portent
déjà de tels octets restent refusés ; `RAW_VERIFIED` et ce contrat ne sont
pas assouplis.

## 4. Ce qui reste NON PROUVÉ

- l'origine des octets : rien ne prouve qu'ils viennent du fournisseur
  (pas de TLS conservé, pas de signature de collecteur) ;
- l'instant de réception : déclaré par l'outil ou l'opérateur, sans horloge
  de confiance ;
- la complétude : qu'aucune réponse n'a été omise (voir l'audit de
  continuité, toujours `NOT_ATTESTED`) ;
- la licence : les conditions déclarées ne sont pas relues par ce code.

## 5. Décisions qui lèveraient ces limites (non prises)

1. Collecteur autorisé écrivant seul le journal, avec identité et version
   (décisions DATA-3 n° 1 et 3).
2. Schéma de signature des captures et gestion des clés.
3. Stockage brut runtime (décision n° 2, migration).
4. Revue des conditions de chaque fournisseur (redistribution, conservation).

## 6. État des journaux réels (2026-10-25, lecture seule)

3 journaux, 5 captures : toutes `BYTES_CONSISTENT`, `OPERATOR_DECLARED`,
collecteur et licence `NOT_RECORDED`, aucun manifeste. Sources inchangées.
