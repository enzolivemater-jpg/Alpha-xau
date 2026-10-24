# XAU V2 — DATA-REAL: first authentic sources (preparation)

Status: `CFTC REAL FILE QUALIFIED LOCALLY (2026-10-18) — NO PROVIDER CONTACTED — AUTHENTIC DATA OFF THE REPOSITORY`

## 1. CFTC Disaggregated Futures Only (COMEX gold, `088691`)

Official files: `https://www.cftc.gov/files/dea/history/fut_disagg_txt_<YEAR>.zip`
(Historical Compressed page; reports since September 2009; the zip holds
`f_year.txt`). Field list: CFTC "Variable Names for the Comma Delimited
Commitment of Traders Files", Disaggregated (191 fields), copied in
`tests/fixtures/cftc_disaggregated_variables_official.txt`. Terms of use of
the files were **not** found on the download page: to confirm before any
excerpt is committed.

Adapter 1.3.0 against that list:

| Point | Documentation | Adapter |
| --- | --- | --- |
| 18 identity and position columns, incl. `Swap__Positions_Short_All` (double underscore) | fields 1–23 | required, same spelling |
| Report date | `As_of_Date_Form_YYYY-MM-DD` (field 3) | accepts it or `Report_Date_as_YYYY-MM-DD` (1.0.0's assumption); both present must agree |
| `FutOnly_or_Combined` (field 191) | present | read and shown verbatim (`fileDatasetMarker`), never interpreted: the declaration stays the operator's |
| 191-field row | — | converts (test on a file laid out exactly as the list, synthetic values) |

### Real file, 2026-10-18 (DATA-REAL-3)

`fut_disagg_txt_2026.zip` downloaded once from cftc.gov (HTTP 200, 1,981,329
bytes, sha256 `be28cebb914e0b4ef9325df0a66d1594a478f19f906ec23a289339977cbd13b0`,
received 2026-10-18T21:44:42.077Z, `Last-Modified: Fri, 16 Oct 2026 19:28:01 GMT`).
ZIP checked before extraction: one entry `f_year.txt`, 18,047,430 bytes,
deflate, CRC valid, no link, no unsafe path, no encryption. `f_year.txt` sha256
`bbafea92b984a09bee7846352fa4ce7bcb9594a4de6ce27e5c5190e7472687db`. Kept
outside the repository with a local provenance record; never committed.

Facts of the real header and rows:

- 191 columns, identical to the CFTC variable list **except field 3**: the
  real file says `Report_Date_as_YYYY-MM-DD` (the list says
  `As_of_Date_Form_YYYY-MM-DD`). Adapter 1.3.0 reads either: no parser change.
- Header names quoted; numbers right-aligned with leading spaces (trimmed).
- `FutOnly_or_Combined` = `FutOnly` on every row.
- COMEX gold `088691` "GOLD - COMMODITY EXCHANGE INC.", contract units
  "(CONTRACTS OF 100 TROY OUNCES)": 41 weekly reports, 2026-01-06 to
  2026-10-13, YYMMDD twin consistent.
- Report 2026-10-13 converted: 14 metrics identical to an independent CSV
  parse; open interest 396,345 equals the sum of every long and spread
  category (internal identity of the report).
- Publication instant declared for that report only: 2026-10-16T19:30:00Z,
  from the CFTC Release Schedule (3:30 p.m. Eastern; October 16 in the 2026
  table; data of the previous Tuesday), corroborated by the server's
  Last-Modified. The 40 earlier reports carry no declared instant.
- Terminal: catalog entry EXTRACTED, bound to the bytes, NOT_APPROVED; with
  the real captures replayed at their last reception (2026-10-15T19:58Z) the
  evidence is after the cutoff (`EVIDENCE_AFTER_KNOWLEDGE_CUTOFF`); with a
  cutoff after reception it is kept, freshness NOT_EVALUATED, methodology not
  approved; positioning UNAVAILABLE; HOLD / FORBIDDEN on every view.

Still open: the files' terms of use (not found on the download page); a
publication instant per earlier report (from the schedule, holiday shifts
checked one by one) if they are to be declared.

### Procedure for the first real file (after authorization to download)

1. Download the year's zip from cftc.gov; note the reception instant; unzip
   (`unzip fut_disagg_txt_2026.zip`), keep the zip and its sha256.
2. `node scripts/cot_declare.mjs f_year.txt --inspect` — format, layout,
   missing columns, date column(s), `FutOnly_or_Combined` values, gold report
   dates. Writes nothing.
3. For one report: take its publication instant from the CFTC release
   schedule (never inferred), then `node scripts/cot_declare.mjs f_year.txt
   --dataset futures-only --published-at … --received-at … --report-date …
   --source-url https://www.cftc.gov/files/dea/history/fut_disagg_txt_2026.zip`
   (writes `f_year.declaration.json` bound to the file's sha256).
4. Put both in `~/.local/share/xau-v2/positioning/`; `npm run terminal:data`;
   choose the file in DONNÉES LOCALES; compare a few values with the CFTC
   viewable report of the same week.
5. If step 2 shows a difference with the documentation, fix the adapter with
   a red test on that header, then green.

## 2. FRED DTWEXBGS (Nominal Broad U.S. Dollar Index) — not integrated

DTWEXBGS is a Federal Reserve trade-weighted index (26 currencies, daily,
published with a lag). It is **not** the ICE U.S. Dollar Index (DXY, six
currencies). The market contract binds field `dxy` to instrument `DXY`
(`evidence_archive.ts`, `dry_run.ts`, `database/schema.sql`, migration
`20261002085845_market_pricing_history_as_of.sql`): putting DTWEXBGS there
would mislabel it. A distinct field touches MP-0/MP-1, CHAIN-0 input
validation, the archive contract, the capture series, the SQL schema (a
migration, not authorized) and the golden digest. Nothing was changed; it is
a contract decision.

## 3. Decisions (matrix)

| Source | Benefit | Cost | Licence / terms | Constraints | Decision needed |
| --- | --- | --- | --- | --- | --- |
| CFTC COT disaggregated | real positioning evidence, history since 2009 | none | US federal data; site terms not found | weekly; publication instants from the release schedule; revisions not identified | authorize the download; repository excerpt or local only |
| FRED DTWEXBGS | free daily dollar proxy | none | FRED / Federal Reserve terms | not DXY; lag; new field = contract change and migration | new canonical field or not |
| ICE DXY | the real DXY | paid (ICE fee schedule: display and datafeed fees, redistribution licence) | ICE licence | real-time or delayed tiers | budget and licence |
| OANDA v20 (bid/ask XAU/USD) | bid/ask candles (`price=BA`) | account (demo possible) | OANDA terms not reviewed | broker quotes, not a market-wide book; XAU_USD availability to confirm | open an account or not |
| Consensus (Trading Economics, Bloomberg, Econoday…) | ends `CONSENSUS_FACTS_UNAVAILABLE` (contract C-0 ready) | paid, plan per redistribution | per-provider licence; single-user plans forbid sharing | timestamps and revisions must satisfy C-0 | budget, provider, methodology |

HOLD / FORBIDDEN unchanged by every row. REC-1 frozen.

## 4. Terms of reuse (verified 2026-10-19)

CFTC Web Policy (https://www.cftc.gov/WebPolicy/index.htm): "Government
information at the CFTC website is in the public domain"; it "may be freely
distributed and copied, but it is requested that in any subsequent use the
CFTC be given appropriate acknowledgement"; the CFTC "makes no claims,
promises, or guarantees about the accuracy, completeness, or adequacy" of the
site's contents. Repository policy unchanged: authentic files stay off Git
(acknowledgement: "Source: U.S. Commodity Futures Trading Commission").

## 5. Publication instants of the 41 gold reports of 2026 (evidence, not inference)

Sources: the Release Schedule (https://www.cftc.gov/MarketReports/CommitmentsofTraders/ReleaseSchedule/index.htm:
"released at 3:30 p.m. Eastern time"; "a **tentative** schedule"; "The release
**usually** includes data from the previous Tuesday"; "*Delayed release date
due to a federal holiday") and press release 9138-25
(https://www.cftc.gov/PressRoom/PressReleases/9138-25), which pairs each
backlog report with its publication date. The tentative schedule is not proof
for a given report: it lists a January 9 release, but 9138-25 published the
January 6 report on January 16.

- `EXPLICIT_OFFICIAL_MAPPING` (3 reports): an official document pairs the
  report with its publication date (time: the schedule's 3:30 p.m. ET rule).
- `OFFICIAL_SCHEDULE_INFERRED` (38 reports): paired with the next listed
  release date by the "usually previous Tuesday" rule; **inferred, not
  proved**. They must not be declared as official publication instants
  without per-report evidence (or an explicit approval to accept this
  basis), and a declaration that uses them must say so
  (`--publication-basis schedule-inferred`).
- A declaration that names a basis (either kind) must give the release
  instant the basis rests on: 3:30 p.m. America/New_York, to the second, with
  an explicit zone (19:30Z in EDT, 20:30Z in EST). Otherwise `cot_declare`
  declares nothing and the terminal refuses the file
  (`DECLARATION_BASIS_CONTRADICTED`), so no CFTC value is served before the
  instant the cited rule gives. A declaration without a basis is unchanged.
- The 2026-10-13 report already declared locally rests on this inferred basis,
  corroborated by the server `Last-Modified` (2026-10-16 19:28:01 GMT); its
  declaration names no basis, and the terminal shows "non indiquée
  (déclaration de l'opérateur seule)".

| Report (as of) | Release date | 3:30 p.m. ET in UTC | Basis | Reference |
| --- | --- | --- | --- | --- |
| 2026-01-06 | 2026-01-16 | 2026-01-16T20:30:00.000Z | EXPLICIT_OFFICIAL_MAPPING | PR 9138-25 |
| 2026-01-13 | 2026-01-20 | 2026-01-20T20:30:00.000Z | EXPLICIT_OFFICIAL_MAPPING | PR 9138-25 |
| 2026-01-20 | 2026-01-23 | 2026-01-23T20:30:00.000Z | EXPLICIT_OFFICIAL_MAPPING | PR 9138-25 |
| 2026-01-27 | 2026-01-30 | 2026-01-30T20:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-02-03 | 2026-02-06 | 2026-02-06T20:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-02-10 | 2026-02-13 | 2026-02-13T20:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-02-17 | 2026-02-20 | 2026-02-20T20:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-02-24 | 2026-02-27 | 2026-02-27T20:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-03-03 | 2026-03-06 | 2026-03-06T20:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-03-10 | 2026-03-13 | 2026-03-13T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-03-17 | 2026-03-20 | 2026-03-20T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-03-24 | 2026-03-27 | 2026-03-27T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-03-31 | 2026-04-03 | 2026-04-03T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-04-07 | 2026-04-10 | 2026-04-10T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-04-14 | 2026-04-17 | 2026-04-17T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-04-21 | 2026-04-24 | 2026-04-24T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-04-28 | 2026-05-01 | 2026-05-01T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-05-05 | 2026-05-08 | 2026-05-08T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-05-12 | 2026-05-15 | 2026-05-15T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-05-19 | 2026-05-22 | 2026-05-22T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-05-26 | 2026-05-29 | 2026-05-29T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-06-02 | 2026-06-05 | 2026-06-05T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-06-09 | 2026-06-12 | 2026-06-12T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-06-16 | 2026-06-22 | 2026-06-22T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule (* holiday) |
| 2026-06-23 | 2026-06-26 | 2026-06-26T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-06-30 | 2026-07-06 | 2026-07-06T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule (* holiday) |
| 2026-07-07 | 2026-07-10 | 2026-07-10T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-07-14 | 2026-07-17 | 2026-07-17T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-07-21 | 2026-07-24 | 2026-07-24T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-07-28 | 2026-07-31 | 2026-07-31T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-08-04 | 2026-08-07 | 2026-08-07T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-08-11 | 2026-08-14 | 2026-08-14T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-08-18 | 2026-08-21 | 2026-08-21T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-08-25 | 2026-08-28 | 2026-08-28T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-09-01 | 2026-09-04 | 2026-09-04T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-09-08 | 2026-09-11 | 2026-09-11T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-09-15 | 2026-09-18 | 2026-09-18T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-09-22 | 2026-09-25 | 2026-09-25T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-09-29 | 2026-10-02 | 2026-10-02T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-10-06 | 2026-10-09 | 2026-10-09T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |
| 2026-10-13 | 2026-10-16 | 2026-10-16T19:30:00.000Z | OFFICIAL_SCHEDULE_INFERRED | Release Schedule |

### Audit of the inferred instants (2026-10-19)

- **Where they matter.** P-0 drops a value published *or received* after the
  cutoff, so a value is known from max(`publishedAt`, `receivedAt`). For the
  file received on 2026-10-18 every report is known from that reception,
  whatever its publication instant: an inferred instant cannot create
  look-ahead there. It matters in two places:
  - a declared history (one declaration per past report, received at its
    publication): an instant inferred *earlier* than the real one is
    look-ahead;
  - ages under P-FRESH-CFTC-1.
- **Observed error of the rule.** January 2026: the tentative schedule says
  January 9, while PR 9138-25 published the January 6 report on January 16.
  That is a 7-day error, in the unsafe direction. Holiday delays
  (2026-06-22, 2026-07-06) are already in the table.
- **What would prove an instant**, per report (none collected; collecting
  needs an authorization):
  1. an official CFTC document pairing the report with its release date
     (press release, notice of delay);
  2. the CFTC's own `Last-Modified` / archive timestamp of the weekly files.
     This only bounds publication from above, as the 2026-10-13 one does
     (19:28:01 GMT);
  3. a reception receipt written at capture time, which proves "known by
     then", never the publication instant.
- **Local evidence for the 2026-10-13 report** (checked 2026-10-19).
  - HTTP `Last-Modified: Fri, 16 Oct 2026 19:28:01 GMT`: the server copy
    changed 2 minutes before 3:30 p.m. ET. This corroborates the schedule
    instant, without proving it.
  - The ZIP entry `f_year.txt` is dated `2026-10-15 15:27:10`, with no time
    zone (DOS time): the file was built the day *before* the release. An
    archive's internal timestamp is therefore never a publication instant.
  - Received `2026-10-18T21:44:42.077Z`: known from then.
- **Until then.** Declarations keep `OFFICIAL_SCHEDULE_INFERRED`. The
  terminal and `terminal:check-data` say "déclaration seule" / the basis. No
  inferred instant is turned into an official one.

## 6. Proposals — NOT ACTIVE, NOT APPROVED (versioned for review)

### P-FRESH-CFTC-1 — freshness of CFTC COT weekly evidence (proposal)

- Scope: `sourceAuthority=cftc`, datasets `cot_disaggregated_futures_only`
  and `cot_disaggregated_futures_options_combined`.
- Age reference: the declared `publishedAt` whose basis is
  `EXPLICIT_OFFICIAL_MAPPING` (or an approved basis); evidence with no basis
  or an inferred one stays `NOT_EVALUATED`.
- Fresh until the next official release instant of the same dataset; with
  no proved next release, at most 7 days (weekly cadence) + 2 days ("Federal
  holidays may delay release by one or two days") = 9 days after
  `publishedAt`. Beyond: `STALE` (blocking).
- Encoding: a new P-0 version (`xau.positioning-evidence.v3`), a per-dataset
  policy table with its approver, and the golden digest change it implies;
  until approved, P-0 v2 (`FRESHNESS_POLICY_NOT_APPROVED`) stays.

### P-METHOD-CFTC-1 — positioning methodology (proposal)

- Input: managed money long and short (`M_Money_Positions_*_All`) and open
  interest of COMEX gold, one report per week, only `EVIDENCE_READY` evidence.
- Measures (descriptive, no direction): net = long − short; net / open
  interest; rank of net within the trailing N approved weekly reports (N to
  decide; missing weeks are gaps, never filled).
- Output: a bounded descriptive state (e.g. extreme long / neutral / extreme
  short at percentile cut-offs to decide), never a trade direction, size or
  order; Regime R-1 and Horizon S-1 consume it only after their own approval.
- Validation before activation: back-test on the 2009+ history with
  publication instants proved per report; documented revisions; review by the
  methodology owner.

Both proposals need a named approver and their own version and tests; neither
changes HOLD / FORBIDDEN.

### Review aid (2026-10-19): benefits, risks, acceptance criteria

| | P-FRESH-CFTC-1 | P-METHOD-CFTC-1 |
| --- | --- | --- |
| Benefit | positioning can leave `FRESHNESS_POLICY_NOT_APPROVED`; a stale report blocks instead of being silently old | a bounded, descriptive state the regime / horizon layers can consume once approved |
| Main risk | an inferred instant (7-day error seen in January) makes an old report look fresh, or a fresh one stale | look-ahead in the back-test if instants are inferred; percentile cut-offs fitted to the sample; gaps filled by mistake |
| Mitigation in the text | only `EXPLICIT_OFFICIAL_MAPPING` or an approved basis is aged; others stay `NOT_EVALUATED` | only `EVIDENCE_READY` input; gaps are gaps; no direction, size or order |
| Acceptance criteria | approver named; P-0 v3 with the policy table; tests at the 9-day edge, on holidays and with an inferred basis (NOT_EVALUATED); golden digest change reviewed | approver named; N and cut-offs fixed before the back-test; back-test on reports whose instants are proved; out-of-sample period; tests for gaps and for revisions |
| Blocked by | the publication-basis decision (accept the schedule rule or not) | P-FRESH-CFTC-1, and the history of proved instants |
