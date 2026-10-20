# XAU V2 — Consensus evidence contract (C-0)

Status: `LOCAL CONTRACT — NO SOURCE, PROVIDER OR METHODOLOGY APPROVED`

Canonical implementation: `backend/event_facts/consensus_evidence_contract.ts`.
Versions: `xau.consensus-evidence.v1` / `consensus-evidence-normalizer-1.0.0`.
Test: `tests/test_consensus_evidence_contract.mjs`.

## Why

Event Impact V2 and Gold Transmission V2 stop at `CONSENSUS_FACTS_UNAVAILABLE`:
every official metric carries `consensus: { state: 'UNKNOWN', value: null }`.
The completion board lists the consensus source as `NOT_STARTED` behind a
Human Gate (auditable source, licensing, timestamps, revisions). C-0 fixes,
before any source is chosen, what a consensus figure must prove. It changes
no consumer: consensus stays `UNKNOWN` everywhere.

## Figure (exact keys)

`sourceAuthority`, `datasetCode` (lower-case codes), `statistic` (`MEDIAN` or
`MEAN`, representation only), `releaseIdentityType` and
`releaseIdentityValue` (the official adapter's release identity),
`metricCode`, `referencePeriod` (`{kind: MONTH, year, month}` or
`{kind: WEEK_ENDING, date}`), `unit`, `value` (decimal text, as the official
`actual`), `publishedAt` and `observedAt` (explicit UTC instants, publication
not after retrieval), `artifactId` (`sha256:`), `revision` (or null).

## Checks against the RESOLVED official adapter result

A figure is kept only if it names the same release, a metric of that release
with the same reference period and unit, was **published strictly before the
official release instant** (`publishedAt` of the adapter, B3), and was
published and retrieved not after the knowledge cutoff. One figure per
source, dataset, statistic, metric, period and revision. Each refused figure
is listed with its index and reason (`INVALID_EVIDENCE_SHAPE`,
`RELEASE_IDENTITY_MISMATCH`, `METRIC_NOT_IN_RELEASE`,
`REFERENCE_PERIOD_MISMATCH`, `UNIT_MISMATCH`,
`CONSENSUS_NOT_BEFORE_RELEASE`, `EVIDENCE_AFTER_KNOWLEDGE_CUTOFF`,
`DUPLICATE_EVIDENCE_KEY`); a release that is not RESOLVED, an invalid cutoff
or no figure are envelope reasons.

## Always abstains

`evidenceState=ABSTAIN`, `consensusState=UNKNOWN`, and the reasons
`CONSENSUS_SOURCE_NOT_APPROVED` and `CONSENSUS_METHODOLOGY_NOT_APPROVED` on
every envelope. Per official metric: its consensus stays UNKNOWN and only the
count of valid figures is reported. No surprise (actual minus consensus),
direction or magnitude is computed. Activation needs, separately: an approved
source (licensing, cost, timestamps, revisions), a methodology choosing among
figures, and a reviewed consumer version that accepts a KNOWN consensus.

Pure: no clock, network, database or environment. The test checks it on the
repository's BLS CPI and DOL claims fixtures with invented figures whose
source names say so.
