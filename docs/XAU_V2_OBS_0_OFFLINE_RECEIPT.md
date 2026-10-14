# OBS-0 — audit receipt for the offline institutional chain

Status: `OFFLINE / CONTRACT-ONLY / NON-AUTHORITATIVE`.

`backend/observability/offline_receipt.ts` derives a deterministic
SHA-256 content checksum from an actual CHAIN-0 run. It includes the
one explicit `knowledgeCutoff`, exactly ten ordered stages, each
stage's schema and algorithm identities, abstention state and reason codes.
The receipt carries no input market values, credentials, account state,
operator identity or broker instructions.

The verifier rejects `READY`, `AUTHORIZED`, a non-null order or
risk allocation, tampered version/cutoff, duplicated reason codes and
a non-suppressed alert. Any rejected receipt has `fingerprint=null`
and `execution=FORBIDDEN`. It does not silently repair a bad input.

**SHA-256 is only a deterministic checksum.** It does not attest to
authentic data, user identity, immutable storage, approved methodology,
a deployed service, evidence that any release existed, or successful
recovery. No signing keys or persistence are introduced. Inputs are
offline claims; a forged-but-well-formed chain cannot be authenticated
by its hash.

A later OBS-1 must separately define independently trustworthy source
artifact IDs, version/vintage selectors, replay input manifests,
authorization and a retention/audit policy before any live claim.

This is a stacked follow-up to CHAIN-0. Do not merge until that PR and
all REC-1 Human Gates have been reviewed. There is no HTTP, cron,
database, provider, broker, notification or production integration.

## Explicit calendar validation (OBS-0 strict-cutoff follow-up)

The checksum verifier rejects non-existent civil dates, non-leap February 29,
invalid hour/minute/second, missing timezone, and out-of-range UTC offsets
without using JavaScript Date.parse normalization. E.g. 2026-02-30 is invalid
even though Date.parse normalizes it to a March timestamp in Node.

The check uses the provided cutoff only; no runtime clock, provider or data
source is consulted. A calendar-valid timestamp is still just an offline
caller claim, **not** proof of source release/vintage admissibility, no-lookahead,
or production state. A rejected cutoff yields `CUTOFF_INVALID`,
`verification=REJECTED`, `fingerprint=null`.
