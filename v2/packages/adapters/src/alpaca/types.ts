// Alpaca adapter types. Raw API shapes + normalized domain types + error
// taxonomy, mirroring the Hyperliquid adapter's structure.

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AlpacaConfig {
  /** trading API host — assets/account metadata */
  tradingBaseUrl: string;
  /** market-data API host — bars */
  dataBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  feed: 'iex' | 'sip';
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  rateLimitRps: number;
  degradedThresholdMs: number;
  staleThresholdMs: number;
}

export function createDefaultAlpacaConfig(overrides: Partial<AlpacaConfig> = {}): AlpacaConfig {
  return {
    tradingBaseUrl: 'https://api.alpaca.markets',
    dataBaseUrl: 'https://data.alpaca.markets',
    apiKey: '',
    apiSecret: '',
    feed: 'iex',
    timeoutMs: 10_000,
    maxRetries: 3,
    retryBackoffMs: 1_000,
    rateLimitRps: 3, // free tier: 200 req/min → stay conservative
    degradedThresholdMs: 30_000,
    staleThresholdMs: 300_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Raw API shapes
// ---------------------------------------------------------------------------

export interface AlpacaAsset {
  id: string;
  class: 'us_equity' | 'crypto' | 'etf' | string;
  exchange: string;
  symbol: string;
  name: string;
  status: 'active' | 'inactive';
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  easyToBorrow?: boolean;
  fractionable: boolean;
  minOrderSize?: string;
  maxOrderSize?: string;
}

/** GET /v2/assets returns a bare array; fixtures wrap it as { assets } */
export interface AlpacaAssetsResponse {
  assets: AlpacaAsset[];
}

export interface AlpacaBar {
  t: string; // RFC-3339 bar open time
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number; // trade count
  vw: number; // volume-weighted average price
}

export interface AlpacaBarsResponse {
  bars: Record<string, AlpacaBar[]>;
  next_page_token?: string | null;
}

export type AlpacaTimeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

// ---------------------------------------------------------------------------
// Normalized domain types
// ---------------------------------------------------------------------------

export interface AlpacaAssetNormalized {
  uid: AssetUID; // stable canonical uid: stock:us:<SYMBOL>
  symbol: string;
  name: string;
  type: 'stock' | 'crypto';
  exchange: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  fractionable: boolean;
}

export interface AlpacaBarNormalized {
  assetUid: AssetUID;
  symbol: string;
  timestamp: Date; // bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  vwap: number;
  timeframe: AlpacaTimeframe;
  source: 'alpaca';
}

// ---------------------------------------------------------------------------
// Errors & health
// ---------------------------------------------------------------------------

export type AlpacaErrorType =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INVALID_RESPONSE';

export interface AlpacaError extends Error {
  type: AlpacaErrorType;
  statusCode?: number;
  retryable: boolean;
}

export function createAlpacaError(
  message: string,
  type: AlpacaErrorType,
  options: { statusCode?: number; retryable: boolean },
): AlpacaError {
  const err = new Error(message) as AlpacaError;
  err.name = 'AlpacaError';
  err.type = type;
  err.statusCode = options.statusCode;
  err.retryable = options.retryable;
  return err;
}

export function isRetryableAlpacaError(error: unknown): boolean {
  return (
    error instanceof Error && 'retryable' in error && (error as AlpacaError).retryable === true
  );
}

export interface TypedSourceError {
  type: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export function toTypedSourceError(error: unknown, source: FactReference): TypedSourceError {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    type: (err as AlpacaError).type ?? 'UNKNOWN',
    message: err.message,
    timestamp: new Date(),
    metadata: { sourceId: source.id, sourceType: source.type },
  };
}

export interface AlpacaSourceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastChecked: Date;
  errors: TypedSourceError[];
  lastAssetsFetch: Date | null;
  lastBarsFetch: Date | null;
}
