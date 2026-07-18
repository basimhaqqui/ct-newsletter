import {
 type HyperliquidConfig,
 createDefaultConfig,
 type HyperliquidMetaResponse,
 type HyperliquidAssetContext,
 type HyperliquidClearinghouseState,
 type HyperliquidUserFill,
 type HyperliquidAsset,
 type HyperliquidMarketObservation,
 type HyperliquidPositionSnapshot,
 type HyperliquidUserFillNormalized,
 type HyperliquidSourceHealth,
 type HyperliquidAdapter,
 type HyperliquidError,
 type HyperliquidErrorType,
 type FactReference,
 type AssetUID,
 createHyperliquidError,
 isRetryableError,
 toTypedSourceError,
} from './types.js';
import type { FactEnvelope } from './types.js';
export class HyperliquidPublicAdapter implements HyperliquidAdapter {
  private config: HyperliquidConfig;
  private health: HyperliquidSourceHealth;
  private metaCache: HyperliquidMetaResponse | null = null;
  private metaCacheTime: number = 0;
  private readonly META_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config?: Partial<HyperliquidConfig>) {
    this.config = createDefaultConfig(config);
    this.health = {
      status: 'healthy',
      lastChecked: new Date(),
      errors: [],
      lastMetaFetch: null,
      lastAssetCtxFetch: null,
      lastClearinghouseFetch: null,
      lastUserFillsFetch: null,
    };
  }

  private async fetchWithRetry<T>(
    body: Record<string, unknown>,
    healthField: keyof HyperliquidSourceHealth
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await fetch(`${this.config.baseUrl}/info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 429) {
            throw createHyperliquidError(
              `Rate limited: ${response.status}`,
              'RATE_LIMITED',
              { statusCode: response.status, retryable: true }
            );
          }
          if (response.status >= 500) {
            throw createHyperliquidError(
              `Server error: ${response.status}`,
              'SERVER_ERROR',
              { statusCode: response.status, retryable: true }
            );
          }
          if (response.status === 404) {
            throw createHyperliquidError(
              `Not found: ${response.status}`,
              'NOT_FOUND',
              { statusCode: response.status, retryable: false }
            );
          }
          if (response.status === 401 || response.status === 403) {
            throw createHyperliquidError(
              `Unauthorized: ${response.status}`,
              'UNAUTHORIZED',
              { statusCode: response.status, retryable: false }
            );
          }
          throw createHyperliquidError(
            `HTTP error: ${response.status}`,
            'INVALID_RESPONSE',
            { statusCode: response.status, retryable: false }
          );
        }

        const data = await response.json();

        // Update health on success
        this.health.status = 'healthy';
        this.health.errors = [];
        (this.health as Record<string, unknown>)[healthField] = new Date();

        return data as T;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DOMException && error.name === 'AbortError') {
          lastError = createHyperliquidError(
            `Request timeout after ${this.config.timeoutMs}ms`,
            'TIMEOUT',
            { retryable: true }
          );
        } else if (error instanceof TypeError && error.message.includes('fetch')) {
          lastError = createHyperliquidError(
            `Network error: ${error.message}`,
            'NETWORK_ERROR',
            { retryable: true }
          );
        }

        // Don't retry on non-retryable errors
        if (lastError && 'retryable' in lastError && !(lastError as HyperliquidError).retryable) {
          break;
        }

        // Don't retry on last attempt
        if (attempt === this.config.maxRetries) {
          break;
        }

        // Exponential backoff
        const delay = this.config.retryBackoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Update health on failure
    this.health.status = 'degraded';
    this.health.errors.push(toTypedSourceError(lastError!, {
      id: 'hyperliquid',
      type: 'hyperliquid',
    }));
    this.health.lastChecked = new Date();

    throw lastError!;
  }

  async fetchMeta(): Promise<HyperliquidMetaResponse> {
    // Use cached meta if still valid
    const now = Date.now();
    if (this.metaCache && now - this.metaCacheTime < this.META_CACHE_TTL_MS) {
      return this.metaCache;
    }

    const data = await this.fetchWithRetry<HyperliquidMetaResponse>(
      { type: 'meta' },
      'lastMetaFetch'
    );

    this.metaCache = data;
    this.metaCacheTime = now;
    return data;
  }

  async fetchAssetCtxs(): Promise<HyperliquidAssetContext[]> {
    const result = await this.fetchWithRetry<[HyperliquidMetaResponse, HyperliquidAssetContext[]]>(
      { type: 'metaAndAssetCtxs' },
      'lastAssetCtxFetch'
    );
    return result[1];
  }

  async fetchClearinghouseState(address: string): Promise<HyperliquidClearinghouseState> {
    return this.fetchWithRetry<HyperliquidClearinghouseState>(
      { type: 'clearinghouseState', user: address },
      'lastClearinghouseFetch'
    );
  }

  async fetchUserFills(address: string): Promise<HyperliquidUserFill[]> {
    return this.fetchWithRetry<HyperliquidUserFill[]>(
      { type: 'userFills', user: address },
      'lastUserFillsFetch'
    );
  }

  /** OHLC candles: interval '1m'|'5m'|'15m'|'1h'|'4h'|'1d', times in ms. */
  async fetchCandles(
    coin: string,
    interval: string,
    startTimeMs: number,
    endTimeMs: number
  ): Promise<{ t: number; o: string; h: string; l: string; c: string; v: string }[]> {
    return this.fetchWithRetry<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>(
      { type: 'candleSnapshot', req: { coin, interval, startTime: startTimeMs, endTime: endTimeMs } },
      'lastAssetCtxFetch'
    );
  }

  normalizeMeta(meta: HyperliquidMetaResponse): HyperliquidAsset[] {
    return meta.universe.map((asset) => ({
      uid: `hyperliquid:${asset.name.toLowerCase()}` as AssetUID,
      symbol: asset.name,
      name: asset.name,
      type: 'crypto' as const,
      decimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage,
      onlyIsolated: asset.onlyIsolated,
    }));
  }

  normalizeAssetCtxs(
    ctxs: HyperliquidAssetContext[],
    meta: HyperliquidMetaResponse
  ): HyperliquidMarketObservation[] {
    const timestamp = new Date();
    const observations: HyperliquidMarketObservation[] = [];

    for (let i = 0; i < ctxs.length && i < meta.universe.length; i++) {
      const ctx = ctxs[i];
      const asset = meta.universe[i];

      observations.push({
        assetUid: `hyperliquid:${asset.name.toLowerCase()}` as AssetUID,
        symbol: asset.name,
        markPrice: Number(ctx.markPx),
        midPrice: Number(ctx.midPx),
        prevDayPrice: Number(ctx.prevDayPx),
        dayVolume: Number(ctx.dayNtlVlm),
        fundingRate: Number(ctx.funding),
        openInterest: Number(ctx.openInterest),
        oraclePrice: Number(ctx.oraclePx),
        premium: Number(ctx.premium),
        impactBid: Number(ctx.impactPxs?.[0] ?? NaN),
        impactAsk: Number(ctx.impactPxs?.[1] ?? NaN),
        timestamp,
        source: 'hyperliquid',
      });
    }

    return observations;
  }

  normalizeClearinghouseState(
    state: HyperliquidClearinghouseState,
    meta: HyperliquidMetaResponse
  ): HyperliquidPositionSnapshot[] {
    const timestamp = new Date();
    const snapshots: HyperliquidPositionSnapshot[] = [];
    const assetMap = new Map(meta.universe.map((a) => [a.name, a]));

    for (const assetPos of state.assetPositions) {
      const pos = assetPos.position;
      const asset = assetMap.get(pos.coin);

      if (!asset) continue;

      const szi = Number(pos.szi);
      if (szi === 0) continue;

      snapshots.push({
        assetUid: `hyperliquid:${pos.coin.toLowerCase()}` as AssetUID,
        symbol: pos.coin,
        userAddress: 'unknown', // Address not in clearinghouse response
        side: szi > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(szi),
        entryPrice: Number(pos.entryPx),
        leverage: pos.leverage?.value ?? 0,
        positionValue: Number(pos.positionValue),
        unrealizedPnl: Number(pos.unrealizedPnl),
        returnOnEquity: Number(pos.returnOnEquity),
        timestamp,
        source: 'hyperliquid',
      });
    }

    return snapshots;
  }

  normalizeUserFills(
    fills: HyperliquidUserFill[],
    meta: HyperliquidMetaResponse
  ): HyperliquidUserFillNormalized[] {
    const assetMap = new Map(meta.universe.map((a) => [a.name, a]));

    return fills
      .filter((fill) => assetMap.has(fill.coin))
      .map((fill) => {
        const szi = Number(fill.szi);
        const side = fill.side === 'B' ? 'BUY' : 'SELL';
        let direction: HyperliquidUserFillNormalized['direction'];

        if (fill.dir === 'Open Long') direction = 'OPEN_LONG';
        else if (fill.dir === 'Open Short') direction = 'OPEN_SHORT';
        else if (fill.dir === 'Close Long') direction = 'CLOSE_LONG';
        else if (fill.dir === 'Close Short') direction = 'CLOSE_SHORT';
        else direction = szi > 0 ? 'OPEN_LONG' : 'OPEN_SHORT';

        return {
          assetUid: `hyperliquid:${fill.coin.toLowerCase()}` as AssetUID,
          symbol: fill.coin,
          userAddress: 'unknown',
          price: Number(fill.px),
          size: Math.abs(szi),
          side,
          direction,
          timestamp: new Date(fill.time),
          closedPnl: Number(fill.closedPnl),
          hash: fill.hash,
          fee: Number(fill.fee),
          tradeId: fill.tid,
          source: 'hyperliquid',
        };
      });
  }

  async healthCheck(): Promise<HyperliquidSourceHealth> {
    this.health.lastChecked = new Date();

    try {
      // Quick health check with meta endpoint
      await this.fetchWithRetry(
        { type: 'meta' },
        'lastMetaFetch'
      );
      this.health.status = 'healthy';
    } catch (error) {
      if (isRetryableError(error)) {
        this.health.status = 'degraded';
      } else {
        this.health.status = 'unhealthy';
      }
      this.health.errors.push(toTypedSourceError(error, {
        id: 'hyperliquid',
        type: 'hyperliquid',
      }));
    }

    return { ...this.health };
  }

  // Deterministic idempotency helpers
  static generateAssetId(symbol: string): AssetUID {
    return `hyperliquid:${symbol.toLowerCase()}` as AssetUID;
  }

  static generateObservationId(symbol: string, timestamp: Date): string {
    return `hyperliquid:obs:${symbol.toLowerCase()}:${timestamp.toISOString()}`;
  }

  static generatePositionId(symbol: string, address: string, timestamp: Date): string {
    return `hyperliquid:pos:${address.toLowerCase()}:${symbol.toLowerCase()}:${timestamp.toISOString()}`;
  }

  static generateFillId(hash: string): string {
    return `hyperliquid:fill:${hash.toLowerCase()}`;
  }

  // Create fact envelopes for normalized data
  static createAssetFactEnvelope(
    asset: HyperliquidAsset,
    sourceRef: FactReference,
    evidenceRefs: string[] = []
  ): FactEnvelope<HyperliquidAsset> {
    const now = new Date().toISOString();
    const payloadHash = HyperliquidPublicAdapter.hashPayload(asset);

    return {
      schema_version: '0.1',
      source: 'hyperliquid',
      source_record_id: HyperliquidPublicAdapter.generateAssetId(asset.symbol),
      asset_uid: asset.uid,
      event_time: now,
      observed_time: now,
      ingested_time: now,
      payload_hash: payloadHash,
      quality: 'ok',
      evidence_ref_ids: evidenceRefs,
      data: asset,
    };
  }

  static createObservationFactEnvelope(
    obs: HyperliquidMarketObservation,
    sourceRef: FactReference,
    evidenceRefs: string[] = []
  ): FactEnvelope<HyperliquidMarketObservation> {
    const now = new Date().toISOString();
    const payloadHash = HyperliquidPublicAdapter.hashPayload(obs);

    return {
      schema_version: '0.1',
      source: 'hyperliquid',
      source_record_id: HyperliquidPublicAdapter.generateObservationId(obs.symbol, obs.timestamp),
      asset_uid: obs.assetUid,
      event_time: obs.timestamp.toISOString(),
      observed_time: now,
      ingested_time: now,
      payload_hash: payloadHash,
      quality: 'ok',
      evidence_ref_ids: evidenceRefs,
      data: obs,
    };
  }

  static createPositionFactEnvelope(
    pos: HyperliquidPositionSnapshot,
    sourceRef: FactReference,
    evidenceRefs: string[] = []
  ): FactEnvelope<HyperliquidPositionSnapshot> {
    const now = new Date().toISOString();
    const payloadHash = HyperliquidPublicAdapter.hashPayload(pos);

    return {
      schema_version: '0.1',
      source: 'hyperliquid',
      source_record_id: HyperliquidPublicAdapter.generatePositionId(pos.symbol, pos.userAddress, pos.timestamp),
      asset_uid: pos.assetUid,
      event_time: pos.timestamp.toISOString(),
      observed_time: now,
      ingested_time: now,
      payload_hash: payloadHash,
      quality: 'ok',
      evidence_ref_ids: evidenceRefs,
      data: pos,
    };
  }

  static createFillFactEnvelope(
    fill: HyperliquidUserFillNormalized,
    sourceRef: FactReference,
    evidenceRefs: string[] = []
  ): FactEnvelope<HyperliquidUserFillNormalized> {
    const now = new Date().toISOString();
    const payloadHash = HyperliquidPublicAdapter.hashPayload(fill);

    return {
      schema_version: '0.1',
      source: 'hyperliquid',
      source_record_id: HyperliquidPublicAdapter.generateFillId(fill.hash),
      asset_uid: fill.assetUid,
      event_time: fill.timestamp.toISOString(),
      observed_time: now,
      ingested_time: now,
      payload_hash: payloadHash,
      quality: 'ok',
      evidence_ref_ids: evidenceRefs,
      data: fill,
    };
  }

  // Deterministic hash for idempotency
  private static hashPayload(data: unknown): string {
    const str = JSON.stringify(data, Object.keys(data as object).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  getConfig(): HyperliquidConfig {
    return { ...this.config };
  }
}

export function createHyperliquidAdapter(config?: Partial<HyperliquidConfig>): HyperliquidPublicAdapter {
  return new HyperliquidPublicAdapter(config);
}