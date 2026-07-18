// SEC EDGAR types for Form 4 insider trading filings

// Core types (duplicated from contracts to avoid workspace resolution issues)
export type AssetUID = string;

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

export interface FactReference {
  id: string;
  type: string;
}

export interface SourceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastChecked: Date;
  errors: TypedSourceError[];
}

export interface TypedSourceError {
  type: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// Configuration for the SEC adapter
export interface SECConfig {
  baseUrl: string;
  userAgent: string;
  rateLimitRps: number;      // Max requests per second (SEC requires ≤10)
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  rssFeedUrl: string;
  companyTickersUrl: string;
}

// Raw EDGAR RSS feed entry (Atom format)
export interface EdgarRssEntry {
  title: string;              // e.g. "Form 4 - 2024-01-15 - Apple Inc."
  link: string;               // Filing detail page URL
  updated: string;            // ISO timestamp
  id: string;                 // Unique identifier
  content: string;            // HTML content with filing summary
  'sec:cik'?: string;         // CIK if present in feed
  'sec:form-type'?: string;   // Should be "4"
  'sec:filing-date'?: string; // Filing date
  'sec:period-of-report'?: string; // Period of report
}

// Parsed Form 4 data structures
export interface Form4Filing {
  accessionNumber: string;
  filingDate: string;
  periodOfReport: string;
  issuer: IssuerInfo;
  reportingOwner: ReportingOwnerInfo;
  nonDerivativeTable: NonDerivativeTransaction[];
  derivativeTable: DerivativeTransaction[];
  signature: SignatureInfo;
}

export interface IssuerInfo {
  issuerCik: string;
  issuerName: string;
  issuerTradingSymbol: string;
}

export interface ReportingOwnerInfo {
  rptOwnerCik: string;
  rptOwnerName: string;
  rptOwnerAddress?: {
    street1?: string;
    street2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    stateDescription?: string;
  };
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  officerTitle?: string;
}

export interface NonDerivativeTransaction {
  securityTitle: string;
  transactionDate: string;
  transactionCode: string;      // P=Purchase, S=Sale, A=Grant/Award, D=Disposition, M=Exercise, etc.
  transactionTimeliness?: string;
  shares: number;
  pricePerShare: number;
  acquisitionOrDisposition: 'A' | 'D'; // A=Acquired, D=Disposed
  sharesOwnedFollowingTransaction: number;
  directOrIndirectOwnership: 'D' | 'I'; // D=Direct, I=Indirect
  natureOfIndirectOwnership?: string;
}

export interface DerivativeTransaction {
  securityTitle: string;
  conversionOrExercisePrice: number;
  transactionDate: string;
  transactionCode: string;
  transactionTimeliness?: string;
  numberOfDerivativeSecurities: number;
  exerciseDate: string;
  expirationDate: string;
  underlyingSecurityTitle: string;
  underlyingSecurityShares: number;
  acquisitionOrDisposition: 'A' | 'D';
  sharesOwnedFollowingTransaction: number;
  directOrIndirectOwnership: 'D' | 'I';
  natureOfIndirectOwnership?: string;
}

export interface SignatureInfo {
  signatureName: string;
  signatureDate: string;
}

// Normalized domain types
export interface InsiderTradeNormalized {
  uid: AssetUID;                    // e.g., "sec:form4:{accessionNumber}:{sequence}"
  symbol: string;                   // Issuer trading symbol
  issuerCik: string;
  issuerName: string;
  ownerCik: string;
  ownerName: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  officerTitle?: string;
  transactionDate: Date;
  transactionCode: string;
  transactionType: 'P' | 'S' | 'A' | 'D' | 'M' | 'F' | 'G' | 'J' | 'K' | 'U' | 'V' | 'other';
  securityTitle: string;
  shares: number;
  pricePerShare: number;
  value: number;                    // shares * pricePerShare
  sharesOwnedAfter: number;
  directOrIndirect: 'D' | 'I';
  natureOfIndirect?: string;
  isDerivative: boolean;
  // For derivative transactions
  conversionPrice?: number;
  exerciseDate?: Date;
  expirationDate?: Date;
  underlyingSecurityTitle?: string;
  underlyingShares?: number;
  source: 'sec';
}

// SEC Company Tickers mapping
export interface CompanyTickerEntry {
  cik_str: string;
  ticker: string;
  title: string;
}

export interface CompanyTickersResponse {
  [key: string]: CompanyTickerEntry;
}

// Health check types - extending contracts SourceHealth with SEC-specific fields
export interface SecSourceHealth extends SourceHealth {
  lastRssFetch: Date | null;
  lastCompanyTickersFetch: Date | null;
  rateLimiterTokens: number;
}

// Error types
export type SecErrorType =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'PARSE_ERROR'
  | 'UNKNOWN';

export interface SecError extends Error {
  type: SecErrorType;
  statusCode?: number;
  retryable: boolean;
  metadata?: Record<string, unknown>;
}

export function createSecError(
  message: string,
  type: SecErrorType,
  options?: { statusCode?: number; retryable?: boolean; metadata?: Record<string, unknown> }
): SecError {
  const error = new Error(message) as SecError;
  error.type = type;
  error.statusCode = options?.statusCode;
  error.retryable = options?.retryable ?? (type === 'NETWORK_ERROR' || type === 'TIMEOUT' || type === 'RATE_LIMITED' || type === 'SERVER_ERROR');
  error.metadata = options?.metadata;
  return error;
}

export function isRetryableSecError(error: unknown): boolean {
  if (error instanceof Error && 'retryable' in error) {
    return (error as SecError).retryable;
  }
  return false;
}

// Re-export from contracts for convenience
// export type { TypedSourceError } from '../contracts/src/types.js';

export function toTypedSourceError(error: unknown, source: FactReference): TypedSourceError {
  if (error instanceof Error && 'type' in error) {
    const secError = error as SecError;
    return {
      type: secError.type,
      message: secError.message,
      timestamp: new Date(),
      metadata: secError.metadata,
    };
  }
  return {
    type: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    timestamp: new Date(),
  };
}

export interface SecAdapterInterface {
  fetchLatestFilings(limit?: number): Promise<Form4Filing[]>;
  fetchFilingsForCik(cik: string, limit?: number): Promise<Form4Filing[]>;
  fetchCompanyTickers(): Promise<CompanyTickersResponse>;
  normalizeForm4(filing: Form4Filing): InsiderTradeNormalized[];
  healthCheck(): Promise<SecSourceHealth>;
  getConfig(): SECConfig;
}

// Factory for default config
export function createDefaultSecConfig(overrides: Partial<SECConfig> = {}): SECConfig {
  return {
    baseUrl: 'https://www.sec.gov',
    userAgent: 'MarketIntelligence/2.0 (contact@marketintel.example)',
    rateLimitRps: 10,
    timeoutMs: 30000,
    maxRetries: 3,
    retryBackoffMs: 1000,
    rssFeedUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&count=100&output=atom',
    companyTickersUrl: 'https://www.sec.gov/files/company_tickers.json',
    ...overrides,
  };
}

// Token bucket rate limiter
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms

  constructor(rps: number) {
    this.capacity = rps;
    this.tokens = rps;
    this.refillRate = rps / 1000; // tokens per ms
    this.lastRefill = Date.now();
  }

  async take(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      // Wait until we have a token
      const waitMs = (1 - this.tokens) / this.refillRate;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  getTokens(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    return Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
  }
}
