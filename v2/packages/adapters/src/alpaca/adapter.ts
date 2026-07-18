// Alpaca adapter — production rebuild (Kanban t_0fd966d5). Matches the
// Hyperliquid adapter quality bar: retry/backoff, rate limiting, typed errors,
// health tracking, deterministic IDs, stable asset UIDs, fact envelopes.
// Fixture-driven testable: fetch is injectable.

import { TokenBucketRateLimiter, hashPayload } from '../shared/rate-limiter.js';
import {
  createAlpacaError,
  createDefaultAlpacaConfig,
  isRetryableAlpacaError,
  toTypedSourceError,
  type AlpacaAsset,
  type AlpacaAssetNormalized,
  type AlpacaAssetsResponse,
  type AlpacaBar,
  type AlpacaBarNormalized,
  type AlpacaBarsResponse,
  type AlpacaConfig,
  type AlpacaError,
  type AlpacaSourceHealth,
  type AlpacaTimeframe,
  type AssetUID,
  type FactEnvelope,
} from './types.js';

type FetchLike = typeof fetch;

export class AlpacaAdapter {
  private readonly config: AlpacaConfig;
  private readonly health: AlpacaSourceHealth;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly fetchImpl: FetchLike;
  private assetsCache: AlpacaAssetsResponse | null = null;
  private assetsCacheTime = 0;
  private readonly ASSETS_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(config?: Partial<AlpacaConfig>, fetchImpl?: FetchLike) {
    this.config = createDefaultAlpacaConfig(config);
    this.fetchImpl = fetchImpl ?? fetch;
    this.rateLimiter = new TokenBucketRateLimiter({
      capacity: Math.max(1, Math.ceil(this.config.rateLimitRps)),
      refillRatePerSec: this.config.rateLimitRps,
    });
    this.health = {
      status: 'healthy',
      lastChecked: new Date(),
      errors: [],
      lastAssetsFetch: null,
      lastBarsFetch: null,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP core: rate-limited, timed-out, retried with exponential backoff
  // -------------------------------------------------------------------------

  private async fetchWithRetry<T>(
    url: string,
    healthField: 'lastAssetsFetch' | 'lastBarsFetch',
  ): Promise<T> {
    await this.rateLimiter.take();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'APCA-API-KEY-ID': this.config.apiKey,
            'APCA-API-SECRET-KEY': this.config.apiSecret,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw this.httpError(response.status);
        }

        const data = (await response.json()) as T;
        this.health.status = 'healthy';
        this.health.errors = [];
        this.health[healthField] = new Date();
        this.health.lastChecked = new Date();
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = this.classify(error);
        if (!isRetryableAlpacaError(lastError)) break;
        if (attempt === this.config.maxRetries) break;
        const delay = this.config.retryBackoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.health.status = 'degraded';
    this.health.errors.push(toTypedSourceError(lastError, { id: 'alpaca', type: 'market-data' }));
    this.health.lastChecked = new Date();
    throw lastError;
  }

  private httpError(status: number): AlpacaError {
    if (status === 429) {
      return createAlpacaError(`Rate limited: ${status}`, 'RATE_LIMITED', { statusCode: status, retryable: true });
    }
    if (status >= 500) {
      return createAlpacaError(`Server error: ${status}`, 'SERVER_ERROR', { statusCode: status, retryable: true });
    }
    if (status === 401 || status === 403) {
      return createAlpacaError(`Unauthorized: ${status}`, 'UNAUTHORIZED', { statusCode: status, retryable: false });
    }
    if (status === 404) {
      return createAlpacaError(`Not found: ${status}`, 'NOT_FOUND', { statusCode: status, retryable: false });
    }
    return createAlpacaError(`HTTP error: ${status}`, 'INVALID_RESPONSE', { statusCode: status, retryable: false });
  }

  private classify(error: unknown): AlpacaError {
    if (error instanceof Error && 'retryable' in error) return error as AlpacaError;
    if (error instanceof DOMException && error.name === 'AbortError') {
      return createAlpacaError(`Request timeout after ${this.config.timeoutMs}ms`, 'TIMEOUT', { retryable: true });
    }
    if (error instanceof TypeError) {
      return createAlpacaError(`Network error: ${error.message}`, 'NETWORK_ERROR', { retryable: true });
    }
    return createAlpacaError(String(error), 'INVALID_RESPONSE', { retryable: false });
  }

  // -------------------------------------------------------------------------
  // Fetchers
  // -------------------------------------------------------------------------

  async fetchAssets(): Promise<AlpacaAssetsResponse> {
    const now = Date.now();
    if (this.assetsCache && now - this.assetsCacheTime < this.ASSETS_CACHE_TTL_MS) {
      return this.assetsCache;
    }
    const raw = await this.fetchWithRetry<AlpacaAsset[] | AlpacaAssetsResponse>(
      `${this.config.tradingBaseUrl}/v2/assets?status=active`,
      'lastAssetsFetch',
    );
    // live API returns a bare array; tolerate both shapes
    const data: AlpacaAssetsResponse = Array.isArray(raw) ? { assets: raw } : raw;
    this.assetsCache = data;
    this.assetsCacheTime = now;
    return data;
  }

  async fetchBars(
    symbols: string[],
    timeframe: AlpacaTimeframe = '1Day',
    limit = 100,
    start?: string,
    end?: string,
  ): Promise<AlpacaBarsResponse> {
    if (symbols.length === 0) return { bars: {} };
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe,
      limit: String(limit),
      adjustment: 'raw',
      feed: this.config.feed,
    });
    if (start) params.set('start', start);
    if (end) params.set('end', end);

