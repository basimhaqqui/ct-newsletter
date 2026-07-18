// Candle, social, and catalyst pipeline tests + engine wiring.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createInMemoryRepositoryFactory } from '@market-intel/db';
import { emptyState, runEngine } from '@market-intel/signal-engine';
import { candleJob, type CandlePort } from '../src/candles.js';
import { buildFactSet } from '../src/factset.js';
import { catalystJob, socialJob, type CatalystPort, type SocialPort, type ViralPost } from '../src/social-catalyst.js';

const COHORT: unknown = JSON.parse(
  readFileSync(new URL('../../signal-engine/cohort/cohort-2026.07.0.json', import.meta.url), 'utf8'),
);
const NOW = new Date('2026-07-18T12:00:00Z');
const clock = () => NOW;
const HYPE = { assetUid: 'crypto:hl:HYPE', symbol: 'HYPE', venue: 'hyperliquid' };

describe('candle pipeline', () => {
  const port: CandlePort = {
    async fetchCandles(_symbol, _interval, startMs, endMs) {
      const bars = [];
      for (let t = startMs; t < endMs; t += 3600_000) {
        if (t < startMs) continue;
        bars.push({ openTimeMs: t, open: 46, high: 47, low: 45.5, close: 46.5, volume: 1e6 });
      }
      return bars.slice(0, 24);
    },
  };

  it('backfills on first run and stores OHLC rows', async () => {
    const repos = createInMemoryRepositoryFactory();
    const result = await candleJob(port, [HYPE], 'hyperliquid', '1h', 1800, 86_400).run({ repos, clock });
    expect(result.errors).toEqual([]);
    expect(result.observations).toBe(24);
    const series = await repos.candles.getSeries(
      HYPE.assetUid, 'hyperliquid', '1h',
      new Date(NOW.getTime() - 86_400_000), NOW,
    );
    expect(series.length).toBe(24);
    expect(series[0].high).toBe(47);
  });

  it('resumes incrementally from the latest stored bar', async () => {
    const repos = createInMemoryRepositoryFactory();
    const job = candleJob(port, [HYPE], 'hyperliquid', '1h', 1800, 86_400);
    await job.run({ repos, clock });
    const secondRun = await job.run({ repos, clock });
    // latest bar is < 1h old → nothing (or almost nothing) new to fetch
    expect(secondRun.observations).toBeLessThanOrEqual(1);
  });
});

describe('social pipeline → mention facts → engine', () => {
  function post(id: string, likes = 500): ViralPost {
    return {
      postId: id,
      authorHandle: 'degentrader',
      authorFollowers: 50_000,
      text: `$HYPE is going parabolic`,
      cashtags: ['HYPE'],
      likes,
      url: `https://x.com/x/status/${id}`,
      postedAtMs: NOW.getTime() - 600_000,
    };
  }
  const resolver = (sym: string) => (sym === 'HYPE' ? 'crypto:hl:HYPE' : null);

  it('persists claims idempotently and skips unknown tickers', async () => {
    const repos = createInMemoryRepositoryFactory();
    const port: SocialPort = {
      async fetchViralPosts() {
        return [post('1'), post('1'), { ...post('2'), cashtags: ['UNKNOWN'] }];
      },
    };
    const result = await socialJob(port, resolver).run({ repos, clock });
    expect(result.errors).toEqual([]);
    const claims = await repos.socialClaims.findByAsset('crypto:hl:HYPE');
    expect(claims.length).toBe(1); // dupes + unknown filtered
    expect(claims[0].cashtags).toEqual(['HYPE']);
  });

  it('ingested claims aggregate into mention facts that can fire the engine', async () => {
    const repos = createInMemoryRepositoryFactory();
    const port: SocialPort = {
      async fetchViralPosts() {
        return Array.from({ length: 8 }, (_, i) => post(`p${i}`));
      },
    };
    await socialJob(port, resolver).run({ repos, clock });

    const facts = await buildFactSet(repos, { now: NOW });
    expect(facts.mentions.length).toBe(1);
    expect(facts.mentions[0].mention_count).toBe(8);

    // baseline of 2 → 8 mentions is a 4x spike
    const state = emptyState();
    state.mention_baseline = { 'crypto:hl:HYPE': 2 };
    const result = runEngine(facts, {
      now: Math.floor(NOW.getTime() / 1000),
      cohort: COHORT,
      state,
      user: { tracked_asset_uids: ['crypto:hl:HYPE'], cluster_asset_uids: [], covered_asset_uids: ['crypto:hl:HYPE'] },
    });
    const spike = result.signals.find((s) => s.family_id === 'CROWD_MENTION_SPIKE');
    expect(spike).toBeDefined();
    expect(spike!.trigger.inputs['mentions']).toBe(8);
  });
});

describe('catalyst pipeline → engine', () => {
  it('upserts calendar events and fires CATALYST_UPCOMING', async () => {
    const repos = createInMemoryRepositoryFactory();
    const port: CatalystPort = {
      async fetchEvents() {
        return [
          {
            eventId: 'aapl-q3-2026',
            assetUid: 'stock:us:AAPL',
            catalystType: 'earnings' as const,
            title: 'AAPL Q3 earnings',
            impact: 'high' as const,
            scheduledAtMs: NOW.getTime() + 86_400_000,
            actualAtMs: null,
            consensusEstimate: { eps: 2.35 },
            actualValue: null,
            surprisePct: null,
            source: 'earnings',
            url: null,
          },
        ];
      },
    };
    const result = await catalystJob(port).run({ repos, clock });
    expect(result.errors).toEqual([]);

    // idempotent upsert
    await catalystJob(port).run({ repos, clock });
    expect((await repos.catalysts.findAll()).length).toBe(1);

    const facts = await buildFactSet(repos, { now: NOW });
    expect(facts.catalysts.length).toBe(1);

    const engineResult = runEngine(facts, {
      now: Math.floor(NOW.getTime() / 1000),
      cohort: COHORT,
      state: emptyState(),
      user: { tracked_asset_uids: ['stock:us:AAPL'], cluster_asset_uids: [], covered_asset_uids: ['stock:us:AAPL'] },
    });
    const sig = engineResult.signals.find((s) => s.family_id === 'CATALYST_UPCOMING');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('neutral');
  });
});
