import { describe, expect, it, vi } from 'vitest';
import { createPolymarketPublicDiscoveryAdapter } from '../src/prediction/index.js';

const NOW = new Date('2026-08-02T00:00:00Z');

describe('PolymarketPublicDiscoveryAdapter', () => {
  it('uses the public markets endpoint and preserves conservative dependence clusters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
            {
              id: 'market-yes-no', conditionId: 'condition-1', question: 'Will it rain?',
              endDate: '2026-08-02T12:00:00Z', active: true, closed: false,
              liquidity: '12000', volume24hr: '3000', resolutionSource: 'https://weather.gov/rain',
              events: [{ id: 'event-1' }],
              outcomes: '["Yes","No"]', outcomePrices: '["0.61","0.39"]',
            },
            {
              id: 'market-related', conditionId: 'condition-2', question: 'Will it be windy?',
              endDate: '2026-08-02T16:00:00Z', active: true, closed: false,
              liquidity: '14000', volume24hr: '4000', resolutionSource: 'https://weather.gov/wind',
              events: [{ id: 'event-1' }],
              outcomes: '["Yes","No"]', outcomePrices: '["0.40","0.60"]',
            },
            {
              id: 'market-too-far', conditionId: 'condition-3', question: 'Too far out?',
              endDate: '2026-08-08T00:00:00Z', active: true, closed: false,
              liquidity: '50000', volume24hr: '50000', resolutionSource: 'https://weather.gov/far',
              events: [{ id: 'event-1' }],
              outcomes: '["Yes","No"]', outcomePrices: '["0.50","0.50"]',
            },
      ],
    });
    const adapter = createPolymarketPublicDiscoveryAdapter({}, fetchImpl);

    const markets = await adapter.discoverFastSettling(NOW);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/markets' }),
      { method: 'GET' },
    );
    const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(requestUrl.searchParams.get('order')).toBe('volume24hr');
    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject({
      venue: 'polymarket', marketId: 'market-related', observedTime: NOW,
      independenceClusterIds: [
        'polymarket:event:event-1',
        'polymarket:resolution:weather.gov:2026-08-02',
      ],
    });
    expect(markets[0].outcomes).toEqual([
      { label: 'Yes', impliedProbability: 0.4 },
      { label: 'No', impliedProbability: 0.6 },
    ]);
    expect(markets[0].independenceClusterIds).toContain('polymarket:event:event-1');
    expect(markets[0].independenceClusterIds[1]).toBe(markets[1].independenceClusterIds[1]);
  });

  it('rejects invalid responses rather than inferring market eligibility', async () => {
    const adapter = createPolymarketPublicDiscoveryAdapter({}, vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(adapter.discoverFastSettling(NOW)).rejects.toThrow('non-array payload');
  });
});
