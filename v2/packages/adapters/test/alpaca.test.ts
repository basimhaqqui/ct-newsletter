// Fixture-driven Alpaca adapter tests: metadata, bars, normalization,
// deterministic IDs, fact envelopes, retry/backoff, degraded health.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlpacaAdapter, createAlpacaAdapter } from '../src/alpaca/adapter.js';
import type { AlpacaAssetsResponse, AlpacaBarsResponse } from '../src/alpaca/types.js';

const assetsFixture = JSON.parse(
  readFileSync(new URL('./fixtures/alpaca/assets.json', import.meta.url), 'utf8'),
) as AlpacaAssetsResponse;
const barsFixture = JSON.parse(
  readFileSync(new URL('./fixtures/alpaca/bars.json', import.meta.url), 'utf8'),
) as AlpacaBarsResponse;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function adapterWith(fetchImpl: typeof fetch): AlpacaAdapter {
  return createAlpacaAdapter(
    { apiKey: 'test-key', apiSecret: 'test-secret', retryBackoffMs: 1, rateLimitRps: 10_000 },
    fetchImpl,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('asset metadata', () => {
  it('fetches, filters to tradable+active, and normalizes with stable UIDs', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(assetsFixture));
    const adapter = adapterWith(mock as unknown as typeof fetch);

    const raw = await adapter.fetchAssets();
    const assets = adapter.normalizeAssets(raw);

    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      expect(a.uid).toBe(`stock:us:${a.symbol.toUpperCase()}`);
      expect(a.tradable).toBe(true);
    }
    // auth headers sent
    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['APCA-API-KEY-ID']).toBe('test-key');
  });

  it('tolerates the live API bare-array shape', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(assetsFixture.assets));
    const adapter = adapterWith(mock as unknown as typeof fetch);
    const raw = await adapter.fetchAssets();
    expect(adapter.normalizeAssets(raw).length).toBeGreaterThan(0);
  });

  it('caches assets within the TTL (one fetch for two calls)', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(assetsFixture));
    const adapter = adapterWith(mock as unknown as typeof fetch);
    await adapter.fetchAssets();
    await adapter.fetchAssets();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('bar data', () => {
  it('fetches and normalizes every bar for every symbol', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(barsFixture));
    const adapter = adapterWith(mock as unknown as typeof fetch);

    const raw = await adapter.fetchBars(['AAPL', 'MSFT'], '1Day');
    const bars = adapter.normalizeBars(raw, '1Day');

    const aapl = bars.filter((b) => b.symbol === 'AAPL');
    expect(aapl.length).toBe(barsFixture.bars['AAPL'].length);
    expect(aapl[0].assetUid).toBe('stock:us:AAPL');
    expect(aapl[0].open).toBe(185.5);
    expect(aapl[0].timestamp.toISOString()).toBe('2024-01-15T14:30:00.000Z');
    expect(aapl[0].vwap).toBe(185.72);
  });

  it('follows pagination tokens until exhausted', async () => {
    const page1: AlpacaBarsResponse = {
      bars: { AAPL: barsFixture.bars['AAPL'].slice(0, 1) },
      next_page_token: 'tok2',
    };
    const page2: AlpacaBarsResponse = {
      bars: { AAPL: barsFixture.bars['AAPL'].slice(1) },
      next_page_token: null,
    };
    const mock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));
    const adapter = adapterWith(mock as unknown as typeof fetch);

    const merged = await adapter.fetchBars(['AAPL']);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(merged.bars['AAPL'].length).toBe(barsFixture.bars['AAPL'].length);
    expect(String(mock.mock.calls[1][0])).toContain('page_token=tok2');
  });

  it('returns empty for an empty symbol list without fetching', async () => {
    const mock = vi.fn();
    const adapter = adapterWith(mock as unknown as typeof fetch);
    const res = await adapter.fetchBars([]);
    expect(res.bars).toEqual({});
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('deterministic identity & fact envelopes', () => {
  it('generates stable, repeatable IDs', () => {
    expect(AlpacaAdapter.generateAssetUid('aapl')).toBe('stock:us:AAPL');
    const t = new Date('2024-01-15T14:30:00Z');
    const id1 = AlpacaAdapter.generateBarId('AAPL', '1Day', t);
    const id2 = AlpacaAdapter.generateBarId('AAPL', '1Day', t);
    expect(id1).toBe(id2);
    expect(id1).toBe('alpaca:bar:AAPL:1Day:1705329000');
  });

  it('creates envelopes with deterministic payload hashes and provenance', () => {
    const bar = AlpacaAdapter.normalizeBar('AAPL', barsFixture.bars['AAPL'][0], '1Day');
    const observedAt = new Date('2024-01-15T15:00:00Z');
    const env1 = AlpacaAdapter.createBarFactEnvelope(bar, observedAt);
    const env2 = AlpacaAdapter.createBarFactEnvelope(bar, observedAt);

    expect(env1.payload_hash).toBe(env2.payload_hash);
    expect(env1.source).toBe('alpaca');
    expect(env1.asset_uid).toBe('stock:us:AAPL');
    expect(env1.event_time).toBe('2024-01-15T14:30:00.000Z'); // bar time, not now
    expect(env1.evidence_ref_ids.length).toBeGreaterThan(0);

    // hash changes when the payload changes
    const mutated = { ...bar, close: bar.close + 1 };
    const env3 = AlpacaAdapter.createBarFactEnvelope(mutated, observedAt);
    expect(env3.payload_hash).not.toBe(env1.payload_hash);
  });
});

describe('retries, errors, health', () => {
  it('retries retryable errors with backoff and succeeds', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ message: 'rate' }, 429))
      .mockResolvedValueOnce(jsonResponse(assetsFixture));
    const adapter = adapterWith(mock as unknown as typeof fetch);

    const res = await adapter.fetchAssets();
    expect(mock).toHaveBeenCalledTimes(3);
    expect(res.assets.length).toBeGreaterThan(0);
    expect(adapter.getHealth().status).toBe('healthy');
  });

  it('does not retry non-retryable errors (401)', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ message: 'no' }, 401));
    const adapter = adapterWith(mock as unknown as typeof fetch);

    await expect(adapter.fetchAssets()).rejects.toMatchObject({ type: 'UNAUTHORIZED' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(adapter.getHealth().status).toBe('degraded');
    expect(adapter.getHealth().errors.length).toBeGreaterThan(0);
  });

  it('gives up after maxRetries and marks degraded', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ message: 'down' }, 503));
    const adapter = adapterWith(mock as unknown as typeof fetch);

    await expect(adapter.fetchAssets()).rejects.toMatchObject({ type: 'SERVER_ERROR' });
    expect(mock).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(adapter.getHealth().status).toBe('degraded');
  });

  it('classifies network failures as retryable NETWORK_ERROR', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(assetsFixture));
    const adapter = adapterWith(mock as unknown as typeof fetch);
    const res = await adapter.fetchAssets();
    expect(res.assets.length).toBeGreaterThan(0);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('healthCheck reflects unhealthy on hard auth failure', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ message: 'no' }, 403));
    const adapter = adapterWith(mock as unknown as typeof fetch);
    const health = await adapter.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});
