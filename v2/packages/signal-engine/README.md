# @market-intel/signal-engine + @market-intel/grading-ledger

Implements Kanban **t_8c71d7c8** against the frozen spec
(`docs/specs/signal-and-grading-spec.md`). Both packages are **pure** — no I/O,
no wall clock (time injected), no randomness (seeded PRNG only). Same facts +
state + cohort + clock = byte-identical output (tested).

## signal-engine

- `src/families/` — all 11 family detectors (§1.2). v1 logic ported:
  `divergence.mjs` → `CROWD_DIVERGENCE` + `POS_WHALE_CONSENSUS`,
  `smartmoney.mjs` → `POS_SMARTMONEY_SHIFT`, `radar.mjs` → `CROWD_MENTION_SPIKE`
  (incl. EMA baseline + first-run-learns-silently), `ta.mjs` templates → `TA_SETUP`
  with deterministic `NO_SETUP` abstention.
- `src/scoring.ts` — severity/novelty/personal-relevance/priority + tiers (§3).
- `src/abstain.ts` — all 6 abstention rules + §5.2 latency auto-abstain; explicit
  reasons, never silent.
- `src/dedupe.ts` — idempotency keys, deterministic signal ids, cooldowns (§2.2, §2.5).
- `src/horizon.ts` — crypto wall-clock vs stock trading-day calendars (§5.1).
- `src/index.ts` — `runEngine(facts, {now, cohort, state, user})` → signals +
  abstentions + suppressed count + next state.
- `cohort/cohort-2026.07.0.json` — frozen params (v1-proven thresholds:
  funding +35/−3, spike 2.5×, consensus 3, $25k floor).

## grading-ledger

- `excursions.ts` — MFE/MAE in abs/%/R, sign-adjusted (§4.2).
- `outcomes.ts` — first-touch target-vs-invalidation, AMBIGUOUS never guesses,
  finer-bar resolution (§4.3).
- `neutral.ts` — catalyst information-value track: realized-vol ratio + lead time (§4.4).
- `grade.ts` — `gradeSignal()`; enforces the leakage boundary: LEAKAGE_REJECT on
  llm-origin fields, rejects future-dated evidence + out-of-window bars, refuses
  to run pre-horizon (§0, §2.4).
- `calibration.ts` — BASE_RANDOM/ALWAYS_LONG/MOMENTUM baselines, bootstrap edge
  CIs, ECE calibration, §5.5 min-sample floors. All seeded/deterministic.

## ingestion (@market-intel/ingestion — t_7410f09c)

- `pipelines.ts` — Hyperliquid / Alpaca / SEC jobs: poll port → RawSnapshotRow
  retention → normalized ObservationRow/PositioningEventRow upserts (idempotent,
  deterministic ids) → source-health recording. Ports are structural interfaces;
  concrete adapters bolt on with one-line glue.
- `scheduler.ts` — tick-driven runner (cron/Actions-friendly, no setInterval).
- `factset.ts` — deterministic feature prep: repos → signal-engine `FactSet`
  (Dates → unix seconds, funding/OI, mention tallies, TA facts via `indicators.ts`
  ported from v1 ta.mjs, source health mapping).
- End-to-end tested: fixture ports → jobs → in-memory repos → `buildFactSet` →
  `runEngine` fires CROWD_DIVERGENCE and POS_INSIDER_CLUSTER.

## adapters (t_0fd966d5)

- `alpaca/` rebuilt for real: retries/backoff, token-bucket rate limit, typed
  errors, health, pagination, stable `stock:us:<SYM>` UIDs, deterministic bar
  ids + payload hashes, injectable fetch, 13 fixture-driven tests.
- `sec/` verified genuine (Form 4 XML parsing, transaction codes, latency-
  preserving times, 27 tests). `hyperliquid/` untouched (20 tests).

## db additions

- `memory.ts` — `createInMemoryRepositoryFactory()`: full RepositoryFactory over
  Maps. Resolves the "tests require live PostgreSQL" blocker; unit tests for
  ingestion/engine/grading run with zero infrastructure.

Run everything: `npx vitest run packages` (142 tests; live-Postgres migration
tests auto-skip without a database).
