# ARCH-2 — Institutional decision-layer purity check

Status: `STATIC CI GUARD / NO RUNTIME CHANGE`.

Institutional gate builders must stay deterministic and provider-independent.
The test `tests/test_institutional_purity_guard.mjs` uses the TypeScript
parser to scan the ten existing V2 gate modules (plus optional CHAIN-0 and
OBS-0 modules if those branches are later merged) for common violations:

- direct imports of the Worker, legacy news ingestion, or legacy Committee;
- external/bare package imports in this intentionally dependency-light layer;
- direct network, timers, randomness, environment secrets, dynamic import,
  wall-clock reads, or WebSocket/EventSource construction.

It deliberately allows `Date.parse(explicitInput)`, and the optional
OBS-0 offline `crypto.subtle.digest` over a deterministic byte string:
neither constitutes an unobserved data-provider read.

The guard is tested against eight small negative examples. It is **not**
a JavaScript/TypeScript effect system: clever aliases, indirect imports,
side effects hidden in helpers, runtime reflection and monkeypatching
still require review. Do not weaken the CI guard merely to attach an
unapproved LLM/broker/cron call.

This change requires no provider, database, migration or deployment and
does not alter the runtime behavior, broker authority, alert delivery
or REC-1. `main` remains frozen until explicit permission.
