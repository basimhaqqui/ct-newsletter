// Ingestion pipeline tests: fixture ports → jobs → in-memory repos →
// deterministic feature prep → signal engine. No Postgres, no network.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInMemoryRepositoryFactory } from '@market-intel/db';
import { emptyState, runEngine } from '@market-intel/signal-engine';
import { buildFactSet } from '../src/factset.js';
import {
  alpacaJob,
  hyperliquidJob,
  secJob,
  type AlpacaPort,
  type HyperliquidPort,
  type SecPort,
} from '../src/pipelines.js';
import { IngestionScheduler } from '../src/scheduler.js';

const COHORT: unknown = JSON.parse(
  readFileSync(
    new URL('../../signal-engine/cohort/cohort-2026.07.0.json', import.meta.url),
    'utf8',
  ),
);

const NOW = new Date('2026-07-18T12:00:00Z');
const clock = () => NOW;

// ---------------------------------------------------------------------------
// Fixture ports
// ---------------------------------------------------------------------------

const hlPort: HyperliquidPort = {
  async fetchMarket() {
    return [
      {
        symbol: 'HYPE',
        markPrice: 46.1,
        midPrice: 46.12,
        fundingRate: -7.2 / (24 * 365 * 100), // -7.2%/yr annualized
        openInterest: 2_600_000, // * price ≈ $120M
        dayVolume: 300_000_000,
      },
    ];
  },
  async fetchWalletPositions(addr: string) {
    return [
      {
        symbol: 'HYPE',
        side: 'LONG' as const,
        size: 2500,
        entryPrice: 44,
        leverage: 3,
        positionValue: addr === '0xccc' ? 250_000 : 100_000,
      },
    ];
  },
};

const alpacaPort: AlpacaPort = {
  async fetchDailyBars(symbols: string[]) {
    return symbols.map((symbol) => ({
      symbol,
      timestamp: new Date('2026-07-17T13:30:00Z'),
      close: 230.5,
      volume: 50_000_000,
      vwap: 230.1,
      timeframe: '1Day',
    }));
  },
};

const secPort: SecPort = {
  async fetchLatestInsiderTrades() {
    const base = {
      ticker: 'AAPL',
      direction: 'buy' as const,
      price: 228,
      transactionDate: new Date('2026-07-17T00:00:00Z'),
      filingDate: new Date('2026-07-17T22:00:00Z'),
      isDerivative: false,
    };
    return [
      { ...base, insiderName: 'COOK TIM', insiderCik: '0001', accessionNumber: 'acc-1', shares: 1500, sequence: 1 },
      { ...base, insiderName: 'MAESTRI LUCA', insiderCik: '0002', accessionNumber: 'acc-2', shares: 1200, sequence: 1 },
      { ...base, insiderName: 'WILLIAMS JEFF', insiderCik: '0003', accessionNumber: 'acc-3', shares: 1000, sequence: 1 },
    ];
  },
};

const WALLETS = [
  { addr: '0xaaa', label: 'whale-a' },
  { addr: '0xbbb', label: 'whale-b' },
  { addr: '0xccc', label: 'whale-c' },
];

// ---------------------------------------------------------------------------

describe('pipelines write rows + health', () => {
  it('hyperliquid job persists observations, whale positions, raw snapshots', async () => {
    const repos = createInMemoryRepositoryFactory();
    const result = await hyperliquidJob(hlPort, WALLETS).run({ repos, clock });

    expect(result.errors).toEqual([]);
    expect(result.observations).toBe(1);
    expect(result.positioningEvents).toBe(3);
    expect(await repos.rawSnapshots.countBySource('hyperliquid')).toBe(1);

    const obs = await repos.observations.findLatestByAsset('crypto:hl:HYPE');
    expect(obs).not.toBeNull();
    expect(obs!.funding_rate_annualized).toBeCloseTo(-7.2, 6);
    expect(obs!.open_interest_usd).toBeGreaterThan(10_000_000);

    const whales = await repos.positioningEvents.getWhalePositions('crypto:hl:HYPE');
    expect(whales.length).toBe(3);
    expect(new Set(whales.map((w) => w.wallet_address)).size).toBe(3);

    const health = await repos.sourceHealth.findByStatus('healthy');
    expect(health.some((h) => h.source_id === 'hyperliquid')).toBe(true);
  });

  it('is idempotent: re-running does not duplicate positioning rows', async () => {
    const repos = createInMemoryRepositoryFactory();
    const job = hyperliquidJob(hlPort, WALLETS);
    await job.run({ repos, clock });
    await job.run({ repos, clock });
    const whales = await repos.positioningEvents.getWhalePositions('crypto:hl:HYPE');
    expect(whales.length).toBe(3); // same deterministic ids → replaced, not duplicated
  });

  it('sec job records insider filings with latency-preserving times', async () => {
    const repos = createInMemoryRepositoryFactory();
    const result = await secJob(secPort).run({ repos, clock });

    expect(result.errors).toEqual([]);
    expect(result.positioningEvents).toBe(3);
    const filings = await repos.positioningEvents.getInsiderFilings('stock:us:AAPL');
    expect(filings.length).toBe(3);
    for (const f of filings) {
      expect(f.event_time.toISOString()).toBe('2026-07-17T00:00:00.000Z'); // transaction date
      expect(f.observed_time).toEqual(NOW); // observation time — the gap is reporting latency
      expect(f.filing_accession).toBeTruthy();
    }
  });

  it('a failing port records source health degradation, never throws', async () => {
    const repos = createInMemoryRepositoryFactory();
    const badPort: HyperliquidPort = {
      fetchMarket: async () => {
        throw new Error('api down');
      },
      fetchWalletPositions: async () => [],
    };
    const result = await hyperliquidJob(badPort, WALLETS).run({ repos, clock });
    expect(result.errors.length).toBe(1);
    const degraded = await repos.sourceHealth.findByStatus('degraded');
    expect(degraded.some((h) => h.source_id === 'hyperliquid')).toBe(true);
  });
});

