# XAU V2 — US BEA PCE Source Contract

Status: **PURE ADAPTER — CI PROOF ONLY — NO RUNTIME ACTIVATION**

## 1. Scope

This contract introduces a deterministic, side-effect-free CES V2 adapter for
the U.S. Bureau of Economic Analysis Personal Income and Outlays release. It
adds no live fetcher, HTML parser, persistence, identity lookup, Worker route,
schedule, secret, deployment, production mutation, consensus value, economic
interpretation, Gold path or trading action.

The reviewed evidence consists of the official archived July and August 2026
BEA news-release pages. Each fixture records the exact downloaded HTML SHA-256
and a lossless structured projection of the release header and the four PCE
price-index facts explicitly stated in that release.

| Reference month | Official page | Release number | Downloaded HTML SHA-256 |
|---|---|---|---|
| July 2026 | `/news/2026/personal-income-and-outlays-july-2026` | `BEA 26–39` | `6dbc1950e4a7b06691c4cf7206623cd0231fd94d565fc6a0eaf954ddedec65ec` |
| August 2026 | `/news/2026/personal-income-and-outlays-august-2026` | `BEA 26–43` | `6c207be356d7a4a0023086bfed2c1ea3d6dc33c43be8496a39207d0fd2e2f329` |

## 2. Exact source tuple

| Field | Required value |
|---|---|
| Authority | `US_BEA` |
| Provider | `bea` |
| Source code | `bea_personal_income_outlays_release` |
| Source domain | `bea.gov` |
| Release family | `US_PCE` |
| Release stage | `SINGLE` |

Any mismatch is `UNSUPPORTED`. The adapter never substitutes an interactive
table, current API value, secondary source, market-data vendor or URL/date
proximity for this exact tuple.

## 3. Release identity

Strategy version: `bea_personal_income_outlays_v1`.

The exact BEA news-page release-number grammar is `BEA NN–NN`, using the en
dash published by BEA. The adapter maps that grammar to canonical ASCII
`BEA-NN-NN` only after validation. The identity proposal is:

- authority namespace: `xau_v2:official_release:us_bea:v1`;
- identity type: `official_release_id:bea_personal_income_outlays_v1`;
- authority: `us_bea`;
- family: `US_PCE`;
- stage: `SINGLE`;
- strategy: `OFFICIAL_RELEASE_ID`.

The two-digit release-number year must equal the publication year's final two
digits. Facts and artifact hashes cannot alter identity. A corrected page under
the same official release number retains identity and, if persistence is later
authorized, would produce an append-only Event Version.

## 4. Admitted facts

Only four price-index percentage changes explicitly stated on the official
release page are admitted:

| Metric code | Official series/basis | Unit |
|---|---|---|
| `PCE_HEADLINE_MOM` | PCE price index / preceding month | `PERCENT_CHANGE_MOM` |
| `PCE_HEADLINE_YOY` | PCE price index / same month one year ago | `PERCENT_CHANGE_YOY` |
| `PCE_CORE_MOM` | PCE price index excluding food and energy / preceding month | `PERCENT_CHANGE_MOM` |
| `PCE_CORE_YOY` | PCE price index excluding food and energy / same month one year ago | `PERCENT_CHANGE_YOY` |

The source values must be finite and exactly representable at one decimal
place. Canonical output removes redundant trailing zeroes and canonicalizes
negative zero to `0`. Metric order carries no meaning; output is sorted by
`metric_code`.

The reference period is the price-index month, not the publication date. Title
and archive slug must exactly encode that same month and year.

## 5. Revisions and annual update boundary

The August 2026 release is part of BEA's annual update and its comparison table
shows updated July values. The adapter deliberately emits no `prior_periods`:
the August release does not state, inside one self-contained metric projection,
both the previously published July value and the newly revised July value in
the exact CES V2 revision shape. Cross-release reconstruction is forbidden.

This preserves release-vintage truth: July facts come from the July page;
August facts come from the August page. Current interactive-table or API values
must not overwrite either fixture.

## 6. Consensus and semantics

No consensus source is authorized. Every metric emits `UNKNOWN` with a null
value. The adapter computes no surprise, direction, regime, Gold path,
confidence, recommendation or action.

## 7. Failure behavior

- missing release number or required official evidence: `UNAVAILABLE`;
- malformed shapes, hashes, periods, metric labels or values: `MALFORMED`;
- release/title/path/year contradictions: `CONFLICT`;
- source tuple, family or stage mismatch: `UNSUPPORTED`.

Every failure has a stable reason. There is no fallback.

## 8. Proof boundary

CI proves deterministic replay, no input mutation, exact identity, consecutive
release separation, fact/hash correction identity stability, canonical values,
order independence, negative cases and absence of network, database, clock,
environment, model, market or consensus dependencies.

CI does not prove live fetch, retained raw HTML bytes, HTML parsing,
persistence, runtime activation, consumer admission, deployment or positive
inference. Those remain separately reviewed work.
