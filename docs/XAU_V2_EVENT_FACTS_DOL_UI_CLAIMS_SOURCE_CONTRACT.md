# XAU V2 — US DOL Weekly UI Claims Source Contract

Status: **RAW PDF + BOUNDED DECODER + PURE PARSER/ADAPTER — CI PROOF ONLY — NO RUNTIME ACTIVATION**

## 1. Scope

This contract retains the exact official PDF, adds a bounded local/CI decoder,
then applies a deterministic, side-effect-free text parser and CES V2 adapter
for the U.S. Department of Labor Employment and Training Administration weekly
unemployment-insurance claims release. It adds no fetcher or runtime decoder,
database write, identity lookup, Worker route, schedule, secret, provider,
deployment, production mutation, consensus value, Gold interpretation or
trading action.

The reviewed evidence fixture projects the official October 1, 2026 release:

- embargo/publication line: 8:30 A.M. (Eastern) Thursday, October 1, 2026;
- title: UNEMPLOYMENT INSURANCE WEEKLY CLAIMS;
- footer release number: USDL 26-1543-NAT;
- source path: /ui/data.pdf;
- official regular-state seasonally adjusted summary and its release-local
  prior revisions.

The DOL path is overwritten for each new release. The release number, not the
URL, is the strong identity. Any future runtime must retain exact artifact
bytes before invoking a parser or adapter.

The retained CI fixture includes the exact nine-page official archive PDF at
`/sites/dolgov/files/OPA/newsreleases/ui-claims/20261543.pdf` (538666 bytes,
SHA-256 `e33ba5adcf0eb213d1d60ee96b55b9486d9a871250a99e28d6258a424cc0294e`)
and the complete `pdftotext 24.02.0 -layout` projection
of that PDF, normalized only by appending one final LF. Its provenance manifest
freezes the source URL, raw-PDF byte count and SHA-256, extraction command, and
normalized-text byte count and SHA-256. CI authenticates the PDF before calling
the external decoder, runs `pdftotext` without a shell under timeout/output
bounds, and proves that the resulting projection matches the retained text
byte-for-byte before parsing.

## 2. Exact source tuple

| Field | Required value |
|---|---|
| Authority | US_DOL_ETA |
| Provider | dol_eta |
| Source code | dol_ui_weekly_claims_release |
| Source domain | dol.gov |
| Release family | US_JOBLESS_CLAIMS |
| Release stage | SINGLE |

Any mismatch is UNSUPPORTED. No title, URL, date proximity, metric value or
market context may substitute for this tuple.

## 3. Release identity

Strategy version: dol_ui_weekly_claims_v1.

The exact official footer grammar is “USDL NN-NNNN-NAT”. The adapter explicitly
maps the single separator after USDL to the canonical identity form
“USDL-NN-NNNN-NAT”; no other repair is permitted.

The identity proposal is exact:

- authority namespace: xau_v2:official_release:us_dol_eta:v1;
- identity type: official_release_id:dol_ui_weekly_claims_v1;
- authority: us_dol_eta;
- family: US_JOBLESS_CLAIMS;
- release ID for the fixture: USDL-26-1543-NAT;
- stage: SINGLE;
- strategy: OFFICIAL_RELEASE_ID.

Corrections to facts under the same footer number retain identity and create
new append-only Event Versions only after separately authorized persistence.

## 4. Admitted facts

Only the regular-state seasonally adjusted national series are admitted:

| Metric | Official row | Reference period | Unit |
|---|---|---|---|
| INITIAL_CLAIMS | Initial Claims (SA) | latest initial-claims week | THOUSANDS_OF_PERSONS |
| CONTINUING_CLAIMS | Insured Unemployment (SA) | exactly one week behind initial claims | THOUSANDS_OF_PERSONS |
| CLAIMS_4WK_AVERAGE | initial-claims 4-Wk Moving Average (SA) | anchored to latest initial-claims week | THOUSANDS_OF_PERSONS |

The source projection retains integer person counts. The adapter renders
canonical thousands exactly: 197000 becomes “197”, 1701000 becomes “1701”,
and 202250 becomes “202.25”.

Each metric must retain the immediately preceding week's value before and
after the revision stated in the same official release. Every week-ending
date must be a valid ISO calendar Saturday. The average anchor must match the
initial-claims week, and continuing claims must lag it by exactly seven days.

## 5. Consensus and semantics

No consensus provider is authorized. Every metric emits the canonical
UNKNOWN state with a null value.

The adapter computes no surprise, direction, regime, Gold path, confidence,
recommendation or action. Official facts alone do not authorize economic or
market interpretation.

## 6. Failure behavior

- missing official evidence or release number: UNAVAILABLE;
- malformed shapes, dates, numbers or source person counts: MALFORMED;
- period, title or artifact contradictions: CONFLICT;
- source tuple, family or stage mismatch: UNSUPPORTED.

Every non-resolved result carries a stable machine-readable reason. The
adapter never falls back to another source, series, period or identity.

## 7. Parser boundary

`dol-ui-claims-text-parser-v1` accepts only a bounded string of at most
1,000,000 characters. It requires exactly one official embargo/publication
line, one exact DOL footer release number, one initial-claims narrative block,
and one continuing-claims narrative block. Missing or duplicated evidence,
invalid comma-grouped person counts, unsupported titles, NUL bytes and
oversized inputs fail closed.

The parser derives only the immediately prior week dates by exact seven-day
calendar subtraction. It validates the stated Thursday publication date, the
one-to-seven-day publication lag, and the exact seven-day gap between initial
and continuing claims. It emits the strict payload consumed by the existing
adapter; the adapter remains responsible for Saturday, source-tuple and
canonical-state validation. Parser and adapter composition is tested against
the reviewed JSON fixture byte-for-byte at the object level.

## 8. Evidence and proof boundary

The structured fixture values are now reproduced from the retained official
text projection by the pure parser rather than accepted solely as a manual
transcription. The tests prove the retained text hash, recorded raw-PDF
provenance, exact parser-to-fixture equality, deterministic replay, no input
mutation, canonical identity, metric ordering, metric-specific periods,
release-local revisions, exact person-to-thousands rendering, strict negative
cases, and absence of network, database, clock, environment, model, market or
consensus dependencies.

This proof is code/fixture evidence only. It is not evidence of a live fetch,
committed raw-PDF bytes, independent PDF decoding, persistence, deployment,
scheduled capture, production activation or downstream positive inference.

## 9. Conservative consumer admission

Event Impact and Gold Transmission processor version 4 admit only this exact
three-metric shape, including valid Saturday periods, the one-week continuing
claims lag, one immediately prior release-local revision per metric,
non-negative canonical thousands with at most three decimals, and UNKNOWN
consensus.

Admission produces no signal. Event Impact remains INSUFFICIENT_EVIDENCE with
zero interpretations; Gold Transmission remains CONSENSUS_FACTS_UNAVAILABLE
with zero paths. Any positive claims-to-Gold rule requires a separately
reviewed methodology and evidence package.
