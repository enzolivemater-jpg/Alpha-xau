# XAU V2 — DATA-REAL: first authentic sources (preparation)

Status: `PREPARED OFFLINE — NO REAL CFTC FILE READ — NO PROVIDER CONTACTED`

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

**Not verified:** the header of a real `f_year.txt`, the values of
`FutOnly_or_Combined`, the padding and quoting of real cells. No real file
has been read.

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
