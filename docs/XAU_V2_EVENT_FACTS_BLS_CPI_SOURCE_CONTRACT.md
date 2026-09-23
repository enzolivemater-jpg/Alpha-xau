# XAU V2 — Event Facts EF-2 / US BLS CPI Source Contract

Status: `PURE ADAPTER — EF-2, NOT ACTIVATED`
Milestone: EF-2 (one official release family only)
Baseline verified against: `d72b0dfeadea63857e10ee718186d3fe435c8cec`

This contract introduces one pure adapter for the US Bureau of Labor
Statistics Consumer Price Index release family. It adds no fetcher, XLSX
parser, database write, identity-claim lookup, Worker route, cron path,
deployment, consensus provider, or CES V2 activation.

## 1. Exact scope

| Field | Frozen value |
|---|---|
| Authority | US Bureau of Labor Statistics |
| Authority code | `US_BLS` |
| EF-1 authority namespace code | `us_bls` |
| Provider | `bls` |
| Source code | `bls_cpi_release` |
| Source domain | `bls.gov` |
| Release family | `US_CPI` |
| Release stage | `SINGLE` |
| Identity strategy | `OFFICIAL_RELEASE_ID` |
| Strategy version | `bls_cpi_v1` |
| Adapter version | `bls-cpi-event-facts-adapter-v1` |

No other BLS family, regional CPI release, CPI-W release, chained CPI
release, stage, table, or source tuple is supported by EF-2.

## 2. Official artifacts

One adapter input binds two artifacts published by the same official
authority for the same CPI release instance:

1. the archived CPI news-release header, which carries the exact BLS news
   release identifier (`USDL-YY-NNNN`), the release heading, and the public
   release statement;
2. the month-specific archived **News Release Table 1** XLSX, which carries
   the reviewed headline and core CPI percentage-change cells.

Official source pages:

- CPI news release and archive entry point:
  `https://www.bls.gov/cpi/news.htm`
- archived CPI news releases:
  `https://www.bls.gov/bls/news-release/cpi.htm`
- archived CPI supplemental XLSX files:
  `https://www.bls.gov/cpi/tables/supplemental-files/`
- CPI release schedule:
  `https://www.bls.gov/schedule/news_release/cpi.htm`
- BLS correction/errata register:
  `https://www.bls.gov/errata/`

The public BLS Data API is intentionally not the EF-2 source. BLS states
that API data has a one-day lag after publication, and the API exposes
historical time-series observations rather than a self-contained immutable
release-instance bundle. It therefore cannot establish the release-time,
as-published boundary required here. See:
`https://www.bls.gov/bls/api_features.htm`.

## 3. Reviewed structured projection boundary

`backend/event_facts/bls_cpi_adapter.ts` consumes a lossless structured
projection of the two artifacts. The projection is not a generic macro
payload and is not accepted from aggregators.

The exact top-level keys are:

```text
source, release, table1
```

The source tuple is exact. The release projection preserves:

- `releaseFamily`;
- `releaseStage`;
- the exact official `releaseId`;
- the exact CPI header title;
- the official public-release statement as raw text;
- the archived BLS release path.

The Table 1 projection preserves:

- the month-specific archived XLSX path;
- the exact Table 1 title;
- the explicitly extracted `MONTH` reference period;
- the exact reviewed YoY and MoM column labels after line-break removal by
  the future source parser;
- exactly the two reviewed rows and their two numeric cells.

Fetching and parsing XLSX are future source-ingestion work. The future
parser must reproduce this projection exactly and preserve the original
artifact outside CES for audit. It must not supply inferred, repaired, or
aggregator-derived fields.

## 4. Release identity

### 4.1 Evidence

The archived news-release header exposes a BLS release identifier such as
`USDL-26-1496`. EF-2 requires the exact uppercase grammar:

```text
USDL-[0-9]{2}-[0-9]{4}
```

The identifier is scoped by the exact authority, family, and stage. A URL,
title, reference period, metric, publication time, or workbook path never
substitutes for a missing identifier.

### 4.2 EF-1 proposal

For `USDL-26-1496`, the pure resolver emits:

```json
{
  "authorityNamespace": "xau_v2:official_release:us_bls:v1",
  "identityType": "official_release_id:bls_cpi_v1",
  "identityValue": "{\"authority\":\"us_bls\",\"release_family\":\"US_CPI\",\"release_id\":\"USDL-26-1496\",\"release_stage\":\"SINGLE\",\"strategy\":\"OFFICIAL_RELEASE_ID\",\"strategy_version\":\"bls_cpi_v1\"}"
}
```

`identityValue` uses EF-1 canonical JSON: lexicographically sorted keys,
strings only, no whitespace, and no silent normalization.

The resolver emits no `candidateClusterIds`. A future orchestrator must
derive the existing three-part strong-identity hash, perform the exact
active-claim lookup, and enforce the reviewed 0/1/>1 behavior before it
constructs `StrongIdentityContext`.

## 5. Artifact binding and conflicts

The news release and Table 1 workbook are accepted together only when all
of these statements agree with the explicit Table 1 reference period:

- the news-release heading is exactly
  `CONSUMER PRICE INDEX - <UPPERCASE MONTH> <YEAR>`;
