# XAU V2 — Positioning evidence contract (P-0)

Status: `CONTRACT_CI_PROVEN — NO PROVIDER OR METHODOLOGY APPROVED`

## Purpose

P-0 defines the provider-independent evidence boundary that any future gold
positioning source must satisfy. It accepts retained, attributable metrics and
normalizes their order. It does not infer crowding, percentile, bullishness,
bearishness, regime, horizon, recommendation or trade.

Canonical implementation:
`backend/positioning_engine/evidence_contract.ts`.

Frozen versions:

- `xau.positioning-evidence.v2`;
- `positioning-evidence-normalizer-2.0.0`.

v1 / `1.0.0` declared valid evidence `EVIDENCE_READY` whatever its age: a
weekly report published on 30 September was still "ready" a year later. v2
(B5) closes that, see "Freshness" below.

## Evidence tuple

Every metric must carry its source authority, dataset, instrument, metric code,
finite value, unit, report period end, publication timestamp, system observation
timestamp, retained artifact identifier and explicit revision identifier/null.
The tuple is rejected if its shape is not exact, its timestamps are ambiguous,
its date is impossible, it is duplicated, or publication/observation occurs
after the supplied knowledge cutoff. Identity fields follow the P-1 schema
checks: an explicit revision matches `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$` and
the artifact identifier carries no surrounding whitespace, so P-0 accepts no
evidence that persistence would reject.

Supported units describe representation only: `CONTRACTS`, `PERCENT`, `RATIO`,
and `INDEX`. They do not confer semantic comparability between datasets.

Evidence is ordered field by field (identity, then publication, observation
and artifact strings) in UTF-16 code-unit order, never by locale collation, so
the envelope is identical whatever the host locale.

## Freshness (v2, B5)

No freshness policy (maximum age and the instant the age is measured from)
is approved for any positioning dataset, and none is defined here. Valid
evidence is therefore never declared ready: it is kept in `evidence`, listed,
and the envelope abstains with the blocking reason
`FRESHNESS_POLICY_NOT_APPROVED` (fail-closed). Invalid, future or absent
evidence keeps its own reasons; the freshness reason is added only when valid
evidence exists. `EVIDENCE_READY` stays in the state type for a later,
separately approved per-dataset policy (option 2 of the B5 decision), which
must state each threshold, its age reference and its approver.

Consequences in CHAIN-0: POSITIONING abstains, and Regime R-0 abstains on it
(`POSITIONING_EVIDENCE_ABSTAINED`, an existing reason). Everything stays
HOLD / FORBIDDEN. The golden dry-run digest changed from
`sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7`
(P-0 v1) to
`sha256:9bbd9cacdf16aff9fe886fb938b3cbf6202674d1ef4b3e34581f7b45eef2db3c`
(P-0 v2); only the POSITIONING and REGIME trace entries differ.

The terminal shows "fraîcheur non évaluée — aucun seuil approuvé" with the
publication age at the cutoff (a fact, not a judgement), and refuses a view
that declares positioning evidence ready.

Test: `tests/test_positioning_freshness_gate.mjs`.

## Deliberate abstention

In v1, valid evidence could be `EVIDENCE_READY`; in v2 it abstains until a
freshness policy is approved (above). In every version P-0 returns:

```text
positioningState=UNAVAILABLE
reason=METHODOLOGY_NOT_APPROVED
```

This separation prevents “data exists” from becoming “a positioning signal is
known.” A later methodology decision must define category mappings, revisions,
normalization window, percentile/crowding rules, instrument roll treatment,
missing-report behavior and backtest/validation evidence.

## Human Gate

Before any live collection or semantic activation, the owner must separately
approve the exact source, access path, terms/licensing, cost, retention policy,
release/revision semantics and directional methodology. CFTC, CME/COMEX, LBMA
and WGC remain candidates only; this contract does not assert access, approval,
coverage or suitability for any of them.

P-0 authorizes no provider call, account creation, purchase, secret, database
write, migration, deployment, schedule, broker connection or trading action.

P-1 now defines a separate provider-neutral append-only persistence and
complete-or-error historical read contract. It remains schema/code only until
proved and does not change P-0's deliberate `UNAVAILABLE` positioning state.

## CFTC COT offline adapter (candidate source, not approved)

`backend/positioning_engine/cftc_cot_offline_adapter.ts`
(`xau.positioning-cftc-cot-offline.v1` /
`cftc-cot-disaggregated-offline-adapter-1.2.0`) converts a CFTC
Commitments of Traders file **already on the operator's disk**
(Disaggregated, comma-separated text) into P-0 tuples. The CFTC publishes it
as Futures Only and as Futures-and-Options Combined with the same columns, so
the file cannot say which it is: the operator **declares** `dataset`
(`FUTURES_ONLY` → `cot_disaggregated_futures_only`,
`FUTURES_AND_OPTIONS_COMBINED` → `cot_disaggregated_futures_options_combined`);
none declared is `INVALID_REQUEST` (1.0.0 labelled every file futures-only). It is
pure: no network, clock, process or file access; the caller hashes the bytes.

- One report of one market per call (default COMEX gold, contract market
  code `088691`): a file holding several reports of that market needs the
  report date, because each report has its own publication instant
  (`MULTIPLE_REPORT_DATES` otherwise).
- 14 raw metrics in `CONTRACTS` (open interest; producer/merchant, swap
  dealer, managed money, other reportable long/short/spread; non-reportable
  long/short). Nothing is derived: no net position, ratio or percentile.
- Tuple: `sourceAuthority=cftc`, `datasetCode` from the declared dataset,
  `instrumentCode=CFTC:<code>`, `periodEnd` = report date, `publishedAt` and
  `observedAt` = the operator's declared publication and reception instants
  (never inferred from a schedule), `artifactId` = `sha256:` of the file,
  `revision=null` (revisions are not identified in the file).
- Fail-closed, whole file: missing or duplicate column, broken quoting, row
  width, report date impossible or disagreeing with its `YYMMDD` twin,
  duplicate row, non-integer or negative position, publication before the
  report date, reception before publication.
- Unknown formats are named (1.2.0): `UNSUPPORTED_FORMAT` for a ZIP archive,
  an Excel or other binary / UTF-16 / non-UTF-8 file, an HTML or JSON page, or
  another separator (semicolon, tab); `UNSUPPORTED_LAYOUT` for another CFTC
  report (legacy, Traders in Financial Futures, or a CFTC header of unknown
  type). Extra columns, as in the real files, are accepted.
- `sourceApproval` is always `NOT_APPROVED`. The column names follow the
  CFTC disaggregated text layout; they are **not verified against a retained
  real CFTC file** in this repository (the test fixture is synthetic and says
  so in its market names), so an unexpected header is rejected, not guessed.

The local terminal takes it with `--positioning-cot FILE --cot-dataset
futures-only|futures-and-options --cot-published-at ISO --cot-received-at ISO
[--cot-report-date YYYY-MM-DD]`, or from `--data-root DIR` where each file of
`DIR/positioning/` carries its declaration `<name>.declaration.json`
(`xau.cftc-cot-declaration.v1`), selectable in the page; see the terminal
view contract. P-0 keeps the tuples and abstains
(`FRESHNESS_POLICY_NOT_APPROVED`, `METHODOLOGY_NOT_APPROVED`); positioning
stays `UNAVAILABLE`; CHAIN-0 stays HOLD / FORBIDDEN. This changes nothing in
the Human Gate above.

Tests: `tests/test_cftc_cot_offline_adapter.mjs`,
`tests/test_terminal_positioning_cot.mjs`.
