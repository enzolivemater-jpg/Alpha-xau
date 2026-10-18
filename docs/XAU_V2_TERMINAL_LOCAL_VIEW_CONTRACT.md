# XAU V2 — local terminal view (TV-0)

Status: `LOCAL_ONLY — NOT DEPLOYED — NOT CC-1`

TV-0 lets the static terminal show the V2 chain without any runtime. A
loopback server runs CHAIN-0 on a local input and serves a read-only view;
the terminal renders it in two panels: **Chaîne décisionnelle V2** and
**Matrice des capacités**.

Frozen versions:

- `xau.terminal-local-view.v4`;
- `terminal-local-view-4.7.0`.

Version 2 (TV-1) added `temporal` and `holdRationale`. Version 3 (TV-2) adds
`summary`, a plain-French meaning (`plain`) on every reason, and `reasons`
on every root cause. Version 4 (DATA-1) adds `marketEvidence` and the origin
`LOCAL_MARKET_ARCHIVE`. The terminal accepts only v4.

Algorithm 4.1.0 (B4) adds `inputProvenance` to the v4 view, additively: one
entry per chain input, in this order, `MARKET`, `POSITIONING`,
`EVENT_IMPACT`, `GOLD_TRANSMISSION`, `EVIDENCE_GRAPH`, `AUTHORIZATIONS`, each
with a `source` and a plain-French `detail`:

| Source | Meaning |
| --- | --- |
| `CAPTURED_ARCHIVE` | Market only: a replayed archive of class `CAPTURED` whose nature is not a simulation. The class is declared by the operator, not independently attested. |
| `SYNTHETIC_FIXTURE` | The golden fixture, a scenario built from it, or a synthetic archive. |
| `LOCAL_INPUT_UNVERIFIED` | A local `--input` file of unknown provenance. |
| `UNAVAILABLE` | Nothing supplied or evaluated: rejected input or archive, no positioning evidence, no evidence graph. |
| `UNKNOWN` | Missing or contradictory claims: an archive origin without a manifest or without the input document's origin, a manifest on a non-archive origin, a class that contradicts the nature. |

The `origin` names only the market's carrier: in `--archive` mode the market
comes from the archive and every other input from the input document (the
golden fixture by default), which `buildLocalView` passes as `inputDocument`.
The terminal draws a PROVENANCE DES ENTRÉES panel, adds `AUTRES ENTRÉES : …`
to the header of an archive view, and refuses the whole view when a non-market
input claims an archive, when the market's claim contradicts the manifest, or
when the list is malformed. A view without `inputProvenance` (an older 4.0.0
producer) is still drawn, with "PROVENANCE PAR ENTRÉE NON FOURNIE".

