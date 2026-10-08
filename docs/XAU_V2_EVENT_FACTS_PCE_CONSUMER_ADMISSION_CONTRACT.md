# XAU V2 — US PCE Conservative Consumer Admission

Status: **CI CONTRACT — ZERO POSITIVE INFERENCE**

## 1. Decision

Event Impact and Gold Transmission may validate the exact CES V2 `US_PCE`
state emitted by the reviewed BEA Personal Income and Outlays adapter.
Admission proves only that the typed official facts have the expected shape.
It does not authorize a surprise, economic direction, Gold direction,
transmission path, confidence, horizon, recommendation or action.

Processor versions are:

| Consumer | Version |
|---|---|
| Event Impact | `event-impact-deterministic-processor-v5` |
| Gold Transmission | `gold-transmission-deterministic-processor-v5` |

## 2. Exact admitted family

The canonical event must be a `STATISTICAL_RELEASE` with null detail, a
canonical non-blank subject, release family `US_PCE`, and exactly these four
unique metrics:

| Metric | Unit |
|---|---|
| `PCE_CORE_MOM` | `PERCENT_CHANGE_MOM` |
| `PCE_CORE_YOY` | `PERCENT_CHANGE_YOY` |
| `PCE_HEADLINE_MOM` | `PERCENT_CHANGE_MOM` |
| `PCE_HEADLINE_YOY` | `PERCENT_CHANGE_YOY` |

All four reference periods must be the same valid month. Metric order carries
no meaning.

## 3. Values, consensus and revisions

Every actual value must be a canonical decimal string produced from the
official one-decimal BEA release fact. Integers are canonical without a
trailing `.0`; non-integers have exactly one decimal place. Negative zero,
trailing zeroes and finer precision are rejected.

Every consensus is exactly `UNKNOWN` with a null value. Every
`prior_periods` array is empty. A known forecast or reconstructed revision is
rejected until separately authorized source and methodology contracts exist.

## 4. Conservative output

For exact valid input:

- Event Impact emits `PROCESS / INSUFFICIENT_EVIDENCE /
  GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE` with zero interpretations;
- Gold Transmission emits `PROCESS / INSUFFICIENT_EVIDENCE /
  CONSENSUS_FACTS_UNAVAILABLE` with zero paths.

Malformed periods, units, values, precision, consensus, priors, duplicates or
extra keys cause both processors to `ABSTAIN` with
`INVALID_CANONICAL_EVENT_STATE_V2`.

## 5. Exclusions

This lot adds no fetcher, HTML parser, artifact retention, producer, writer,
database migration, runtime route, schedule, deployment, provider, secret,
alert delivery or production mutation. It does not activate CES V2.

Any positive PCE-to-Gold method remains a Human Gate because it requires an
authorized consensus source, explicit semantic evidence, calibration and
review.
