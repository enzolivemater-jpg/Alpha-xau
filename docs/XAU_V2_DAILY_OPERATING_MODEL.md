# XAU V2 — Daily Operating Model

**Status:** DRAFT v2 — corrected after independent architecture review
(XAU-V2-GOV-008)
**Scope:** product/runtime behavior and operator experience. This
document defines **what the production terminal must do for the
operator every day** — it does not define how developers build XAU V2
(see `docs/XAU_V2_RESOURCE_REGISTRY.md` for that), and it implements
nothing: no runtime, database, secret, cron, provider, prompt, risk
limit, or trading-logic change accompanies this file.

**Core principle:** development AIs (ChatGPT, Claude Code, Gemini) build
and audit XAU V2. **The production terminal must operate without
requiring any of them for normal daily trading use.** The daily operator
workflow is terminal-centric — a human reads a screen, not a
conversation with an AI assistant, to trade gold day to day.

Every capability below is labeled `CURRENT`, `PARTIAL`, `TARGET`, or
`NOT_IMPLEMENTED`. A target capability is never presented as already
existing. Where an existing frontend element already covers part of a
target concept, this document says so explicitly rather than either
ignoring it or overstating it as complete.

---

## 1. Target Pipeline

```
DATA SOURCES
  → DATA QUALITY / FRESHNESS
  → RAW OBSERVATIONS
  → EVENT CLUSTER
  → EVENT VERSION
  → NOVELTY / CONFIRMATION / CORRECTION / REVERSAL
  → EVENT IMPACT
  → GOLD TRANSMISSION
  → MARKET PRICING / POSITIONING / REGIME
  → H1 / H2 / H3 / H4 / H5
  → AI COMMITTEE (orchestration layer)
      → ANALYST LAYER
      → PRE-PM EVIDENCE/RISK GATE
      → PORTFOLIO MANAGER PROPOSAL
      → FINAL ACTION RISK GATE
  → ACTION / ABSTENTION
  → COMMAND CENTER + SCENARIO TREE
  → ALERTS
  → AUDIT TRAIL
```

The Committee/PM/Risk stages are expanded beyond a single arrow here
because § 10 corrects a specific sequencing gap; see that section for
the full rationale.

### Horizon contract (fixed — used everywhere in this document)

| Horizon | Window |
|---|---|
| H1 | 1–2 hours |
| H2 | 4 hours |
| H3 | 24 hours |
| H4 | 7 days |
| H5 | 30 days |
| structural_tail | beyond 30 days |

There is no H6. Anything beyond H5's 30-day window is `structural_tail`,
not a numbered horizon.

---

## 2. Current vs. Target — headline facts

