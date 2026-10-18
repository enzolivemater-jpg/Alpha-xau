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
