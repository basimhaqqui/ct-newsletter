import {
  type SECConfig,
  createDefaultSecConfig,
  type Form4Filing,
  type InsiderTradeNormalized,
  type SecSourceHealth,
  type SecError,
  type CompanyTickersResponse,
  type EdgarRssEntry,
  type CompanyTickerEntry,
  TokenBucketRateLimiter,
  createSecError,
  isRetryableSecError,
  toTypedSourceError,
  type SecAdapterInterface,
  type FactReference,
  type AssetUID,
  type TypedSourceError,
} from './types.js';
// // // import type { FactEnvelope } from '../contracts/src/types.js';
// Local FactEnvelope type (duplicated from contracts to avoid workspace issues)
type FactEnvelope<T> = {
  schema_version: string;
  source: string;
  source_record_id: string;
  asset_uid?: string;
  event_time: string;
  observed_time: string;
  ingested_time: string;
  payload_hash: string;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
  data: T;
};

interface ParsedRssFeed {
  feed: {
    entry: EdgarRssEntry[];
  };
}

export class SecAdapter implements SecAdapterInterface {
  private config: SECConfig;
  private health: SecSourceHealth;
  private rateLimiter: TokenBucketRateLimiter;
  private companyTickersCache: CompanyTickersResponse | null = null;
  private companyTickersCacheTime: number = 0;
  private rssFeedCache: ParsedRssFeed | null = null;
  private rssFeedCacheTime: number = 0;
  private readonly TICKERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly RSS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config?: Partial<SECConfig>) {
    this.config = createDefaultSecConfig(config);
    this.rateLimiter = new TokenBucketRateLimiter(this.config.rateLimitRps);
    this.health = {
      status: 'healthy',
      lastChecked: new Date(),
      errors: [],
      lastRssFetch: null,
      lastCompanyTickersFetch: null,
      rateLimiterTokens: this.config.rateLimitRps,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': this.config.userAgent,
      'Accept': 'application/atom+xml, application/xml, text/xml, */*',
      'Accept-Encoding': 'gzip, deflate',
    };
  }

  private async fetchWithRetry<T>(
    url: string,
    options: RequestInit = {},
    healthField: keyof SecSourceHealth
  ): Promise<T> {
    await this.rateLimiter.take();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...this.getHeaders(),
            ...(options.headers as Record<string, string>),
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 429) {
            throw createSecError(
              `Rate limited: ${response.status}`,
              'RATE_LIMITED',
              { statusCode: response.status, retryable: true }
            );
          }
          if (response.status >= 500) {
            throw createSecError(
              `Server error: ${response.status}`,
              'SERVER_ERROR',
              { statusCode: response.status, retryable: true }
            );
          }
          if (response.status === 404) {
            throw createSecError(
              `Not found: ${response.status}`,
              'NOT_FOUND',
              { statusCode: response.status, retryable: false }
            );
          }
          if (response.status === 401 || response.status === 403) {
            throw createSecError(
              `Unauthorized: ${response.status}`,
              'UNAUTHORIZED',
              { statusCode: response.status, retryable: false }
            );
          }
          throw createSecError(
            `HTTP error: ${response.status}`,
            'INVALID_RESPONSE',
            { statusCode: response.status, retryable: false }
          );
        }

        const contentType = response.headers.get('content-type') || '';
        let data: unknown;
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        // Update health on success
        this.health.status = 'healthy';
        this.health.errors = [];
        (this.health as unknown as Record<string, unknown>)[healthField] = new Date();
        this.health.rateLimiterTokens = this.rateLimiter.getTokens();

        return data as T;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DOMException && error.name === 'AbortError') {
          lastError = createSecError(
            `Request timeout after ${this.config.timeoutMs}ms`,
            'TIMEOUT',
            { retryable: true }
          );
        } else if (error instanceof TypeError && error.message.includes('fetch')) {
          lastError = createSecError(
            `Network error: ${error.message}`,
            'NETWORK_ERROR',
            { retryable: true }
          );
        }

        // Don't retry on non-retryable errors
        if (lastError && 'retryable' in lastError && !(lastError as SecError).retryable) {
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
      id: 'sec',
      type: 'sec',
    }));
    this.health.lastChecked = new Date();
    this.health.rateLimiterTokens = this.rateLimiter.getTokens();

    throw lastError!;
  }

  async fetchCompanyTickers(): Promise<CompanyTickersResponse> {
    const now = Date.now();
    if (this.companyTickersCache && now - this.companyTickersCacheTime < this.TICKERS_CACHE_TTL_MS) {
      return this.companyTickersCache;
    }

    const data = await this.fetchWithRetry<CompanyTickersResponse>(
      this.config.companyTickersUrl,
      { method: 'GET' },
      'lastCompanyTickersFetch'
    );

    this.companyTickersCache = data;
    this.companyTickersCacheTime = now;
    return data;
  }

  async getTickerForCik(cik: string): Promise<string> {
    if (!this.companyTickersCache) {
      await this.fetchCompanyTickers();
    }
    const paddedCik = cik.padStart(10, '0');
    const entry = Object.values(this.companyTickersCache || {}).find(
      e => e.cik_str === paddedCik || e.cik_str === cik
    );
    return entry?.ticker || 'UNKNOWN';
  }

  getCikForTicker(ticker: string): string | undefined {
    if (!this.companyTickersCache) return undefined;
    const entry = Object.values(this.companyTickersCache).find(
      e => e.ticker.toUpperCase() === ticker.toUpperCase()
    );
    return entry?.cik_str;
  }

  async fetchRssFeed(): Promise<ParsedRssFeed> {
    const now = Date.now();
    if (this.rssFeedCache && now - this.rssFeedCacheTime < this.RSS_CACHE_TTL_MS) {
      return this.rssFeedCache;
    }

    const xmlText = await this.fetchWithRetry<string>(
      this.config.rssFeedUrl,
      { method: 'GET' },
      'lastRssFetch'
    );

    const parsed = this.parseRssFeed(xmlText);
    this.rssFeedCache = parsed;
    this.rssFeedCacheTime = now;
    return parsed;
  }

  private parseRssFeed(xmlText: string): ParsedRssFeed {
    const entries: EdgarRssEntry[] = [];

    try {
      // Simple approach: extract all entry elements first
      const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
      let match;

      while ((match = entryRegex.exec(xmlText)) !== null) {
        const entryXml = match[1];

        // Simple helper to extract tag content - handles namespaced tags
        const getTag = (tag: string) => {
          // For namespaced tags like sec:cik, we need to escape the colon
          const escapedTag = tag.replace(/:/g, '\\:');
          // Match opening tag (with optional attributes), capture content, match closing tag
          // Use a more permissive pattern that works for both namespaced and non-namespaced
          const openTagRegex = new RegExp(`<${tag}[^>]*>`, 'i');
          const closeTagRegex = new RegExp(`</${tag}>`, 'i');
          
          const openMatch = entryXml.match(openTagRegex);
          const closeMatch = entryXml.match(closeTagRegex);
          
          if (openMatch && closeMatch) {
            const openIndex = openMatch.index! + openMatch[0].length;
            const closeIndex = closeMatch.index!;
            return entryXml.substring(openIndex, closeIndex).trim();
          }
          return '';
        };

        const getAttr = (tag: string, attr: string) => {
          const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["']`);
          const m = entryXml.match(regex);
          return m ? m[1] : '';
        };

        entries.push({
          title: getTag('title'),
          link: getAttr('link', 'href') || getTag('link'),
          updated: getTag('updated'),
          id: getTag('id'),
          content: getTag('content'),
          'sec:cik': getTag('sec:cik'),
          'sec:form-type': getTag('sec:form-type'),
          'sec:filing-date': getTag('sec:filing-date'),
          'sec:period-of-report': getTag('sec:period-of-report'),
        });
      }
    } catch (error) {
      throw createSecError(
        `Failed to parse RSS feed: ${error}`,
        'PARSE_ERROR',
        { retryable: false }
      );
    }

    return { feed: { entry: entries } };
  }

  async fetchAndParseLatestFilings(limit: number = 100): Promise<Form4Filing[]> {
    const rssFeed = await this.fetchRssFeed();
    const filings: Form4Filing[] = [];

    for (const entry of rssFeed.feed.entry.slice(0, limit)) {
      try {
        const filing = await this.fetchAndParseForm4(entry.link);
        if (filing) filings.push(filing);
      } catch (error) {
        console.warn(`Failed to parse filing ${entry.link}:`, error);
      }
    }

    return filings;
  }

  async fetchAndParseForm4(filingUrl: string): Promise<Form4Filing | null> {
    // Fetch the filing index page to find the primary XML document
    const htmlResponse = await this.fetchWithRetry<string>(
      filingUrl,
      { method: 'GET' },
      'lastRssFetch'
    );

    // fetchWithRetry returns the parsed response, we need the raw text
    const htmlText = typeof htmlResponse === 'string' ? htmlResponse : JSON.stringify(htmlResponse);

    // Find the primary document link (Form 4 XML) - more permissive regex
    // Match any anchor tag with .xml href, optionally containing "Form 4"
    let primaryDocMatch = htmlText.match(/<a[^>]*href="([^"]*\.xml)"[^>]*>.*?Form 4.*?<\/a>/i);
    if (!primaryDocMatch) {
      // Try alternative pattern - any .xml link in anchor tag
      primaryDocMatch = htmlText.match(/<a[^>]*href="([^"]*\.xml)"[^>]*>/i);
      if (!primaryDocMatch) return null;
    }

    const primaryDocUrl = primaryDocMatch[1];
    if (!primaryDocUrl) return null;

    const fullDocUrl = primaryDocUrl.startsWith('http')
      ? primaryDocUrl
      : `${this.config.baseUrl}${primaryDocUrl}`;

    const xmlText = await this.fetchWithRetry<string>(
      fullDocUrl,
      { method: 'GET' },
      'lastRssFetch'
    );

    return this.parseForm4Xml(xmlText);
  }

  private getTagFromXml(tag: string, xml: string): string {
    // Robust approach: find opening tag, then find closing tag, extract between them
    const openTag = `<${tag}`;
    const closeTag = `</${tag}>`;
    const xmlLower = xml.toLowerCase();
    const openIndex = xmlLower.indexOf(openTag.toLowerCase());
    if (openIndex === -1) return '';
    // Find the end of the opening tag
    const openEndIndex = xml.indexOf('>', openIndex);
    if (openEndIndex === -1) return '';
    // Find the closing tag
    const closeIndex = xmlLower.indexOf(closeTag.toLowerCase(), openEndIndex);
    if (closeIndex === -1) return '';
    // Extract content between tags using original string indices
    const content = xml.substring(openEndIndex + 1, closeIndex).trim();
    // Handle nested <value> tags
    const contentLower = content.toLowerCase();
    const valueStart = contentLower.indexOf('<value>');
    if (valueStart !== -1) {
      const valueEnd = contentLower.indexOf('</value>', valueStart);
      if (valueEnd !== -1) {
        return content.substring(valueStart + 7, valueEnd).trim();
      }
    }
    return content;
  }

  private parseForm4Xml(xmlText: string): Form4Filing {
    const getTag = (tag: string, xml: string = xmlText) => {
      // Robust approach: find opening tag, then find closing tag, extract between them
      const openTag = `<${tag}`;
      const closeTag = `</${tag}>`;
      const xmlLower = xml.toLowerCase();
      const openIndex = xmlLower.indexOf(openTag.toLowerCase());
      if (openIndex === -1) return '';
      // Find the end of the opening tag
      const openEndIndex = xml.indexOf('>', openIndex);
      if (openEndIndex === -1) return '';
      // Find the closing tag
      const closeIndex = xmlLower.indexOf(closeTag.toLowerCase(), openEndIndex);
      if (closeIndex === -1) return '';
      // Extract content between tags using original string indices
      const content = xml.substring(openEndIndex + 1, closeIndex).trim();
      // Handle nested <value> tags
      const contentLower = content.toLowerCase();
      const valueStart = contentLower.indexOf('<value>');
      if (valueStart !== -1) {
        const valueEnd = contentLower.indexOf('</value>', valueStart);
        if (valueEnd !== -1) {
          return content.substring(valueStart + 7, valueEnd).trim();
        }
      }
      return content;
    };

    const getAllTags = (tag: string, xml: string = xmlText) => {
      const regex = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'g');
      const matches = [];
      let match;
      while ((match = regex.exec(xml)) !== null) {
        matches.push(match[1].trim());
      }
      return matches;
    };

    const accessionNumber = getTag('accessionNumber') || this.extractAccessionFromUrl(xmlText);
    const filingDate = getTag('filingDate');
    const periodOfReport = getTag('periodOfReport');

    // Issuer info
    const issuerCik = getTag('issuerCik');
    const issuerName = getTag('issuerName');
    const issuerTradingSymbol = getTag('issuerTradingSymbol');

    // Reporting owner
    const rptOwnerCik = getTag('rptOwnerCik');
    const rptOwnerName = getTag('rptOwnerName');
    const isDirector = getTag('isDirector') === '1';
    const isOfficer = getTag('isOfficer') === '1';
    const isTenPercentOwner = getTag('isTenPercentOwner') === '1';
    const officerTitle = getTag('officerTitle');

    // Non-derivative transactions (Table I)
    const nonDerivativeTable: Form4Filing['nonDerivativeTable'] = [];
    const nonDerivSections = xmlText.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/);
    if (nonDerivSections) {
      const transactions = nonDerivSections[1].match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g) || [];
      for (const txXml of transactions) {
        nonDerivativeTable.push({
          securityTitle: this.getTagFromXml('securityTitle', txXml),
          transactionDate: this.getTagFromXml('transactionDate', txXml),
          transactionCode: this.getTagFromXml('transactionCode', txXml),
          transactionTimeliness: this.getTagFromXml('transactionTimeliness', txXml) || undefined,
          shares: parseFloat(this.getTagFromXml('transactionShares', txXml)) || 0,
          pricePerShare: parseFloat(this.getTagFromXml('transactionPricePerShare', txXml)) || 0,
          acquisitionOrDisposition: (this.getTagFromXml('transactionAcquiredDisposedCode', txXml) as 'A' | 'D') || 'A',
          sharesOwnedFollowingTransaction: parseFloat(this.getTagFromXml('sharesOwnedFollowingTransaction', txXml)) || 0,
          directOrIndirectOwnership: (this.getTagFromXml('directOrIndirectOwnership', txXml) as 'D' | 'I') || 'D',
          natureOfIndirectOwnership: this.getTagFromXml('natureOfIndirectOwnership', txXml) || undefined,
        });
      }
    }

    // Derivative transactions (Table II)
    const derivativeTable: Form4Filing['derivativeTable'] = [];
    const derivSections = xmlText.match(/<derivativeTable>([\s\S]*?)<\/derivativeTable>/);
    if (derivSections) {
      const transactions = derivSections[1].match(/<derivativeTransaction>([\s\S]*?)<\/derivativeTransaction>/g) || [];
      for (const txXml of transactions) {
        derivativeTable.push({
          securityTitle: this.getTagFromXml('securityTitle', txXml),
          conversionOrExercisePrice: parseFloat(this.getTagFromXml('conversionOrExercisePrice', txXml)) || 0,
          transactionDate: this.getTagFromXml('transactionDate', txXml),
          transactionCode: this.getTagFromXml('transactionCode', txXml),
          transactionTimeliness: this.getTagFromXml('transactionTimeliness', txXml) || undefined,
          numberOfDerivativeSecurities: parseFloat(this.getTagFromXml('numberOfDerivativeSecurities', txXml)) || 0,
          exerciseDate: this.getTagFromXml('exerciseDate', txXml),
          expirationDate: this.getTagFromXml('expirationDate', txXml),
          underlyingSecurityTitle: this.getTagFromXml('underlyingSecurityTitle', txXml),
          underlyingSecurityShares: parseFloat(this.getTagFromXml('underlyingSecurityShares', txXml)) || 0,
          acquisitionOrDisposition: (this.getTagFromXml('transactionAcquiredDisposedCode', txXml) as 'A' | 'D') || 'A',
          sharesOwnedFollowingTransaction: parseFloat(this.getTagFromXml('sharesOwnedFollowingTransaction', txXml)) || 0,
          directOrIndirectOwnership: (this.getTagFromXml('directOrIndirectOwnership', txXml) as 'D' | 'I') || 'D',
          natureOfIndirectOwnership: this.getTagFromXml('natureOfIndirectOwnership', txXml) || undefined,
        });
      }
    }

    return {
      accessionNumber,
      filingDate,
      periodOfReport,
      issuer: {
        issuerCik,
        issuerName,
        issuerTradingSymbol,
      },
      reportingOwner: {
        rptOwnerCik,
        rptOwnerName,
        isDirector,
        isOfficer,
        isTenPercentOwner,
        officerTitle: officerTitle || undefined,
      },
      nonDerivativeTable,
      derivativeTable,
      signature: {
        signatureName: getTag('signatureName'),
        signatureDate: getTag('signatureDate'),
      },
    };
  }

  private extractAccessionFromUrl(xml: string): string {
    const match = xml.match(/(\d{10}-\d{2}-\d{6})/);
    return match ? match[1] : '';
  }

  normalizeForm4(filing: Form4Filing): InsiderTradeNormalized[] {
    const trades: InsiderTradeNormalized[] = [];
    const symbol = filing.issuer.issuerTradingSymbol;
    const issuerCik = filing.issuer.issuerCik;
    const ownerCik = filing.reportingOwner.rptOwnerCik;
    const ownerName = filing.reportingOwner.rptOwnerName;
    const isDirector = filing.reportingOwner.isDirector;
    const isOfficer = filing.reportingOwner.isOfficer;
    const isTenPercentOwner = filing.reportingOwner.isTenPercentOwner;
    const officerTitle = filing.reportingOwner.officerTitle;
    const accessionNoDashes = filing.accessionNumber.replace(/-/g, '');

    // Non-derivative trades
    filing.nonDerivativeTable.forEach((tx) => {
      const shares = tx.shares;
      const price = tx.pricePerShare;
      const value = shares * price;
      const transactionType = this.mapTransactionCode(tx.transactionCode);

      trades.push({
        uid: `sec:form4:${accessionNoDashes}:${trades.length}`,
        symbol,
        issuerCik,
        issuerName: filing.issuer.issuerName,
        ownerCik,
        ownerName,
        isDirector,
        isOfficer,
        isTenPercentOwner,
        officerTitle,
        transactionDate: new Date(tx.transactionDate),
        transactionCode: tx.transactionCode,
        transactionType,
        securityTitle: tx.securityTitle,
        shares,
        pricePerShare: price,
        value,
        sharesOwnedAfter: tx.sharesOwnedFollowingTransaction,
        directOrIndirect: tx.directOrIndirectOwnership,
        natureOfIndirect: tx.natureOfIndirectOwnership,
        isDerivative: false,
        source: 'sec',
      });
    });

    // Derivative trades
    filing.derivativeTable.forEach((tx) => {
      const shares = tx.numberOfDerivativeSecurities;
      const price = tx.conversionOrExercisePrice;
      const value = shares * price;
      const transactionType = this.mapTransactionCode(tx.transactionCode);

      trades.push({
        uid: `sec:form4:${accessionNoDashes}:${trades.length}`,
        symbol,
        issuerCik,
        issuerName: filing.issuer.issuerName,
        ownerCik,
        ownerName,
        isDirector,
        isOfficer,
        isTenPercentOwner,
        officerTitle,
        transactionDate: new Date(tx.transactionDate),
        transactionCode: tx.transactionCode,
        transactionType,
        securityTitle: tx.securityTitle,
        shares,
        pricePerShare: price,
        value,
        sharesOwnedAfter: tx.sharesOwnedFollowingTransaction,
        directOrIndirect: tx.directOrIndirectOwnership,
        natureOfIndirect: tx.natureOfIndirectOwnership,
        isDerivative: true,
        conversionPrice: tx.conversionOrExercisePrice,
        exerciseDate: tx.exerciseDate ? new Date(tx.exerciseDate) : undefined,
        expirationDate: tx.expirationDate ? new Date(tx.expirationDate) : undefined,
        underlyingSecurityTitle: tx.underlyingSecurityTitle,
        underlyingShares: tx.underlyingSecurityShares,
        source: 'sec',
      });
    });

    return trades;
  }

  private mapTransactionCode(code: string): InsiderTradeNormalized['transactionType'] {
    const validCodes: InsiderTradeNormalized['transactionType'][] = ['P', 'S', 'A', 'D', 'M', 'F', 'G', 'J', 'K', 'U', 'V'];
    return validCodes.includes(code as InsiderTradeNormalized['transactionType']) ? code as InsiderTradeNormalized['transactionType'] : 'other';
  }

  async healthCheck(): Promise<SecSourceHealth> {
    this.health.lastChecked = new Date();

    try {
      await this.fetchWithRetry(
        `${this.config.baseUrl}/cgi-bin/browse-edgar?action=getcurrent&type=4&count=1&output=atom`,
        { method: 'GET' },
        'lastRssFetch'
      );
      this.health.status = 'healthy';
    } catch (error) {
      if (isRetryableSecError(error)) {
        this.health.status = 'degraded';
      } else {
        this.health.status = 'unhealthy';
      }
      this.health.errors.push(toTypedSourceError(error, {
        id: 'sec',
        type: 'sec',
      }));
    }

    return { ...this.health };
  }


  async fetchLatestFilings(limit?: number): Promise<Form4Filing[]> {
    const rssFeed = await this.fetchRssFeed();
    const entries = rssFeed.feed.entry || [];
    
    const filings: Form4Filing[] = [];
    for (const entry of entries.slice(0, limit)) {
      const filing = await this.fetchAndParseForm4(entry.link);
      if (filing) filings.push(filing);
    }
    
    return filings;
  }

  async fetchFilingsForCik(cik: string, limit?: number): Promise<Form4Filing[]> {
    const filings = await this.fetchLatestFilings(limit);
    return filings.filter(f => f.issuer.issuerCik === cik.padStart(10, '0') || f.reportingOwner.rptOwnerCik === cik.padStart(10, '0'));
  }


    getConfig(): SECConfig {
    return { ...this.config };
  }

  // Deterministic idempotency helpers
  static generateInsiderTradeId(accessionNumber: string, sequence: number): AssetUID {
    const cleanAccession = accessionNumber.replace(/-/g, '');
    return `sec:form4:${cleanAccession}:${sequence}` as AssetUID;
  }

  // Create fact envelope for insider trades
  static createInsiderTradeFactEnvelope(
    trade: InsiderTradeNormalized,
    sourceRef: FactReference,
    evidenceRefs: string[] = []
  ): FactEnvelope<InsiderTradeNormalized> {
    const now = new Date().toISOString();
    const payloadHash = SecAdapter.hashPayload(trade);

    return {
      schema_version: '0.1',
      source: 'sec',
      source_record_id: trade.uid,
      asset_uid: trade.uid,
      event_time: trade.transactionDate.toISOString(),
      observed_time: now,
      ingested_time: now,
      payload_hash: payloadHash,
      quality: 'ok',
      evidence_ref_ids: evidenceRefs,
      data: trade,
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
}

export function createSecAdapter(config?: Partial<SECConfig>): SecAdapter {
  return new SecAdapter(config);
}

// Re-export types for convenience
export type {
  SECConfig,
  Form4Filing,
  InsiderTradeNormalized,
  SecSourceHealth,
  SecError,
  CompanyTickersResponse,
  EdgarRssEntry,
  CompanyTickerEntry,
  FactReference,
  AssetUID,
  TypedSourceError,
  SecAdapterInterface,
};
export {
  createDefaultSecConfig,
  createSecError,
  isRetryableSecError,
  toTypedSourceError,
} from './types.js';
