# XAU V2 — US_NFP Conservative Consumer Admission

Status: `CI CONTRACT — NO SIGNAL / NO RUNTIME ACTIVATION`  
Baseline: PR #80 / `6c1a6c4e7497432633c1b57595c9407b0fd7798d`

## 1. Purpose

Event Impact and Gold Transmission may validate the exact CES V2 `US_NFP`
shape emitted by the reviewed BLS Employment Situation adapter. Admission only
distinguishes valid typed facts from malformed input. It does not authorize or
create a directional interpretation, transmission path, magnitude, confidence,
pricing state, alert, or trade.

The processor versions are advanced because their accepted input domain
changes:

| Processor | Version |
|---|---|
| Event Impact | `event-impact-deterministic-processor-v5` |
| Gold Transmission | `gold-transmission-deterministic-processor-v5` |

## 2. Exact admitted family

The canonical envelope must contain `STATISTICAL_RELEASE`, `detail: null`, a
canonical non-blank subject, `release_family: US_NFP`, and exactly these three
unique metrics:

| Metric | Unit | Actual precision | Prior periods |
|---|---|---|---|
| `AVG_HOURLY_EARNINGS_MOM` | `PERCENT_CHANGE_MOM` | canonical decimal, at most one decimal place | `[]` |
| `NFP_PAYROLL_CHANGE` | `THOUSANDS_OF_PERSONS` | canonical integer | exactly the two immediately preceding months |
| `UNEMPLOYMENT_RATE` | `LEVEL_PERCENT` | canonical decimal, at most one decimal place | `[]` |

All current metrics must use the same valid `MONTH` period. Payroll revision
array order carries no meaning. Each of its two entries must have exact keys,
an integer `prior_value`, an integer `revised_value`, and one of the two
immediately preceding month identities. Duplicate, missing, current, future,
or non-consecutive revision periods are invalid.

Every actual is `KNOWN`. Every consensus remains exactly:

```json
{ "state": "UNKNOWN", "value": null }
```

No extra family, metric, unit, key, precision, consensus, or prior-period field
is accepted.

## 3. Conservative outputs

For exact valid NFP input:

- Event Impact returns `PROCESS / INSUFFICIENT_EVIDENCE` with
  `GOLD_TRANSMISSION_EVIDENCE_UNAVAILABLE` and `interpretations: []`;
- Gold Transmission returns `PROCESS / INSUFFICIENT_EVIDENCE` with
  `CONSENSUS_FACTS_UNAVAILABLE` and `paths: []`.

Metric order and payroll revision order do not change either result. Malformed
NFP input causes both processors to `ABSTAIN / INVALID_INPUT` with
`INVALID_CANONICAL_EVENT_STATE_V2` before persistence.

## 4. Unchanged gates

This contract does not change the CPI-only CES persistence validator and does
not add an NFP artifact parser, planner, writer, database migration, fetcher,
provider, Worker route, schedule, deployment, or production mutation. Horizon
synthesis follows the versioned EI/GT envelopes and continues to emit five
explicit abstentions because positive transmission evidence, consensus,
methodology, positioning, regime, and other required inputs remain unavailable.

Any positive NFP-to-gold rule requires a separately reviewed semantic method
and the applicable Human Gate. No numeric sign, payroll revision, unemployment
move, or earnings move is converted into a gold direction by this contract.
