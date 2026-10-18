# XAU V2 — OFFLINE release candidate qualification file (target 2026-10-30)

Status: `QUALIFICATION IN PROGRESS — NOT AN OFFLINE RC YET — NOT INSTITUTIONAL LIVE`

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
| Qualification branch (local, unpushed) | `recon/rc-offline-qualification` | head of that branch; first commit `296f490` | none |

`2f44903` = `58d63e4` + one line (`workflow_dispatch:`) in
`.github/workflows/quality-gate.yml`: the application tree CI tested is
`58d63e4`'s, but that is evidence about a different SHA, not CI on `58d63e4`.
The qualification branch adds RECON-AUTO-1 (`296f490`, tooling only) and these
documents; it changes no backend, frontend, SQL or fixture.

## Definition of done (plan §"Definition of done")

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | DATA-4G and TV-3 integrated, delta reviewed against DATA-4F | PASS (engineering); human review of the delta pending | RC-0 `e1e7022` and DATA-4G `2fbed2b` are ancestors of `44b08b9`; the TV-3 receipt-only fingerprint (`981292b`/`fe5aa19`) is in `scripts/serve_terminal_local.mjs` and asserted by `test_terminal_local` |
| 2 | Typecheck, deterministic inventory and ephemeral PostgreSQL CI green on the same HEAD | **BLOCKED** for `58d63e4` and any later SHA; PASS for `2f44903` | see Commits; locally on `58d63e4`: typecheck clean, 144/144 (Node 22.23.3), PostgreSQL 17/17 last run locally on `44b08b9` (no SQL changed since) |
| 3 | RC-0 smoke: DATA-4E → 4F → 4G and, independently, CHAIN-0 → OBS-0 → terminal agree on no live authority | PASS | `tests/test_rc0_cross_system_contract.mjs` (RC-0 blocks, B1 official-fixture chain, B3 EIA-0 v2 block) |
| 4 | Terminal shows provenance, simulated/observed distinction, cutoff and 12 stages; invalid evidence and altered receipts give no actionable signal | PASS in Chromium 129; other browsers not checked | `test_terminal_local`, `test_terminal_view`, `test_terminal_input_provenance` (B4), `test_positioning_freshness_gate` (B5), `test_unified_receipt_gate`, layout check 30/30 at 320–1440 px |
| 5 | Absent actual evidence stays PENDING / UNVERIFIED; no supplier request, migration, broker or order | PASS | replay `INCOMPLETE` on real captures, `CAPTURED_ARCHIVE` labelled "non certifiée", P-0 never ready, CHAIN mutation sweep 2,762 inputs always HOLD/FORBIDDEN, no network in tests |
| 6 | `main` unchanged, no PR merged, no deploy | PASS | `main` = `ec9cde542d6b51b68391462ee8fa474e650b389f` locally and on GitHub; PRs #155/#156 draft and open |
| — | Published handoff and residual risk register | PASS on this branch (not published) | `docs/XAU_V2_NIGHT_HANDOFF.md` (rows 34–40), this file |

## E2E blockers from the offline qualification of `44b08b9`

| ID | Item | Status | Where |
|---|---|---|---|
| B1 | Repository E2E test, official artifact → terminal at one cutoff | DONE | `c6bb706` |
| B2 | Frozen RC SHA with CI on it | **OPEN** — human designation | DoD 2 |
| B3 | Event version known before its official release | DONE in EIA-0 v2 and at event-version construction; v1, EI/GT v5 and the CPI planner unchanged by decision | `ad747b1`, `390c26c` |
| B4 | Terminal attributes fixture inputs to the archive | DONE | `b695b78` |
| B5 | Positioning ready whatever its age | DONE fail-closed (no policy approved); option 2 (thresholds) needs approval | `6a0eb53` |
| B6 | Browsers other than Chromium | **OPEN** — manual operator check | — |
| B7 | DATA-4 receipts never establish DATA-1 coverage | OUT OF SCOPE (needs authorized collection) | — |

## Evidence summary

- Golden CHAIN-0 digest: `sha256:9bbd9cacdf16aff9fe886fb938b3cbf6202674d1ef4b3e34581f7b45eef2db3c`
  (P-0 v2; previously `sha256:b39bad106bee8ccd0cc4269ee0fcd29ee1d5dd4f6f99637718c4dea22ec7a6f7`
  with P-0 v1; only the POSITIONING and REGIME trace entries differ).
