# XAU V2 — AI Committee dependency contract (C-0)

Status: `CONTRACT_CI_PROVEN — PROVIDER INVOCATION FORBIDDEN`

C-0 freezes the fail-closed boundary between the versioned H1–H5 synthesis
and any future AI Committee V2 request. It accepts only the exact S-0 schema
and algorithm identities, one shared knowledge cutoff and the exact ordered
H1–H5 set.

Frozen versions:

- `xau.ai-committee-gate.v1`;
- `ai-committee-dependency-gate-1.0.0`.

## Current output

C-0 always emits an explicit abstention with `providerInvocation=FORBIDDEN`,
`request=null` and `response=null`. It records missing horizon readiness,
provider authorization, cost authorization and V2 methodology approval as
separate reason codes.

The existing `committee_output.schema.json`, prompts and orchestrator are
legacy runtime assets. They are not accepted as XAU V2 evidence and C-0 does
not call, adapt, persist or deploy them. In particular, C-0 does not transform
S-0 abstentions into legacy bullish, bearish or neutral scenarios.

## C-1 closure requirements

C-1 must separately freeze the provider and model allowlist, prompt identity,
structured request/response schemas, evidence citations, deterministic
validation, token and monetary budgets, retry/timeout policy, audit fields,
redaction, replay semantics, failure containment and explicit abstention.
Positive invocation additionally requires ready H1–H5 inputs and explicit
provider, cost and runtime authorization.

C-0 authorizes no LLM call, provider purchase, secret use, persistence,
migration, deployment, schedule, notification, broker connection or trading.
