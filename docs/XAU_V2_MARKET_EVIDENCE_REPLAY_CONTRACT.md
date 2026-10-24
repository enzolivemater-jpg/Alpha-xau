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
- replay: `xau.market-evidence-replay.v1` / `market-evidence-replay-1.1.0`.

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
- a covered field with no value held at the cutoff
  (`DECLARED_FIELD_NOT_OBSERVED`, 1.1.0, DATA-3 L1). It makes the replay
  `INCOMPLETE`: a declaration alone never proves completeness, so the absence
  of a value is no longer read as "nothing existed";
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
    field, **every covered field has a value held at the cutoff** (1.1.0),
    and the pinned digest matches when given;
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

## Capture (DATA-2)

`backend/market_engine/evidence_capture.ts` turns a provider response that is
already in hand into archive records. It never requests anything.

**What one capture contains:**
- the exact body;
- the provider series or symbol it was requested for (`CAPTURE_SERIES`: FRED
  `DGS10`, `DFII10`, `VIXCLS`, `DCOILWTICO`, equal to the runtime
  `FRED_SERIES`, and Twelve Data `XAU/USD`);
- the explicit time it was received.

**What it does:**
- The body is kept verbatim under its digest. Every observation it holds
  becomes a record naming that digest. A FRED body holds several observations;
  `parseFredObservations` reads them all, with the `parseFred` rules.
- `publishedAt` stays unknown, because neither provider states a publication
  time. A Twelve Data quote has no book, so no bid or ask is captured.
- The log is append-only:
  - the same bytes again change nothing;
  - a known observation with the same value is not recorded again;
  - a different value becomes a revision superseding the latest one;
  - capture times never go backwards.
- The declared coverage ends at the last capture, so a later cutoff is
  `INCOMPLETE`.
- A capture applies only if the resulting archive replays without a blocking
  finding (for example an implausible value, or a yield in basis points).

The raw-payload verification now accepts a parser that returns every
observation of a body. A record must be one of them; with the single-latest
`parseFred`, older records of a FRED body would be rejected.

`scripts/market_evidence_capture.mjs init | append | replay` runs the log on
files already on disk. Every time is explicit; file times are never used. An
archive is `SYNTHETIC_FIXTURE` unless initialized with `--class CAPTURED
--attest-captured`, the operator's statement that every body came unmodified
from the provider. Test: `tests/test_market_evidence_capture.mjs`.

`appendProviderCapture` and `mergeCaptureArchives` refuse (`ARCHIVE_INVALID`,
`SOURCE_INVALID:STRUCTURE`, `SOURCES_INVALID`) a log that is not an object with a
`records` array and a `rawPayloads` object, such as a log file holding `null` or an
array; they used to raise a `TypeError`. `validatePoint` rejects a symbol that has
no plausibility rule (own-property lookup) instead of reading it through the
prototype.

The provider parsers that re-derive values from kept raw bodies
(`parseFred`, `parseFredObservations`, `parseTwelveData`) never throw on a hostile
body: a non-text FRED `date` is an unusable observation (it used to raise a
`TypeError` in `toUtcIso`), and a quote time whose ISO form is not RFC3339 (year
above 9999 or below 0) is no timestamp at all. An available point always has a
finite value and a strict observation time (`tests/test_provider_parsers_mutation.mjs`).

`replayMarketEvidence` never throws on untrusted input: a non-string cutoff is
treated as an invalid cutoff and a non-string pinned digest never matches (both
would otherwise be echoed into the hashed envelope). `tests/test_market_evidence_mutation.mjs`
sweeps 4109 hostile archives, cutoffs and pins through replay, CHAIN-0, OBS-0 and
the terminal view: no exception, HOLD/FORBIDDEN everywhere, and an INVALID replay
exposes no market value.

`init` and `append` rewrite the whole log, so they take an exclusive writer lock
(`<log>.lock`, created with `O_EXCL`). A second writer exits 1 immediately and
leaves the log untouched, instead of silently dropping a capture in a
read-modify-write race. A lock left by a crashed run is never removed by the
script: the operator checks the log, then removes it. The new log is flushed to
disk (`fsync`) before it replaces the old one. `replay` is read-only and takes
no lock. This protects one machine's file; it is not a distributed lock and
proves nothing about provider authenticity or coverage.

## Not established

- **No authentic market archive exists in this repository:** every replay
  here is a SIMULATION. `HISTORICAL_VERIFIED` is exercised only with test
  bodies written in the test.
