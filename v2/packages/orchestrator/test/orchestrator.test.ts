// Full-product test: ingestion → engine → persistence → tiered Telegram
// alert → time-travel past horizon → grading ledger row. In-memory repos,
// fixture ports, mock Telegram. This is the wiring t_efb36ee3 ships.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createInMemoryRepositoryFactory } from '@market-intel/db';
import { IngestionScheduler, hyperliquidJob, type HyperliquidPort } from '@market-intel/ingestion';
import type { SendResult, TelegramSender } from '@market-intel/telegram';
import { gradeDue, runCycle } from '../src/cycle.js';
import { MemoryStateStore } from '../src/state-store.js';

const COHORT: unknown = JSON.parse(
  readFileSync(
    new URL('../../signal-engine/cohort/cohort-2026.07.0.json', import.meta.url),
    'utf8',
  ),
);

const T0 = new Date('2026-07-18T12:00:00Z');

class MockTelegram implements TelegramSender {
  sent: string[] = [];
  async send(html: string): Promise<SendResult> {
    this.sent.push(html);
    return { ok: true, delivered: true };
  }
}

function hlPort(funding = -7.2, price = 46.12): HyperliquidPort {
  return {
    async fetchMarket() {
      return [
        {
          symbol: 'HYPE',
          markPrice: price,
          midPrice: price,
          fundingRate: funding / (24 * 365 * 100),
          openInterest: 2_600_000,
          dayVolume: 300_000_000,
        },
      ];
    },
    async fetchWalletPositions() {
      return [
        { symbol: 'HYPE', side: 'LONG' as const, size: 2500, entryPrice: 44, leverage: 3, positionValue: 120_000 },
      ];
    },
  };
}

const WALLETS = [
  { addr: '0xaaa', label: 'a' },
  { addr: '0xbbb', label: 'b' },
  { addr: '0xccc', label: 'c' },
];

function deps(telegram: MockTelegram, now: Date, stateStore = new MemoryStateStore()) {
  const repos = createInMemoryRepositoryFactory();
  const scheduler = new IngestionScheduler(repos, () => now);
  scheduler.register(hyperliquidJob(hlPort(), WALLETS, 1800));
  return {
    repos,
    scheduler,
    cohort: COHORT,
    user: {
      tracked_asset_uids: ['crypto:hl:HYPE'],
      cluster_asset_uids: [],
      covered_asset_uids: ['crypto:hl:HYPE'],
    },
    stateStore,
    telegram,
    now: () => now,
  };
}

describe('runCycle: the full product loop', () => {
  it('ingests, detects, persists, and pushes a P0 alert', async () => {
    const telegram = new MockTelegram();
    const d = deps(telegram, T0);

    const report = await runCycle(d);

    expect(report.ingestionRuns).toBe(1);
    expect(report.signalsFired).toBeGreaterThanOrEqual(2); // divergence + consensus
    expect(report.alertsSent.push).toBe(true);

    // persisted rows
    const active = await d.repos.signals.findActive();
    expect(active.length).toBe(report.signalsFired);
    const div = active.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    expect(div).toBeDefined();
    expect(div!.origin).toBe('deterministic');
    expect(div!.reference_price).toBeCloseTo(46.12, 6);

    // the alert names the coin, the levels are absent (no TA), provenance included
    const push = telegram.sent.find((m) => m.includes('act now'));
    expect(push).toBeDefined();
    expect(push!).toContain('<b>HYPE</b>');
    expect(push!).toContain('whales LONG');
    expect(push!).toContain('cohort/2026.07.0');
  });

  it('second cycle inside cooldown fires nothing and sends nothing', async () => {
    const telegram = new MockTelegram();
    const store = new MemoryStateStore();
    const d1 = deps(telegram, T0, store);
    await runCycle(d1);
    const sentAfterFirst = telegram.sent.length;

    // 30 min later, same conditions, same state store — suppressed by cooldown
    const later = new Date(T0.getTime() + 1800_000);
    const d2 = { ...deps(telegram, later, store), stateStore: store };
    const report2 = await runCycle(d2);

    expect(report2.signalsFired).toBe(0);
    expect(report2.suppressed).toBeGreaterThan(0);
    expect(telegram.sent.length).toBe(sentAfterFirst);
  });

  it('records abstentions as first-class rows (never alerted)', async () => {
    const telegram = new MockTelegram();
    const d = deps(telegram, T0);
    // ingest first (data exists), THEN mark the source unhealthy → ABSTAIN_SOURCE
    await hyperliquidJob(hlPort(), WALLETS, 1800).run({ repos: d.repos, clock: () => T0 });
    for (let i = 0; i < 3; i++) {
      await d.repos.sourceHealth.recordError('hyperliquid', { type: 'x', message: 'down', timestamp: T0 });
    }

    const report = await runCycle({ ...d, scheduler: null });
    expect(report.signalsFired).toBe(0);
    expect(report.abstentions).toBeGreaterThan(0);
    const abst = await d.repos.abstentions.findAll();
    expect(abst.length).toBe(report.abstentions);
    expect(abst[0].reason).toBe('ABSTAIN_SOURCE');
    expect(telegram.sent.length).toBe(0);
  });
});

describe('gradeDue: post-horizon ledger', () => {
  it('grades a fired signal after its horizon from stored price series', async () => {
    const telegram = new MockTelegram();
    const d = deps(telegram, T0);
    await runCycle(d);

    const [signal] = await d.repos.signals.findActive(1);
    expect(signal).toBeDefined();

    // nothing due yet
    const early = await gradeDue({ repos: d.repos, cohort: COHORT, now: () => T0 });
    expect(early.graded).toBe(0);
    expect(early.skippedNotDue).toBeGreaterThan(0);

    // seed the in-window price series: drift upward, then past-horizon clock
    const horizonEnd = new Date(signal.detected_time.getTime() + signal.horizon_seconds * 1000);
    const seed = [];
    for (let i = 1; i <= 10; i++) {
      const t = new Date(signal.detected_time.getTime() + (i * signal.horizon_seconds * 100));
      seed.push({
        id: `seed:${i}`,
        asset_uid: signal.asset_uid,
        symbol: signal.symbol,
        venue: signal.venue,
        price: 46.12 * (1 + 0.002 * i),
        bid: null, ask: null, mark_price: null, index_price: null,
        funding_rate: null, funding_rate_annualized: null,
        open_interest: null, open_interest_usd: null,
        volume_24h: null, volume_24h_usd: null, basis: null, basis_annualized: null,
        event_time: t, observed_time: t, ingested_time: t,
        source: 'hyperliquid', source_record_id: `seed:${i}`,
        quality: 'ok' as const, evidence_ref_ids: [],
      });
    }
    await d.repos.observations.bulkInsert(seed);

    const after = new Date(horizonEnd.getTime() + 60_000);
    const report = await gradeDue({ repos: d.repos, cohort: COHORT, now: () => after });

    expect(report.graded).toBeGreaterThan(0);
    const grade = await d.repos.grades.findBySignalId(signal.signal_id);
    expect(grade).not.toBeNull();
    expect(grade!.origin).toBe('deterministic');
    expect(grade!.grader_version).toBe('grader/2.0.0');
    // no levels on this signal (no TA facts) → excursion-only NOT_GRADED or timeout
    expect(['NOT_GRADED', 'TIMEOUT_WIN', 'TIMEOUT_LOSS']).toContain(grade!.outcome);

    // idempotent: re-running grades nothing new (append-only ledger)
    const again = await gradeDue({ repos: d.repos, cohort: COHORT, now: () => after });
    expect(again.graded).toBe(0);
  });
});