- OBS-0 receipt `STRUCTURALLY_VALID_HOLD_UNVERIFIED`; terminal fingerprint only from an accepted receipt.
- Contract versions on the candidate: P-0 `xau.positioning-evidence.v2` / `positioning-evidence-normalizer-2.0.0`;
  terminal `xau.terminal-local-view.v4` / `terminal-local-view-4.6.0`; EIA-0 v1
  `event-plan-aggregation-gate-1.0.0` and v2 `event-plan-aggregation-release-gate-2.0.0`;
  `official-release-instant-us-eastern-1.0.0`; CHAIN-0 `decision-chain-dry-run-1.0.0`. Registry test PASS.
- Real DATA-3 captures (local, never committed): 115/115 read-only, source sha256 unchanged,
  merged archive byte-identical across runs; status `INCOMPLETE`, coverage not declared.
- Reconciliation: RECON-AUTO-1 dry runs of PR #153 + B1–B5 + PR #154 gave the same head
  `58d63e4…` and `resultDigest` three times; the RC tracking plan
  (`docs/recon/plan-rc-offline.json`) passes with no drift.

## Terminal OFFLINE (local, branch `recon/terminal-offline-final`)

| Requirement | Status | Evidence |
|---|---|---|
| Starts from the candidate checkout, one command | PASS (WSL) | `npm run terminal` / `sh scripts/terminal/xau-terminal.sh`; `test_terminal_offline_finalisation` |
| Windows double-click launcher | NOT_TESTED on Windows (no Windows host here); static checks PASS | `scripts/terminal/xau-terminal.cmd` |
| Node found without a pinned version path | PASS | PATH, else newest nvm version; test with isolated PATH |
| No second instance from the same checkout | PASS | health endpoint + launcher reuse |
| Browser opened only after the view answers over HTTP | PASS | test records that the view answered when the browser was called |
| Busy port, clean stop, readable failures | PASS | fallback port followed; Ctrl+C / `--stop` release the port; EADDRINUSE / missing dependencies / bad option diagnosed |
| 12 simulation scenarios selectable, HOLD / FORBIDDEN, no positive output | PASS (Chromium 129) | real-browser walk 23/23, no console or HTTP error |
| Demo never shows a gold impact | PASS (fixed) | MARCHÉ matrix showed « Pression », « Soutien »… from random demo moves; now « N/A — DÉMO » |
| Empty or redundant displays | PASS (fixed) | rejected input explains POURQUOI HOLD; no freshness legend without fields; macro note is a general principle |
| Layout 320–1440 px | PASS (Chromium 129) | `check_terminal_layout.mjs` 30/30 |
| Firefox | NOT_TESTED | not installed here |
| Safari | NOT_TESTED (impossible) | no Safari for Windows or Linux |
| Windows browser actually opening `localhost:4173` through WSL | NOT_TESTED here | the user reports Brave on `localhost:4173` works from WSL |

## Human gates (not engineering items; none is closed)

REC-1 recovery; FRED / Twelve Data licence, quota and retention; DXY, bid/ask and
consensus sources; continuous retained captures and real revisions; approved
methodologies (regime, horizons, committee, pre-PM, PM, final risk); positioning
freshness policy per dataset (B5 option 2); production schema migrations; deploy;
broker and trading.

## Residual risks

- The candidate SHA has no CI run; the CI copy differs by one workflow line.
- Non-market chain inputs are the synthetic golden fixture; real market data is a
  local, incomplete replay; nothing reaches a positive decision.
- EIA-0 v2 and the release-instant check are not wired into any runtime.
- `CAPTURED_ARCHIVE` relies on the operator's declaration.
- The #154 patch exists under two SHAs (`709227…` on PR #154, `58d63e4` here).
- Branches `recon/rc-b5-plus-154`, `ci/rc155-quality-gate-validation` are public;
  the qualification branch and B1–B5 branches are local only.

## Next actions

1. Human: designate the RC SHA (e.g. `58d63e4`, or this qualification branch's head)
   and obtain one Quality Gate run on that exact SHA (closes B2 / DoD 2).
2. Human: Firefox and Safari pass of the local terminal (B6), recorded here.
3. Engineering, once 1 is decided: rerun `scripts/recon_auto.mjs --plan
   docs/recon/plan-rc-offline.json --verify inventory,typecheck,full` on the
   designated SHA and record the report digest here.
4. 28–30 Oct: operator walkthrough and sign-off of the residual blockers.
