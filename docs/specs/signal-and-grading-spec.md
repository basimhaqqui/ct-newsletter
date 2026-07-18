# Deterministic Signal & Grading Specification (v2)

Status: FROZEN for v2 build. Owner card: t_7fa75193. Downstream: t_ff98078b (architecture synthesis).

This document is the **analytical contract** for the cross-asset (crypto + stocks)
intelligence product. It defines what a *signal* is, the exact payload it must carry,
how signals are scored and when the system must abstain, what evidence a signal must
cite, and the leakage-free ledger and evaluation math that grade every signal after
the fact.

## 0. Non-negotiable principle: LLMs explain, they do not compute

The system draws a hard line between **ground truth** and **narration**.

- **Deterministic layer (authoritative).** All signal detection, thresholds, scoring,
  target/invalidation levels, entry/observed prices, timestamps, and *every graded
  outcome* are produced by pure, versioned, unit-tested functions over numeric source
  data. Given the same inputs and the same `cohort_version`, they return byte-identical
  output. No network calls, no clocks read mid-computation (time is injected), no
  randomness.
- **LLM layer (advisory only).** An LLM may (a) rewrite a deterministic payload into
  human-readable prose, (b) cluster/label free-text social claims into themes, and
  (c) rank *narration* priority. An LLM may **never** originate a signal, set a
  numeric level, decide fire/abstain, or produce any field that the grader reads.
- **Enforcement.** Any field consumed by the grader carries `origin: "deterministic"`.
  The grader rejects (does not grade, logs `LEAKAGE_REJECT`) any signal whose graded
  fields carry `origin: "llm"`. This is a schema-validated, CI-tested boundary, not a
  convention. See §2.4.

v1 already respects this in spirit: `radar.mjs`, `divergence.mjs`, `smartmoney.mjs`,
`watch-eval.mjs`, `hl-scorecard.mjs` compute everything deterministically and only
`ta.mjs`/`summarize.mjs` call an LLM — and even there the numbers are pre-computed and
handed to the model. v2 formalizes and hardens that split.

---

## 1. Signal grammar (asset-agnostic)

Every signal is an instance of exactly one **signal family**. Families are the closed
vocabulary; there are no ad-hoc signals. Each family is `(dimension, trigger)` where
`dimension ∈ {positioning, crowd, catalyst}`.

### 1.1 Dimensions

- **positioning** — what *proven capital* is actually doing (perp positions of tracked
  wallets / leaderboard traders for crypto; Form 4 insider buys, 13F deltas, congressional
  disclosures for stocks). Derived from `PositioningEvent` records.
- **crowd** — what the *undifferentiated many* are doing or saying (perp funding/OI as a
  crowd-leverage proxy, social mention velocity, cashtag spikes). Derived from
  `Observation` (funding/OI/price) and `SocialClaim` records.
- **catalyst** — a scheduled or discrete real-world event with a known event-time
  (earnings, FOMC, token unlock, mainnet, protocol upgrade, economic print, SEC filing
  deadline). Derived from `Catalyst` records.

### 1.2 Signal family registry (frozen v2.0 set)

| family_id | dim | trigger (deterministic) | asset classes |
|---|---|---|---|
| `POS_WHALE_CONSENSUS` | positioning | ≥ `consensus_min` tracked wallets same side on a coin, min notional each | crypto |
| `POS_WHALE_FLIP` | positioning | tracked-wallet net side on a coin flips vs last snapshot, both snapshots ≥ min notional | crypto |
| `POS_SMARTMONEY_SHIFT` | positioning | leaderboard-aggregate `pct_long` swings ≥ `swing` or crosses `strong` consensus, or net-notional flips ≥ `flip_min_usd` | crypto |
| `POS_INSIDER_CLUSTER` | positioning | ≥ N distinct insiders (Form 4) net-buy same issuer within window, min aggregate $ | stocks |
| `POS_CONGRESS_DISCLOSURE` | positioning | new congressional disclosure, single-trade $ ≥ threshold or clustered | stocks |
| `CROWD_DIVERGENCE` | crowd×positioning | proven capital positioned *against* crowd funding (whales long + funding ≤ `funding_neg`; whales short + funding ≥ `funding_pos`) | crypto |
| `CROWD_MENTION_SPIKE` | crowd | cashtag viral-mention count ≥ `min_mentions` AND ≥ `spike`× rolling EMA baseline | crypto (stocks: $TICKER cashtag) |
| `CROWD_FUNDING_EXTREME` | crowd | annualized funding ≥ `funding_pos` or ≤ `funding_neg` with OI ≥ floor | crypto |
| `CATALYST_UPCOMING` | catalyst | a `Catalyst` enters the `[now, now+lead]` window for a covered asset | crypto + stocks |
| `CATALYST_SURPRISE` | catalyst | realized catalyst value deviates from consensus/estimate by ≥ threshold (earnings beat/miss, CPI surprise) | stocks (crypto: unlock-vs-float) |
| `TA_SETUP` | crowd | deterministic multi-timeframe TA state matches a named setup template (trend+RSI+level confluence) — see §1.4 | crypto + stocks |