| Fact | Status |
|---|---|
| Market-data engine (Twelve Data, XAUUSD) | `CURRENT` |
| FRED macro inputs (US10Y, real yield, VIX, WTI) | `CURRENT` |
| DXY as a macro input | `NOT_IMPLEMENTED` — displayed in the UI, but no working data provider exists (Twelve Data does not carry the symbol; confirmed, not assumed) |
| Official RAW collectors (Fed, ECB, US Treasury, OFAC) | `CURRENT` |
| GDELT / NewsAPI legacy scored news flow → notifications → Committee | `CURRENT` |
| Internal engine-to-engine Committee recalculation trigger | `CURRENT` — see § 13 |
| Official RAW flow reaching event clustering | `PARTIAL` — Event Cluster/Event Version foundation implemented and live-proven (deterministic official-source processing, append-only membership/version persistence, 45 live Event Versions independently reconciled as of this review); reachable only through a controlled authenticated manual runtime — no automatic/cron backlog draining exists |
| H1–H5 scenario contract (schema, validation, generation) | `CURRENT` for direction/probability/target/invalidation/confidence/reasoning; `NOT_IMPLEMENTED` for event-level magnitude — see § 6 |
| AI Committee architecture (multi-agent LLM pipeline) | `CURRENT` |
| Anthropic (Committee's LLM provider) | `CURRENT` integration, **currently blocked** (insufficient account credit) — not reactivated by this document or this task |
| Command Center (existing frontend shell) | `CURRENT`/`PARTIAL` — a real Command Center panel, Macro Driver Matrix, Scenario Tree, NO VALID SETUP presentation, invalidations list, and AI bias/conviction/market-regime/execution-status fields already exist in the frontend today |
| Enriched institutional Command Center (this document's target) | `NOT_IMPLEMENTED`/`PARTIAL` by capability — event cluster/version, pricing, positioning, full source confidence, and state-change explanation are not yet part of it — see § 15 |
| Portfolio Manager / Risk Committee concepts | `PARTIAL` — real, deterministically-enforced roles exist inside the Committee's LLM pipeline; the target defense-in-depth sequencing (a distinct pre-PM gate and a distinct post-PM final-action gate) does not — see § 10 |
| Automatic broker execution | `NOT_IMPLEMENTED` (and not a near-term goal — see § 19) |

---

## 3. The six questions the terminal must answer

Before the terminal may express any view on gold, it must be able to
answer, in this order:

1. **What is happening?**
2. **Is it true?**
3. **Is it new?**
4. **Why does it matter for gold?**
5. **Is it already priced?**
6. **Does the risk justify action?**

Only after these six may the terminal answer the seventh, operator-facing
question: **"What should I do?"** A terminal that answers question 7
without being able to answer 1–6 is not trustworthy, regardless of how
confident its output looks.

Status: `PARTIAL`. Questions 1 ("what is happening") and 4 ("why does it
matter") are addressed today by the Committee's analyst/risk-committee
LLM narrative, and question 6 is partially addressed by the Risk
Committee's deterministic veto (§ 10). Questions 2 ("is it true" — source
independence, official-vs-secondary confirmation), 3 ("is it new" — event
novelty/confirmation/correction/reversal), and 5 ("is it already priced")
have no dedicated mechanism yet (§ 7, § 9).

---

## 4. System Health / Data Quality

### Global freshness/quality states

`LIVE` · `FRESH` · `STALE` · `MISSING` · `INVALID` · `UNVERIFIED`

### RAW news quality states (distinct, narrower vocabulary)

`VALID` · `DEGRADED` · `UNVERIFIED`

These are not interchangeable: the global states describe *any* data
feed's freshness/health; the RAW news states describe the quality
assessment of one ingested news observation specifically.

The terminal must visibly expose, at all times:

- market data freshness (staleness of the live XAUUSD price and related
  market variables)
- macro data freshness, **per driver** (see § 8 — a working driver and a
  provider-less driver like DXY must never be presented identically)
- official-news (RAW) freshness
- broad-news (legacy GDELT/NewsAPI) quality
- AI provider availability (Committee LLM up/blocked/degraded)
- data conflicts between sources
- degraded providers, named explicitly
- last successful update, per feed
- the confidence impact caused by any degraded input — a degraded input
  must lower displayed confidence, never disappear silently

**A degraded provider must never silently appear healthy.** This is a
hard requirement, not a preference: if a provider is stale, missing, or
returning low-quality data, the terminal must say so on the primary
screen, not bury it in a log.

Status: `PARTIAL`. A per-feed staleness/freshness concept already exists
in the market-data engine (age-based validation, an explicit `N/A` state
for missing market variables rather than a fabricated zero) and in RAW
news ingestion (`VALID`/`DEGRADED`/`UNVERIFIED` already exist as a real
column on the RAW observation table). A durable, cross-provider circuit
for the Committee's LLM provider exists and is proven in production
(detects and surfaces a blocked/unavailable state rather than retrying
blindly). What does **not** exist yet is a single, unified, operator-facing
system-status view that aggregates all of the above into one glance —
today this information is derivable from logs and database state, not
presented as one screen, and per-driver freshness (§ 8) is not yet
surfaced distinctly from per-driver *availability* (DXY has neither today).

---

## 5. Event Operating Model

Three distinct objects, never conflated:

- **RAW OBSERVATION** — one ingested item from one provider at one point
  in time. Immutable once written. A correction from the same upstream
  source arrives as a *new* RAW observation, never an edit to an old one.
- **EVENT CLUSTER** — the stable identity of one real-world event,
  independent of how many observations (from how many providers)
  describe it.
- **EVENT VERSION** — the current knowledge state of one event cluster,
  as of the latest observation that changed it.

Event versions must be classified, at minimum, as one of:

`NOVELTY` · `CONFIRMATION` · `CORRECTION` · `REVERSAL`

**Article count alone must never equal confirmation.** Ten outlets
syndicating the same wire story is one piece of evidence, not ten.
**Source independence must be tracked explicitly**, and **official-source
confirmation must be visually and structurally distinguishable from
secondary-media confirmation** — a central bank's own statement
confirming an event is not the same evidentiary weight as five news
sites republishing a rumor.

**No LLM may be the sole mechanism defining event identity.** Event
clustering must be deterministic-first (entity/time/source matching,
canonical identifiers where available), with any LLM involvement limited
to optional enrichment or ambiguity resolution — never a required
ingestion dependency. This mirrors the resource registry's standing
architectural decision that AI must not be required for raw ingestion.

Status: `PARTIAL`. RAW observations exist today exactly as described
(immutable, append-only, correction-safe). The Event Cluster / Event
Observation Membership / Event Version / Event Version Evidence
foundation is now **implemented and live-proven** (OPS-023):
deterministic official-source processing for Fed/ECB/Treasury/OFAC RAW
observations, append-only cluster/membership/version persistence, and a
controlled authenticated **manual** runtime that has independently
reconciled 45 live Event Versions end to end (creation, idempotent
replay, and bounded discovered-batch proofs up to 25 candidates in one
authenticated call). Every live-exercised version so far is
`transition_type = NOVELTY` against a `SINGLE_EDITORIAL_ORIGIN` source;
`CONFIRMATION`/`CORRECTION`/`REVERSAL` classification and the other three
`source_independence_state` values exist in the schema's fixed
vocabulary but have **no live-exercised example yet**. Event cluster
relation topology and strong-identity-claim primitives also exist in the
schema but remain unexercised in production (zero relation operations,
zero relation edges, zero identity claims as of this review). **There is
no automatic or cron-driven backlog draining** — every mutation to date
was operator-triggered through the authenticated manual endpoint;
discovery is state-derived (never a cursor/watermark), so the remaining
backlog stays reachable on demand at whatever pace an operator chooses.
The legacy GDELT/NewsAPI path has a much weaker, article-level notion of
identity (exact-title deduplication only), which remains not a
substitute for event clustering. OPS-023's implementation work is
complete for this Event Cluster/Event Version foundation; the next
architecture stage — Event Impact (§ 6) — remains a separate,
`NOT_IMPLEMENTED` effort, not automatically advanced by this
foundation's completion.

---

## 6. Event Impact Contract

Event impact must be expressed as **separate dimensions**, never
collapsed into a single number:

- **direction** — bullish / bearish / neutral
- **magnitude** — expected size of effect
- **confidence** — how sure the system is
- **horizon** — which of H1–H5 (or structural_tail) it affects
- **pricing state** — unpriced / partially priced / largely priced /
  uncertain

The operator must be able to see all five independently, plus **major
competing interpretations** when analysts or sources disagree on what an
event means.

The Event Impact object described above belongs at **EVENT VERSION**
level (§ 5). The Event Cluster/Event Version foundation this object
would attach to now exists and is live-proven (§ 5) — but that upstream
existence does not by itself advance Event Impact: **the institutional
Event Impact object remains `NOT_IMPLEMENTED` as an end-to-end stage** —
there is no single object, tied to a specific event version, that
carries direction/magnitude/confidence/horizon/pricing together today,
and no implementation work on Event Impact itself has been built or
approved. The Committee's per-scenario direction/confidence/horizon
fields are real, but they belong to a scenario, not to a versioned
event, and must not be read as if they were already the target Event
Impact object.

**TARGET EVENT IMPACT OBJECT:** `NOT_IMPLEMENTED`

**CURRENT FOUNDATIONS / PRECURSORS:** `PARTIAL` — the following exist
today and are usable building blocks, but are not yet assembled into one
event-version-level Event Impact object:
- legacy article-level `gold_direction_impact` (a per-article directional
  tag in the legacy news schema)
- legacy transmission metadata (the scoring engine's keyword-rule channel
  tags — § 7)
- Committee scenario direction/confidence/horizon (per-scenario, not
  per-event-version)

Status by dimension:
- **direction, confidence, horizon**: `PARTIAL` — real precursor signals
  exist (legacy `gold_direction_impact`, and the Committee's per-scenario
  direction/probability/horizon fields), but none of them are yet
  expressed as a single event-version-level Event Impact object.
- **magnitude**: `NOT_IMPLEMENTED`. There is no populated, distinct
  event-level magnitude field today. The legacy news schema carries an
  `expected_move_usd` type, but current scoring deliberately leaves it
  `NULL` rather than invent an amplitude — this is correct, disciplined
  behavior, not a bug to route around. **`news_score`, target distance,
  and probability must not be substituted for magnitude** — each of
  those measures something else (impact classification, a scenario's
  price target, and confidence, respectively), and conflating any of
  them with "how big is this event's expected effect" would misrepresent
  what the system actually knows.
- **pricing state**: `NOT_IMPLEMENTED` — no pricing-state concept exists
  anywhere in the system today (§ 8).
- **competing interpretations**: visible only inside the Committee's
  narrative text (reasoning fields) today, not as a structured,
  comparable object — `PARTIAL`.

---

## 7. Gold Transmission

Every event-level view the terminal expresses must be traceable through
an explicit causal chain:

```
EVENT → TRANSMISSION CHANNEL → MARKET VARIABLE → GOLD EFFECT
```

Candidate transmission channels include: nominal yields, real yields,
USD, monetary-policy expectations, inflation expectations, risk-off/safe
haven demand, liquidity, geopolitical risk, positioning/crowding,
physical/ETF/structural demand, and volatility.

**No black-box "bullish because the AI says so" is acceptable.** Every
directional call must be attributable to at least one named channel.

Status: `PARTIAL`. The scoring engine's keyword rules already tag a
qualitative channel per news category (e.g. "policy rate → real yields →
gold"), and the Committee's macro/geopolitical analysts narrate a channel
in free text as part of their reasoning. What is missing is a
**structured, always-populated, machine-readable transmission-channel
field** attached to every event impact — today the channel is either a
fixed keyword-rule tag or embedded prose, not a first-class, consistently
present part of the event's data contract.

---

## 8. Market Pricing / Positioning / Regime

Three **separate** concepts — never merged into one variable:

- **PRICING** — how much of the available information already appears
  reflected in the current XAUUSD price.
- **POSITIONING** — how crowded or extended market positioning currently
  is (e.g. futures/options positioning, trader-category concentration).
- **REGIME** — the broader market environment the signal is occurring in
  (e.g. trending, range-bound, high/low volatility).

Future candidate data sources for positioning and cross-validation
include CME/COMEX, CFTC (the actual source authority for Commitments of
Traders data), LSEG, WGC, LBMA, S&P Global, and Bigdata.com — **none of
these are integrated today**; see the resource registry for their exact
evidence/disposition state. This document does not claim any of them are
connected.

Status: `NOT_IMPLEMENTED` for pricing and positioning as distinct
concepts — neither exists anywhere in the system today. `PARTIAL` for
regime — a single coarse `market_regime` label (e.g. "range-bound")
already exists in the Committee's output, and it already reaches the
current Command Center shell (§ 15) as a displayed field; but it is one
static label, not the full three-way decomposition this section requires.

### 8.1 Macro Driver Matrix operating contract

The frontend already presents a Macro Driver Matrix panel (`CURRENT`
shell). Its target operating contract, per driver, requires:

`VALUE` · `CHANGE` · `DIRECTION` · `FRESHNESS` · `IMPACT_ON_GOLD` · `CONFIDENCE`

Core drivers currently relevant: **DXY, US10Y, REAL_YIELD, VIX, WTI.**

**DXY is displayed today, but has no working data provider** — Twelve
Data does not carry the symbol (a real, verified 404 from the provider,
not an assumption), so `dxy_value` currently remains `NULL` by design
because DXY collection is removed, and the UI correctly shows it as
unavailable. This reflects today's removed collector, not a permanent
architectural ceiling — a future working DXY provider could be added
without contradicting anything in this document. US10Y, REAL_YIELD,
VIX, and WTI each
have a real, live data provider today (FRED-backed daily series) — these
are not in the same state as DXY, and this document does not claim DXY
has a usable provider when it does not.

The target model must support **interactions between drivers** — e.g. a
rising DXY alongside falling real yields is a different gold signal than
either moving alone — and **gold impact must not be determined solely
from one static sign rule per driver.** A fixed "DXY up → bearish for
gold" rule is a starting heuristic, not a substitute for a contract that
can express interaction effects and confidence.

Status: `PARTIAL`. The panel shell, and a static per-driver directional
label for available drivers, exist today. VALUE/CHANGE/FRESHNESS/
CONFIDENCE as a uniform per-driver contract, cross-driver interaction
modeling, and DXY's absence being clearly and permanently flagged (rather
than looking like "just another loading driver") are not yet in place.

---

## 9. Horizon Contract (H1–H5)

For each of H1 through H5, the terminal must present:

- direction
- probability / confidence
- dominant drivers
- counter-drivers
- invalidation level
- expected time window
- pricing state
- data-quality caveat
- scenario-change trigger

**Probability values must never be treated as certainty.** A 70%
confidence scenario is not a promise.

**Horizon outputs may legitimately disagree with each other** — H1 can be
bearish while H4 is bullish, and that is a correct output, not a bug. The
terminal must **show disagreement**, never force an artificial single
consensus view across horizons. The existing Scenario Tree panel (§ 15)
is the natural home for this — it must remain a first-class operator
view in the target model, not be replaced by a single blended number.

Status: `PARTIAL`. Direction, probability, invalidation level, and a
reasoning/driver narrative already exist per horizon in the current
scenario contract, deterministically validated (geometry, risk/reward,
non-empty invalidation, activation condition) before being accepted, and
are already rendered in the Scenario Tree panel today. Counter-drivers,
pricing state, an explicit data-quality caveat per horizon, and a
structured scenario-change trigger do not exist as distinct fields
today — they are, at best, embedded in free-text reasoning.

---

## 10. AI Committee / Portfolio Manager / Risk Committee — defense in depth

**"AI Committee" names the whole orchestration layer, not only the
analyst agents.** Today's real Committee pipeline already includes
analyst agents, a Risk Committee agent, and a Portfolio Manager agent
under that one name — this document does not silently redefine "AI
Committee" to mean analysts only. The target model describes the
Committee's *internal* stages, arranged as **defense in depth**, not as
a simple linear replacement of what exists today:

```
AI COMMITTEE
  ANALYST LAYER
    → PRE-PM EVIDENCE/RISK GATE
    → PORTFOLIO MANAGER PROPOSAL
    → FINAL ACTION RISK GATE
    → ACTION / ABSTENTION
```

- **ANALYST LAYER** — interprets structured evidence and produces
  scenario analysis. This is the analyst-agent portion of the Committee,
  not the Committee as a whole.
- **PRE-PM EVIDENCE/RISK GATE** — reviews the analyst layer's raw outputs
  before synthesis; may already block a bad setup from ever reaching a
  proposal.
- **PORTFOLIO MANAGER PROPOSAL** — synthesizes across horizons and
  proposes an actionable bias, constrained by whatever the pre-PM gate
  already decided.
- **FINAL ACTION RISK GATE** — reviews the *concrete proposed action*
  itself, downstream of the Portfolio Manager, and **may veto it**. This
  gate must not be bypassable by presentation logic — a UI that hides or
  soft-pedals a veto is not acceptable.

**LLM output alone can never activate a live broker action.** (There is
no broker action to activate today — see § 19 — but this constraint is
stated now, before one exists, so it is never an afterthought.)

**Current state, precisely:** today's real Committee pipeline already has
analyst agents, a Risk Committee agent, and a Portfolio Manager agent.
The Risk Committee's verdict is **deterministically enforced in code** —
a blocking verdict (rejected / data-insufficient / conflict) forces a "no
valid setup" result regardless of what the Portfolio Manager or any LLM
says, independent of any presentation layer. That is a real, working
veto, and it conceptually maps onto the **pre-PM evidence/risk gate**
above: today's Risk Committee reviews the analysts' outputs *before* the
Portfolio Manager synthesizes, exactly as the pre-PM gate is defined
here.

**What does not exist yet:** a distinct **final action risk gate** that
reviews the Portfolio Manager's *specific concrete proposal* after it is
formed, as a second, separate check. Today, one gate (pre-PM) does all
the deterministic work; the target model adds a second, independent gate
downstream of the proposal itself. This is architecture documentation
only — **no runtime component is implemented, renamed, or restructured by
this task.**

Status: `PARTIAL`.

---

## 11. Abstention Is a First-Class Output

The terminal must be able to output, as legitimate, successful decision
states — not failures:

- `NO_VALID_SETUP`
- `DATA_QUALITY_INSUFFICIENT`
- `SIGNAL_CONFLICT`
- `EVENT_ALREADY_PRICED`
- `CONFIDENCE_TOO_LOW`
- `RISK_VETO`
- `WAIT_FOR_CONFIRMATION`

**Abstention is a successful decision state, not a system failure.** A
terminal that always finds a trade is a terminal that cannot be trusted;
"no valid setup, here is exactly why" is a correct and complete answer.

These reason codes are one half of the Final Action Contract (§ 12);
`actionability = NO_ACTION` always carries exactly one of them as
`no_action_reason`.

Status: `PARTIAL`. `NO_VALID_SETUP` already exists as a real execution
status and is already rendered in the frontend today (the "NO VALID
SETUP" banner, keyed off the same rejected/data-insufficient/conflict
verdicts). Those verdicts map conceptually onto
`RISK_VETO`/`DATA_QUALITY_INSUFFICIENT`/`SIGNAL_CONFLICT`.
`EVENT_ALREADY_PRICED` cannot exist yet (§ 6, § 8 — no pricing-state
concept exists to trigger it), and `WAIT_FOR_CONFIRMATION` has no
dedicated mechanism (it depends on event versioning, § 5, which does not
exist yet).

---

## 12. Final Action Contract

The terminal needs both positive and abstention outputs, expressed
through one canonical contract — never a lot size, broker order, stop
loss/take profit, or any automatic execution detail (that boundary is
defined separately in § 19 and stays firm).

**Directional bias and actionability must not be mixed into one enum.**
They are separate axes: a directional read can exist even when the
terminal is not actionable (e.g. a clear bullish lean that is still
`NO_ACTION` because of a risk veto), and collapsing them into one value
would hide that distinction.

**bias_state:**

`LONG_BIAS` · `SHORT_BIAS` · `NEUTRAL`

**actionability:**

`ACTIONABLE` · `NO_ACTION`

When `actionability = NO_ACTION`, exactly one `no_action_reason` is
required, from § 11:
`NO_VALID_SETUP`, `DATA_QUALITY_INSUFFICIENT`, `SIGNAL_CONFLICT`,
`EVENT_ALREADY_PRICED`, `CONFIDENCE_TOO_LOW`, `RISK_VETO`, or
`WAIT_FOR_CONFIRMATION`. `no_action_reason` is nullable only when
`actionability = ACTIONABLE`.

Every final decision snapshot must expose, at minimum:

- `bias_state`
- `actionability`
- `no_action_reason`
- `primary_horizon`
- `confidence`
- `valid_until`
- `invalidation`
- `risk_verdict`
- `data_quality`
- `dominant_rationale`

**`valid_until` is `TARGET`/`NOT_IMPLEMENTED` as an explicit current
Committee field.** No explicit validity-window field exists on today's
Committee output. A scenario's horizon (H1–H5) describes which time
window a scenario is scoped to, but that is not the same thing as a
`valid_until` timestamp marking when a specific decision snapshot should
be considered stale — the two must not be conflated.

Status: `PARTIAL` foundations / `NOT_IMPLEMENTED` as a unified contract.
Several of the underlying fields already exist individually in some form
today (a risk verdict, an invalidation level, and a confidence score all
exist in today's Committee output; `overall_bias` maps loosely onto a
future `bias_state`, and the NO_VALID_SETUP banner maps loosely onto
`actionability = NO_ACTION`), but they are not assembled into one
canonical, separated `bias_state`/`actionability` contract — today's
frontend derives bullish/bearish/neutral framing and the NO_VALID_SETUP
state from two separate ad hoc fields, not from one unified snapshot
object, and has no `valid_until` field at all.

---

## 13. Alert Model

Two distinct things must not be confused with each other.

### 13.1 Internal recalculation notification — `CURRENT`

The News Engine already triggers an internal Committee
recalculation/re-evaluation when an eligible legacy CRITICAL or MAJOR
event is detected (subject to horizon and provider-circuit guards
already proven in production). **This is an internal engine-to-engine
dispatch, not an operator-facing alert.** No human is notified by it
directly; it causes the Committee to do work, which may later change
what the Command Center displays.

### 13.2 Operator state-change alerting — `NOT_IMPLEMENTED`

A genuine operator delivery channel (push, in-app, or otherwise) driven
by meaningful state change does not exist today. Target triggers, once
built:

- a new dominant event
- official confirmation of an existing event
- a major correction
- a reversal
- material H1–H5 probability or regime change
- a Portfolio Manager bias change
- a final-action-risk-gate veto
- an invalidation level being breached
- major data-quality degradation
- a high-impact event becoming materially (un)priced

**Avoid notification spam.** Every alert must answer, immediately:

**What changed? Why? Which horizons? What bias_state/actionability
changed?**

Status: `CURRENT` for internal recalculation dispatch;
`NOT_IMPLEMENTED` for operator-facing alerting, unless and until a real
delivery channel is proven to exist. Most of the candidate triggers above
have no corresponding mechanism today, because the underlying state
objects they'd key off (event versions, a tracked PM bias value, a
final-action-risk-gate veto, invalidation-breach detection) do not exist
yet.

---

## 14. Upcoming Catalyst Contract

The Daily Command Center (§ 15) requires an "upcoming catalysts"
section. Its target object, at minimum:

- `event_name`
- `scheduled_at`
- `source`
- `region`
- expected relevance to gold
- affected horizons
- data-quality/source state
- consensus/expectation — **only if actually available**
- previous/revision value — **only if actually available**

**Scheduled macro events must never be invented.** Potential future
primary authorities for a calendar feed may include official sources
such as Fed, BLS, or BEA release schedules where appropriate — but **no
collector for any of these currently exists**, and none is claimed to.

Status: `NOT_IMPLEMENTED` as a unified operator-facing catalyst service.
No calendar ingestion of any kind exists in the system today.

---

## 15. Daily Command Center (target primary screen)

The target primary terminal screen, prioritizing decision usefulness over
dashboard density. Minimum required sections, each tagged with its
current status:

| Section | Status |
|---|---|
| 1. System status | `NOT_IMPLEMENTED` (unified) — see § 4 |
| 2. XAUUSD / market state | `CURRENT` |
| 3. Dominant event | `PARTIAL` — the event-cluster concept now exists at the backend (§ 5), but is not yet surfaced by the Command Center; the Committee's current top-line narrative approximates it |
| 4. Event confidence / source status | `NOT_IMPLEMENTED` — source-independence is now tracked at the backend (§ 5), but no operator-facing confidence/source-status display exists yet |
| 5. Gold transmission | `PARTIAL` — see § 7 |
| 6. Market pricing | `NOT_IMPLEMENTED` — see § 8 |
| 7. Positioning / crowding | `NOT_IMPLEMENTED` — see § 8 |
| 8. Regime | `PARTIAL` — a static label exists and is displayed; see § 8 |
| 9. H1–H5 (Scenario Tree) | `CURRENT` shell / `PARTIAL` full contract — see § 9 |
| 10. Portfolio Manager | `PARTIAL` — see § 10 |
| 11. Risk Committee | `PARTIAL` — see § 10 |
| 12. Action / abstention | `CURRENT` (NO VALID SETUP banner) / `NOT_IMPLEMENTED` (full Final Action Contract) — see § 11, § 12 |
| 13. Key invalidations | `CURRENT` — an invalidations list is already rendered today |
| 14. Upcoming catalysts | `NOT_IMPLEMENTED` — see § 14 |
| 15. What changed since previous state | `NOT_IMPLEMENTED` |

**Goal: the operator should understand the current market state in under
~60 seconds.** This document does not design frontend pixels or
components — it defines the required sections and their informational
purpose, and states plainly which already exist in some form and which
do not.

**Frontend is a projection of validated state, not a new decision
engine.** The target conceptual output flow is:

```
H1-H5 → Committee → pre-PM risk gate → Portfolio Manager proposal
  → final risk gate → final decision snapshot
  → Command Center + Scenario Tree → operator alerts → audit trail
```

The Scenario Tree is explicitly **not** subsumed or replaced by the
Command Center — both remain first-class operator views, since the
Command Center's job is the at-a-glance summary and the Scenario Tree's
job is the honest multi-horizon disagreement view (§ 9).

Status overall: `PARTIAL`. A real Command Center, Macro Driver Matrix,
Scenario Tree, NO VALID SETUP presentation, invalidations list, and AI
bias/conviction/market-regime/execution-status fields already exist in
the frontend today — this is a genuine, working shell, not a blank
slate. The enriched institutional layer this document targets (event
cluster/version awareness, pricing, positioning, full source confidence,
and state-change explanation) is what remains to be built on top of it.

---

## 16. Temporal Integrity / As-Of-Time Contract

The system must distinguish, wherever relevant:

- `published_at`
- `observed_at`
- effective/event time
- analysis/decision time
- `valid_until`
- `knowledge_cutoff`

**For historical replay or backtest: no datum with a timestamp later than
the `knowledge_cutoff` being reconstructed may influence the decision
under review.** This is a hard rule, not a best-effort guideline — a
replay that leaks future information is not a replay, it is a different,
misleading exercise.

**A later correction must create a new state/version, never rewrite what
the terminal knew earlier.** This is already the behavior for RAW
observations today (append-only, immutable) and must extend to every
later stage in the pipeline as those stages are built.

Where applicable, define operating phases:

- `PRE_RELEASE` — only information known before publication may be used
- `RELEASE` — the publication event itself
- `POST_RELEASE` — creates a new decision state; must never be
  back-applied to a `PRE_RELEASE` decision

This requirement is **mandatory for any future replay, shadow, or
calibration work** — it is a precondition for that work being trustworthy
at all, not an optional refinement.

Status: `PARTIAL` for the underlying primitives (RAW observations already
distinguish `published_at`/`published_date` from `observed_at` from
`ingested_at`, and are already append-only); `NOT_IMPLEMENTED` as an
end-to-end capability — no `knowledge_cutoff`-aware replay mechanism, and
no `PRE_RELEASE`/`RELEASE`/`POST_RELEASE` phase model, exists anywhere in
the system today.

---

## 17. Audit Trail / Explainability

The operator must later be able to answer: **"Why was XAU V2
bullish/bearish/neutral at time T?"**

Target audit chain:

```
source observation → event cluster → event version → impact
  → gold transmission → pricing/positioning/regime → H1–H5
  → Committee → pre-PM gate → Portfolio Manager proposal
  → final risk gate → final action/abstention
```

All important states must be timestamped and versioned, consistent with
§ 16. **No silent historical rewriting** — a later correction must
produce a new version, never overwrite the old one.

Status: `PARTIAL`. The legacy path (GDELT/NewsAPI → scored news →
Committee analysis) is largely traceable today: analyses are new rows,
never mutated in place, and are linked back to the news items that fed
them. RAW official observations are immutably append-only by design (a
database trigger blocks any update or delete outright, even for elevated
database roles). The Event Cluster / Event Version chain (§ 5) is now
**also** auditable end to end for its live-exercised path: each Event
Version is append-only and immutably linked, via Event Version Evidence,
to the exact membership decisions that produced it — an independent
reconciliation can already trace a live Event Version back to its
founding RAW observation today. **The pre-PM Risk Committee/evidence-risk
gate is not missing** — it exists today with deterministic, code-enforced
blocking behavior (§ 10) and is part of what an audit can already
inspect. What is still missing is: **Event Impact** (§ 6), **Gold
Transmission**, **pricing/positioning**, and the distinct **post-PM final
action risk gate** (§ 10) — none of which exist yet. As a result, the
audit trail today has two separate traceable segments (the legacy
article-to-Committee-analysis path, and the RAW-to-Event-Version path)
with no impact/transmission/pricing stage bridging the Event Version
path onward to a decision, and no post-PM final-action-gate stage, in
between to audit.

---

## 18. Operator Daily Workflow

Three operating moments, each with a defined checklist.

### A. Before acting
- system/data health
- dominant event
- H1–H5
- invalidation
- pricing
- conflicts
- risk state

### B. When alerted
- what changed
- source confidence
- affected horizons
- bias_state/actionability transition
- new invalidation/risk

### C. After the fact
- what the system knew at that time
- what changed later
- whether a failure traces to data, interpretation, pricing, risk, or an
  execution assumption

Status: `TARGET`. This workflow presumes the enriched Command Center
(§ 15), the event/pricing model (§ 5, § 8), the Final Action Contract
(§ 12), operator alerting (§ 13.2), and the audit trail (§ 17) all
exist. None are complete today, so this workflow is not yet fully
executable by an operator using only the terminal — it is the design
target the other sections build toward. The existing Command Center
shell already supports a meaningful subset of moment A today (market
state, regime label, conviction, invalidations, NO VALID SETUP status).

---

## 19. Future Live Execution Boundary

**Current: decision-support terminal only.** There is no broker
integration, automatic or otherwise, anywhere in XAU V2 today.

If broker execution is ever approved in the future, it must sit strictly
behind this chain, never in front of it or bypassing it:

```
Portfolio Manager proposal → final action risk gate
  → deterministic risk controls → execution policy → broker adapter
```

**Never: LLM → broker, directly.** No LLM output may reach a broker
without passing through the final action risk gate, deterministic risk
controls, and an execution policy layer first — this applies regardless
of how confident any future LLM output appears.

**No broker integration is implemented by this task**, and none is
implemented anywhere in XAU V2 as of this document's creation.

Status: `NOT_IMPLEMENTED` (and, per § 21, not a near-term roadmap item —
this section exists to state the boundary in advance, not to schedule
building it).

---

## 20. Success Criteria

The Daily Operating Model is successfully realized when the terminal:

- is understandable in under ~60 seconds
- makes provenance visible (which source, which observation, which
  version)
- makes degraded data visible (never silently healthy)
- treats abstention as normal, not as failure
- shows multi-horizon disagreement instead of forcing consensus
- provides a causal gold-transmission explanation for every directional
  call
- states invalidation levels explicitly
- distinguishes internal engine notifications from operator-facing
  alerts
- makes every state change auditable, with a defensible as-of-time
  boundary
- requires no development AI (ChatGPT, Claude Code, Gemini) for normal
  daily use
- has no hidden direct LLM → broker execution path

Not all of these criteria are fully met today. § 21 distinguishes
existing foundations (already-proven safeguards such as the pre-PM
Risk Committee's deterministic veto, RAW append-only integrity, and the
LLM-provider circuit breaker) from the remaining gaps — it does not
imply that already-proven safeguards are absent.

---

## 21. Implementation Gap Map

Strict status for every capability this document depends on. This map is
intended to constrain OPS-023 and future implementation planning — it is
the boundary of what may be assumed to already exist, and it deliberately
does not collapse "existing shell" and "target enrichment" into one
status where they differ.

| Capability | Status |
|---|---|
| Current Command Center shell (panel, market state, regime label, conviction, invalidations, NO VALID SETUP) | `CURRENT`/`PARTIAL` |
| Enriched target Command Center (event cluster/version, pricing, positioning, full source confidence, state-change explanation) | `NOT_IMPLEMENTED`/`PARTIAL` by capability |
| Current Scenario Tree shell | `CURRENT`/`PARTIAL` |
| Enriched target Scenario Tree (counter-drivers, pricing state, data-quality caveat, scenario-change trigger) | `PARTIAL` |
| Macro Driver Matrix (shell + static labels for available drivers) | `PARTIAL` |
| Data-quality presentation (unified, operator-facing) | `PARTIAL` |
| Event cluster | `PARTIAL` — implemented and live-proven (manual runtime only; see § 5) |
| Event version | `PARTIAL` — implemented and live-proven (manual runtime only; see § 5) |
| Novelty / confirmation / correction / reversal classification | `PARTIAL` — `NOVELTY` implemented and live-proven; `CONFIRMATION`/`CORRECTION`/`REVERSAL` exist in the fixed vocabulary but have no live-exercised example yet |
| Source independence tracking | `PARTIAL` — `SINGLE_EDITORIAL_ORIGIN` implemented and live-observed; the other three states exist in the fixed vocabulary but have no live-exercised example yet |
| Event Impact object (EVENT VERSION-level direction/magnitude/confidence/horizon/pricing) | `NOT_IMPLEMENTED`, with `PARTIAL` precursor signals only (legacy `gold_direction_impact`, legacy transmission metadata, Committee scenario direction/confidence/horizon) |
| Event magnitude | `NOT_IMPLEMENTED` |
| Gold transmission (structured, always-populated) | `PARTIAL` |
| Pricing model | `NOT_IMPLEMENTED` |
| Positioning model | `NOT_IMPLEMENTED` |
| Regime model (full three-way decomposition) | `PARTIAL` |
| H1–H5 integration (full field contract) | `PARTIAL` |
| Committee availability | `CURRENT` integration, currently blocked by account state (not a code/architecture gap) |
| Portfolio Manager (proposal stage) | `PARTIAL` |
| Pre-PM evidence/risk gate | `PARTIAL` — today's Risk Committee already fills this role, deterministically enforced |
| Post-PM final action risk gate | `NOT_IMPLEMENTED` |
| Internal Committee recalculation notification | `CURRENT` |
| Operator state-change alert delivery | `NOT_IMPLEMENTED` |
| Temporal / as-of-time integrity contract (end-to-end) | `PARTIAL` for primitives, `NOT_IMPLEMENTED` as a capability |
| Upcoming catalyst service | `NOT_IMPLEMENTED` |
| Final Decision Contract (bias_state/actionability/no_action_reason snapshot) | `PARTIAL` foundations / `NOT_IMPLEMENTED` unified contract |
| Audit trail (full chain) | `PARTIAL` |
| Historical replay | `NOT_IMPLEMENTED` |
| Shadow mode | `NOT_IMPLEMENTED` |
| Broker execution boundary (adapter/policy layer) | `NOT_IMPLEMENTED` |

---

## 22. Relationship to Other Governance Documents

This document is the second in a fixed sequence agreed in
`docs/XAU_V2_RESOURCE_REGISTRY.md`'s Near-Term Action Queue:

**Resource Registry → Daily Operating Model → OPS-023 implementation
planning.**

This document does not re-litigate the resource registry's evidence
states, architecture dispositions, or standing decisions — it assumes
them. OPS-023's RAW → Event Cluster → Event Version implementation work
(§ 5) is now complete and live-proven against this sequence. Any further
implementation work — Event Impact (§ 6) and every stage downstream of
it — must be scoped against the gap map in § 21, not against an assumed
capability this document has marked `NOT_IMPLEMENTED` or `PARTIAL`, and
must not overstate what the existing frontend shell (§ 15) already
provides.
