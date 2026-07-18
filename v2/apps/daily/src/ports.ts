// Live adapter → ingestion-port glue. This is the only file where real
// adapters meet the pipeline; everything downstream is deterministic.

import {
  createAlpacaAdapter,
  createHyperliquidAdapter,
  createSecAdapter,
  type AlpacaConfig,
  type SECConfig,
} from '@adapters/core';
import type {
  AlpacaPort,
  CandlePort,
  CatalystPort,
  HyperliquidPort,
  SecPort,
  SocialPort,
  ViralPost,
} from '@market-intel/ingestion';

export function liveHyperliquidPort(): HyperliquidPort {
  const adapter = createHyperliquidAdapter();
  return {
    async fetchMarket() {
      const meta = await adapter.fetchMeta();
      const ctxs = await adapter.fetchAssetCtxs();
      const obs = adapter.normalizeAssetCtxs(ctxs, meta);
      return obs.map((o) => ({
        symbol: o.symbol,
        markPrice: o.markPrice,
        midPrice: o.midPrice,
        fundingRate: o.fundingRate,
        openInterest: o.openInterest,
        dayVolume: o.dayVolume,
      }));
    },
    async fetchWalletPositions(addr: string) {
      const meta = await adapter.fetchMeta();
      const state = await adapter.fetchClearinghouseState(addr);
      const positions = adapter.normalizeClearinghouseState(state, meta);
      return positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        leverage: p.leverage,
        positionValue: p.positionValue,
      }));
    },
  };
}

export function liveAlpacaPort(config: Partial<AlpacaConfig>): AlpacaPort {
  const adapter = createAlpacaAdapter(config);
  return {
    async fetchDailyBars(symbols: string[]) {
      const raw = await adapter.fetchBars(symbols, '1Day', 100);
      const bars = adapter.normalizeBars(raw, '1Day');
      return bars.map((b) => ({
        symbol: b.symbol,
        timestamp: b.timestamp,
        close: b.close,
        volume: b.volume,
        vwap: b.vwap,
        timeframe: b.timeframe,
      }));
    },
  };
}

export function liveHyperliquidCandlePort(): CandlePort {
  const adapter = createHyperliquidAdapter();
  return {
    async fetchCandles(symbol, interval, startMs, endMs) {
      const raw = await adapter.fetchCandles(symbol, interval, startMs, endMs);
      return raw.map((c) => ({
        openTimeMs: c.t,
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v) || null,
      }));
    },
  };
}

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'USD', 'USDE', 'BUSD', 'TUSD', 'FDUSD', 'PYUSD', 'USDD']);

/** Apify X scraper port — mirrors v1 radar.mjs (viral posts, cashtag tally). */
export function liveApifySocialPort(
  apifyToken: string,
  options: { actor?: string; hours?: number; minFaves?: number; maxItems?: number } = {},
): SocialPort {
  const actor = options.actor ?? 'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest';
  const hours = options.hours ?? 6;
  const minFaves = options.minFaves ?? 150;
  const maxItems = options.maxItems ?? 120;
  return {
    async fetchViralPosts(): Promise<ViralPost[]> {
      const since = String(Math.floor((Date.now() - hours * 3600_000) / 1000));
      const q = `(crypto OR altcoin OR memecoin OR pump OR gem OR ape OR "low cap") min_faves:${minFaves} -is:reply -is:retweet lang:en`;
      const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${apifyToken}&maxItems=${maxItems}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms: [q], maxItems, queryType: 'Latest', since_time: since }),
      });
      if (!res.ok) throw new Error(`Apify ${res.status}`);
      const raw = (await res.json()) as Record<string, unknown>[];
      const tick = /\$([A-Za-z]{2,10})\b/g;
      return raw
        .filter((t) => t && typeof t.text === 'string' && !/From KaitoEasyAPI/i.test(String(t.text)) && !t.isReply && !t.retweeted_tweet)
        .map((t) => {
          const text = String(t.text);
          const cashtags = [...new Set([...(text.match(tick) ?? [])].map((m) => m.slice(1).toUpperCase()))].filter(
            (s) => !STABLES.has(s),
          );
          const author = t.author as Record<string, unknown> | undefined;
          return {
            postId: String(t.id ?? t.url ?? Math.abs(hashCode(text))),
            authorHandle: String(author?.userName ?? 'unknown'),
            authorFollowers: typeof author?.followers === 'number' ? (author.followers as number) : null,
            text,
            cashtags,
            likes: Number(t.likeCount ?? 0),
            url: typeof t.url === 'string' ? t.url : null,
            postedAtMs: t.createdAt ? new Date(String(t.createdAt)).getTime() : Date.now(),
          };
        })
        .filter((p) => p.cashtags.length > 0);
    },
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** File-backed catalyst calendar (curated JSON) — swap for an API port later. */
export function fileCatalystPort(path: URL | string): CatalystPort {
  return {
    async fetchEvents() {
      const { readFileSync, existsSync } = await import('node:fs');
      if (typeof path === 'string' && !existsSync(path)) return [];
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return [];
      }
    },
  };
}

export function liveSecPort(config: Partial<SECConfig> = {}, filingLimit = 25): SecPort {
  const adapter = createSecAdapter(config);
  return {
    async fetchLatestInsiderTrades() {
      const filings = await adapter.fetchLatestFilings(filingLimit);
      const out: {
        ticker: string;
        insiderName: string;
        insiderCik: string;
        accessionNumber: string;
        direction: 'buy' | 'sell';
        shares: number;
        price: number;
        transactionDate: Date;
        filingDate: Date;
        isDerivative: boolean;
        sequence: number;
      }[] = [];
      for (const filing of filings) {
        const trades = adapter.normalizeForm4(filing);
        trades.forEach((t, i) => {
          // open-market buys/sells only — grants/awards are not positioning
          if (t.transactionType !== 'P' && t.transactionType !== 'S') return;
          out.push({
            ticker: t.symbol,
            insiderName: t.ownerName,
            insiderCik: t.ownerCik,
            accessionNumber: filing.accessionNumber,
            direction: t.transactionType === 'P' ? 'buy' : 'sell',
            shares: t.shares,
            price: t.pricePerShare,
            transactionDate: t.transactionDate,
            filingDate: new Date(filing.filingDate),
            isDerivative: false,
            sequence: i + 1,
          });
        });
      }
      return out;
    },
  };
}