Algorithm 4.2.0 (B5) adds `positioning.freshness`, additively:
`status` `NOT_EVALUATED` (evidence kept, reason
`FRESHNESS_POLICY_NOT_APPROVED`, plain "fraîcheur non évaluée — aucun seuil
approuvé") or `NO_EVIDENCE`, the latest publication instant and its age in
seconds at the cutoff. The age is a fact, not a freshness judgement: no
threshold is approved. The terminal draws it under FRAÎCHEUR POSITIONNEMENT
and refuses a view whose positioning is `EVIDENCE_READY`, or whose evidence
lacks a `NOT_EVALUATED` freshness.

Algorithm 4.3.0 adds the freshness `status` `AFTER_KNOWLEDGE_CUTOFF` (reason
`EVIDENCE_AFTER_KNOWLEDGE_CUTOFF`, plain "preuve postérieure au cutoff —
écartée, fraîcheur non évaluée", no publication age) when a kept evidence was
published or observed after the cutoff. P-0 already rejects such evidence but
keeps it in its envelope; 4.2.0 showed it with a negative age ("publiée -7 h
avant le cutoff"). The terminal marks the observation date "(après le cutoff)"
and refuses a view that gives that evidence an age, or a negative age to any.

Algorithm 4.4.0 adds a positioning file: with `--positioning-cot`, the
server's own input takes its positioning evidence from a local CFTC
Commitments of Traders file (see the positioning contract). Its
`inputProvenance` entry is `LOCAL_INPUT_UNVERIFIED` ("fichier CFTC COT local
(…), rapport du …, futures seuls (déclaré) ; publication et réception
déclarées par l'opérateur ; source non approuvée"; `--cot-dataset` is
required), or `UNAVAILABLE` with the rejection reason when the
file is rejected. Scenarios never use the file. The server prints one line
saying whether the file was read or rejected.

Algorithm 4.5.0 adds `cutoffAlignment` (null for a rejected input or when the
caller gives no input cutoffs): the chain cutoff, the knowledge cutoffs of
the input's Event Impact and Gold Transmission summaries, `aligned`, and a
plain sentence. These two summaries are computed before the chain, at their
own cutoff, and never recomputed: a replay at another instant makes the
horizon synthesis abstain with `UPSTREAM_CUTOFF_MISMATCH`, and the page now
says which cutoffs differ under POURQUOI HOLD. `aligned` is false exactly
when the horizon synthesis reports that mismatch (test on every scenario
and archive replay instant).

Algorithm 4.6.0 adds `positioning.evidence` (and `evidenceTruncated`): the
raw evidence P-0 kept, in P-0's order, at most 64 rows: source authority,
dataset, instrument, metric code, value, unit, period end, published and
observed instants, and `afterCutoff` (published or observed after the
cutoff; P-0 rejects it, the row is shown flagged). Nothing is derived: no
net, ratio, rank or direction (no positioning method is approved). The page
groups the rows by report under PREUVES DE POSITIONNEMENT — VALEURS BRUTES
and refuses a view whose untruncated rows do not match `evidenceCount`.

Algorithm 4.7.0 adds a macro events source. The catalog lists `events`:
`input` (the input document's Event Impact / Gold Transmission summaries,
the default), `official:repository` (the seven official release documents
committed under `tests/fixtures/`, parsed from BLS, BEA and DOL artifacts) and,
with `--data-root DIR`, `official:local` (`DIR/official/*.json`, documents of
the same shape). `?events=<id>` (or the page's **Événements macro** selector)
runs each document through its Event Facts adapter, makes an event version
known at the adapter's official `publishedAt` (B3), plans Event Impact and Gold
Transmission with the existing processors, and aggregates them with EIA-0 v2
**at the chain's own cutoff** (the replay instant for an archive): a release
published after it is excluded, the summaries carry the chain cutoff, so a
replay no longer reports `UPSTREAM_CUTOFF_MISMATCH`. Both inputs are then
`LOCAL_INPUT_UNVERIFIED`; the view's `officialEvents` lists the releases known
at the cutoff, those not yet published and those rejected (with the
adapter's reason); the page shows them under ÉVÉNEMENTS MACRO OFFICIELS AU
CUTOFF. The processors still give `INSUFFICIENT_EVIDENCE` (no consensus, no
approved method): nothing is interpreted, HOLD / FORBIDDEN unchanged.
Identifiers are derived from the documents' bytes (no runtime, no database).
`--events ID` sets the default events source (an unknown id falls back to
`input`, with the note `EVENTS_SOURCE_UNKNOWN:<id>`). The launcher's
`--local-data` (so `npm run terminal:data` and a double-click on
`xau-terminal.cmd`) passes `--events official:repository`: with local data,
the macro summaries come from the official releases by default.

## What the view contains

- The CHAIN-0 envelope, copied unchanged: `HOLD`, execution `FORBIDDEN`,
  integrity, violations, input findings, knowledge cutoff and the replay
  digest. When CHAIN-0 rejects its input, the view carries the rejection and no
  stage at all.
- One row per stage, in CHAIN-0 order, with the state and the reason codes
  unchanged. Each reason code is classified by the blocker it names: `DATA`,
  `UPSTREAM`, `INTEGRITY`, `BUSINESS_DECISION`, `AUTHORIZATION` or
  `ENVIRONMENT`. A test keeps the classification equal to the reason-code
  unions of the twelve gates. A code with no category stays visible with a
  null category.
- Market Pricing fields with their value, status and age **at the cutoff**,
  their source and the replay mode. These are never statuses at reading time.
- Positioning evidence counts and authorities. There is no positioning signal.
- A capability matrix where each capability has one of four statuses:
  - `OPERATIONAL_LOCAL`: runs and is tested locally (the dry run, the digest
    and the integrity check);
  - `SIMULATED`: a stage that reports evidence, computed from fixture input;
  - `BLOCKED`: a stage that abstains, with its blockers;
  - `NOT_VALIDATED`: the V1 feed, which needs Supabase.

- `temporal`: `HISTORICAL` when the cutoff precedes generation by more than
  the existing XAUUSD LIVE window (360 s), `AT_GENERATION` within it,
  `UNKNOWN` when either time is unreadable or the cutoff is after generation
  (an impossible boundary: no negative age is ever shown).
- `holdRationale`: the first blocking stage, and the root causes grouped by
  category (every reason that is not `UPSTREAM`, distinct codes in stage
  order, with their stages). Inherited (`UPSTREAM`) reasons are counted.
  Unclassified codes are listed.

- `summary`, derived only from the rest of the view, for a first reading:
  - `decision` `HOLD` and `execution` `FORBIDDEN`, always;
  - `status`: `BLOCKED`, `INPUT_REJECTED` or `INTEGRITY_VIOLATED`, with a
    one-sentence `headline` and the blocked / total stage counts;
  - `mainReasons`: the root-cause categories, most codes first;
  - `missingData`: market fields not fresh at the cutoff, then `DATA`
    reasons (optional-field codes are not repeated when fields are listed),
    or the input errors of a rejected input;
  - `blockingDependencies`: every `BUSINESS_DECISION`, `AUTHORIZATION` and
    `ENVIRONMENT` root cause, with the stages that report it;
  - `missingAcceptanceEvidence`: undeclared E2E-0 evidence flags.
- `REASON_CODE_PLAIN_FR` gives each classified code one French sentence.
  A test keeps its keys equal to the classified codes and forbids raw codes
  and trade words in it. An unknown code has `plain: null`.

- `marketEvidence`: `null` when the market snapshot came as chain input.
  Otherwise it is the DATA-1 replay manifest
  (`docs/XAU_V2_MARKET_EVIDENCE_REPLAY_CONTRACT.md`):
  - status, nature and reproducibility;
  - archive id, class, digest and pinned digest, and replay digest;
  - coverage, reasons and post-cutoff audit counts;
  - each selected observation with its full provenance.

  The terminal refuses the whole view when:
  - `reproducible` disagrees with `VERIFIED`;
  - the nature disagrees with the archive class;
  - the nature is `HISTORICAL_VERIFIED` without a `VERIFIED` replay whose
    every value is `RAW_VERIFIED`.

- `horizons` (status and direction of H1–H5), `acceptance` (state and the
  eleven E2E-0 evidence flags *as declared in the chain input*) and
  `observability` (state, correlation and deployment IDs). The terminal refuses
  a horizon that does not abstain or that carries a direction.

`simulated` is always `true`. The origin is `GOLDEN_FIXTURE`,
`LOCAL_INPUT_FILE` or `LOCAL_SCENARIO`, never a production source.

## Terminal rules

The terminal shows nothing from a view unless all of the following hold:
- the schema version is exact;
- `simulated` is `true` and the origin is known;
- the chain is `HOLD` with execution `FORBIDDEN`;
- every status is known.

Otherwise it shows `VUE V2 REFUSÉE` and nothing else. Every string is written
as text, never as HTML.

| Situation | What the panel shows |
| --- | --- |
| `V2_VIEW_URL` empty (the published page) | `INDISPONIBLE` |
| Unreachable server | `VUE V2 INJOIGNABLE` (HOLD is kept) |
| Rejected input | `HOLD — ENTRÉE REJETÉE` |
| Violated integrity | `HOLD — INTÉGRITÉ VIOLÉE` |

The terminal has two workspaces: **MARCHÉ** (the V1 panels) and **CHAÎNE V2**.
They are accessible tabs, selected by `#marche` / `#chaine` or by the
remembered choice. A bar visible from both always states the nature of the
data:

| Label | Meaning |
| --- | --- |
| `DÉMO` | synthetic values generated by the browser (V1 without backend) |
| `SIMULATION` | engines run on a fixture or local file (every V2 view) |
| `HISTORIQUE` | the V2 cutoff is outside the current window |
| `HISTORIQUE VÉRIFIÉ` | DATA-1 replay of a captured archive: complete, valid, every value re-read from its bytes |
| `ARCHIVE SYNTHÉTIQUE` | DATA-1 replay of a synthetic archive: a simulation |
| `LIVE` | real V1 feed whose freshness is within the threshold, nothing else |

The decision always reads `HOLD — EXÉCUTION INTERDITE`. A market field that
was `LIVE` at a simulated cutoff is shown as `FRAIS AU CUTOFF`: the word
`LIVE` never appears in the CHAÎNE V2 workspace. A `LÉGENDE` in the bar
defines every label. Inside the workspace, a sticky navigation bar keeps the
full nature of the view visible (origin, `HISTORIQUE` and cutoff age, `PAS
UNE ANALYSE RÉELLE`) and links to each section without changing the address.

The workspace reads top-down: status, decision summary (state, main
reasons, missing data, blocking dependencies), facts, why HOLD (one plain
sentence of what stops the chain and what would lift it, then one folded
card per category with the plain reasons, codes and stages), stages (folded,
with reason counts; `TOUT DÉPLIER` opens them all). Every reason code stays
in the page; a refresh keeps what the reader unfolded. Below 900 px the page
is the only vertical scroller.

In V1 demo mode:
- the price badge reads `DÉMO`, never `LIVE`;
- demo headlines are prefixed `[DÉMO]`;
- no analysis, verdict, setup or scenario is fabricated.

## Local start

```sh
npm ci
npm run terminal:local                    # http://127.0.0.1:4173/ (golden fixture)
node scripts/serve_terminal_local.mjs --port 4180 --input path/to/chain-input.json
```

The input file has the CHAIN-0 shape `{ knowledgeCutoff, input }`.

### Launcher (Windows and WSL)

- **Windows:** double-click `scripts/terminal/xau-terminal.cmd` (open it from
  `\\wsl.localhost\<distribution>\…\scripts\terminal\` or copy it to the
  desktop). From the repository it derives the WSL distribution and the
  checkout from its own location; a copy uses the two values at its top. It
  runs `wsl.exe -d <distribution> --cd <checkout> -- sh scripts/terminal/xau-terminal.sh`.
  It changes no system setting and installs nothing.
- **WSL / Linux:** `npm run terminal` (or `sh scripts/terminal/xau-terminal.sh`).
- `xau-terminal.sh` finds Node.js on `PATH`, else the newest version installed
  by nvm (`$NVM_DIR` or `~/.nvm`), without a pinned version path, and runs
  `scripts/terminal_launch.mjs`.
- `terminal_launch.mjs` checks the checkout (dependencies, Node ≥ 22), reuses a
  server already started from the same checkout (`GET /local/v2/health.json`
  on the port range: app, root, pid, args) instead of starting a second one —
  only when that server runs with the same data options (port options aside,
  in any order);
  otherwise it refuses (exit 1) and says to `--stop` it first, so a launch
  asking for `--captures` or `--archive` never shows other data — starts
  `serve_terminal_local.mjs`, waits until the view answers over HTTP with a
  HOLD / FORBIDDEN chain, and only then opens `http://localhost:<port>/#chaine`
  (Windows default browser from WSL, `xdg-open` elsewhere, or
  `XAU_TERMINAL_BROWSER`); otherwise it prints the URL. It follows the
  server's port fallback, stops the server on Ctrl+C / SIGTERM / SIGHUP,
  `--stop` stops this checkout's server, `--status` reports it, `--no-browser`
  skips the browser, and other options (`--port`, `--port-range`, `--input`,
  `--archive`, `--archive-digest`, `--cutoff`) pass through. Exit: 0 ok, 1
  server failure, 3 environment, 64 usage.
- Test: `tests/test_terminal_offline_finalisation.mjs`. The `.cmd` itself is
  only checked statically: no Windows host in CI.

Data labels on screen: MARCHÉ tab = **DÉMO — VALEURS SYNTHÉTIQUES** (random
demo values; no gold impact is ever read from them); CHAÎNE V2 = **SIMULATION —
FIXTURE / SCÉNARIO / FICHIER LOCAL**, **ARCHIVE SYNTHÉTIQUE**, or with
`--archive` on a captured archive **HISTORIQUE NON VÉRIFIÉ** and, per input,
**ARCHIVE CAPTURÉE — NON CERTIFIÉE**; **HISTORIQUE VÉRIFIÉ** only for a fully
re-read, complete replay. Nothing is ever labelled live.

`GET /local/v2/scenarios.json` lists local simulation scenarios derived from the
golden fixture (`scripts/lib/terminal_scenarios.mjs`). `GET
/local/v2/terminal.json?scenario=<id>` serves one of them, with origin
`LOCAL_SCENARIO`. An unknown id returns 404. The scenarios are:
- `golden`;
- `everything-granted` (every grantable authorization, still HOLD);
- `read-7-days-later`;
- `market-unavailable`;
- `lookahead` (price 500 µs after the cutoff);
- `invalid-input`.

The terminal offers them in a selector, **SCÉNARIO DE SIMULATION**, which opens the
CHAÎNE V2 panel (above the status) with a one-line count and a reminder that every
scenario is a simulation that stays HOLD. The ready line of the server says where it
is (`http://127.0.0.1:<port>/#chaine`). The terminal shows only the latest requested
view. Each scenario is a simulation, never market data.

The server:
- binds `127.0.0.1` only (fixed in code, no option widens it) and accepts only `GET` and `HEAD`;
- port: without `--port` it takes 4173 or, if busy, the next free port among the 10 starting
  there (the ready line shows the port actually used, and a line says the first was busy);
  an explicit `--port N` is strict, and `--port N --port-range K` (1–50) allows the next K-1
  ports; when none is free it prints one readable line and exits 1;
- starts as `npm run terminal:local` does and is checked on the REAL process
  (`tests/test_terminal_cli_process.mjs`): the ready line gives the URL, HOLD and how to
  stop (`Ctrl+C`); every scenario returns a simulated HOLD / FORBIDDEN view with the 12
  CHAIN-0 stages in order, an origin, a cutoff and a fingerprint only for an accepted
  receipt (or a stated rejection with no stage and no fingerprint); a port already in use
  or forbidden prints one readable line and exits 1 (no stack trace); invalid arguments
  print the usage and exit 1; SIGTERM stops it and frees the port;
- refuses with `403` any request whose `Host` header is not exactly
  `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard, every route,
  including a missing `Host`); proven by `tests/test_terminal_local_host_guard.mjs`;
- turns any `--input` / `--archive` content (invalid JSON, `null`, an array, a BOM,
  100,000 levels of nesting, binary bytes, a directory, a missing path) into a
  simulated HOLD / FORBIDDEN view, never a `500`; a requested archive pin is always
  applied, so an empty or wrong `--archive-digest` fails the replay instead of
  disabling it (`tests/test_terminal_local_hostile_files.mjs`);
- shows a chain fingerprint only if it has the `sha256:<64 hex>` shape and the chain is
  `CONSISTENT`;
- never leaves a half-drawn view: for 18 views that pass the client guard but carry `null`
  items, wrong types or minimal sections, the page either draws the whole view or falls back
  to its refused / error state with nothing of the view visible, and raises no uncaught page
  error (`tests/test_terminal_render_isolation.mjs`);
- serves `frontend/` read-only and refuses paths outside it;
- serves the page with a strict Content-Security-Policy: the only inline
  script allowed is the configuration block, by its SHA-256 after injection;
  network access is limited to this server (no web font, no foreign
  stylesheet: the typography is the system's, `IBM Plex` only if already
  installed); framing is denied;
- injects `V2_VIEW_URL` only into the page it serves.

It makes no database, provider, broker or network call. The Supabase settings
stay empty, so the V1 panels run in labelled demo mode.

### Archive replay cutoffs (`--archive`)

With `--archive`, the server also answers `/local/v2/archive-cutoffs.json`
(`xau.terminal-archive-cutoffs.v1`): the distinct reception instants
(`ingestedAt`) of the archive records in time order (at most 500, the latest;
`truncated` says so), and `defaultCutoff`, the cutoff used without a choice
(`--cutoff`, else the input document's). `/local/v2/terminal.json?cutoff=ISO`
replays the archive at that instant: an explicit UTC instant only, in archive
mode only and never with `?scenario=` (HTTP 400 otherwise); without
`--archive` the list is 404 and the served page does not carry its URL
(`V2_ARCHIVE_CUTOFFS_URL` stays empty), so the default page never asks it. The
page shows a **CUTOFF DE REJEU (ARCHIVE)**
selector only when the list has instants, and disables it while a scenario
is selected. A replay knows only what the archive had received at that
instant; the other inputs stay those of the input document, so a cutoff that
differs from theirs is reported by CHAIN-0 as `UPSTREAM_CUTOFF_MISMATCH`.
Every replay is HOLD, execution forbidden. Both routes sit behind the Host
guard. `receptions` gives, for each instant (same order as `cutoffs`), the
market fields whose records arrived then; the selector labels each instant
with them ("réception 3/5 · VIX"). The choice is kept in the page anchor,
`#chaine/scenario/<id>` or `#chaine/rejeu/<instant>`, and restored on load
only when that scenario or instant exists (otherwise the server's input is
shown), so a reload or a shared link shows the same replay. The list also carries `fields`: for each of the eight market fields,
the number of records, their sources and the first/last observation and
reception instants, whatever the cutoff (counts and ranges, no judgement); the
page shows them under **DISPONIBILITÉ DE L'ARCHIVE PAR CHAMP**, a field
without records reading "aucun enregistrement". `captureSeries` says whether
the DATA-2 capture tooling defines a series for the field (`CAPTURE_SERIES`;
null when unknown): DXY, bid and ask have none, so no capture can ever fill
them until a source is decided, and the page says "aucune série de capture
définie (source à décider)" instead of suggesting a failed capture.

### Capture logs (`--captures DIR`)

`--captures DIR` shows DATA-2 capture logs without a separate merge step:
every `DIR/<capture>/archive.json` is read (never written) and merged in
memory with the DATA-3 merge (`mergeCaptureArchives`: every body re-read,
reception order, no declared coverage, `CAPTURED` only if every log is). The
result is replayed like an `--archive` (same views, replay cutoffs and
availability), its origin label naming the directory and the number of logs.
Without `--cutoff` the replay is at the **last reception instant**, so the
captures are visible at launch (`--archive` keeps the input document's
cutoff). A failed merge (no log, unreadable directory or file, a log whose
bytes no longer give its values, ambiguity) supplies no market at all: the
replay rejects it, HOLD, and the server's start line gives the reasons.
For `--captures`, `archive-cutoffs.json` also carries `captures` (`sources`,
`merged`, `problems`); when the merge failed, the page shows "CAPTURES NON
FUSIONNÉES (…) : <reasons>" in place of the replay selector. An archive that
cannot be read at all (unreadable file, failed merge) is replayed as
`INVALID` with no provenance class; the page draws it as ARCHIVE REJETÉE,
HOLD (before this, it refused the whole view as "nature de marché
incohérente"), and still refuses such a view if it claims a historical
nature, carries observations or is not `INVALID`. `--captures` and
`--archive` are exclusive. Example (WSL):
`npm run terminal -- --captures ~/.local/share/xau-v2/evidence`. The launcher's
`--captures-local` means exactly that directory (the capture tooling's own,
as in `validate_evidence_captures.mjs`), and on Windows
`scripts/terminal/xau-terminal-captures.cmd`, kept next to
`xau-terminal.cmd`, calls it with `--captures-local` (double-click; not run
on a Windows host here).

### Local data catalog (`--data-root DIR`, DATA-TO-TERMINAL)

`--data-root DIR` makes the operator's local data **selectable in the page**,
none selected by default (the server's input stays the default view):

- `DIR/evidence/<log>/archive.json`: each DATA-2 capture log on its own
  (`log:evidence:<log>`) and their in-memory DATA-3 merge (`merged:evidence`);
  a log that cannot be read is listed with `SOURCE_UNREADABLE`, and the merge
  then fails closed (pick the logs one by one);
- `DIR/positioning/<file>` with `<file without extension>.declaration.json`
  (`xau.cftc-cot-declaration.v1`: `dataset`, `publishedAt`, `receivedAt`,
  optional `reportDate`, `contractMarketCode`, `artifactId`, `sourceUrl`
  (https only), `publicationBasis` (`{kind: EXPLICIT_OFFICIAL_MAPPING |
  OFFICIAL_SCHEDULE_INFERRED, reference: https://www.cftc.gov/…}`, shown in the
  card; absent = "déclaration de l'opérateur seule"); each CFTC entry also gives
  `fileReports` (count, first and last report date of the market in the
  file, from its rows, declared or not); any other key is `DECLARATION_INVALID`; an `artifactId` that
  is not the file's sha256 is `DECLARATION_DIGEST_MISMATCH`): CFTC COT files (`cot:<file>`). Without a valid
  declaration a file is never converted (`DECLARATION_MISSING` /
  `DECLARATION_INVALID`, its format problem named when visible); unknown
  formats and other CFTC reports are named by the adapter
  (`UNSUPPORTED_FORMAT`, `UNSUPPORTED_LAYOUT`). File and directory names must
  match `[A-Za-z0-9._-]`; others are listed in `notes` and ignored.

`/local/v2/catalog.json` (`xau.terminal-data-catalog.v1`, behind the Host
guard) lists the market sources (`input`, `archive` for `--archive`,
`merged:*`, `log:*`) with kind, label, provenance class, archive id, record
count, fields, observed and received periods, declared coverage, and the
validation state DATA-1 gives the archive replayed after its last reception
(status, nature, reason codes), plus problems; and the positioning sources
(`input`, `cli-cot` for `--positioning-cot`, `cot:*`) with status, dataset,
report date, declared instants, metric count, artifact digest, reasons;
`sourceApproval` is always `NOT_APPROVED`. No path reaches the page: it sends
catalog ids only (`?market=`, `?positioning=`, with `?cutoff=` for an archive
source); anything else is 400, an unknown id 404, a scenario with a data
source 400. `archive-cutoffs.json?market=<id>` lists that source's replay
instants. Defaults: `--archive` → `archive`, `--captures` → its merge,
`--positioning-cot` → `cli-cot`, otherwise `input`. A capture log or merge
replays at its last reception unless `--cutoff` or a chosen instant says
otherwise. Everything is read once at start (restart to see new files).

The page shows a **DONNÉES LOCALES** panel (two selectors, Marché and
Positionnement, hidden when there is nothing to choose) and one card per
chosen source with those facts. Changing the market resets the replay
instant and loads that source's instants; a scenario disables the panel. The
choice is kept in `#chaine/donnees/<market>/<positioning>[/rejeu/<instant>]`
and restored only when every id exists. Every view stays HOLD / FORBIDDEN; a
CFTC file is at most `LOCAL_INPUT_UNVERIFIED`, a rejected one supplies
nothing; no positioning method is approved.

Inspecting a file first: `node scripts/cot_declare.mjs FILE --inspect` (writes
nothing). The declaration written by the script records the file's sha256
and, with `--source-url`, where the operator says it came from (shown, not
verified); the positioning card shows them with the file's own date column
and `FutOnly_or_Combined` value.

Declaring a CFTC file: `node scripts/cot_declare.mjs FILE --dataset
futures-only|futures-and-options --published-at ISO --received-at ISO
[--report-date YYYY-MM-DD]` converts it first with the same adapter and
writes `<name>.declaration.json` only when it converts (create-only, never
replaced; a refusal names the reason and, for a multi-report file, the report
dates present). Declaring approves nothing.

`notes` explain what is missing: `EVIDENCE_DIR_ABSENT`,
`POSITIONING_DIR_ABSENT`, `POSITIONING_DIR_UNREADABLE:<code>`, ignored file
names. The page writes them in plain words (where to put capture logs and
CFTC files) and keeps the panel visible for them, without empty selectors.

Launch: `npm run terminal:data` (WSL) or the launcher's `--local-data`
(= `--data-root ~/.local/share/xau-v2`); `scripts/terminal/xau-terminal.cmd`
passes `--local-data`, so a double-click on Windows offers the local data.

## Layout check in a browser

CI has no browser. `scripts/check_terminal_layout.mjs` checks the terminal in
headless Chromium at 320, 390, 1024, 1280 and 1440 px, in both workspaces,
with every section unfolded, on the `market-unavailable` and
`invalid-input` scenarios, and in `--archive` mode on an earlier replay
cutoff, and with `--data-root` on a capture log and a CFTC file. It reports clipped content, content overflowing
the viewport, text below WCAG AA and, below 900 px, any nested vertical
scroller. It needs `XAU_PLAYWRIGHT` (path to `playwright-core`) and `XAU_CHROMIUM`,
neither of which is a project dependency. `tests/test_terminal_contrast.mjs`
keeps the palette's contrast in CI.

## Not authorized by TV-0

TV-0 does not authorize:
- CC-1 (that requires a reviewed UI mapping, runtime correlation and
  deployment proof);
- any deployment of the view, or a published `V2_VIEW_URL`;
- persistence, provider calls, alerts, orders or trading.

Module: `backend/decision_chain/terminal_view.ts`, inside the CHAIN-0
containment (no runtime module imports it). Tests:
`tests/test_terminal_view.mjs`, `tests/test_terminal_local.mjs`.

## TV-2 demo news trust boundary (2026-10-14)

In the local terminal with no configured historical V1 backend, demonstration news is **illustrative only**: fictional headlines, fictional time labels, no news score, no CATALYST/MAJOR classification and **no bullish/bearish or neutral gold-impact claim**. The UI displays `DÉMO`, `NON ÉVALUÉ` and `OR — NON ÉVALUÉ (DÉMO)`; it must not imply source authentication or methodology approval. The non-demo V1 rendering logic and the independent V2 HOLD/ABSTAIN/FORBIDDEN contract are unchanged. `tests/test_terminal_local.mjs` enforces the display and fixture properties in jsdom. No live source, broker, execution, alert, deployment, migration or REC-1 permission is implied.