    // follow pagination so long ranges are complete
    const merged: AlpacaBarsResponse = { bars: {} };
    let pageToken: string | null | undefined;
    do {
      if (pageToken) params.set('page_token', pageToken);
      const page = await this.fetchWithRetry<AlpacaBarsResponse>(
        `${this.config.dataBaseUrl}/v2/stocks/bars?${params.toString()}`,
        'lastBarsFetch',
      );
      for (const [sym, bars] of Object.entries(page.bars ?? {})) {
        merged.bars[sym] = [...(merged.bars[sym] ?? []), ...bars];
      }
      pageToken = page.next_page_token;
    } while (pageToken);

    return merged;
  }

  // -------------------------------------------------------------------------
  // Normalizers (pure)
  // -------------------------------------------------------------------------

  normalizeAssets(response: AlpacaAssetsResponse): AlpacaAssetNormalized[] {
    return response.assets
      .filter((a) => a.tradable && a.status === 'active')
      .map((a) => ({
        uid: AlpacaAdapter.generateAssetUid(a.symbol),
        symbol: a.symbol,
        name: a.name,
        type: a.class === 'crypto' ? ('crypto' as const) : ('stock' as const),
        exchange: a.exchange,
        tradable: a.tradable,
        marginable: a.marginable,
        shortable: a.shortable,
        fractionable: a.fractionable,
      }))
      .sort((x, y) => x.symbol.localeCompare(y.symbol));
  }

  normalizeBars(response: AlpacaBarsResponse, timeframe: AlpacaTimeframe = '1Day'): AlpacaBarNormalized[] {
    const out: AlpacaBarNormalized[] = [];
    for (const symbol of Object.keys(response.bars).sort()) {
      for (const bar of response.bars[symbol] ?? []) {
        out.push(AlpacaAdapter.normalizeBar(symbol, bar, timeframe));
      }
    }
    return out;
  }

  static normalizeBar(symbol: string, bar: AlpacaBar, timeframe: AlpacaTimeframe): AlpacaBarNormalized {
    return {
      assetUid: AlpacaAdapter.generateAssetUid(symbol),
      symbol,
      timestamp: new Date(bar.t),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      tradeCount: bar.n,
      vwap: bar.vw,
      timeframe,
      source: 'alpaca',
    };
  }

  // -------------------------------------------------------------------------
  // Deterministic identity + provenance
  // -------------------------------------------------------------------------

  /** Stable canonical UID (spec §2.1): stock:us:<SYMBOL> — venue-independent. */
  static generateAssetUid(symbol: string): AssetUID {
    return `stock:us:${symbol.toUpperCase()}`;
  }

  static generateBarId(symbol: string, timeframe: AlpacaTimeframe, barOpen: Date): string {
    return `alpaca:bar:${symbol.toUpperCase()}:${timeframe}:${Math.floor(barOpen.getTime() / 1000)}`;
  }

  static createAssetFactEnvelope(
    asset: AlpacaAssetNormalized,
    observedAt: Date = new Date(),
  ): FactEnvelope<AlpacaAssetNormalized> {
    const iso = observedAt.toISOString();
    return {
      schema_version: '0.1',
      source: 'alpaca',
      source_record_id: `alpaca:asset:${asset.symbol.toUpperCase()}`,
      asset_uid: asset.uid,
      event_time: iso,
      observed_time: iso,
      ingested_time: iso,
      payload_hash: hashPayload(asset),
      quality: 'ok',
      evidence_ref_ids: [`alpaca:asset:${asset.symbol.toUpperCase()}`],
      data: asset,
    };
  }

  static createBarFactEnvelope(
    bar: AlpacaBarNormalized,
    observedAt: Date = new Date(),
  ): FactEnvelope<AlpacaBarNormalized> {
    const recordId = AlpacaAdapter.generateBarId(bar.symbol, bar.timeframe, bar.timestamp);
    return {
      schema_version: '0.1',
      source: 'alpaca',
      source_record_id: recordId,
      asset_uid: bar.assetUid,
      event_time: bar.timestamp.toISOString(),
      observed_time: observedAt.toISOString(),
      ingested_time: observedAt.toISOString(),
      payload_hash: hashPayload({ ...bar, timestamp: bar.timestamp.toISOString() }),
      quality: 'ok',
      evidence_ref_ids: [recordId],
      data: bar,
    };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<AlpacaSourceHealth> {
    this.health.lastChecked = new Date();
    try {
      await this.fetchWithRetry(`${this.config.tradingBaseUrl}/v2/assets?status=active`, 'lastAssetsFetch');
      this.health.status = 'healthy';
    } catch (error) {
      this.health.status = isRetryableAlpacaError(error) ? 'degraded' : 'unhealthy';
    }
    return { ...this.health, errors: [...this.health.errors] };
  }

  getHealth(): AlpacaSourceHealth {
    return { ...this.health, errors: [...this.health.errors] };
  }

  getConfig(): AlpacaConfig {
    return { ...this.config };
  }
}

export function createAlpacaAdapter(
  config?: Partial<AlpacaConfig>,
  fetchImpl?: FetchLike,
): AlpacaAdapter {
  return new AlpacaAdapter(config, fetchImpl);
}
