# XAU V2 — OFFLINE release candidate qualification file (target 2026-10-30)

Status: `QUALIFICATION IN PROGRESS — NOT AN OFFLINE RC YET — NOT INSTITUTIONAL LIVE`

Current candidate: `adae6fa6d5782b3bb3548a27e5e5874925c7f85a` (PR #161, draft) —
GitHub Quality Gate 11/11 on this exact SHA (B2 / DoD 2 PASS). The candidate is
**not** accepted: human gates, B6 outside Chromium and the decisions listed
below stay open (2026-10-19).

Single reference for the RC OFFLINE decision defined in
`docs/XAU_V2_2026_10_30_WHOLE_SYSTEM_RC_PLAN.md`. Statuses are PASS (evidenced),
BLOCKED (evidence missing, with the reason) or OUT OF SCOPE (not an engineering
item of the offline RC). Nothing here authorizes a merge, deploy, migration,
provider call, broker connection or trade. HOLD / FORBIDDEN on every path;
REC-1 frozen.

## Commits

| Role | Ref | SHA | CI on this exact SHA |
|---|---|---|---|
| Base (PR #153) | `ci/quality-gate-terminal-offline` | `44b08b933052cfd89c4370569835c3853f12b608` | run `39070091763`, 11/11 |
| Consolidated candidate (PR #155, draft) | `recon/rc-b5-plus-154` | `58d63e454224acd449cb43c0a72c68a5ed675b1c` | **none** |
| CI copy (PR #156, draft) | `ci/rc155-quality-gate-validation` | `2f44903f4be7d23c2b02e0c3cd2e172fc9fdacd2` | run `39117320216`, 11/11 |
| Qualification branch (history) | `recon/rc-offline-qualification` | first commit `296f490`; superseded by the candidate below | none |
| **OFFLINE RC candidate (PR #161, draft → `verify/terminal-demo-offline`)** | `rc/offline-qualification-adae6fa` | `adae6fa6d5782b3bb3548a27e5e5874925c7f85a` | **run `39241376740`, 11/11** (`quality` + 10 PostgreSQL jobs), event `pull_request`, head SHA checked |

`2f44903` = `58d63e4` + one line (`workflow_dispatch:`) in
`.github/workflows/quality-gate.yml`: the application tree CI tested is
`58d63e4`'s, but that is evidence about a different SHA, not CI on `58d63e4`.
The qualification branch adds RECON-AUTO-1 (`296f490`, tooling only) and these
documents; it changes no backend, frontend, SQL or fixture.

## Definition of done (plan §"Definition of done")

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | DATA-4G and TV-3 integrated, delta reviewed against DATA-4F | PASS (engineering); human review of the delta pending | RC-0 `e1e7022` and DATA-4G `2fbed2b` are ancestors of `44b08b9`; the TV-3 receipt-only fingerprint (`981292b`/`fe5aa19`) is in `scripts/serve_terminal_local.mjs` and asserted by `test_terminal_local` |
| 2 | Typecheck, deterministic inventory and ephemeral PostgreSQL CI green on the same HEAD | **PASS on `adae6fa`** (run `39241376740`, 11/11, 2026-10-19); earlier: PASS for `2f44903`, none for `58d63e4` | see Commits; locally on `58d63e4`: typecheck clean, 144/144 (Node 22.23.3), PostgreSQL 17/17 last run locally on `44b08b9` (no SQL changed since) |
| 3 | RC-0 smoke: DATA-4E → 4F → 4G and, independently, CHAIN-0 → OBS-0 → terminal agree on no live authority | PASS | `tests/test_rc0_cross_system_contract.mjs` (RC-0 blocks, B1 official-fixture chain, B3 EIA-0 v2 block) |
| 4 | Terminal shows provenance, simulated/observed distinction, cutoff and 12 stages; invalid evidence and altered receipts give no actionable signal | PASS in Chromium 129; other browsers not checked | `test_terminal_local`, `test_terminal_view`, `test_terminal_input_provenance` (B4), `test_positioning_freshness_gate` (B5), `test_unified_receipt_gate`, layout check 30/30 at 320–1440 px |
| 5 | Absent actual evidence stays PENDING / UNVERIFIED; no supplier request, migration, broker or order | PASS | replay `INCOMPLETE` on real captures, `CAPTURED_ARCHIVE` labelled "non certifiée", P-0 never ready, CHAIN mutation sweep 2,762 inputs always HOLD/FORBIDDEN, no network in tests |
| 6 | `main` unchanged, no PR merged, no deploy | PASS | `main` = `ec9cde542d6b51b68391462ee8fa474e650b389f` locally and on GitHub (2026-10-19); PRs #159, #160, #161 draft and open, nothing merged |
| — | Published handoff and residual risk register | PASS on this branch (not published) | `docs/XAU_V2_NIGHT_HANDOFF.md` (rows 34–40), this file |

## E2E blockers from the offline qualification of `44b08b9`

| ID | Item | Status | Where |
|---|---|---|---|
| B1 | Repository E2E test, official artifact → terminal at one cutoff | DONE | `c6bb706` |
| B2 | Frozen RC SHA with CI on it | **PASS** on `adae6fa6d578…` — run `39241376740`, 11/11 | DoD 2; the SHA was designated by the user for publication (PR #161) |
| B3 | Event version known before its official release | DONE in EIA-0 v2 and at event-version construction; v1, EI/GT v5 and the CPI planner unchanged by decision | `ad747b1`, `390c26c` |
| B4 | Terminal attributes fixture inputs to the archive | DONE | `b695b78` |
| B5 | Positioning ready whatever its age | DONE fail-closed (no policy approved); option 2 (thresholds) needs approval | `6a0eb53` |
| B6 | Browsers | Chromium 129: **PASS** on `adae6fa` (walk 23/23, layout 40/40); Firefox, Edge, Brave, Safari and the Windows `.cmd`: **NOT TESTED** (not available here) | see Terminal OFFLINE below |
| B7 | DATA-4 receipts never establish DATA-1 coverage | OUT OF SCOPE (needs authorized collection) | — |

## Evidence summary

- Golden CHAIN-0 digest: `sha256:9bbd9cacdf16aff9fe886fb938b3cbf6202674d1ef4b3e34581f7b45eef2db3c`
  (P-0 v2; previously `sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7`
  with P-0 v1; only the POSITIONING and REGIME trace entries differ).
- OBS-0 receipt `STRUCTURALLY_VALID_HOLD_UNVERIFIED`; terminal fingerprint only from an accepted receipt.
- Contract versions on the candidate: P-0 `xau.positioning-evidence.v2` / `positioning-evidence-normalizer-2.0.0`;
  terminal `xau.terminal-local-view.v4` / `terminal-local-view-4.8.0`, health `xau.terminal-local-health.v2`; EIA-0 v1
  `event-plan-aggregation-gate-1.0.0` and v2 `event-plan-aggregation-release-gate-2.0.0`;
  `official-release-instant-us-eastern-1.0.0`; CHAIN-0 `decision-chain-dry-run-1.0.0`. Registry test PASS.
- Real DATA-3 captures (local, never committed): 115/115 read-only, source sha256 unchanged,
  merged archive byte-identical across runs; status `INCOMPLETE`, coverage not declared.
- Reconciliation: RECON-AUTO-1 dry runs of PR #153 + B1–B5 + PR #154 gave the same head
  `58d63e4…` and `resultDigest` three times; the RC tracking plan
  (`docs/recon/plan-rc-offline.json`) passes with no drift.

## Terminal OFFLINE (`adae6fa`, checked 2026-10-19 from the `xau-terminal` checkout the Windows launcher opens)

| Requirement | Status | Evidence |
|---|---|---|
| Starts from the candidate checkout, one command | PASS (WSL) | `npm run terminal` / `sh scripts/terminal/xau-terminal.sh`; `test_terminal_offline_finalisation` |
| Windows double-click launcher | NOT_TESTED on Windows (no Windows host or WSL interop here: no `cmd.exe`, `wsl.exe`, `/mnt/c`); static checks PASS; the WSL side it calls (`xau-terminal.sh --local-data`) PASS | `scripts/terminal/xau-terminal.cmd` |
| The running code is named; a server on other code is never reused | PASS | health `code`, footer `CODE adae6fa (terminal/current)`, launcher lines; `test_terminal_offline_finalisation` |
| Node found without a pinned version path | PASS | PATH, else newest nvm version; test with isolated PATH |
| No second instance from the same checkout | PASS | health endpoint + launcher reuse |
| Browser opened only after the view answers over HTTP | PASS | test records that the view answered when the browser was called |
| Busy port, clean stop, readable failures | PASS | fallback port followed; Ctrl+C / `--stop` release the port; EADDRINUSE / missing dependencies / bad option diagnosed |
| 12 simulation scenarios selectable, HOLD / FORBIDDEN, no positive output | PASS (Chromium 129) | real-browser walk 23/23, no console or HTTP error |
| Demo never shows a gold impact | PASS (fixed) | MARCHÉ matrix showed « Pression », « Soutien »… from random demo moves; now « N/A — DÉMO » |
| Empty or redundant displays | PASS (fixed) | rejected input explains POURQUOI HOLD; no freshness legend without fields; macro note is a general principle |
| Layout 320–1440 px | PASS (Chromium 129) | `check_terminal_layout.mjs` 40/40 on `adae6fa`; footer with real data 36/36 |
| Local authentic data in the browser (B6 walk) | PASS (Chromium 129) | 23/23: launcher, health code, API refusals (unknown id 404, path 400, bad cutoff 400, cutoff without archive 400), HOLD / FORBIDDEN on every page, DONNÉES RÉELLES, provenance per input, cutoffs aligned, 6 official releases, CFTC raw values, replay cutoff, unknown source in the URL, no console error, `--stop` |
| Firefox | NOT_TESTED | not installed here; installing it was not authorized |
| Edge, Brave, Chrome on Windows | NOT_TESTED here | no Windows host |
| Safari | NOT_TESTED (impossible) | no Safari for Windows or Linux |
| Windows browser actually opening `localhost:4173` through WSL | NOT_TESTED here | the user reports Brave on `localhost:4173` works from WSL |

## Human gates (not engineering items; none is closed)

REC-1 recovery; FRED / Twelve Data licence, quota and retention; DXY, bid/ask and
consensus sources; continuous retained captures and real revisions; approved
methodologies (regime, horizons, committee, pre-PM, PM, final risk); positioning
freshness policy per dataset (B5 option 2); production schema migrations; deploy;
broker and trading.

## Residual risks

- Resolved 2026-10-19: the candidate `adae6fa` has its own CI run (11/11). GitHub warns that
  `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19: a later run may differ.
- Non-market chain inputs are the synthetic golden fixture; real market data is a
  local, incomplete replay; nothing reaches a positive decision.
- EIA-0 v2 and the release-instant check are not wired into any runtime.
- `CAPTURED_ARCHIVE` relies on the operator's declaration.
- The #154 patch exists under two SHAs (`709227…` on PR #154, `58d63e4` here).
- Branches `recon/rc-b5-plus-154`, `ci/rc155-quality-gate-validation`, `feat/data-to-terminal`
  and `rc/offline-qualification-adae6fa` are public; B1–B5 branches are local only.
- PR #160 (agent naming) renames `docs/XAU_V2_NIGHT_HANDOFF.md`, which #161 extends: the PR
  landed second needs a trivial rebase.

## Local commits after the published candidate (not CI-qualified)

Last SHA qualified on GitHub: `0fd973dd72719e6571a2960666b4f982060d3373` (PR #161 head,
run `39247558521`, 11/11; `adae6fa` + this file). The commits below are local only. Publishing
them needs an authorization; their evidence is local until then.

| Commit | Change | Local evidence |
|---|---|---|
| `fa467ed` | Replay cutoffs reach the instant a CFTC report becomes known (`knownAt`) | `test_terminal_data_catalog` (3 mutants killed); Chromium on the real data: 6th instant 2026-10-18T21:44:42.077Z, 14 CFTC values known, HOLD |
| `12bdca1` | `terminal:check-data` prints reception and « connu à partir de » | `test_terminal_data_check` |
| `77413ab` | Audit of the inferred CFTC instants; P-FRESH / P-METHOD review aid (docs) | — |
| `4e72d17` | The server's own CFTC positioning (`--positioning-cot`) also offers its knowledge instant; anchor on it restored | `test_terminal_data_catalog` (the old code fails it) |
| `5e39d07` | A capture directory without `archive.json` is named (`CAPTURE_LOG_WITHOUT_ARCHIVE`), never dropped silently | `test_terminal_data_check`, `test_terminal_data_catalog`; damaged copies of the real captures: edited raw body, reception before observation and truncated JSON refused with their reason; a duplicated log merges to the same 39 records |
| `cd896f3` | Test: an inferred CFTC date is never labelled as official | mutant killed |
| `3474d5b` | Local publication evidence of the 2026-10-13 report (docs) | `Last-Modified` 2026-10-16 19:28:01 GMT; ZIP entry dated the day before |
| `cb22aad` | The data panel no longer makes the page scroll sideways on phones; layout check also fails on page width, checks the panel as it opens | `check_terminal_layout` 45/45 (16 failures before the CSS fix); 34 real-data states at 390 px clean |
| `0a879a8` | `terminal:check-data` names the market fields each source never holds | real captures: bid, ask, dxy absent |
| `0401518` | Test: releases after the cutoff shown « PAS ENCORE PUBLIÉE », excluded | mutant killed |
| `9561d8f` | A CFTC report set aside at the cutoff says from when it is known | page test; real data: « connue à partir du 2026-10-18 21:44:42.077Z » |

## Capability matrix (candidate `adae6fa`, 2026-10-19)

VERIFIED = shown by evidence on this SHA; BLOCKED = needs a decision or data that is not
authorized; NOT TESTED = no environment here. VERIFIED never means approved for decisions:
every path stays HOLD / FORBIDDEN.

| Capability | Status | Evidence / reason |
|---|---|---|
| CI on the exact candidate SHA | VERIFIED | run `39241376740`, 11/11 |
| Local full suite, typecheck, inventory | VERIFIED | 158/158 locally on `adae6fa`; CI `quality` job |
| PostgreSQL contracts (10 CI jobs) | VERIFIED | same run |
| CHAIN-0 HOLD / FORBIDDEN, golden digest | VERIFIED | `test_decision_chain_dry_run` in CI; every terminal page HOLD in the B6 walk |
| WSL launch, reuse, stop, code shown | VERIFIED | B6 walk L1–L3; `test_terminal_offline_finalisation` |
| Windows `.cmd` double-click | NOT TESTED | no Windows host here; static checks only |
| Terminal in Chromium 129 (layout, data, errors) | VERIFIED | layout 40/40, walk 23/23, no console error |
| Terminal in Firefox / Edge / Brave / Safari | NOT TESTED | not available here |
| Authentic CFTC file → P-0 → terminal | VERIFIED (read only) | 14/14 values equal to the 2026-10-13 gold row of the file (independent CSV read); report published after the default cutoff is shown « APRÈS LE CUTOFF : écartée »; 41 reports in the file |
| CFTC publication instant | BLOCKED | `2026-10-16T19:30Z` is the operator's declaration (no `publicationBasis`); 38 dates inferred; source approval pending |
| Positioning method / freshness | BLOCKED | P-FRESH-CFTC-1, P-METHOD-CFTC-1 not approved: signal UNAVAILABLE |
| Official releases → EI / GT at the chain cutoff | VERIFIED | 6/7 read; each `publishedAt` equals its document's release line (8:30 a.m. EDT = 12:30Z); at 2026-09-20 two later releases are « pas encore publiées »; Event Impact / Gold Transmission INSUFFICIENT_EVIDENCE |
| BLS Employment Situation July 2026 | VERIFIED (rejected on purpose) | `averageHourlyEarningsMom` absent from the document: REQUIRED_OFFICIAL_EVIDENCE_UNAVAILABLE, no value made up |
| Authentic CFTC values reachable at their knowledge instant | VERIFIED locally (not CI) | `fa467ed`: the replay offers 2026-10-18T21:44:42.077Z; at that cutoff P-0 keeps the 14 values, 1 ms before it flags them |
| Damaged local data fails closed with a reason | VERIFIED locally (not CI) | copies outside Git: edited raw body, chronology, truncated JSON, missing `archive.json` (now named), duplicated log; CFTC declarations published after reception, report absent, published before the report date: all refused with their reason |
| Terminal at phone width with every real-data selection | VERIFIED locally (not CI) | 34 states at 390 px: HOLD, no console error, no sideways scroll; layout check 45/45 |
| Local captures: no API key stored, raw bodies private | VERIFIED (2026-10-19) | no `api_key` / `apikey` / `token=` in `~/.local/share/xau-v2`; capture directories 700, raw bodies 600; DATA-3 validator 115/115 (payload digests, values re-read from bytes) |
| Real market replay (local captures) | BLOCKED | 39 records readable, `publishedAt` absent everywhere, coverage not declared: INCOMPLETE; DATA-3 capture decisions, DXY / bid-ask sources |
| Provenance labels and cutoff alignment | VERIFIED | MARKET CAPTURED_ARCHIVE, POSITIONING / EVENTS LOCAL_INPUT_UNVERIFIED, AUTHORIZATIONS SYNTHETIC_FIXTURE; cutoffs aligned at every offered replay instant |
| Merge, deploy, production, trading | OUT OF SCOPE | not authorized |

## Next actions

1. Done 2026-10-19: `adae6fa` designated and published (PR #161), Quality Gate 11/11 (B2).
2. Operator: Windows `.cmd` double-click, then Firefox / Edge / Brave on `localhost:4173`
   (B6 outside Chromium), recorded here.
3. Engineering, once 1 is decided: rerun `scripts/recon_auto.mjs --plan
   docs/recon/plan-rc-offline.json --verify inventory,typecheck,full` on the
   designated SHA and record the report digest here.
4. 28–30 Oct: operator walkthrough and sign-off of the residual blockers.
