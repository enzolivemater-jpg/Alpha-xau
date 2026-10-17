# XAU V2 — night handoff (offline RC remediation)

Branch `worktree-pr-149`, base `e1e70225a0e178bf2cbafcf19e1804200e818439`
(RC-0 PR #149, verified ancestor of HEAD). Nothing pushed, merged or deployed;
`main` untouched; no migration, secret, provider call, broker or order.

**Nothing here proves production readiness.** Green local tests show the
offline contracts behave as written; every human gate in
`XAU_V2_2026_10_30_WHOLE_SYSTEM_RC_PLAN.md` stays open.

## Baseline (before any change)

- `npm run typecheck`: clean.
- `npm test`: 115/115 test files passed at `e1e70225`.

## Commits (local only, never pushed), oldest first

| Change | Commit |
|---|---|
| 1 terminal Host guard | `f3e98ae` |
| 2 timestamp parity | `c96d34e` |
| 3 + 5 capture lock/fsync, `--out` guard | `7641c9a` |
| 4 RC-0 scenario parity test | `031c928` |
| handoff v1 | `3ec3d22` |
| 6 OBS-0 refuses an unhashable chain, CHAIN-0 mutation sweep | `0f3dadb` |
| 7 DATA-1 replay non-string cutoff/pin, archive mutation sweep | `c07f20b` |
| 8 DATA-4 audit echo, shared mutation helper, DATA-4 sweep | `d6fe8fc` |
| 9 BLS employment adapter `TypeError`, adapters sweep | `b86637b` |
| 10 EI/GT processors sweep | `57362a3` |
| 11 decision gates forged-upstream sweep | `d4c0844` |
| 12 DOL claims text parser borrowed another statement's figures | `6a9ed5b` |
| 13 BLS employment HTML parser, bounded check | `3120fc5` |
| 14 advisory UI / transport / evidence manifest sweep, manifest cutoff echo | `2cbaa92` |
| 15 provider parsers (FRED / Twelve Data) | `02c5038` |
| 16 MP-1 / MP-2 / P-0 / P-1 / validatePoint / capture hardening | `2031ac2` |
| 17 identity-key ambiguity and non-JSON state at the write boundary | `ba0b0f5` |
| 18 deterministic nesting bound (`canonicalJson`, CPI writer) | `19dd94d` |
| 19 terminal shows a fingerprint only if well-formed and chain CONSISTENT | `32821ee` |
| 20 empty archive pin disabled the pin; hostile `--input`/`--archive` files | `1f738ee` |
| 21 render isolation: guard-passing hostile views never half-drawn | `dd65100` |
| 22 ECB / Fed RSS: unclosed item took the next item's date and description | `5326ea3` |
| 23 BLS CPI workbook: a cell could borrow its neighbour's value; quadratic cost | `880f59a` |
| 24 V1 `cleanText` quadratic on unterminated tags | `4e132f4` |
| integration: cloud `84e5374` cherry-picked (branch `integration/pr-149-plus-cloud-canonical-json`) | `979d601`, handoff `8670c87` |
| 25 + 26 `Number()` read blank/non-decimal text as 0 (database read path, committee baseline) | see `git log` on the integration branch |

## Changes

| # | Domain | Defect (demonstrated) | Fix | Main files |
|---|---|---|---|---|
| 1 | Terminal / security | Loopback server served any `Host`: a rebound hostname could read the CHAIN-0 view | `403` unless `Host` is exactly `127.0.0.1:<port>` / `localhost:<port>`, including no Host | `scripts/serve_terminal_local.mjs`, `tests/test_terminal_local_host_guard.mjs` |
| 2 | Time / gates | `shared/strict_timestamp.ts` accepted year `0000`, `-00:00`, offsets to `±23:59`; TIME-0 rejects them | Same policy; 4480-string parity sweep (accept/reject and millisecond instant) | `backend/shared/strict_timestamp.ts`, `tests/test_strict_timestamp.mjs` |
| 3 | DATA capture | `market_evidence_capture.mjs` init/append: no lock (lost update), no fsync before rename | Exclusive `<log>.lock` (`O_EXCL`, fail fast, never auto-removed) + fsync; 6-process concurrency test | `scripts/market_evidence_capture.mjs` |
| 4 | Integration RC-0 | Cross-system smoke covered the golden fixture only | All 6 non-archive terminal scenarios through terminal and unified rehearsal: identical view, deterministic, HOLD/FORBIDDEN, no ticket. `everything-granted`: CHAIN-0 completes, OBS-0 refuses the receipt (`UNSAFE_OUTPUT_PRESENT`), no fingerprint (by design, now asserted) | `tests/test_rc0_cross_system_contract.mjs` |
| 5 | DATA tooling | `validate_evidence_captures.mjs` `--out` guard used a string prefix | Path-segment check | `scripts/validate_evidence_captures.mjs` |
| 6 | Observability | NaN/Infinity in `marketSnapshot` passes input validation, is echoed by the abstaining MP-0 gate; the result is not hashable and `buildOfflineAuditReceipt` (hence rehearsal and terminal) threw | Receipt is REJECTED with `STAGE_INTEGRITY_INVALID`, never throws | `backend/observability/offline_receipt.ts`, `tests/test_decision_chain_mutation.mjs` |
| 7 | DATA-1 | `replayMarketEvidence` threw on a NaN/Infinity cutoff or pinned digest (echoed into the hashed envelope) | Non-string cutoff = invalid cutoff; non-string pin never matches | `backend/market_engine/evidence_archive.ts`, `tests/test_market_evidence_mutation.mjs` |
| 8 | DATA-4A | `auditCaptureContinuity` echoed a non-string cutoff into an unhashable audit | Invalid cutoff with empty echo | `backend/market_engine/capture_continuity.ts`, `tests/test_capture_chain_mutation.mjs`, `tests/lib/mutation_cases.mjs` |
| 9 | Macro facts | `mapBlsEmploymentReleaseToEventFacts` threw `TypeError` when `summary.payroll` was `undefined` | Falls through to the `MALFORMED` shape check | `backend/event_facts/bls_employment_situation_adapter.ts`, `tests/test_event_facts_adapters_mutation.mjs` |
| 10 | Event Impact / Gold Transmission | none found | Sweep only: 17214 hostile event versions, no throw, no mutation, deterministic, zero interpretations / paths | `tests/test_event_consumers_mutation.mjs` |
| 11 | Decision gates | none found | Sweep only: ten gates called directly with forged upstream envelopes, authorizations, versions and cutoffs on the golden and everything-granted chains: no positive or forbidden-state output | `tests/test_decision_gates_forged_upstream.mjs` |

| 12 | Macro facts (DOL) | **Wrong facts accepted.** The lazy `.*?` gaps of the claims text parser could cross into the next paragraph: with the initial-claims "previous week's level was revised" sentence missing, initial claims silently got the continuing-claims revision (1,719,000 → 1,712,000) and the adapter resolved it. Same gaps cost ~7 s on a 900,000-character repeated prefix | Gaps bounded to 800 chars and unable to cross `In the week ending` / `The advance `; now fails closed (`MALFORMED`). Value integrity stays the manifest hash's job (documented) | `backend/event_facts/dol_ui_weekly_claims_text_parser.ts`, `tests/test_official_text_parser_mutation.mjs` |
| 13 | Macro facts (BLS) | none found | Bounded check only (14 cases). An exhaustive HTML sweep is **not run**: jsdom retains ~90 MB per parsed 1 MB page even after `window.close()` (measured with forced GC, raw JSDOM x4 = +370 MB). Operator script, not a service | `tests/test_official_html_parser_mutation.mjs` |
| 14 | Presentation | `buildEvidenceEligibilityManifest` echoed a non-string cutoff into an unhashable value. UI-0 / TR-0: none found (3086 writer round trips always non-actionable; 1765 mutated packets, 57 accepted, all canonical and safe) | Invalid cutoff with empty echo | `backend/observability/evidence_manifest.ts`, `tests/test_advisory_surface_mutation.mjs` |
| 15 | DATA providers | `parseFred` / `parseFredObservations` threw `TypeError` on a non-text `date`; `parseTwelveData` could return a year-275760 timestamp no strict gate accepts | Explicit unavailable points; available points always finite with strict timestamps | `backend/market_engine/providers.ts`, `tests/test_provider_parsers_mutation.mjs` |
| 16 | DATA / positioning | MP-2 and P-1 RPC normalizers: `TypeError` on a non-array result; text NUMERIC read with `Number()` (`"0x10"` → 16); `RegExp.test()` coerced `undefined`/arrays into valid text in **P-0 and P-1** (an undefined source authority reached the evidence set); MP-1 threw on a non-iterable history; `validatePoint` threw on a symbol with no rule; `appendProviderCapture` / `mergeCaptureArchives` threw on a log holding `null`/array; non-string cutoffs echoed into hashed envelopes | `typeof` before every regex, plain-decimal text values, named refusals, own-property symbol lookup, structure check on logs, empty echo for non-string cutoffs | `backend/market_engine/{as_of_snapshot,persisted_as_of,validate,evidence_capture}.ts`, `backend/positioning_engine/{evidence_contract,persisted_evidence}.ts`, `tests/test_market_data_ingest_mutation.mjs` |
| 17 | Event facts write boundary | The strong identity key joins namespace/type/value with U+001F (also `chr(31)` in frozen SQL), so two different triples hash alike; the CPI writer's "JSON" check let `Map`, `Set`, `Date`, class instances, getters and sparse arrays through | Application boundary refuses U+001F in identity fields (no adapter emits it); strictly plain JSON required. **SQL not changed** (migration gate) | `backend/event_facts/{release_identity_lookup,bls_cpi_production_writer}.ts`, `tests/test_event_facts_write_boundary_mutation.mjs` |
| 18 | Shared | `canonicalJson` recursed unbounded: deep or circular input overflowed the stack with a host-dependent `RangeError`; the new strict-JSON check did too | Fixed bound (256 levels; 64 for the CPI writer state) with a typed `TypeError` / `false`; 30 entry points fed 2,000–300,000 levels | `backend/shared/canonical_json.ts`, `tests/test_deep_nesting.mjs` |

| 19 | Terminal | `buildTerminalView` displayed whatever digest the caller passed (callers derive it from an accepted receipt, guarded only by a source-grep test) | Shown only if `sha256:<64 hex>` and the chain is `CONSISTENT` (defence in depth) | `backend/decision_chain/terminal_view.ts`, `tests/test_terminal_view.mjs` |
| 20 | Terminal / DATA CLI | **A requested pin was silently dropped when empty**: `buildLocalView({archiveDigest: ''})` and `market_evidence_capture.mjs replay --digest ""` applied the pin only when truthy, so the replay was not pinned. Hostile `--input`/`--archive` files: none other found (59 views, all HOLD, no HTTP 500) | A requested pin is always applied (`!== undefined`) | `scripts/serve_terminal_local.mjs`, `scripts/market_evidence_capture.mjs`, `tests/test_terminal_local_hostile_files.mjs` |
| 21 | Terminal front | none found: 18 views passing `v2Problem` with `null` items, wrong types, minimal sections → 17 drawn whole, 1 safe fallback, no uncaught page error, no leaked marker | Test only | `tests/test_terminal_render_isolation.mjs` |
| 22 | Macro / news | **Wrong publication date accepted.** ECB and Fed extracted items with a lazy `<item>…</item>`; a missing `</item>` merged two items and the first took the second's description and `pubDate`. 20,000 unclosed items cost ~4 s | One linear tag pass; an item opened while another is open is dropped and reported (`ecb_item_unclosed`, `fed_item_unclosed`); items over 64,000 chars refused. OFAC / Treasury already handle unclosed containers (their tests cover it) | `backend/news_sources/{ecb,federal_reserve}.ts`, `tests/test_news_feed_structure_mutation.mjs` |

| 23 | Macro facts (CPI) | **Wrong CPI figure accepted.** `worksheetCells` used a lazy `<c>…</c>`: a cell left open took the next cell's value. With an unrelated column between the reviewed ones, "All items" YoY read 1.1 instead of 3.4 (or 9.9 instead of 2.4) and the table still parsed; empty `<si/>` shifted every shared-string index. Measured on 1.5 MB (cap 2 MiB): unclosed cells 52 s, unclosed items 43 s, unclosed values 128 s. The old HTML header cleaning, measured separately on unterminated input at 1.5 MB (cap 10 MiB): comments 377 s, scripts 67 s, styles 92 s (quadratic: doubling the size ×4) | Cells, items, parts and values read in one linear pass requiring strictly sequential elements; `<si/>` refused; HTML header cleaning (comments / scripts / styles) linear. Reviewed table or refusal, never other figures | `backend/event_facts/bls_cpi_artifact_parser.ts`, `tests/test_bls_cpi_artifact_structure_mutation.mjs` |

| 24 | V1 news cleaning | `cleanText` (`backend/ingest.ts`) used a lazy `<script>…</script>` pattern and an unbounded `/<[^>]+>/g`: both rescan to the end from every unterminated opener (150,000 characters of `<script>` cost 0.7 s, `<!--` 3.9 s, doubling the size ×4; 1.5 M characters minutes). Inputs are API titles and content, so the exposure was small | Input capped at 100,000 characters (output is capped at a few thousand anyway), tag length bounded to 2,000. 1.5 M characters of `<script>`, `<style>`, `<!--` and `<a ` now clean in under 3 s | `backend/ingest.ts`, `tests/test_gdelt_429_retry_policy.mjs` |

| 25 | DATA (database read path) | **Unreadable freshness read as perfectly fresh.** `market_engine/context.ts` `num()` converted `v_market_latest` text with `Number()`: `""`, `" "` and `"\n"` became **0**, `"0x10"` became 16. A blank `staleness_seconds` therefore became "0 seconds old" (the 3900 spot stayed LIVE) and a blank `close`/`bid` became a price of 0 | Only plain decimal text (or a finite number) is read; anything else is `null`, so the field is UNAVAILABLE / the snapshot unavailable | `backend/market_engine/context.ts`, `tests/test_market_data_ingest_mutation.mjs` |
| 26 | Committee (legacy partial recalculation) | `fetchBaselineScenarios` read the stored jsonb scenarios with `Number()`: a null/empty/`[]`/`false` target or invalidation became a baseline of **0**, `true` became 1, `"0x10"` became 16, instead of making the baseline unavailable | Strict `storedNumber()`; the explicit fallback of `confidence` to 0 is unchanged | `backend/ai_engine/committee_orchestrator.ts`, `tests/test_committee_baseline_numbers.mjs` |

| 27 | News publication times | **Impossible timezone stored as VALID.** `shared/raw_news.ts` accepted offsets to `±23:59`, `-00:00` / `-0000` and year `0000` as an "explicit timezone": `2026-08-25T18:00:00+23:59` was stored `VALID` as `2026-08-24T18:01:00Z`, a publication time shifted by almost a day | Same zone and year policy as TIME-0 (offset ≤ ±14:00, no unknown-offset marker, no year 0000); such times become no timestamp with `DEGRADED`. 4 other event-pipeline copies of the old check left as-is (low exposure, documented) | `backend/shared/raw_news.ts`, `tests/test_raw_news_writer.mjs`, `docs/XAU_V2_TIME_0_STRICT_TEMPORAL_CONTRACT.md` |

| 28 | Reliability (run lock) | **A real outage could pass for "a run is already active".** `isUniqueViolation` (`backend/shared/run_lock.ts`, used by every engine lock and by the committee event idempotency) matched the bare digits `23505` and the words `already exists` anywhere in an error message. `Supabase HTTP 500: request id 1235057 failed`, `timeout after 23505ms` and `relation … already exists` were all classified ALREADY_RUNNING, i.e. a nominal, silent SKIPPED instead of a FAILED | The code must be presented as an error code (`code=23505`, `"code":"23505"`); the unique-constraint wording and `duplicate key` still match; `already exists` no longer does. Four other copies of the loose pattern had the same effect and use the tightened one: the market engine's own `acquireRunLock` (shared predicate) and the three manual shadow runtimes (event, event impact, gold transmission), which classify the upstream error BODY and now also require HTTP 409. The shadow runtimes keep a local copy of the predicate because their tests transpile a fixed module list | `backend/shared/run_lock.ts`, `backend/market_engine/ingest_market.ts`, `backend/{event_engine,event_impact,gold_transmission}/shadow_runtime.ts`, `tests/test_event_routing.mjs`, `tests/test_shadow_lock_conflict_classification.mjs` (27 cases; written after the fix, red-before-fix NOT observed for this one; the unit cases in `test_event_routing.mjs` were seen red first) |

| 29 | Reliability (timeouts) | **The request timeout covered the headers, not the body.** A server (database or provider) that sent its headers and then stalled the body hung the call for ever, and with it the run lock (only the 15-minute stale reclaim frees it). The timer was cleared right after `fetch()` returned, before `response.text()` / `.json()`, in the market engine's database client and its provider fetch (`providers.ts`), the news engine's database client and external fetch (`ingest.ts`), the committee's database client and Anthropic call, and the three manual shadow runtimes. Measured with simulated timers and a body that never ends: all 8 client x status cases pending; the market job with healthy database but stalled providers still running after 12,000 simulated seconds | The timer stays armed through the body read and is cleared after it (the `catch` clears it on error); the shadow runtimes now read the body inside the same `try` as the `fetch`. Verified: the 4 exported clients x {200, 400} and the 3 Worker jobs under two scenarios settle in 1 to 14 steps of 20 simulated seconds | `backend/{market_engine/ingest_market,market_engine/providers,ingest,ai_engine/committee_orchestrator,event_engine/shadow_runtime,event_impact/shadow_runtime,gold_transmission/shadow_runtime}.ts`, `tests/test_database_client_body_timeout.mjs`. Red-before-fix was observed for the 4 exported clients and for the market provider path; the `ingest.ts` and committee clients were fixed in the same pass and are covered by the job scenarios, not seen red on their own |

| 30 | Terminal demo (ergonomics) | Starting the demo when its port is already taken (the usual case when it is restarted) printed a raw stack trace (`Unhandled 'error' event … EADDRINUSE`) and no hint | One readable line on stderr (`le port N est déjà utilisé … --port <numéro>`; `EACCES` likewise), exit 1; the ready line now also says `Ctrl+C pour arrêter` | `scripts/serve_terminal_local.mjs`, `tests/test_terminal_cli_process.mjs` |

**Demo end-to-end check (branch `verify/terminal-demo-offline`).** On the real process (`tests/test_terminal_cli_process.mjs`, new): all 11 scenarios plus the default view are simulated HOLD / FORBIDDEN, 12 ordered stages (or a stated rejection with no stage and no fingerprint), origin and cutoff present, no LIVE capability, no trading word, `everything-granted` shows no fingerprint (OBS-0 refuses its receipt); the page carries the CSP, `X-Frame-Options: DENY`, `no-store`, the injected view/scenario URLs and an empty Supabase URL (demo mode); 404 / 405 / 403 paths leak no path or stack; invalid arguments exit 1 with the usage; a missing `--input` / `--archive` file opens a HOLD view that says so; SIGTERM frees the port. **Not done: a real browser rendering.** No browser binary exists on this machine (`~/.cache/puppeteer/chrome*` are empty directories, no Playwright), `curl` and direct `node` are refused by the session policy, and installing a browser is a download the operator must authorize. The rendering is covered only by jsdom against the real server (`test_terminal_local.mjs`, `test_terminal_render_isolation.mjs`). `scripts/check_terminal_layout.mjs` (layout and contrast in Chromium at 5 viewports) was not run.

Ergonomics that can get in the way of the demo (not changed, need a decision): (1) with Internet access the "offline" page contacts Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`; allowed by the CSP, fallback fonts keep it readable offline), so a strictly offline or privacy-sensitive run should self-host the two IBM Plex families; (2) there is no `--open` or printed hint about the scenario selector, so a first-time user must find the scenario list in the page; (3) the default port 4173 is fixed, a leftover server from a previous session blocks the next start until `--port` is changed (now explained instead of a stack trace); (4) `localhost` works only if it resolves to 127.0.0.1 or falls back from `::1` (the server binds IPv4 only), `http://127.0.0.1:<port>/` always works.

Audited with no defect (regression guards added on branch `audit/shadow-worker-hardening`): `backend/worker.ts` routes (`tests/test_worker_routes_security.mjs`: 1,100 unauthenticated or mis-authenticated requests over 10 routes x 5 methods, no 2xx/5xx, no outbound call before authorization, no secret in body or header, exact routes exact, `/health` leaks nothing, unknown cron runs nothing) and the four manual shadow routes with a VALID token (`tests/test_shadow_routes_authorized_bodies.mjs`: 178 hostile envelopes, all 400/413, none reaches the database). Note: `Bearer  <token>` with extra spaces carries the real token and is rightly accepted.

Reviewed with no change needed: the five `isAuthorized` implementations (token unset or empty → refuse; constant-time compare), tracked files for secrets (only placeholder test tokens), `wrangler.toml` and `frontend/index.html` (no secret, empty Supabase / V2 URLs), BLS CPI planner / orchestrator (injected dependencies, errors mapped to `BLOCKED`).

31. Terminal temporal integrity (branch `verify/terminal-demo-offline`): a cutoff AFTER `generatedAt` (e.g. `--cutoff` in the future) gave a negative `cutoffAgeSeconds`, was classed `AT_GENERATION` and displayed "CUTOFF À LA GÉNÉRATION" with an age like "-12 s". Red first in `tests/test_terminal_view.mjs` (4 cases), fixed in `temporalOf` (`terminal_view.ts`): such a cutoff is now `UNKNOWN` with a null age. Still a fixed-vocabulary change (no new enum value, no schema bump); a distinct `FUTURE_CUTOFF` class would need a v5 view and is left to a human decision. Visual tests: still impossible (no Chromium/Chrome/Edge executable, no `playwright-core`; nothing installed).

Mutation sweeps (6–18) share `tests/lib/mutation_cases.mjs` (deterministic: node
replacement by 25 hostile values, removal, unknown key, own `__proto__` key; no
randomness, clock or I/O).

## Validation (real runs, this worktree)

- Final state of this handoff: `npm run typecheck` clean; `npm test` **133/133**
  test files at the last run (all code commits included; later commits are docs-only).
  Baseline was 115; the 18 new files are the mutation/boundary sweeps above, the
  Host-guard, hostile-files, render-isolation, feed-structure and CPI-structure tests.
- A full `npm test` measured **3 min 19 s** (`real 3m18.7s`) on this machine at 133 files.
  The baseline duration was not measured; the new files add noticeable time (cost ceilings
  run hostile 1.5 MB inputs with a 3 s limit each, the render-isolation test boots 18
  jsdom pages, the mutation sweeps run thousands of calls).
- The `.mjs` scripts (capture CLI, terminal server) are covered by tests, not by `tsc`.
- Each change was followed by a full `npm test` and, for `.ts` edits, `npm run typecheck`.
- Red-before-fix was observed for changes 6, 7, 8, 9 (the new sweep failed first,
  with the stack naming the defect). It was **not** observed in isolation for
  changes 1–3 (first run's output was truncated). Direct `node tests/...` runs are
  refused by the session policy; only `npm test` / `npm run typecheck` run.
- Not run: the 17 PostgreSQL tests (need an ephemeral database / CI), and the 8
  documented exemptions. Frontend layout check (needs headless Chromium) not run.

## Domain status (unchanged unless stated)

| Domain | Status |
|---|---|
| DATA (4A–4G, capture, archives) | OFFLINE_ONLY, HISTORICAL_UNVERIFIED; capture log writer-locked (3); replay/audit harden against non-string cutoffs (7, 8). Real captures, DXY/bid/ask, supplier rights absent |
| Macro / Event Impact / Gold Transmission | NOT_APPROVED; insufficiency preserved, no consensus provider; July 2026 employment stays `UNAVAILABLE` (asserted) |
| Market Pricing, horizons, committee, PM, risk, action, CC, alerts, acceptance | HOLD / FORBIDDEN; contract-level only, no positive output reachable under forged upstream (11) |
| Terminal | READ_ONLY, simulated/origin labelled; Host guard (1) |
| Time contracts | Two parsers in parity by test (2); not consolidated |
| Database / migrations | NOT_MIGRATED; none touched |
| Recovery / security | FROZEN; REC-1 human gate |

## Integration with the cloud branch (DONE locally on `integration/pr-149-plus-cloud-canonical-json`)

Created from `4e132f4`; `84e5374` cherry-picked as `979d601` with no conflict (git auto-merged
`scripts/run_ci_tests.mjs`; `grep -c test_canonical_json_contract` = 1, no duplicate). Verified on
the integrated result: `npm run typecheck` clean; `npm test` **134/134** test files; `CI-GOV-1:
159 tests accounted for (134 deterministic; 17 ephemeral PostgreSQL; 8 reviewed exceptions)`;
`canonical_json contract: OK`, i.e. the cloud test passes against the 256-level `canonicalJson`
bound. Nothing pushed; `main`, #149 and the cloud branch untouched. The paragraph below records
the earlier analysis made while the branch could not yet be created.

### Earlier analysis (before the integration branch existed)

`origin/claude/xau-v2-nightly-20261016` = `84e5374be7c979c1407ede51ecd3ee7ab6360964`, one commit
on the shared base `e1e70225`: `tests/test_canonical_json_contract.mjs` (new) and one line in
`scripts/run_ci_tests.mjs`. By reading the diffs there is no textual overlap (the cloud line is
at least 5 unchanged lines away from mine) and the cloud test is compatible with the 256-level
`canonicalJson` bound (it covers neither depth nor cycles). **Not verified by git:** `git
merge-tree` and `git switch -c` were refused by the session policy (don't-ask mode), so the
integration branch `integration/pr-149-plus-cloud-canonical-json` was never created and `84e5374`
is not in this branch. To do it: `git switch -c integration/pr-149-plus-cloud-canonical-json
c34ff0a`, `git cherry-pick 84e5374` (union of the `TEST_FILES` lines on conflict), then
`npm run typecheck` and `npm test` (134 files expected), then cherry-pick the later commits of
this branch (change 24).

## PostgreSQL validation (17 tests, CI only)

No PostgreSQL toolchain is installed locally (`which psql pg_ctl postgres initdb` finds
nothing), so the 17 `*_postgres.mjs` tests only run in CI. `quality-gate.yml` runs exactly 17
`node tests/*_postgres.mjs` commands over 11 jobs on `postgres:17.6`, but only for pull
requests to `main` and pushes to `main`: obtaining a run needs a pull request, which needs a
separate authorization. Static check that this branch cannot change their outcome: no file under
`database/` differs from `e1e70225`, no PostgreSQL test imports `backend/`, and the one that
imports application code (`test_data_api_default_acl_preflight_postgres.mjs` →
`scripts/evaluate_data_api_default_acl_preflight.mjs`) imports a file this branch did not touch.
This is a reading, not a run.

## Remaining / next

1. Confirm in CI (ephemeral PostgreSQL included) on the exact head commit.
2. Known and left alone: `validate_evidence_captures.mjs` picks each source's
   latest `ingestedAt` with a lexical `sort()` (mis-orders `…:00Z` against
   `…:00.500Z`); it only affects which cutoff the per-source check replays at.
3. Not yet swept: committee / orchestrator legacy paths (`committee_orchestrator.ts`, 2,000+
   lines), `backend/ingest.ts` (V1 news pipeline), the event shadow batches / orchestrators
   (mock-database sweeps), and `backend/worker.ts` routes (deploy-gated). Note: the CPI
   test uses synthetic workbooks built in the test; the real retained XLSX/HTML bytes are
   not in the repository, so a real-artifact replay is still owed once they are retained.
4. **Recommendations that need a human decision (nothing changed):**
   - *Plausibility bounds in the official-release adapters.* BLS CPI / employment, BEA PCE
     and DOL claims accept any finite one-decimal percent or any safe integer. A column mix-up
     in a parser (an index level such as 314.8 read where a percent change belongs) would
     resolve as a valid fact. A bound such as |percent| ≤ 100 and a non-negative unemployment
     rate would catch that class, but the adapters are versioned and frozen
     (`…-adapter-v1` is asserted) and thresholds are a methodology choice: this belongs in a
     reviewed `v2` adapter, not a silent edit.
   - *(Done, see change 24)* V1 `cleanText` quadratic on unterminated tags.
5. Open design question, not changed: the SQL key derivation (`chr(31)` join) stays
   ambiguous in the database; only the application boundary refuses U+001F. A SQL
   `CHECK` or a length-prefixed key is a schema decision for the migration gate.
