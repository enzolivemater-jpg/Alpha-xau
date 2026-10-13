# XAU V2 — decision-chain dry run (CHAIN-0)

Status: `CONTRACT_CI_PROVEN — DRY RUN ONLY`

CHAIN-0 composes the twelve frozen gates into one deterministic run at a
single explicit knowledge cutoff. Each stage receives the exact envelope
produced by the previous stage; no hand-written upstream object crosses a
boundary.

Frozen versions:

- `xau.decision-chain-dry-run.v1`;
- `decision-chain-dry-run-1.0.0`.

| Order | Stage | Upstream |
| --- | --- | --- |
| 1 | Market Pricing MP-0 | market snapshot |
| 2 | Positioning P-0 | retained evidence |
| 3 | Regime R-0 | MP-0, P-0 |
| 4 | H1–H5 S-0 | Event Impact and Gold Transmission summaries, MP-0, P-0, R-0 |
| 5 | AI Committee C-0 | S-0 |
| 6 | Pre-PM PMR-0 | C-0, evidence graph |
| 7 | Portfolio Manager PM-0 | PMR-0 |
| 8 | Final Action Risk FAR-0 | PM-0 |
| 9 | Action A-0 | FAR-0 |
| 10 | Command Center CC-0 | A-0, runtime evidence |
| 11 | Alerts AL-0 | CC-0 |
| 12 | Acceptance E2E-0 | AL-0, evidence manifest |

The result is always `chainState=HOLD` and `execution=FORBIDDEN`. It carries
a per-stage trace (identity, state, reason codes, cutoff) that explains which
gate blocks progress, and every stage envelope in full.

## Explicit inputs

Every authorization (provider, cost, portfolio policy, risk policy,
execution, alert policy, delivery), policy version, broker state, runtime
correlation/deployment identifier and acceptance evidence flag is a required
input. CHAIN-0 never defaults one. Setting all of them to authorized still
yields `HOLD`, because every positive method remains unapproved.

The frozen gates treat any non-null string as a present identifier, so an
empty correlation ID would silently clear `RUNTIME_CORRELATION_UNAVAILABLE`.
CHAIN-0 closes this at its boundary: `evidenceGraph.schemaVersion`,
`brokerConstraintsVersion`, `recipientPolicyVersion`,
`runtimeEvidence.correlationId` and `runtimeEvidence.deploymentId` must match
`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`; any other value is replaced by `null`
before it reaches a gate and recorded in `inputFindings` as
`INVALID_IDENTIFIER_NULLIFIED`. The replacement can only make the chain more
restrictive. Fixing the gates themselves requires new gate versions and is a
separate, reviewed change.

Market freshness is re-derived at the knowledge cutoff, not trusted from the
caller. For each market value, CHAIN-0 computes its age at the cutoff and
classifies it with the existing `SYMBOL_RULES` / `classifyFreshness` policy
(no new threshold). A field declared fresher than that classification is
downgraded to `STALE` (`MARKET_FIELD_STALE_AT_CUTOFF`) or to `UNAVAILABLE`
with its value removed (`MARKET_FIELD_EXPIRED_AT_CUTOFF`). A value without an
approved rule (DXY) is made `UNAVAILABLE`
(`MARKET_FIELD_FRESHNESS_RULE_UNAVAILABLE`). Freshness is never upgraded, and
look-ahead observations are left to MP-0, which abstains on them. A value
outside the ingestion plausibility range of `SYMBOL_RULES` is made
`UNAVAILABLE` (`MARKET_FIELD_OUT_OF_RANGE`).

## Untrusted input

`evaluateDecisionChain(input, knowledgeCutoff)` never throws. It first checks
the input structure with exact keys: a missing or misspelled key, a wrong
type or an unknown enum value (for example `execution: "yes"`) is reported as
`MISSING`, `UNKNOWN_KEY`, `INVALID_TYPE` or `INVALID_VALUE` with its path,
instead of being read as absent. A stage that throws on structurally valid
input is reported with its stage name. Both cases return
`kind=REJECTED`, `chainState=HOLD`, `execution=FORBIDDEN`.
`runDecisionChainDryRun` keeps its typed contract and throws
`DecisionChainStageError` (tagged with the stage) on failure.

## Consistency controls

`verifyDecisionChainIntegrity` re-checks a result, including one reloaded
from a log, and reports `integrity=VIOLATED` with stage-scoped codes when:

- the result is structurally malformed (`MALFORMED_RESULT`; reported, never
  thrown);
- the chain envelope is not the frozen `DRY_RUN`/`HOLD`/`FORBIDDEN` identity
  (`CHAIN_ENVELOPE_MISMATCH`);
- a stage is missing (`STAGE_SET_MISMATCH`);
- a stage identity differs from the frozen version (`STAGE_VERSION_MISMATCH`);
- a stage cutoff differs from the chain cutoff (`STAGE_CUTOFF_MISMATCH`);
- a stage reports a state no unapproved method can reach
  (`STAGE_STATE_FORBIDDEN`);
- a field reserved for an approved positive method is populated —
  positioning signal, regime, anything other than the exact ordered H1–H5
  abstention set, scenario probability/target, provider request/response,
  evidence acceptance, PM input, a cleared advisory-only flag, allocation,
  size, stop, verdict, order, trade ticket, live observability, recipient,
  channel, payload or acceptance run (`POSITIVE_OUTPUT_FORBIDDEN`);
- the trace does not match the stage envelopes (`TRACE_STAGE_MISMATCH`);
- the Command Center lineage or propagated action reasons differ
  (`LINEAGE_MISMATCH`, `ACTION_REASONS_NOT_PROPAGATED`);
- the alert dedupe key does not match the projection
  (`ALERT_DEDUPE_KEY_MISMATCH`).

`computeDecisionChainDigest` returns a SHA-256 of the canonical JSON of the
result (sorted keys; non-finite numbers, `undefined` and non-plain objects
rejected). Equal inputs and cutoff give the same digest. The digest is a
replay identity, not a runtime correlation ID; correlation and deployment IDs
are never derived from it.

## Open design decision

Event Impact and Gold Transmission processors emit one plan per event
version, each with its own cutoff. CHAIN-0 accepts a chain-level summary
(`algorithmVersion`, `status`, `knowledgeCutoff`) and lets S-0 reject version
or cutoff drift. The rule that aggregates per-event plans into that summary
at a chain cutoff is not defined here and requires review.

## Scope

CHAIN-0 is a pure function. It reads no clock, network, database, provider,
broker or random source. It authorizes no persistence, migration, runtime
wiring, deployment, provider call, alert delivery, broker connection, order
construction or trading.

## Golden replay

`tests/fixtures/decision_chain_dry_run_baseline.json` freezes the current
honest input (nothing authorized, no runtime identity), the expected trace
and the expected digest. Any change to any gate's output, ordering or
identity fails CI until the fixture is regenerated in a reviewed change.

## Local simulation

```sh
node scripts/run_decision_chain_dry_run.mjs [input.json]
```

Runs the chain on `{ knowledgeCutoff, input }` (the golden fixture by
default) and prints the trace, integrity verdict, input findings and digest.
Exit code `0` consistent, `2` integrity violated, `1` usage or input error.
It reads only the given file and writes only a temporary transpilation
directory that it removes.
