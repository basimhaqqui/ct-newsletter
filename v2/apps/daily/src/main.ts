// Daily/interval runner — the v2 replacement for run-daily.sh + hl-watch.
// One invocation = one cycle: ingest due sources → detect → persist → alert →
// grade anything past horizon. Designed for cron / GitHub Actions.
//
// Env:
//   DATABASE_URL            Postgres DSN (omit → in-memory, dry-run mode)
//   ALPACA_API_KEY/SECRET   Alpaca credentials
//   TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
//   WALLETS_FILE            tracked wallets json (default ../../wallets.json)
//   STOCK_SYMBOLS           comma-separated coverage list
//   STATE_FILE              engine state path (default state/engine-state.json)

import { readFileSync } from 'node:fs';
import { createInMemoryRepositoryFactory, createPgRepositoryFactory, type RepositoryFactory } from '@market-intel/db';
import {
  IngestionScheduler,
  alpacaJob,
  candleJob,
  catalystJob,
  hyperliquidJob,
  secJob,
  socialJob,
} from '@market-intel/ingestion';
import { FileStateStore, gradeDue, runCycle } from '@market-intel/orchestrator';
import { TelegramClient } from '@market-intel/telegram';
import {
  fileCatalystPort,
  liveAlpacaPort,
  liveApifySocialPort,
  liveHyperliquidCandlePort,
  liveHyperliquidPort,
  liveSecPort,
} from './ports.js';

const COHORT: unknown = JSON.parse(
  readFileSync(
    new URL('../../../packages/signal-engine/cohort/cohort-2026.07.0.json', import.meta.url),
    'utf8',
  ),
);

async function main(): Promise<void> {
  const env = process.env;

  // repos: real Postgres when DATABASE_URL is set; in-memory dry-run otherwise
  const repos: RepositoryFactory = env.DATABASE_URL
    ? await createPgRepositoryFactory({ connectionString: env.DATABASE_URL })
    : createInMemoryRepositoryFactory();
  if (!env.DATABASE_URL) console.error('dry run: no DATABASE_URL, using in-memory repositories');

  const wallets = JSON.parse(
    readFileSync(env.WALLETS_FILE ?? new URL('../../../../wallets.json', import.meta.url), 'utf8'),
  ) as { addr: string; label: string }[];
  const stockSymbols = (env.STOCK_SYMBOLS ?? 'AAPL,MSFT,NVDA,TSLA,SPY').split(',');
  const candleCoins = (env.CANDLE_COINS ?? 'BTC,ETH,SOL,HYPE').split(',').map((symbol) => ({
    assetUid: `crypto:hl:${symbol.toUpperCase()}`,
    symbol: symbol.toUpperCase(),
    venue: 'hyperliquid',
  }));

  const scheduler = new IngestionScheduler(repos);
  scheduler.register(hyperliquidJob(liveHyperliquidPort(), wallets, 1800));
  scheduler.register(candleJob(liveHyperliquidCandlePort(), candleCoins, 'hyperliquid', '1h', 1800));
  if (env.ALPACA_API_KEY) {
    scheduler.register(
      alpacaJob(liveAlpacaPort({ apiKey: env.ALPACA_API_KEY, apiSecret: env.ALPACA_API_SECRET ?? '' }), stockSymbols, 3600),
    );
  }
  scheduler.register(secJob(liveSecPort({}), 3600));
  if (env.APIFY_TOKEN) {
    const coveredCrypto = new Set(candleCoins.map((c) => c.symbol));
    scheduler.register(
      socialJob(
        liveApifySocialPort(env.APIFY_TOKEN),
        (sym) =>
          coveredCrypto.has(sym) ? `crypto:hl:${sym}` : stockSymbols.includes(sym) ? `stock:us:${sym}` : `crypto:hl:${sym}`,
        1800,
      ),
    );
  }
  scheduler.register(catalystJob(fileCatalystPort(env.CATALYSTS_FILE ?? 'state/catalysts.json'), 3600));

  const telegram = new TelegramClient({
    botToken: env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: env.TELEGRAM_CHAT_ID ?? '',
  });

  const report = await runCycle({
    repos,
    scheduler,
    cohort: COHORT,
    user: {
      tracked_asset_uids: (env.TRACKED_ASSETS ?? '').split(',').filter(Boolean),
      cluster_asset_uids: [],
      covered_asset_uids: [],
    },
    coverAllObserved: true,
    stateStore: new FileStateStore(env.STATE_FILE ?? 'state/engine-state.json'),
    telegram,
    now: () => new Date(),
  });
  console.error(`cycle: ${JSON.stringify(report)}`);

  const grades = await gradeDue({ repos, cohort: COHORT, now: () => new Date() });
  console.error(`grading: considered=${grades.considered} graded=${grades.graded}`);
}

main().catch((err) => {
  console.error(`daily runner failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