- **No authorized capture has run.** The capture path exists (DATA-2), but
  no provider response has been recorded. A real capture needs an authorized
  run: the runtime collectors, or an operator downloading responses with the
  provider keys. The runtime ingestion still discards raw bodies.
- **Coverage is self-declared.** The append-only MP-2 table plus its
  complete-or-error RPC is the intended source of a provable coverage.
  Wiring it is gated.
- **Twelve Data quotes carry no book**, so `bid` and `ask` cannot be
  re-read from raw bytes.

## DATA-3: merge and local validation of real captures

`mergeCaptureArchives(sources, { archiveId, parsers })` replays every kept
capture of the source logs, with its exact bytes and its recorded reception
time, in reception order, into a new log. The sources are not modified.

The merge:
- declares **no coverage**: each source declares only its own window, and
  nothing establishes completeness between them, so every replay of the merge
  is `INCOMPLETE`;
- is `CAPTURED` only if every source is;
- is rejected when:
  - a source is invalid;
  - a kept body has no record or several reception times;
  - the replayed captures do not reproduce every source record (a value
    already held from a strictly earlier capture is the only exception).

Capture order and pre-validation now also apply to an archive without
coverage.

`scripts/validate_evidence_captures.mjs [--out DIR] ARCHIVE.json…`, a local
tool not run in CI, checks:
- the sources;
- the merge, including its independence from source order;
- at every capture instant (and one millisecond before) and later:
  - determinism and no look-ahead;
  - `INCOMPLETE` and not reproducible;
  - DXY, bid and ask unavailable;
  - publication time unknown;
  - HOLD / FORBIDDEN for the replay and for CHAIN-0.

It writes `merged-archive.json` and `report.json` to `--out`, never next to a
source. Real captures are never committed: they are third-party data.

## DATA-3 L1: declared coverage is not evidence (replay 1.1.0)

Before 1.1.0, a log that declared all eight fields replayed `VERIFIED` (and,
`CAPTURED`, `HISTORICAL_VERIFIED`) while holding no `dxy`, `bid` or `ask`
value: completeness rested on the declaration alone. Now:
- `createEvidenceArchive` refuses coverage of a field no capture series
  provides (`CAPTURABLE_FIELDS`: spot, us10y, realYield, vix, wti) with
  `COVERAGE_FIELD_NOT_CAPTURABLE`; `market_evidence_capture.mjs init`
  declares only those;
- a replay marks a covered field with no value held at the cutoff
  `DECLARED_FIELD_NOT_OBSERVED`, so `INCOMPLETE`.

Consequences: a capture log is always `INCOMPLETE` (`FIELDS_NOT_COVERED`)
while no series provides `dxy`, `bid` and `ask`, and `HISTORICAL_VERIFIED` is
out of reach. Logs written by an older `init` need no migration: they keep
their format, still append and replay, and are `INCOMPLETE`. The synthetic
DATA-1 fixture declares `dxy` without a DXY value and is now `INCOMPLETE`
(the terminal shows « REJEU INCOMPLET »); its VERIFIED paths are tested on a
copy completed with a fictitious DXY value in the test.

## Remaining decisions (DATA-3 onward)

Three decisions gate authentic history; nothing below is implemented.

1. **Capture authorization.** Use the existing collectors (`fetchFred`,
   `fetchTwelveData`) or an operator download, with keys the operator
   provides. Each body goes through `appendProviderCapture` with its
   reception time.
2. **Raw storage in the runtime.** The runtime ingestion still discards
   bodies, and `official_source_artifacts` cannot hold them: its CHECK limits
   it to BLS CPI. Two options, both schema changes:
   - extend that table with an `artifact_role` for provider responses;
   - add an append-only `market_provider_responses` table holding the
     provider, series, body bytes, a generated SHA-256 and the ingestion time.

   Either way, a request URL is stored only after `redactUrl`, because FRED
   and Twelve Data put the API key in the query string. MP-2
   `evidence_revision` would then be the body digest that DATA-2 already
   derives (`cap-<sha256 prefix>`).
3. **Trust.** Two separate questions:
   - whether MP-0 may report a `VERIFIED` replay instead of
     `HISTORICAL_REPLAY_UNAVAILABLE`;
   - whether operator attestation suffices for `CAPTURED`, or only
     collector-written logs.

   HOLD stays in either case, because no method is approved.
