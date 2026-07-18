// Candle ingestion: poll a candle port → CandleRow upserts. Incremental —
// resumes from the latest stored bar per (asset, interval). Real OHLC gives
// the grader true first-touch ordering (intrabar wicks).

import type { CandleRow } from '@market-intel/db';
import type { IngestionContext, IngestionJob, IngestionResult } from './types.js';

export interface CandleBar {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface CandlePort {
  /** fetch bars for one symbol in [startMs, endMs] */
  fetchCandles(symbol: string, interval: string, startMs: number, endMs: number): Promise<CandleBar[]>;
}

export interface CandleTarget {
  assetUid: string;
  symbol: string;
  venue: string;
}

export function candleRow(
  target: CandleTarget,
  interval: string,
  bar: CandleBar,
  source: string,
  ingestedAt: Date,
): CandleRow {
  const openS = Math.floor(bar.openTimeMs / 1000);
  return {
    id: `${source}:candle:${target.symbol.toUpperCase()}:${interval}:${openS}`,
    asset_uid: target.assetUid,
    symbol: target.symbol.toUpperCase(),
    venue: target.venue,
    bar_interval: interval,
    open_time: new Date(bar.openTimeMs),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    source,
    quality: 'ok',
    ingested_time: ingestedAt,
  };
}

export function candleJob(
  port: CandlePort,
  targets: CandleTarget[],
  source: string,
  interval = '1h',
  intervalS = 1800,
  backfillS = 7 * 86400,
): IngestionJob {
  return {
    name: `${source}-candles-${interval}`,
    source,
    intervalS,
    async run(ctx: IngestionContext): Promise<IngestionResult> {
      const result: IngestionResult = {
        source,
        rawSnapshots: 0,
        observations: 0,
        positioningEvents: 0,
        errors: [],
      };
      const now = ctx.clock();
      for (const target of targets) {
        try {
          const latest = await ctx.repos.candles.latestOpenTime(
            target.assetUid,
            target.venue,
            interval,
          );
          const startMs = latest
            ? latest.getTime() + 1000 // resume just after the last stored bar
            : now.getTime() - backfillS * 1000;
          const bars = await port.fetchCandles(target.symbol, interval, startMs, now.getTime());
          const rows = bars.map((b) => candleRow(target, interval, b, source, now));
          await ctx.repos.candles.upsertMany(rows);
          result.observations += rows.length;
        } catch (err) {
          result.errors.push(
            `${target.symbol}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return result;
    },
  };
}
