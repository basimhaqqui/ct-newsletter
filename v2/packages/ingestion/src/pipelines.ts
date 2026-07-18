// Ingestion pipelines: poll a source port → write raw snapshot retention →
// normalized rows → repos, recording source health either way.
//
// Ports are structural interfaces so pipelines are fixture-testable and the
// concrete adapters (@adapters/core) bolt on with one-line glue at deploy time.

import { hashPayload } from './hash.js';
import {
  alpacaObservationRow,
  hlObservationRow,
  hlWhalePositionRow,
  rawSnapshotRow,
  secInsiderRow,
  type AlpacaBarInput,
  type HlObservationInput,
  type HlWhalePositionInput,
  type InsiderTradeInput,
} from './normalize.js';
import type { IngestionContext, IngestionJob, IngestionResult, TrackedWallet } from './types.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface HyperliquidPort {
  fetchMarket(): Promise<Omit<HlObservationInput, 'observedAt'>[]>;
  fetchWalletPositions(
    addr: string,
  ): Promise<Omit<HlWhalePositionInput, 'observedAt' | 'walletAddress' | 'walletLabel'>[]>;
}

export interface AlpacaPort {
  fetchDailyBars(symbols: string[]): Promise<Omit<AlpacaBarInput, 'observedAt'>[]>;
}

export interface SecPort {
  fetchLatestInsiderTrades(): Promise<Omit<InsiderTradeInput, 'observedAt'>[]>;
}

// ---------------------------------------------------------------------------
// Shared write path
// ---------------------------------------------------------------------------

async function writeHealth(
  ctx: IngestionContext,
  source: string,
  startedMs: number,
  error?: unknown,
): Promise<void> {
  if (error === undefined) {
    await ctx.repos.sourceHealth.recordSuccess(source, Date.now() - startedMs);
  } else {
    await ctx.repos.sourceHealth.recordError(source, {
      type: 'INGESTION_FAILURE',
      message: error instanceof Error ? error.message : String(error),
      timestamp: ctx.clock(),
    });
  }
}

// ---------------------------------------------------------------------------
// Hyperliquid: market observations + tracked-wallet positions
// ---------------------------------------------------------------------------

export function hyperliquidJob(
  port: HyperliquidPort,
  wallets: TrackedWallet[],
  intervalS = 1800,
): IngestionJob {
  return {
    name: 'hyperliquid-market-and-whales',
    source: 'hyperliquid',
    intervalS,
    async run(ctx: IngestionContext): Promise<IngestionResult> {
      const started = Date.now();
      const result: IngestionResult = {
        source: 'hyperliquid',
        rawSnapshots: 0,
        observations: 0,
        positioningEvents: 0,
        errors: [],
      };
      try {
        const observedAt = ctx.clock();
        const market = await port.fetchMarket();
        for (const m of market) {
          const row = hlObservationRow({ ...m, observedAt });
          await ctx.repos.rawSnapshots.insert(
            rawSnapshotRow(
              'hyperliquid',
              row.source_record_id,
              row.asset_uid,
              { ...m },
              hashPayload(m),
              observedAt,
              observedAt,
            ),
          ).catch(() => undefined); // idempotent: duplicate snapshot is fine
          await ctx.repos.observations.bulkInsert([row]);
          result.rawSnapshots += 1;
          result.observations += 1;
        }

        for (const w of wallets) {
          try {
            const positions = await port.fetchWalletPositions(w.addr);
            for (const p of positions) {
              const row = hlWhalePositionRow({
                ...p,
                walletAddress: w.addr,
                walletLabel: w.label,
                observedAt,
              });
              await upsertPositioning(ctx, row);
              result.positioningEvents += 1;
            }
          } catch (err) {
            result.errors.push(`wallet ${w.label}: ${message(err)}`);
          }
        }

        await writeHealth(ctx, 'hyperliquid', started);
      } catch (err) {
        result.errors.push(message(err));
        await writeHealth(ctx, 'hyperliquid', started, err);
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Alpaca: daily bars for the covered stock universe
// ---------------------------------------------------------------------------

export function alpacaJob(port: AlpacaPort, symbols: string[], intervalS = 3600): IngestionJob {
  return {
    name: 'alpaca-daily-bars',
    source: 'alpaca',
    intervalS,
    async run(ctx: IngestionContext): Promise<IngestionResult> {
      const started = Date.now();
      const result: IngestionResult = {
        source: 'alpaca',
        rawSnapshots: 0,
        observations: 0,
        positioningEvents: 0,
        errors: [],
      };
      try {
        const observedAt = ctx.clock();
        const bars = await port.fetchDailyBars(symbols);
        for (const b of bars) {
          const row = alpacaObservationRow({ ...b, observedAt });
          await ctx.repos.rawSnapshots.insert(
            rawSnapshotRow(
              'alpaca',
              row.source_record_id,
              row.asset_uid,
              { ...b, timestamp: b.timestamp.toISOString() },
              hashPayload({ ...b, timestamp: b.timestamp.toISOString() }),
              b.timestamp,
              observedAt,
            ),
          ).catch(() => undefined);
          await ctx.repos.observations.bulkInsert([row]);
          result.rawSnapshots += 1;
          result.observations += 1;
        }
        await writeHealth(ctx, 'alpaca', started);
      } catch (err) {
        result.errors.push(message(err));
        await writeHealth(ctx, 'alpaca', started, err);
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// SEC EDGAR: Form 4 insider transactions
// ---------------------------------------------------------------------------

export function secJob(port: SecPort, intervalS = 3600): IngestionJob {
  return {
    name: 'sec-form4-insiders',
    source: 'sec_edgar',
    intervalS,
    async run(ctx: IngestionContext): Promise<IngestionResult> {
      const started = Date.now();
      const result: IngestionResult = {
        source: 'sec_edgar',
        rawSnapshots: 0,
        observations: 0,
        positioningEvents: 0,
        errors: [],
      };
      try {
        const observedAt = ctx.clock();
        const trades = await port.fetchLatestInsiderTrades();
        for (const t of trades) {
          const row = secInsiderRow({ ...t, observedAt });
          await ctx.repos.rawSnapshots.insert(
            rawSnapshotRow(
              'sec_edgar',
              row.source_record_id,
              row.asset_uid,
              {
                ...t,
                transactionDate: t.transactionDate.toISOString(),
                filingDate: t.filingDate.toISOString(),
              },
              hashPayload({ acc: t.accessionNumber, seq: t.sequence }),
              t.transactionDate,
              observedAt,
            ),
          ).catch(() => undefined);
          await upsertPositioning(ctx, row);
          result.positioningEvents += 1;
          result.rawSnapshots += 1;
        }
        await writeHealth(ctx, 'sec_edgar', started);
      } catch (err) {
        result.errors.push(message(err));
        await writeHealth(ctx, 'sec_edgar', started, err);
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------

async function upsertPositioning(
  ctx: IngestionContext,
  row: import('@market-intel/db').PositioningEventRow,
): Promise<void> {
  // deterministic ids make re-ingestion idempotent: replace, never duplicate
  if (await ctx.repos.positioningEvents.exists(row.id)) {
    await ctx.repos.positioningEvents.update(row);
  } else {
    await ctx.repos.positioningEvents.insert(row);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
