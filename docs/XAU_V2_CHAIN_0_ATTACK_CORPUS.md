# CHAIN-0 / OBS-0 adversarial corpus

The deterministic corpus `tests/fixtures/chain_0_negative_corpus.json`
covers version/schema mismatch, a knowledge-cutoff mismatch, an invalid
cutoff, insufficient event evidence, unavailable market pricing and
unavailable gold transmission. Each case proves reason-code propagation
into the existing institutional chain and keeps
`HOLD / ABSTAIN / FORBIDDEN` end-to-end.

The test also sends untrusted `AUTHORIZED` flags that are **not part
of the CHAIN-0 input contract** and confirms they do not change its
result. Even when all available event/pricing status labels are
spoofed as `ASSESSED` or `AVAILABLE`, unapproved semantic methods and
missing positioning keep the result blocked.

**Coverage boundary:** this is a simulation using pre-built upstream
envelopes, not an upstream release-vintage parser or a time-travel-proof
price selection test. Such validation must remain within the
Market Pricing, Positioning, Event Facts and Event Impact contracts;
CHAIN-0 must not duplicate their business logic.

Do not classify these negative cases as a production acceptance run.
No deploy, migration, live provider, execution, broker or alert is involved.
