# CHAIN-0 synthetic offline CLI

Run from repository root after `npm ci`:

```sh
npm run chain:offline
```

This command uses a fixed **synthetic, explicitly non-live fixture** at
`tests/fixtures/chain0_hold_synthetic.json`. It composes the CHAIN-0
institutional gates, derives the OBS-0 checksum and prints a safe JSON
summary showing the single cutoff, ten stage statuses, abstention
reasons, `HOLD`, `FORBIDDEN` and `NOT_ACCEPTED`.

It cannot accept arbitrary file paths, API credentials, live account
data or runtime options. Command arguments are rejected. It calls
no market or AI provider, Worker, database, Supabase, broker or
notification channel. Temporary transpiled files remain local and are
deleted after module loading. The SHA-256 checksum **does not** prove
that any real economic event happened or that a production service ran.

To test determinism and refusal of a `--production` argument:
`node tests/test_chain_0_offline_cli.mjs`.

This capability is a controlled architectural demonstration, not a
trading-signal generator or E2E production acceptance runner. REC-1,
deployment and all live activation rights remain separate Human Gates.
