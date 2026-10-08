# XAU V2 — US Jobless Claims Conservative Consumer Admission

Status: **CI CONTRACT — ZERO POSITIVE INFERENCE**

## 1. Decision

Event Impact and Gold Transmission may validate the exact CES V2
US_JOBLESS_CLAIMS state emitted by the reviewed DOL weekly UI claims adapter.
Admission only proves that typed facts are structurally usable. It does not
authorize a surprise, economic direction, Gold direction, transmission path,
confidence, horizon, recommendation or action.

Processor versions are:

| Consumer | Version |
|---|---|
| Event Impact | event-impact-deterministic-processor-v5 |
| Gold Transmission | gold-transmission-deterministic-processor-v5 |

## 2. Exact admitted family

The canonical event must be a STATISTICAL_RELEASE with null detail, a
canonical non-blank subject, release family US_JOBLESS_CLAIMS, and exactly
these unique metrics:

| Metric | Unit | Period rule |
|---|---|---|
| INITIAL_CLAIMS | THOUSANDS_OF_PERSONS | valid Saturday |
| CONTINUING_CLAIMS | THOUSANDS_OF_PERSONS | exactly seven days before initial claims |
| CLAIMS_4WK_AVERAGE | THOUSANDS_OF_PERSONS | same anchor Saturday as initial claims |

Metric order carries no meaning.

## 3. Values and revisions

Every actual, prior and revised value must be:

- a canonical non-negative decimal string;
- never negative zero;
- expressed in thousands of persons;
- no more precise than three decimal places.

Each metric has exactly one prior-period entry. Its period is the immediately
preceding Saturday, exactly seven days before that metric's current period.
Both the prior and revised values must satisfy the same value grammar.

Every consensus is exactly UNKNOWN with a null value. A known forecast is
rejected until a separately authorized consensus contract exists.

## 4. Conservative output

For exact valid input:

- Event Impact emits PROCESS / INSUFFICIENT_EVIDENCE /
  GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE with zero interpretations;
- Gold Transmission emits PROCESS / INSUFFICIENT_EVIDENCE /
  CONSENSUS_FACTS_UNAVAILABLE with zero paths.

Malformed dates, week relationships, units, values, precision, revisions,
duplicates, extra keys or consensus cause both processors to ABSTAIN with
INVALID_CANONICAL_EVENT_STATE_V2.

## 5. Exclusions

This lot adds no fetcher, PDF parser, artifact retention, producer, writer,
database migration, runtime route, schedule, deployment, provider, secret,
alert delivery or production mutation. It does not activate CES V2.

Any positive jobless-claims-to-Gold method remains a Human Gate because it
requires explicit semantic evidence, calibration and review.
