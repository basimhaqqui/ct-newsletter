// Live smoke run: real Hyperliquid + SEC EDGAR network calls, in-memory
// repos, console Telegram. No credentials required. Exercises the full loop
// against production APIs without touching any live chat or database.
//
//   pnpm --filter @market-intel/daily exec tsx src/smoke.ts

import { readFileSync } from 'node:fs';
import { createInMemoryRepositoryFactory } from '@market-intel/db';
import { IngestionScheduler, buildFactSet, candleJob, hyperliquidJob, secJob } from '@market-intel/ingestion';
import { MemoryStateStore, runCycle } from '@market-intel/orchestrator';
import { TelegramClient } from '@market-intel/telegram';
import { liveHyperliquidCandlePort, liveHyperliquidPort, liveSecPort } from './ports.js';

const COHORT: unknown = JSON.parse(
  readFileSync(
    new URL('../../../packages/signal-engine/cohort/cohort-2026.07.0.json', import.meta.url),
    'utf8',
  ),
);

async function main(): Promise<void> {
  const repos = createInMemoryRepositoryFactory();
  const wallets = JSON.parse(
    readFileSync(process.env.WALLETS_FILE ?? new URL('../../../../wallets.json', import.meta.url), 'utf8'),
  ) as { addr: string; label: string }[];

  const scheduler = new IngestionScheduler(repos);
  scheduler.register(hyperliquidJob(liveHyperliquidPort(), wallets.slice(0, 3), 1800));
  scheduler.register(
    candleJob(
      liveHyperliquidCandlePort(),
      [{ assetUid: 'crypto:hl:BTC', symbol: 'BTC', venue: 'hyperliquid' }],
      'hyperliquid',
      '1h',
      1800,
      86_400, // 1 day backfill for the smoke
    ),
  );
  scheduler.register(secJob(liveSecPort({}, Number(process.env.SEC_LIMIT ?? 3)), 3600));

  const report = await runCycle({
    repos,
    scheduler,
    cohort: COHORT,
    user: { tracked_asset_uids: [], cluster_asset_uids: [], covered_asset_uids: [] },
    coverAllObserved: true,
    stateStore: new MemoryStateStore(),
    telegram: new TelegramClient({}), // no creds → console fallback
    now: () => new Date(),
  });

  const facts = await buildFactSet(repos, { now: new Date() });
  const candles = await repos.candles.getSeries(
    'crypto:hl:BTC', 'hyperliquid', '1h',
    new Date(Date.now() - 86_400_000), new Date(),
  );
  const health = await repos.sourceHealth.findAll();

  console.error('--- SMOKE REPORT ---');
  console.error(`cycle: ${JSON.stringify(report)}`);
  console.error(
    `facts: observations=${facts.observations.length} positioning=${facts.positioning.length} ta=${facts.ta.length}`,
  );
  console.error(`candles(BTC 1h, 24h): ${candles.length}`);
  console.error(`health: ${health.map((h) => `${h.source_id}=${h.status}`).join(' ')}`);
  const insiders = await repos.positioningEvents.getInsiderFilings();
  console.error(`sec insider trades ingested: ${insiders.length}`);
  const ok =
    facts.observations.length > 0 &&
    candles.length > 0 &&
    health.some((h) => h.source_id === 'hyperliquid' && h.status === 'healthy');
  console.error(ok ? 'SMOKE_PASS' : 'SMOKE_FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