`consensus_min`, `funding_pos`, `spike`, etc. are named parameters, versioned in the
cohort config (§5.4). Adding, removing, or re-tuning a family is a **cohort version bump**.

### 1.3 What is NOT a signal (explicit non-signals)

- An LLM "thinks price will go up." (No deterministic trigger → not a signal.)
- A single viral tweet with no cashtag velocity behind it.
- A position change below `min_notional` (noise floor; v1 uses $25k).
- A catalyst on an asset the user does not cover and has no position in.
- Any trigger already fired inside its cooldown window (dedupe, §2.5).

### 1.4 TA setup templates (deterministic)

`TA_SETUP` fires only when the numeric multi-timeframe read matches a named template.
Templates are booleans over `tfRead` outputs (trend, RSI, EMA20/50, ATR, level distance)
exactly as computed today in `ta.mjs`. The LLM narrates the setup; it does not pick it.

- `LONG_OVERSOLD_SUPPORT`: 1d trend up|mixed AND RSI ≤ os_lo AND price within `k`·ATR of a support level.
- `SHORT_OVERBOUGHT_RESISTANCE`: 1d trend down|mixed AND RSI ≥ ob_hi AND price within `k`·ATR of resistance.
- `MOMENTUM_BREAKOUT`: price closes > 30d high AND MACD hist > 0 AND OI rising.
- `MOMENTUM_BREAKDOWN`: mirror of breakout.
- `NO_SETUP`: none match → abstain (§3). v1's `ta.mjs` currently lets the LLM say
  "no trade"; v2 makes NO_SETUP a *deterministic* abstention so it is never graded.

---

## 2. Signal payload schema

A signal is an immutable JSON record. Every graded field is deterministic and carries
provenance. Schema version travels on the record.

### 2.1 Canonical fields

```jsonc
{
  "signal_id": "sig_<ulid>",              // stable, monotonic, dedupe-safe
  "schema_version": "signal/2.0.0",
  "cohort_version": "cohort/2026.07.0",   // ties to the frozen param + code set (§5.4)
  "family_id": "CROWD_DIVERGENCE",
  "dimension": "crowd",
  "asset_class": "crypto",                // crypto | stock
  "asset": {                              // stable identity from data contract (t_47ff60c2)
    "asset_uid": "crypto:hl:HYPE",        // canonical, never a display symbol alone
    "symbol": "HYPE",
    "venue": "hyperliquid"
  },
  "direction": "long",                    // long | short | neutral (catalyst/info signals)
  "event_time": 1784086100,               // when the underlying fact became true (source event time)
  "observed_time": 1784086125,            // when the pipeline observed it
  "detected_time": 1784086130,            // when detection ran (= grading clock start)
  "source_latency_s": 25,                 // observed_time - event_time, from data contract
  "trigger": {                            // the exact deterministic condition that fired
    "rule": "whales_long>=3 && funding_annual<=-3",
    "inputs": { "whales_long": 4, "whales_short": 0, "funding_annual_pct": -7.2, "oi_usd": 1.2e8 }
  },
  "levels": {                             // DETERMINISTIC price geometry (see §4)
    "reference_price": 46.12,             // price at detected_time, from Observation
    "target": 51.5,                       // computed from ATR/level template, NOT llm
    "invalidation": 43.0,                 // the level that kills the thesis
    "atr_ref": 2.1,                       // ATR used to size target/invalidation
    "target_r_multiple": 1.5              // (target-ref)/(ref-invalidation) for a long
  },
  "horizon": { "class": "crypto_swing", "seconds": 259200 },  // §5.1
  "scores": {                             // §3 — deterministic
    "severity": 0.72,
    "novelty": 0.9,
    "personal_relevance": 1.0,
    "priority": 0.84                      // combined; drives alert tier
  },
  "evidence": [ /* §2.3 EvidenceRef[] */ ],
  "abstained": false,                     // true records are logged but never alerted/graded as active
  "origin": "deterministic",             // MUST be deterministic for all above fields
  "narration": {                          // OPTIONAL, llm-authored, never graded
    "origin": "llm",
    "text": "...",
    "model": "claude-sonnet-4-6",
    "prompt_hash": "sha256:..."
  }
}
```

