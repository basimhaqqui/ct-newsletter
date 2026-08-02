export interface PredictionDiscoveryConfig {
  baseUrl: string;
  minCloseLeadMinutes: number;
  maxSettlementHours: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  limit: number;
}

export interface PredictionOutcomeQuote {
  label: string;
  impliedProbability: number;
}

/** A point-in-time, read-only observation. It has no order, wallet, or key fields. */
export interface PredictionMarketObservation {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  eventId: string;
  question: string;
  endTime: Date;
  observedTime: Date;
  liquidityUsd: number;
  volume24hUsd: number;
  resolutionSource: string;
  outcomes: PredictionOutcomeQuote[];
  /** Analysis must union observations sharing any of these conservative clusters. */
  independenceClusterIds: string[];
  sourceUrl: string;
}

export interface PredictionMarketDiscoveryPort {
  discoverFastSettling(now: Date): Promise<PredictionMarketObservation[]>;
}

export function createPredictionDiscoveryConfig(
  overrides: Partial<PredictionDiscoveryConfig> = {},
): PredictionDiscoveryConfig {
  return {
    baseUrl: 'https://gamma-api.polymarket.com',
    minCloseLeadMinutes: 15,
    maxSettlementHours: 72,
    minLiquidityUsd: 10_000,
    minVolume24hUsd: 2_000,
    limit: 100,
    ...overrides,
  };
}
