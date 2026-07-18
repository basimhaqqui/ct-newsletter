// Hyperliquid-specific types

export type AssetUID = string;

export interface FactReference {
  id: string;
  type: string;
}

export interface FactEnvelope<T> {
  schema_version: string;
  source: string;
  source_record_id: string;
  asset_uid?: AssetUID;
  event_time: string;
  observed_time: string;
  ingested_time: string;
  payload_hash: string;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
  data: T;
}

// Configuration for the Hyperliquid adapter
export interface HyperliquidConfig {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  retryableStatusCodes: number[];
  degradedThresholdMs: number;
  staleThresholdMs: number;
}

// Raw response types from Hyperliquid API
export interface HyperliquidMetaResponse {
  universe: HyperliquidAssetInfo[];
}

export interface HyperliquidAssetInfo {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface HyperliquidAssetContext {
  markPx: string;
  midPx: string;
  prevDayPx: string;
  dayNtlVlm: string;
  funding: string;
  openInterest: string;
  oraclePx: string;
  premium: string;
  impactPxs: [string, string] | null;
}

export interface HyperliquidClearinghouseState {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: HyperliquidAssetPosition[];
}

export interface HyperliquidAssetPosition {
  type: 'oneWay' | 'cross';
  position: {
    coin: string;
    szi: string;
    entryPx: string;
    leverage: { type: 'cross' | 'isolated'; value: number };
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
  };
}

export interface HyperliquidUserFill {
  coin: string;
  px: string;
  szi: string;
  side: 'B' | 'A';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  fee: string;
  tid: number;
}

// Normalized domain types
export interface HyperliquidAsset {
  uid: AssetUID;
  symbol: string;
  name: string;
  type: 'crypto' | 'stock' | 'commodity' | 'fx';
  decimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface HyperliquidMarketObservation {
  assetUid: AssetUID;
  symbol: string;
  markPrice: number;
  midPrice: number;
  prevDayPrice: number;
  dayVolume: number;
  fundingRate: number;
  openInterest: number;
  oraclePrice: number;
  premium: number;
  impactBid: number;
  impactAsk: number;
  timestamp: Date;
  source: string;
}

export interface HyperliquidPositionSnapshot {
  assetUid: AssetUID;
  symbol: string;
  userAddress: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  leverage: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  timestamp: Date;
  source: string;
}

export interface HyperliquidUserFillNormalized {
  assetUid: AssetUID;
  symbol: string;
  userAddress: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestamp: Date;
  direction: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT' | 'UNKNOWN';
  closedPnl: number;
  hash: string;
  fee: number;
  tradeId: number;
  source: string;
}

// Adapter state for degraded/stale tracking
export interface HyperliquidAdapterState {
  lastSuccessfulFetch: Map<string, number>;
  consecutiveErrors: Map<string, number>;
  lastError: Map<string, Error>;
  degradedEndpoints: Set<string>;
}

// Health check types
export interface HyperliquidSourceHealth {
 status: 'healthy' | 'degraded' | 'unhealthy';
 lastChecked: Date;
 errors: Array<{
   type: string;
   message: string;
   timestamp: Date;
   metadata?: Record<string, unknown>;
 }>;
 lastMetaFetch: Date | null;
 lastAssetCtxFetch: Date | null;
 lastClearinghouseFetch: Date | null;
 lastUserFillsFetch: Date | null;
  [key: string]: unknown;
}

// Factory for creating default config
export function createDefaultConfig(overrides: Partial<HyperliquidConfig> = {}): HyperliquidConfig {
  return {
    baseUrl: 'https://api.hyperliquid.xyz',
    timeoutMs: 10000,
    maxRetries: 3,
    retryBackoffMs: 1000,
    retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    degradedThresholdMs: 30000,
    staleThresholdMs: 300000,
    ...overrides,
  };
}

// Error types
export type HyperliquidErrorType =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

export interface HyperliquidError extends Error {
  type: HyperliquidErrorType;
  statusCode?: number;
  retryable: boolean;
  metadata?: Record<string, unknown>;
}

export function createHyperliquidError(
  message: string,
  type: HyperliquidErrorType,
  options?: { statusCode?: number; retryable?: boolean; metadata?: Record<string, unknown> }
): HyperliquidError {
  const error = new Error(message) as HyperliquidError;
  error.type = type;
  error.statusCode = options?.statusCode;
  error.retryable = options?.retryable ?? (type === 'NETWORK_ERROR' || type === 'TIMEOUT' || type === 'RATE_LIMITED' || type === 'SERVER_ERROR');
  error.metadata = options?.metadata;
  return error;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && 'retryable' in error) {
    return (error as HyperliquidError).retryable;
  }
  return false;
}

export interface TypedSourceError {
  type: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export function toTypedSourceError(error: unknown, source: FactReference): TypedSourceError {
  if (error instanceof Error && 'type' in error) {
    const hlError = error as HyperliquidError;
    return {
      type: hlError.type,
      message: hlError.message,
      timestamp: new Date(),
      metadata: hlError.metadata,
    };
  }
  return {
    type: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    timestamp: new Date(),
  };
}

// Adapter interface
export interface HyperliquidAdapter {
  fetchMeta(): Promise<HyperliquidMetaResponse>;
  fetchAssetCtxs(): Promise<HyperliquidAssetContext[]>;
  fetchClearinghouseState(address: string): Promise<HyperliquidClearinghouseState>;
  fetchUserFills(address: string): Promise<HyperliquidUserFill[]>;

  normalizeMeta(meta: HyperliquidMetaResponse): HyperliquidAsset[];
  normalizeAssetCtxs(ctxs: HyperliquidAssetContext[], meta: HyperliquidMetaResponse): HyperliquidMarketObservation[];
  normalizeClearinghouseState(state: HyperliquidClearinghouseState, meta: HyperliquidMetaResponse): HyperliquidPositionSnapshot[];
  normalizeUserFills(fills: HyperliquidUserFill[], meta: HyperliquidMetaResponse): HyperliquidUserFillNormalized[];

  healthCheck(): Promise<HyperliquidSourceHealth>;
}