### 2.2 Field rules

- `signal_id` = ULID; **idempotency key** = `hash(family_id, asset_uid, direction,
  trigger_bucket, cohort_version)` where `trigger_bucket` is the dedupe window bucket
  (§2.5). Re-detecting the same condition in the same bucket returns the same
  `signal_id` — no duplicate row, no duplicate alert. Mirrors v1's `state/*.json`
  cooldown/`alerted` maps, but as a first-class deterministic key.
- All times are Unix seconds, UTC. The grader's clock is `detected_time`; the target
  window is `[detected_time, detected_time + horizon.seconds]`.
- `reference_price` is the observed price at `detected_time` from the canonical
  `Observation` feed — **never** a price the LLM stated, never a mid pulled at grade time.
- `direction: neutral` signals (pure catalyst awareness) carry no `target`/`invalidation`
  and are graded on a different track (§4.4).

### 2.3 Evidence requirements

Every signal MUST cite ≥1 `EvidenceRef` (from the data contract, t_47ff60c2). A signal
with zero verifiable evidence is rejected at validation.

```jsonc
{
  "kind": "observation | positioning_event | social_claim | catalyst | filing",
  "source": "hyperliquid | apify_x | coingecko | alpaca | sec_edgar | congress | earnings",
  "ref": "hl:clearinghouseState:0xabc...:HYPE@block/ts",  // stable provenance handle
  "event_time": 1784086100,
  "observed_time": 1784086120,
  "quality": "ok | degraded | stale",     // from SourceHealth
  "url": "https://..."                     // human-verifiable when available
}
```

Rules:
- **Positioning** signals cite the underlying `PositioningEvent`s (wallet addr + coin +
  side + notional, or filing id).
- **Crowd/social** signals cite the top-engagement `SocialClaim`s that cleared the
  filter, plus the numeric `Observation` (funding/OI/mention-count) that tripped the rule.
- **Catalyst** signals cite the `Catalyst` record (event id, scheduled time, source).
- Evidence with `quality: stale` cannot be the *sole* basis for a fire (§3.3).

### 2.4 Leakage boundary (schema-enforced)

- Fields the grader reads: `family_id, asset, direction, event_time, detected_time,
  levels.*, horizon.*, trigger.inputs, cohort_version`. All must be `origin:
  deterministic`.
- The grader **ignores** `narration.*` and `scores.*` entirely (scores affect alerting,
  not truth).
- A validator (CI + runtime) asserts: no graded field is derivable from `narration`,
  no future-dated evidence (`event_time > detected_time` → reject), and
  `reference_price` matches the Observation feed at `detected_time` within tolerance.

### 2.5 Dedupe & cooldown

- **Dedupe window (idempotency):** identical trigger on same asset/direction inside the
  same bucket → same signal, suppressed. Bucket granularity per family (e.g. divergence
  = active-set membership like v1; mention-spike = `cooldown_h` = 24h like v1).
