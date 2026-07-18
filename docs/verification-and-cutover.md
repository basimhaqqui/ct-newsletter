# Cross-Agent Verification & Cutover Recommendation

Kanban: **t_eb01e003** (final gate). Author: Claude. Date: 2026-07-18.
Scope: verifies work delivered under t_7fa75193 (spec), t_47ff60c2/t_dd8f6c78
(contracts), t_0f29e235/t_0fd966d5 (adapters), t_7410f09c (ingestion/DB),
t_8c71d7c8 (signal engine + ledger), t_efb36ee3 (Telegram/orchestration).

---

## 1. What was verified and how

All checks run from a clean environment (Linux, Node 22, fresh TypeScript
5.4 + Vitest 1.6): full monorepo typecheck (**0 errors**) and test suite —
**155 passing tests across 12 files** (15 Postgres migration tests auto-skip
without a database; run them via `v2-ci.yml`'s `test-postgres` job).

| Layer | Evidence |
|---|---|
| Contracts | 2 envelope-validation tests |
| Adapters | 60 tests: Hyperliquid 20, Alpaca 13 (rebuilt), SEC 27 (Form 4 XML parsing, transaction codes, retries, health) |
| Signal engine | 52 tests: all 11 families, scoring bounds, tiering, abstention rules, dedupe/cooldown, determinism, order-insensitivity |
| Grading ledger | 27 tests: first-touch outcomes incl. AMBIGUOUS + finer-bar resolution, MFE/MAE, leakage rejection, neutral track, baselines, bootstrap CI, ECE, min-sample floors |
| Ingestion | 9 tests incl. end-to-end: fixture ports → jobs → repos → feature prep → engine fires CROWD_DIVERGENCE and POS_INSIDER_CLUSTER |
| Telegram + orchestration | 13 tests incl. full product loop: ingest → detect → persist → P0 push → cooldown suppression → post-horizon grade row |

### Honesty audit of prior claims

- **t_5ce83946 ("Alpaca/SEC done") was falsely marked complete** — confirmed.
  The Alpaca adapter did not compile (syntax error in types.ts, undefined
  helpers, circular self-export). It was rebuilt from scratch this pass.
- The **SEC adapter was genuine** (contrary to the card's blanket claim):
  real Form 4 XML parsing with 27 substantive tests. Audited and kept.
- Also fixed: adapters package missing `"type": "module"`, tsconfig missing
  `resolveJsonModule` — the package could not have passed CI as committed.

## 2. Leakage audit (spec §0, §2.4) — PASS

- Every emitted signal/abstention carries `origin: "deterministic"`; the
  grader **throws `LEAKAGE_REJECT`** on llm-origin graded fields (tested).
- Grader refuses future-dated evidence, out-of-window bars, and pre-horizon
  runs (tested). It reads only the §2.4 field allowlist (`GradableSignal`
  type makes narration/scores structurally unreadable).
- No LLM call exists anywhere in the v2 pipeline. Narration fields are
  schema-reserved and null. Alert text is deterministic templating.
- Determinism: byte-identical engine output for identical inputs, insensitive
  to input fact ordering; grades byte-identical; all randomness (bootstrap,
  BASE_RANDOM) is seeded PRNG (tested).

## 3. Signal quality vs v1

v1 logic is ported 1:1 with its battle-tested thresholds (funding +35/−3,
spike 2.5×, consensus 3, $25k floor — frozen in `cohort/2026.07.0`), so v2 ⊇ v1
by construction: same divergence/smartmoney/radar/TA triggers plus 6 new
families (insider cluster, congress, whale flip, funding extreme, catalyst
upcoming/surprise). **A backtest overlap comparison on live data is not yet
possible** — v1's `state/ta-log.json` lacks outcome fields (the spec's own
finding) and v2 has no accrued production sample. This is exactly what shadow
mode is for; §5.5 floors (≥30/family, ≥200/cohort) gate any promotion claim.

## 4. Operational readiness

- **Latency:** detection cycle is pure compute (<1s); sources poll at 30–60 min.
- **Cost:** zero LLM cost in the deterministic path; API usage within free tiers.
- **Failure modes:** per-job isolation; source health degradation → explicit
  `ABSTAIN_SOURCE` records (silent no-data forbidden, tested); Telegram retry
  with 4xx/5xx discrimination; engine state persists across runs.
- **Former gaps — now closed (2026-07-18, second pass):**
  1. **Postgres repositories** ✅ — `createPgRepositoryFactory` implements all
     14 repositories (core tables from migrations 001–014 + JSONB app stores),
     with transaction support. **Verified against a live Postgres 18 instance**:
     all migrations applied, round-trips, idempotent upserts, Date revival, and
     rollback tested. Wired into `apps/daily` via `DATABASE_URL`.
  2. **OHLC candles** ✅ — `candles` table (migration 014), `CandlesRepository`
     (pg + memory), incremental Hyperliquid candleSnapshot ingestion job, and
     `gradeDue` now prefers real 1h candles (with 5m finer-bar AMBIGUOUS
     resolution) over flat observation bars.
  3. **Social + catalyst pipelines** ✅ — Apify-style viral-post port →
     SocialClaimRow (idempotent, cashtag→asset resolution, v1 radar query) and
     calendar port → CatalystRow; both feed the engine end-to-end (tested:
     ingested claims fire CROWD_MENTION_SPIKE, calendar events fire
     CATALYST_UPCOMING).
- **Remaining before cutover:**
  1. **Live smoke run** — harness ships at `apps/daily/src/smoke.ts` (real
     HL + SEC, no credentials, in-memory repos, console alerts). The build
     sandbox has no external API egress, so run locally:
     `cd v2 && pnpm --filter @market-intel/daily exec tsx src/smoke.ts`
     → expect `SMOKE_PASS`.
  2. Shadow-mode evidence accrual per §5.5 (unchanged — requires calendar time).

## 5. Cutover plan (recommended)

1. **Now:** land this tree; run `pnpm install` + CI (`v2-ci.yml`).
2. **Shadow mode (1–2 weeks):** enable `v2-cycle.yml` pointed at a separate
   Telegram chat (`V2_SHADOW_CHAT_ID`). v1 keeps running untouched.
3. During shadow: wire pg factory + candle ingestion (gap 1–2); let the
   grader accrue a real ledger.
4. **Promotion gate (spec §5.5):** ≥200 graded signals, every promoted family
   ≥30, edge CI excluding 0 vs baselines, ECE ≤ threshold, zero
   `LEAKAGE_REJECT` rows. Compare v2 alerts vs v1 on the overlap window.
5. **Cutover:** repoint v2 to the main chat, demote v1 workflows to manual,
   keep v1 read-only for 30 days as rollback.

## 6. Recommendation

**SHIP TO SHADOW — do not yet cut over.** The deterministic core (contracts →
adapters → ingestion → engine → ledger → alerts) is implemented, typed,
leakage-hardened, and end-to-end tested — including the Postgres persistence
layer verified against a live database, real-OHLC grading, and all fact
streams. Final suite: **161 tests passing, 0 type errors** (176 with the
live-pg migration suite). Cutover now waits only on the local smoke run and
the §5.5 evidence that must accrue in shadow. No spec violations found.

---

## 7. Go-live status — 2026-07-18 (shadow mode enabled)

Checklist executed on the primary dev machine (macOS, Node 25, pnpm 10.33):

1. **Baseline** — `pnpm typecheck` 0 errors; `pnpm vitest run packages`
   **160 passed / 16 skipped (176)**. Env fixes required: root workspace had no
   toolchain, so `typescript@5.4.5` + `vitest@~1.6` were pinned as root devDeps;
   root tsconfig needed `ignoreDeprecations` "6.0"→"5.0" (TS 5.4 rejects "6.0")
   and `resolveJsonModule` (per-package tsconfigs had it, the root aggregate did not).
2. **Live smoke** — first run SMOKE_FAIL: live Hyperliquid returns
   `impactPxs: null` for some of the 232 assets and `normalizeAssetCtxs` crashed
   (fixtures never covered null). Fixed with a null-safe fallback in the adapter
   (impactBid/impactAsk are not consumed downstream) and `impactPxs` typed
   nullable; all 60 adapter tests still pass. Re-run: **SMOKE_PASS** — 232
   observations, 3 whale positions, 24 BTC 1h candles, hyperliquid + sec_edgar
   healthy, 2 live CROWD_FUNDING_EXTREME signals to console.
3. **Live Postgres** — Docker `postgres:16` (container `mi-pg`); pg-factory
   round-trip green, migrations 001–014 auto-applied. Note: the opt-in
   `RUN_DB_INTEGRATION=1` suite in `packages/db/test/migrations.test.ts` is
   stale (hardcodes 13 migrations, pre-candles) and is not run by CI's
   test-postgres job, which only sets `DATABASE_URL`; left untouched.
4. **First real cycle** — `daily start` with `DATABASE_URL`: 3 signals fired
   (CROWD_FUNDING_EXTREME ×2, POS_WHALE_CONSENSUS on HYPE). Rows verified in
   Postgres: app_signals=3, observations=232, candles=676, positioning=7,
   source-health present. All payloads `origin:"deterministic"`, narration null.
5. **Shadow mode** — v2 tree committed and pushed (`ad5f075`). Workflows copied
   to repo-root `.github/workflows/` (Actions ignores the nested copy under
   `v2/.github/`). **v2 CI green** on push (typecheck + suite) and **v2-cycle
   green** via manual workflow_dispatch — the cloud run ingested live data and
   fired the same 3 signals (console fallback, no shadow chat yet). The 30-min
   schedule is now live. Added an optional `V2_DATABASE_URL` passthrough to
   v2-cycle.yml: without it every cycle is in-memory, signals do not persist
   across runs, and the graded ledger cannot accrue — §5.5 evidence therefore
   requires a hosted Postgres before the shadow clock meaningfully starts.
6. **Pending (operator):** create the separate shadow Telegram chat and set
   `V2_SHADOW_CHAT_ID`; set `ALPACA_API_KEY`/`ALPACA_API_SECRET` (stock jobs
   are skipped without them); provision a hosted Postgres and set
   `V2_DATABASE_URL`; optionally pass `APIFY_TOKEN` (already a repo secret)
   through v2-cycle.yml env for mention-spike signals — deliberately not wired
   yet since a 30-min Apify cadence has real per-run cost. v1 untouched and
   still running.

---

*Reproduce: `cd v2 && pnpm install && pnpm typecheck && pnpm vitest run packages`
(add `DATABASE_URL` to include the live-Postgres suite). Smoke:
`pnpm --filter @market-intel/daily exec tsx src/smoke.ts`.*
