# XAU V2 — market evidence archive and replay (DATA-1)

Status: `LOCAL_ONLY — NOT WIRED TO RUNTIME — NO SCHEMA CHANGE`

DATA-1 turns archived market observations into a CHAIN-0 market snapshot at
an explicit cutoff. Each observation is traceable and validated, and the
replay is deterministic. It reuses MP-1 (`selectMarketPricingAsOf`) for
selection and the existing freshness and plausibility rules (`SYMBOL_RULES`).
It adds no provider, persistence, migration or runtime caller.

Module: `backend/market_engine/evidence_archive.ts`. Bridge:
`backend/decision_chain/market_evidence_chain.ts`. Test:
`tests/test_market_evidence_replay.mjs`.

## Frozen versions

- archive: `xau.market-evidence-archive.v1`;
- replay: `xau.market-evidence-replay.v1` / `market-evidence-replay-1.0.0`.

## Evidence record

| Field | Meaning |
| --- | --- |
| `evidenceId` | stable record id (MP-1 `candidateId`) |
| `field`, `instrument`, `unit`, `observationType` | must match `MARKET_EVIDENCE_FIELD_SPEC`; a unit is never converted |
| `value` | finite number within the existing plausibility rule |
| `source`, `sourceRecordId` | source code and the source's own record id (series id, quote id) |
| `observedAt` | time the value describes, as published by the source |
| `publishedAt` | time the source made it available, when stated |
| `ingestedAt` | first time this system held the record; governs availability |
| `revision`, `supersedes` | MP-2 `evidence_revision`; the record a correction replaces |
| `rawPayloadDigest` | `sha256:` of the raw provider bytes |

`sourceRecordId`, `publishedAt` and `rawPayloadDigest` may be `null`, which
means **unknown**. Each replayed observation lists its unknown fields, and the
archive reports `PROVENANCE_INCOMPLETE`. Nothing is inferred.

The archive also carries:
- `provenanceClass`: `SYNTHETIC_FIXTURE` or `CAPTURED`;
- `coverage`: a window and the fields for which the producer states the
  archive holds every record it ingested, or `null`;
- `rawPayloads`: optional raw bodies, keyed by digest.

## Validation

Blocking findings reject the whole archive (`INVALID`). The chain then
receives no value at all:
- shape and types (exact keys);
- instrument, unit and observation type;
- value domain;
- chronology: `observedAt ≤ publishedAt ≤ ingestedAt`;
- an evidence id reused with other content;
- the MP-2 identity `(field, source, observedAt, revision)` reused with another
  value;
- an invalid revision chain: unknown target, another observation, ingested
  before its target, or two corrections of one record;
- two revisions of one observation with different values and no link between
  them;
- kept raw bytes that do not hash to their digest, or from which the injected
  runtime parser does not read back the recorded value and time;
- a pinned archive digest that does not match.

Through MP-1, two sources that disagree at the same instant
(`AMBIGUOUS_TOP_OBSERVATION`) also reject the archive. An inverted book or a
missing spot makes MP-1 abstain: the replay stays verifiable, and the snapshot
is unavailable.

Not blocking, but reported:
- exact duplicates (ignored);
- incomplete provenance;
- missing coverage;
- DXY, which has no freshness rule and therefore stays unavailable, as in
  CHAIN-0.

## Replay

- A record is usable at the cutoff only if it was observed **and** ingested by
  then (MP-1). A test proves the selection is unchanged when every
  later-ingested record is removed. Post-cutoff records are only counted, and
  a later correction is flagged (`audit`), never used.
- Freshness and age are computed at the cutoff with `SYMBOL_RULES`. An expired
  value becomes unavailable.
- `status`:
  - `VERIFIED`: valid, the declared coverage includes the cutoff and every
    field, and the pinned digest matches when given;
  - `INCOMPLETE`: valid, but completeness is not established;
  - `INVALID`: a blocking finding.
- `reproducible` is true only when the status is `VERIFIED`. The archive
  digest, every record digest and the replay digest are SHA-256 of canonical
  JSON. They do not depend on the host time zone or locale.
- `nature`:
  - `SIMULATION`: a synthetic archive;
  - `HISTORICAL_VERIFIED`: a captured archive, a `VERIFIED` replay, and every
    selected value re-read from its kept bytes;
  - `HISTORICAL_UNVERIFIED`: any other captured archive.

  Never LIVE.
- The decision is always `HOLD` and execution `FORBIDDEN`.

## CHAIN-0 integration

`evaluateDecisionChainOnMarketEvidence(input, replay)` replaces only
`input.marketSnapshot` and runs CHAIN-0 at the replay cutoff. MP-0 is
unchanged: it still reports `HISTORICAL_REPLAY_UNAVAILABLE` and
`LATEST_ONLY`. Invalid or abstaining evidence makes MP-0 abstain
(`SOURCE_SNAPSHOT_UNAVAILABLE`). The precise replay reasons are carried in
`sourceReason`, and an `INCOMPLETE` replay says so there too. Upgrading MP-0 to
trust a verified replay is a separate decision.

The local terminal server takes `--archive file [--archive-digest sha256:…]
[--cutoff ISO]`. It also offers five archive scenarios built on
`tests/fixtures/market_evidence_archive_synthetic.json`, a hand-written
archive labelled `SYNTHETIC_FIXTURE`. View v4 carries the manifest as
`marketEvidence`.

## Not established

- **No authentic market archive exists in this repository:** every replay
  here is a SIMULATION. `HISTORICAL_VERIFIED` is exercised only with test
  bodies written in the test.
- **Capture is still missing.** An authorized capture would have to record,
  per provider response:
  - the raw body and its digest;
  - the source record id;
  - the publication time when the source states it (for example FRED
    `realtime_start`);
  - the ingestion time;
  - the coverage window.

  Nothing captures this yet.
- **Coverage is self-declared.** The append-only MP-2 table plus its
  complete-or-error RPC is the intended source of a provable coverage.
  Wiring it is gated.
- **Twelve Data quotes carry no book**, so `bid` and `ask` cannot be
  re-read from raw bytes.