- **Cooldown (re-alert):** after a signal fires, the same family+asset+direction cannot
  fire again until `cooldown_h` elapses (v1 radar uses 24h). Cooldown is deterministic
  state, keyed, and part of the transactional store (per t_c7f5ee39's Git→DB decision).

---

## 3. Scoring & abstention (deterministic)

All scores are pure functions in `[0,1]`. No LLM input. They drive **alert tiering only**
— they are never graded and never gate correctness.

### 3.1 Severity — "how big is this?"

Family-specific, normalized to `[0,1]`:
- positioning: aggregate notional vs a per-family reference notional (log-scaled), and
  count of aligned actors vs `consensus_min`.
- crowd: `spike_ratio` over baseline (mention spike) or `|funding_annual|` past threshold,
  scaled by OI.
- catalyst: pre-defined event weight (FOMC/CPI/earnings > minor prints) × proximity.
- TA: `target_r_multiple` and confluence count (how many timeframes agree).

### 3.2 Novelty — "is this new information?"

`novelty = 1` for a first-seen condition; decays toward 0 as the same condition persists
across detection cycles (an EMA of prior fires for that family+asset, mirroring v1's
`alerted`/active-set dedupe). A signal already inside cooldown has `novelty→0` and is
suppressed. Prevents re-alerting the same standing divergence every 30 min.

### 3.3 Personal relevance — "does this touch the user?"

Deterministic membership/overlap:
- `1.0` if asset is in the user's tracked set, an open position (paper or real), or an
  active `/watch`.
- `0.6` if same sector/narrative cluster as a held asset.
- `0.3` if covered universe but no personal link.
- `0.0` if outside covered universe → **abstain** unless severity is extreme.

### 3.4 Priority & alert tiers

```
priority = w_sev*severity + w_nov*novelty + w_rel*personal_relevance   (weights in cohort config)
```
- `priority ≥ tier_hi` → **push immediately** (tier P0).
- `mid ≤ priority < tier_hi` → **decision queue** (tier P1, batched).
- `priority < mid` → **log only** (tier P2, no notification), still recorded & graded.

### 3.5 Abstention rules (fire nothing, or log-only)

The system MUST abstain (record `abstained: true`, never alert, never enter active grading
as a directional call) when ANY of:
1. `family_id = TA_SETUP` and template = `NO_SETUP` (no deterministic edge).
2. All supporting evidence is `stale` or the required source is `degraded` past its SLA
   (source-degraded state from t_47ff60c2). Degraded ≠ silent: log `ABSTAIN_SOURCE`.
3. `personal_relevance = 0` and `severity < extreme_floor`.
4. Reference price unavailable or `reference_price` fails the Observation cross-check.
5. Sample/liquidity floor unmet (OI/volume below family floor → untradeable, unmeasurable).
6. Direction cannot be determined (crowd data conflicts, e.g. whales split 2L/2S below
   `consensus_min`).

Abstentions are **first-class records** — they are counted for calibration (did abstaining
avoid a loss?) but are never scored as directional hits. Silent "no data" is forbidden;
every cycle emits either signals or explicit abstention rows.

---

## 4. Grading: MFE/MAE and target-vs-invalidation

The grader is a pure function run *after* a signal's horizon elapses, over the canonical
`Observation` price series. It never runs at detection time; it reads only historical bars
within `[detected_time, detected_time + horizon]`. This is the **leakage-free ledger**.

### 4.1 Price series & fill assumptions

- Grade against the same venue's OHLC the signal referenced (`asset.venue`), 1m/5m bars
  for intraday horizons, 1h/1d for swing/position horizons.
- **Reference (entry) = `reference_price`** captured at `detected_time`. No look-back
  entry, no "better fill." Conservative: worst-of-bar for the entry side is optional but
  the default is the recorded `reference_price`.
- Slippage/fee haircut per asset class applied as a config constant (crypto perp taker,
  stock spread) so R-multiples are net, not gross.

### 4.2 MFE / MAE (excursion metrics)

Over the horizon window, sign-adjusted for `direction`:
- **MFE (Max Favorable Excursion):** furthest the price moved *in the signal's favor*
  from `reference_price`, in price, %, **and R** (R = distance to invalidation).
- **MAE (Max Adverse Excursion):** furthest it moved *against*.
- Report both as absolute, %, and R-multiples. `mfe_r`, `mae_r` are the primary units so
  crypto and stocks are comparable.

### 4.3 Target-vs-invalidation outcome (primary label)

Path-dependent, first-touch within the window:
- `TARGET_HIT` — target touched before invalidation.
- `INVALIDATED` — invalidation touched before target.
- `TIMEOUT_WIN` — neither touched, closed in profit at horizon end (record `end_r`).
- `TIMEOUT_LOSS` — neither touched, closed at a loss.
- `AMBIGUOUS` — both target and invalidation fall inside the *same* bar (can't order at
  this granularity) → drop to finer bars; if still ambiguous, exclude from win-rate but
  keep MFE/MAE. Never guess the order.

Realized R per signal = `+target_r_multiple` on TARGET_HIT, `-1` on INVALIDATED, `end_r`
on timeouts (net of §4.1 haircut).

### 4.4 Neutral / catalyst-awareness signals

`direction: neutral` (e.g. `CATALYST_UPCOMING`) have no target/invalidation. They are
graded on **information value**, not P&L:
- realized volatility in the horizon window vs the trailing baseline (did the flagged
  catalyst actually move the asset?),
- lead time delivered (`event_time - detected_time`).
They live on a separate ledger track and never contaminate directional win-rate.

### 4.5 Grade record (appended to ledger)

```jsonc
{
  "grade_id": "grd_<ulid>",
  "signal_id": "sig_...",
  "cohort_version": "cohort/2026.07.0",
  "graded_at": 1784345330,
  "horizon_end": 1784345300,
  "outcome": "TARGET_HIT",
  "mfe": { "abs": 6.1, "pct": 13.2, "r": 1.8 },
  "mae": { "abs": 1.4, "pct": 3.0, "r": 0.5 },
  "realized_r": 1.5,
  "bars_source": "hyperliquid:1h",
  "haircut_r": 0.05,
  "origin": "deterministic"
}
```

The ledger is append-only and immutable; regrades under a new grader version write new
rows with a new `grader_version`, never overwrite (audit trail). v1's `state/ta-log.json`
is the seed of this ledger but lacks outcome/horizon fields — v2 supersedes it.

---

## 5. Horizons, latencies, baselines, calibration, cohorts

### 5.1 Horizon classes (crypto vs stocks separated)

Signals are graded on horizons appropriate to their asset class and family. A signal
inherits its horizon deterministically from `(asset_class, family_id)`.

| horizon class | asset_class | seconds | typical families |
|---|---|---|---|
| `crypto_intraday` | crypto | 4h (14400) | CROWD_FUNDING_EXTREME, CROWD_MENTION_SPIKE |
| `crypto_swing` | crypto | 3d (259200) | CROWD_DIVERGENCE, POS_WHALE_*, TA_SETUP |
| `crypto_position` | crypto | 10d (864000) | POS_SMARTMONEY_SHIFT |
| `stock_swing` | stock | 5 trading days | POS_INSIDER_CLUSTER, TA_SETUP |
| `stock_position` | stock | 21 trading days | POS_CONGRESS_DISCLOSURE, CATALYST_SURPRISE |
| `catalyst_window` | both | event_time → event_time + settle | CATALYST_* |

Stock horizons are in **trading days** (skip weekends/holidays via a market calendar);
crypto is 24/7 wall-clock. The grader uses the correct calendar per `asset_class`.

### 5.2 Source latency handling

- Every signal records `source_latency_s`. Stocks (SEC Form 4: up to 2 business days
  post-trade; congressional: up to 45 days) are structurally laggier than crypto
  (Hyperliquid positions/funding: seconds). Latency is **not** a defect — but the grading
  clock is `detected_time`, so a laggy source simply produces a later, shorter-edge signal.
- A signal whose `source_latency_s` exceeds a family's `max_useful_latency` is auto-abstained
  (§3.5-2): e.g. a congressional disclosure of a trade 44 days old on a `stock_swing`
  horizon has no tradeable edge left → log-only, information track.

### 5.3 Baselines & calibration

Every cohort is graded **against baselines** — a signal set only earns its keep if it beats
naive alternatives on the same assets/horizons:
- `BASE_RANDOM`: random direction, same asset/horizon distribution.
- `BASE_ALWAYS_LONG` (crypto majors trend up historically) / `BASE_BUYHOLD` (stocks).
- `BASE_MOMENTUM`: trivial "follow last N-day return sign."

Reported per family and overall: win-rate, mean realized R, hit-rate vs each baseline,
and **edge = signal_mean_R − baseline_mean_R** with a bootstrap CI.

Calibration: signals are bucketed by `priority`/`severity` decile; we plot predicted
(implied by score) vs realized win-rate and report a calibration error (ECE). A well-behaved
cohort is monotone: higher-severity buckets realize higher R. Miscalibration is a release
blocker for promoting a cohort (t_42ea313b gates).

### 5.4 Cohort versioning

A **cohort** = frozen tuple of `(family registry + parameters + scoring weights + grader
code + baseline set)`. Identified `cohort/YYYY.MM.N`.
- Any threshold change, family add/remove, scoring-weight change, or grader-logic change
  → **new cohort version**. Signals and grades always carry their `cohort_version`.
- Metrics are **never** pooled across cohort versions. Comparisons are cohort-vs-cohort on
  overlapping asset/time windows only.
- Config lives in a versioned, checked-in cohort manifest (deterministic, hashable). The
  running system pins one active cohort; shadow cohorts (t_ff98078b's shadow-mode) run in
  parallel and are graded on the same signals for A/B.

### 5.5 Minimum sample requirements

No performance claim is published below these floors (else report "insufficient sample"):
- Per-family win-rate / mean-R: **≥ 30 graded, non-abstained, non-AMBIGUOUS signals**.
- Baseline-beat / edge CI: **≥ 50** signals per family (bootstrap n≥1000).
- Calibration (ECE): **≥ 100** signals across ≥3 severity buckets.
- Cohort promotion: overall **≥ 200** graded signals AND every promoted family meets its
  ≥30 floor AND edge CI excludes 0 AND ECE ≤ threshold.
- Stocks accrue samples slower (fewer, laggier events) — floors are per asset_class, and a
  cohort may promote crypto families while stock families stay "provisional / insufficient
  sample."

---

## 6. Acceptance criteria (this card's deliverable)

1. Closed signal-family registry with deterministic triggers, asset classes, and dimensions — §1.2. ✔
2. Versioned signal payload schema with provenance, evidence, idempotency, and leakage boundary — §2. ✔
3. Deterministic severity/novelty/personal-relevance scoring + priority tiers + explicit abstention rules — §3. ✔
4. Evidence requirements tied to the data contract, ≥1 verifiable EvidenceRef, stale/degraded handling — §2.3, §3.5. ✔
5. Leakage-free append-only grading ledger; grader is pure, post-horizon, reads only in-window bars — §4. ✔
6. MFE/MAE (in R) and target-vs-invalidation first-touch outcomes incl. AMBIGUOUS handling — §4.2–4.3. ✔
7. Neutral/catalyst information-value track separated from directional P&L — §4.4. ✔
8. Crypto vs stock horizons and latencies separated, with correct calendars — §5.1–5.2. ✔
9. Baselines, edge-vs-baseline, and calibration (ECE) defined as release gates — §5.3. ✔
10. Cohort versioning (never pool across versions) + minimum-sample floors per family/asset_class — §5.4–5.5. ✔
11. LLM-explains-not-computes enforced by schema + validator + CI, not convention — §0, §2.4. ✔

## 7. Interfaces this hands to downstream cards

- **To data contract (t_47ff60c2):** consumes `Asset.asset_uid`, `Observation` (price/funding/OI),
  `PositioningEvent`, `SocialClaim`, `Catalyst`, `SourceHealth`, `EvidenceRef`; requires
  event_time/observed_time/latency/quality on every record. Requires OHLC history retrievable
  by `(asset_uid, venue, interval, [t0,t1])` for the grader.
- **To security/reliability (t_42ea313b):** the leakage validator, origin-enforcement, and
  min-sample/calibration gates are P0 acceptance checks; the ledger is the transactional
  outbox's grade-emit consumer; idempotency keys (§2.2) are the dedupe primitive.
- **To architecture synthesis (t_ff98078b):** three tables/streams — `signals` (immutable),
  `grades` (append-only), `abstentions` — plus a versioned `cohort_manifest`. Detector,
  scorer, and grader are separate deterministic modules; the LLM narrator is an isolated,
  non-graded service. Shadow cohorts run the same detector inputs for 1–2 week A/B before cutover.
