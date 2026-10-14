# EVIDENCE-0 — Structural provenance and cutoff admission boundary

**Status: CODE / CONTRACT ONLY — UNVERIFIED, NO SOURCE ATTESTATION.**

## Purpose

The official event, market-pricing, and positioning engines retain
source-specific contracts. EVIDENCE-0 introduces a **cross-engine envelope
check only** for caller-supplied references to evidence artifacts. It does
not parse an official report, validate numerical indicators, calculate
economic surprise, choose a data provider, or infer a trading direction.
Those responsibilities remain in their owning engines.

Implementation: `backend/observability/evidence_manifest.ts`.
The function is pure and not connected to the Worker, UI, providers,
database, Committee or the CHAIN-0 simulation.

## Input and causal timeline

Every claim must supply exactly:

- `kind` (`OFFICIAL_RELEASE`, `MARKET_PRICE`, `POSITIONING`);
- `sourceAuthority`, `evidenceId`, `revision`, `producerVersion`;
- lowercase 64-digit `artifactSha256`;
- `effectiveAt` (when the fact applies),
  `publishedAt` (when the source released it),
  `firstIngestedAt` (first admission of that exact source revision).

The strict causal condition is

```text
effectiveAt <= publishedAt <= firstIngestedAt <= knowledgeCutoff
```

plus `publishedAt <= knowledgeCutoff`. This implements **structural
chronology**, not proof that a timestamp was actually supplied by an
official publisher or independently captured by the database.

All timestamps require an explicit UTC offset and precision no finer
than milliseconds. Higher precision is **rejected rather than rounded**,
because JavaScript millisecond comparisons could otherwise hide an
observation a fraction of a millisecond after the cutoff.

Identical replay of the same `(kind, authority, evidenceId, revision)`
is deduplicated. Reuse of that identity with divergent payload is an
error. The whole claim batch is rejected if **any** input is invalid,
future-dated, contradictory, malformed or missing. Valid entries are
returned sorted in deterministic codepoint order without changing input.

## Semantics and trust ceiling

For a structurally coherent nonempty batch:

```json
{"structuralStatus":"COHERENT","evidenceState":"UNVERIFIED","authorization":"NONE"}
```

`SOURCE_ATTESTATION_UNAVAILABLE` is always present. A coherent batch
**must never become** `VERIFIED`, `READY` or `AUTHORIZED` solely
because fields, timestamps or hashes look correct. An attacker can supply
an arbitrary SHA-256 string; computing or comparing a string does not
verify an official source, data lineage, provenance, signature or
collection authority.

For any failure `structuralStatus=REJECTED`, `claims=[]`,
`evidenceState=UNVERIFIED`, `authorization=NONE`. The output has
ordered reason codes. A missing source cannot be treated as zero,
a positive signal or proof of a historical release.

## Relationship to existing as-of contracts

- **MP-1/MP-2** remain the authority for price history and ingestion
  semantics, including ambiguity, revisions and field-level selection.
- **P-0/P-1** remain the authority for positioning data and revision policy.
- **EF-1 / Event Facts** remain the authority for official release identity,
  trusted source routing and stored raw artifact evidence.
- **OBS-0** remains an offline lineage checksum, not a source authenticity
  proof. EVIDENCE-0 cannot magically upgrade its checksum.
- **CHAIN-0** stays `HOLD / ABSTAIN / FORBIDDEN`; this new component is not
  wired as a dependency or accepted input gate.

Future EVIDENCE-1 would require an independent authority registry,
verified artifact retrieval with independently compared hashes,
trusted database-owned ingestion timestamps, artifact/release revision
proof and explicit authorization of any integration. Such claims must
be supported by proofs, not inferred from this structurally valid input.

**No REC-1 interaction, provider cost, migration, runtime, deploy,
alert delivery, broker connection, order or trade is authorized.**


## EVIDENCE-0 bounded untrusted input amendment (draft)

Algorithm: `evidence-structural-cutoff-gate-1.0.1`; schema remains
`xau.evidence-manifest.v1` with the existing `INVALID_CLAIM_SHAPE` rejection.
This is a patch to input validation, not an evidence trust upgrade.

- At most **256** claims in one structural batch. A larger batch is rejected
  **in full** before iteration; no sample, truncation, partial manifest or
  positive claim is emitted.
- Each claim must contain exactly the nine own, enumerable, data properties
  of the contract. Accessor properties are rejected without invoking getters.
  Descriptor retrieval failures are rejected.
- Inputs must be plain data from a trusted JSON-parsing boundary before
  crossing into a runtime. JavaScript Proxy traps cannot be made safe by
  validation running in the same realm; this remains a pure offline guard,
  **not** an untrusted-code sandbox.
- A bounded but otherwise coherent batch remains `UNVERIFIED` and has
  `authorization=NONE`, with permanent
  `SOURCE_ATTESTATION_UNAVAILABLE`.

Deterministic coverage: 256 duplicates, 257-item atomic rejection,
getter-bearing claims and throwing Proxy descriptors. No source authority
or production permission is inferred from passing these tests.