describe('scheduler', () => {
  it('runs due jobs and respects intervals', async () => {
    const repos = createInMemoryRepositoryFactory();
    const scheduler = new IngestionScheduler(repos, clock);
    scheduler.register(hyperliquidJob(hlPort, WALLETS, 1800));
    scheduler.register(secJob(secPort, 3600));

    const first = await scheduler.tick(NOW);
    expect(first.length).toBe(2);

    // 10 minutes later: nothing due
    const second = await scheduler.tick(new Date(NOW.getTime() + 600_000));
    expect(second.length).toBe(0);

    // 31 minutes later: only the 30-min hyperliquid job is due
    const third = await scheduler.tick(new Date(NOW.getTime() + 1_860_000));
    expect(third.map((r) => r.job)).toEqual(['hyperliquid-market-and-whales']);
  });

  it('rejects duplicate job names', () => {
    const scheduler = new IngestionScheduler(createInMemoryRepositoryFactory(), clock);
    scheduler.register(secJob(secPort));
    expect(() => scheduler.register(secJob(secPort))).toThrow(/duplicate/);
  });
});

describe('end-to-end: ingestion → feature prep → signal engine', () => {
  it('whales long + negative funding ingested via pipeline fires CROWD_DIVERGENCE', async () => {
    const repos = createInMemoryRepositoryFactory();
    await hyperliquidJob(hlPort, WALLETS).run({ repos, clock });

    const facts = await buildFactSet(repos, { now: NOW });
    expect(facts.observations.length).toBe(1);
    expect(facts.positioning.length).toBe(3);
    expect(facts.source_health['hyperliquid']).toBe('ok');

    const result = runEngine(facts, {
      now: Math.floor(NOW.getTime() / 1000),
      cohort: COHORT,
      state: emptyState(),
      user: {
        tracked_asset_uids: ['crypto:hl:HYPE'],
        cluster_asset_uids: [],
        covered_asset_uids: ['crypto:hl:HYPE'],
      },
    });

    const div = result.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    expect(div).toBeDefined();
    expect(div!.direction).toBe('long');
    expect(div!.levels.reference_price).toBeCloseTo(46.12, 6);
    expect(div!.trigger.inputs['whales_long']).toBe(3);
    expect(div!.origin).toBe('deterministic');

    const consensus = result.signals.find((s) => s.family_id === 'POS_WHALE_CONSENSUS');
    expect(consensus).toBeDefined();
  });

  it('insider cluster ingested via SEC pipeline fires POS_INSIDER_CLUSTER', async () => {
    const repos = createInMemoryRepositoryFactory();
    await secJob(secPort).run({ repos, clock });
    await alpacaJob(alpacaPort, ['AAPL']).run({ repos, clock });

    const facts = await buildFactSet(repos, { now: NOW });
    const result = runEngine(facts, {
      now: Math.floor(NOW.getTime() / 1000),
      cohort: COHORT,
      state: emptyState(),
      user: {
        tracked_asset_uids: ['stock:us:AAPL'],
        cluster_asset_uids: [],
        covered_asset_uids: ['stock:us:AAPL'],
      },
    });

    const sig = result.signals.find((s) => s.family_id === 'POS_INSIDER_CLUSTER');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
    expect(sig!.asset.asset_uid).toBe('stock:us:AAPL');
    expect(sig!.evidence.length).toBe(3);
    expect(sig!.horizon.class).toBe('stock_swing');
  });

  it('feature prep is deterministic for fixed repo content and clock', async () => {
    const repos = createInMemoryRepositoryFactory();
    await hyperliquidJob(hlPort, WALLETS).run({ repos, clock });
    const a = await buildFactSet(repos, { now: NOW });
    const b = await buildFactSet(repos, { now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