- the Table 1 title names the same month and year;
- the XLSX path ends in `news-release-table1-YYYYMM.xlsx` for that month;
- the unadjusted YoY column names the same month one year apart;
- the seasonally adjusted MoM column names the immediately preceding month
  and the current reference month.

Contradiction is `CONFLICT`. The adapter never chooses the nearest month,
uses the release date as the reference month, or repairs a mismatched file.

The archived release path is validated as an official CPI archive path but
does not participate in identity. Release rescheduling therefore does not
change release identity. The raw official public-release statement remains
audit evidence outside CES; EF-2 does not convert `ET` to an offset and does
not use the statement for consensus because no consensus source is present.

## 6. CES V2 mapping

The adapter emits exactly four metrics in deterministic `metric_code`
order:

| Metric | Official Table 1 row | Official column | CES unit |
|---|---|---|---|
| `CPI_CORE_MOM` | `All items less food and energy` | current seasonally adjusted one-month change | `PERCENT_CHANGE_MOM` |
| `CPI_CORE_YOY` | `All items less food and energy` | current unadjusted 12-month change | `PERCENT_CHANGE_YOY` |
| `CPI_HEADLINE_MOM` | `All items` | current seasonally adjusted one-month change | `PERCENT_CHANGE_MOM` |
| `CPI_HEADLINE_YOY` | `All items` | current unadjusted 12-month change | `PERCENT_CHANGE_YOY` |

Every metric uses the explicit Table 1 `MONTH` reference period. Numeric
cells must be finite and expressible at the BLS table's reviewed one-decimal
precision. CES values are canonical decimal strings; negative zero becomes
`"0"`. Higher precision, non-numeric cells, missing rows, or duplicate rows
are `MALFORMED`, never rounded or guessed.

The emitted CES V2 subject is deterministic:

```text
US Bureau of Labor Statistics releases <Month> <Year> Consumer Price Index
```

`detail` is `null`. No source URL, release ID, timestamp, or provenance is
copied into CES.

## 7. Consensus and prior periods

No consensus provider is authorized. All four metrics therefore emit:

```json
{ "state": "UNKNOWN", "value": null }
```

The adapter input has no consensus field. It cannot accept or accidentally
forward a forecast from another source.

Table 1 includes recent historical percentage-change columns, but it does
not provide the paired immediately-before and restated values required by
EF-0 `prior_periods[]`. EF-2 therefore emits `prior_periods: []` for all four
metrics. It never reconstructs a revision from later BLS API values or from
another release. BLS also warns that archived CPI supplemental data may be
revised in later editions, especially seasonal data; this is why the exact
month-specific artifact must be retained as evidence.

## 8. Corrections and reissues

BLS records reissued news releases and corrections in its errata/notices.
When BLS republishes or corrects the same release under the same official
`USDL` identifier, release identity remains unchanged. Changed official
Table 1 values produce changed CES facts and may later create a new
append-only Event Version; they do not create a new release identity.

A publication with a different `USDL` identifier is a different release
identity even if its timestamp, title, period, or values resemble another
release. EF-2 does not infer whether a correction with a new identifier is
the same event. Such a case fails outside this activated strategy pending
separate review.

## 9. Result states

| State | Meaning |
|---|---|
| `RESOLVED` | Exact source, identity, artifact binding, rows, and values pass |
| `UNAVAILABLE` | Required official evidence is explicitly absent/null |
| `MALFORMED` | Shape, grammar, row cardinality, or numeric precision is invalid |
| `CONFLICT` | Official release/table period evidence contradicts itself |
| `UNSUPPORTED` | Source tuple, family, or stage is outside this one contract |

No non-`RESOLVED` state emits partial CES facts or a fallback identity.

## 10. Determinism and security

For identical payload bytes the adapter emits deep-equal output. It has no
imports and reads no network, database, environment, clock, random source,
market data, price reaction, legacy score, Committee output, or LLM.

Credentials, auth headers, query secrets, collector timestamps, and private
tokens are absent from the input and output contracts. Future raw evidence
storage and parsing must remain service-role-only and must not place secrets
inside identity values or CES.

## 11. Reviewed fixtures

The deterministic fixtures are projections of official archived artifacts:

- August 2026: `USDL-26-1496`, release 2026-09-11, Table 1 file
  `news-release-table1-202608.xlsx`;
- July 2026: `USDL-26-1378`, release 2026-08-12, Table 1 file
  `news-release-table1-202607.xlsx`.

They prove consecutive releases have different identities, duplicate input
is byte-deterministic, same-release factual correction keeps identity,
artifact/title/period disagreement fails closed, and missing identity never
falls back to URL/title/period evidence.

## 12. Activation boundary

EF-2 is not activated. A later milestone must separately review and add:

1. official fetch and immutable raw-artifact retention;
2. deterministic XLSX/header parsing into this exact projection;
3. exact active identity-claim lookup with 0/1/>1 handling;
4. persistence/orchestration integration;
5. downstream CES V2 consumer readiness;
6. shadow/replay proof and explicit rollback;
7. coordinated CES V2 activation.

Adding a paid or recurring-cost consensus provider remains a Human Gate.
