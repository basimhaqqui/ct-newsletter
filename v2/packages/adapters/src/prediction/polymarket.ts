// Public Gamma discovery only. This adapter intentionally has no CLOB order,
// signing, wallet, bridge, or authenticated API surface.

import {
  createPredictionDiscoveryConfig,
  type PredictionDiscoveryConfig,
  type PredictionMarketDiscoveryPort,
  type PredictionMarketObservation,
} from './types.js';

interface GammaMarket {
  id?: string | number;
  conditionId?: string;
  question?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  liquidity?: string | number;
  volume24hr?: string | number;
  resolutionSource?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  events?: Array<{ id?: string | number }>;
}

function numberOrNull(value: string | number | undefined): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringArray(value: string | string[] | undefined): string[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function resolutionHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unparseable-source';
  }
}

/**
 * Maps a public Gamma markets response to the frozen v1 discovery universe.
 * A whole event is one conservative dependence cluster; a second cluster
 * links events sharing a resolution-source host and UTC resolution day.
 */
export class PolymarketPublicDiscoveryAdapter implements PredictionMarketDiscoveryPort {
  private readonly config: PredictionDiscoveryConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: Partial<PredictionDiscoveryConfig> = {},
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = createPredictionDiscoveryConfig(config);
    this.fetchImpl = fetchImpl;
  }

  async discoverFastSettling(now: Date): Promise<PredictionMarketObservation[]> {
    const url = new URL('/markets', this.config.baseUrl);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    // Gamma currently validates the API field name as `volume24hr` (verified
    // against the public endpoint on 2026-08-02).
    url.searchParams.set('order', 'volume24hr');
    url.searchParams.set('ascending', 'false');
    url.searchParams.set('limit', String(this.config.limit));

    const response = await this.fetchImpl(url, { method: 'GET' });
    if (!response.ok) throw new Error(`Polymarket Gamma discovery failed: HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('Polymarket Gamma discovery returned a non-array payload');

    const minEnd = now.getTime() + this.config.minCloseLeadMinutes * 60_000;
    const maxEnd = now.getTime() + this.config.maxSettlementHours * 3_600_000;
    const observations: PredictionMarketObservation[] = [];
    for (const market of payload as GammaMarket[]) {
      const eventId = market.events?.[0]?.id;
      if (!eventId) continue;
      {
        const eventIdString = String(eventId);
        const endTime = new Date(market.endDate ?? '');
        const liquidityUsd = numberOrNull(market.liquidity);
        const volume24hUsd = numberOrNull(market.volume24hr);
        const outcomes = stringArray(market.outcomes);
        const prices = stringArray(market.outcomePrices)?.map(Number);
        const resolutionSource = market.resolutionSource?.trim();
        if (
          !market.id || !market.conditionId || !market.question || !resolutionSource ||
          market.active === false || market.closed === true ||
          !Number.isFinite(endTime.getTime()) || endTime.getTime() < minEnd || endTime.getTime() > maxEnd ||
          liquidityUsd === null || liquidityUsd < this.config.minLiquidityUsd ||
          volume24hUsd === null || volume24hUsd < this.config.minVolume24hUsd ||
          !outcomes || outcomes.length !== 2 || !prices || prices.length !== 2 ||
          prices.some((price) => !Number.isFinite(price) || price < 0 || price > 1) ||
          Math.abs(prices[0] + prices[1] - 1) > 0.02
        ) continue;

        const resolutionDay = endTime.toISOString().slice(0, 10);
        observations.push({
          venue: 'polymarket',
          marketId: String(market.id),
          conditionId: market.conditionId,
          eventId: eventIdString,
          question: market.question,
          endTime,
          observedTime: now,
          liquidityUsd,
          volume24hUsd,
          resolutionSource,
          outcomes: outcomes.map((label, index) => ({ label, impliedProbability: prices[index] })),
          independenceClusterIds: [
            `polymarket:event:${eventIdString}`,
            `polymarket:resolution:${resolutionHost(resolutionSource)}:${resolutionDay}`,
          ],
          sourceUrl: `${this.config.baseUrl}/markets/${encodeURIComponent(String(market.id))}`,
        });
      }
    }
    return observations.sort((a, b) => a.marketId.localeCompare(b.marketId));
  }
}

export function createPolymarketPublicDiscoveryAdapter(
  config: Partial<PredictionDiscoveryConfig> = {},
  fetchImpl?: typeof fetch,
): PolymarketPublicDiscoveryAdapter {
  return new PolymarketPublicDiscoveryAdapter(config, fetchImpl);
}
