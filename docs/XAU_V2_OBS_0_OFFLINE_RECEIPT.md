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

## OBS-0 hardening — full non-action envelope

The receipt rejects not only an illicit order or alert, but also all
fields that could *misrepresent* approval in an offline audit:
inconsistent H1–H5 ordering, non-null confidence/target/invalidation,
LLM request/response, pre-PM verdict, portfolio sizing,
final-risk maximum loss or verdict, forged runtime correlation IDs,
alert channels/recipients, and acceptance evidence claimed true or a
manufactured acceptance run. It hashes only a complete, verified
non-action envelope. The verification remains structural and offline:
it is not a cryptographic signature of real upstream data.
