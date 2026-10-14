# XAU V2 — local terminal view (TV-0)

Status: `LOCAL_ONLY — NOT DEPLOYED — NOT CC-1`

TV-0 lets the static terminal show the V2 chain without any runtime. A
loopback server runs CHAIN-0 on a local input and serves a read-only view;
the terminal renders it in two panels: **Chaîne décisionnelle V2** and
**Matrice des capacités**.

Frozen versions:

- `xau.terminal-local-view.v1`;
- `terminal-local-view-1.0.0`.

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

`simulated` is always `true`. The origin is `GOLDEN_FIXTURE` or
`LOCAL_INPUT_FILE`, never a production source.

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

The input file has the CHAIN-0 shape `{ knowledgeCutoff, input }`. The server:
- binds `127.0.0.1` only and accepts only `GET` and `HEAD`;
- serves `frontend/` read-only and refuses paths outside it;
- injects `V2_VIEW_URL` only into the page it serves.

It makes no database, provider, broker or network call. The Supabase settings
stay empty, so the V1 panels run in labelled demo mode.

## Not authorized by TV-0

TV-0 does not authorize:
- CC-1 (that requires a reviewed UI mapping, runtime correlation and
  deployment proof);
- any deployment of the view, or a published `V2_VIEW_URL`;
- persistence, provider calls, alerts, orders or trading.

Module: `backend/decision_chain/terminal_view.ts`, inside the CHAIN-0
containment (no runtime module imports it). Tests:
`tests/test_terminal_view.mjs`, `tests/test_terminal_local.mjs`.
