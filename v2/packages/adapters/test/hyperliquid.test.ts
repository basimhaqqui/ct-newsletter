import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHyperliquidAdapter, HyperliquidPublicAdapter } from '../src/hyperliquid/index.js';
import type {
  HyperliquidConfig,
  HyperliquidMetaResponse,
  HyperliquidAssetContext,
  HyperliquidClearinghouseState,
  HyperliquidUserFill,
  HyperliquidError,
} from '../src/hyperliquid/types.js';
import userFillsFixture from './fixtures/hyperliquid/user_fills.json';
import clearinghouseStateFixture from './fixtures/hyperliquid/clearinghouse_state.json';
import assetCtxsFixture from './fixtures/hyperliquid/asset_ctxs.json';
import metaFixture from './fixtures/hyperliquid/meta.json';

describe('HyperliquidPublicAdapter', () => {
  let adapter: ReturnType<typeof createHyperliquidAdapter>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    adapter = createHyperliquidAdapter({
      baseUrl: 'https://api.hyperliquid.xyz',
      maxRetries: 3,
      retryBackoffMs: 100,
      timeoutMs: 5000,
    });
  });

  describe('fetchMeta', () => {
    it('should fetch and cache meta', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => metaFixture,
      });

      const result = await adapter.fetchMeta();
      expect(result).toEqual(metaFixture);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const cachedResult = await adapter.fetchMeta();
      expect(cachedResult).toEqual(metaFixture);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle errors and retry', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => metaFixture,
      });

      const result = await adapter.fetchMeta();
      expect(result).toEqual(metaFixture);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw on non-retryable errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(adapter.fetchMeta()).rejects.toThrow('Not found');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchAssetCtxs', () => {
    it('should fetch asset contexts', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [metaFixture, assetCtxsFixture],
      });

      const result = await adapter.fetchAssetCtxs();
      expect(result).toEqual(assetCtxsFixture);
    });
  });

  describe('fetchClearinghouseState', () => {
    it('should fetch clearinghouse state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => clearinghouseStateFixture,
      });

      const result = await adapter.fetchClearinghouseState('0x123');
      expect(result).toEqual(clearinghouseStateFixture);
    });
  });

  describe('fetchUserFills', () => {
    it('should fetch user fills', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => userFillsFixture,
      });

      const result = await adapter.fetchUserFills('0x123');
      expect(result).toEqual(userFillsFixture);
    });
  });

  describe('normalizeMeta', () => {
    it('should normalize meta data', () => {
      const normalized = adapter.normalizeMeta(metaFixture);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('normalizeAssetCtxs', () => {
    it('should normalize asset contexts', () => {
      const normalized = adapter.normalizeAssetCtxs(assetCtxsFixture as unknown as HyperliquidAssetContext[], metaFixture);
      expect(normalized).toHaveLength(4);
      expect(normalized[0]).toMatchObject({
        assetUid: 'hyperliquid:btc',
        symbol: 'BTC',
        markPrice: 67000,
        fundingRate: 0.0001,
        source: 'hyperliquid',
      });
      expect(normalized.every((value) => value.timestamp instanceof Date)).toBe(true);
    });
  });

  describe('normalizeClearinghouseState', () => {
    it('should normalize clearinghouse state', () => {
      const normalized = adapter.normalizeClearinghouseState(clearinghouseStateFixture as unknown as HyperliquidClearinghouseState, metaFixture);
      expect(normalized).toHaveLength(3);
      expect(normalized[0]).toMatchObject({
        assetUid: 'hyperliquid:btc',
        symbol: 'BTC',
        side: 'LONG',
        size: 2.5,
        userAddress: 'unknown',
      });
      expect(normalized[1]).toMatchObject({ symbol: 'ETH', side: 'SHORT', size: 50 });
      expect(normalized.every((value) => value.timestamp instanceof Date)).toBe(true);
    });
  });

  describe('normalizeUserFills', () => {
    it('should normalize user fills', () => {
      const normalized = adapter.normalizeUserFills(userFillsFixture as unknown as HyperliquidUserFill[], metaFixture);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('healthCheck', () => {
    it('should report healthy when fetch succeeds', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => metaFixture,
      });

      const health = await adapter.healthCheck();
      expect(health.status).toBe('healthy');
    });

    it('should report degraded when fetch fails with retryable error', async () => {
      adapter = createHyperliquidAdapter({ maxRetries: 0, retryBackoffMs: 0 });
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const health = await adapter.healthCheck();
      expect(health.status).toBe('degraded');
    });

    it('should report unhealthy when fetch fails with non-retryable error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const health = await adapter.healthCheck();
      expect(health.status).toBe('unhealthy');
    });
  });

  describe('idempotency', () => {
    it('should generate deterministic IDs for assets', () => {
      const id = HyperliquidPublicAdapter.generateAssetId('BTC');
      expect(id).toBe('hyperliquid:btc');
    });

    it('should generate deterministic IDs for observations', () => {
      const id = HyperliquidPublicAdapter.generateObservationId('BTC', new Date('2023-01-01'));
      expect(id).toMatch(/^hyperliquid:obs:btc:2023-01-01/);
    });

    it('should generate deterministic IDs for positions', () => {
      const id = HyperliquidPublicAdapter.generatePositionId('BTC', '0x123', new Date('2023-01-01'));
      expect(id).toMatch(/^hyperliquid:pos:0x123:btc:2023-01-01/);
    });

    it('should generate deterministic IDs for fills', () => {
      const id = HyperliquidPublicAdapter.generateFillId('0xabc');
      expect(id).toBe('hyperliquid:fill:0xabc');
    });
  });

  describe('error handling', () => {
    it('should handle rate limits', async () => {
      adapter = createHyperliquidAdapter({ maxRetries: 0, retryBackoffMs: 0 });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
      });

      await expect(adapter.fetchMeta()).rejects.toThrow('Rate limited');
    });

    it('should handle server errors', async () => {
      adapter = createHyperliquidAdapter({ maxRetries: 0, retryBackoffMs: 0 });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(adapter.fetchMeta()).rejects.toThrow('Server error');
    });

    it('should handle timeouts', async () => {
      adapter = createHyperliquidAdapter({ maxRetries: 0, retryBackoffMs: 0, timeoutMs: 10 });
      mockFetch.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 20);
        });
      });

      await expect(adapter.fetchMeta()).rejects.toThrow('Request timeout');
    });
  });
});