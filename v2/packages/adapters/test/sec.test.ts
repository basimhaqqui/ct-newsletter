import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally BEFORE imports
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Mock the rate limiter class BEFORE importing the adapter
vi.mock('../src/sec/types.js', async () => {
  const actual = await vi.importActual('../src/sec/types.js') as Record<string, unknown>;
  return {
    ...actual,
    TokenBucketRateLimiter: vi.fn().mockImplementation(() => ({
      take: vi.fn().mockResolvedValue(undefined),
      getTokens: vi.fn().mockReturnValue(10),
    })),
  };
});

// Now import the adapter (which will use the mocked rate limiter)
import { createSecAdapter, SecAdapter } from '../src/sec/adapter.js';
import type {
  SECConfig,
  Form4Filing,
  InsiderTradeNormalized,
  SecSourceHealth,
} from '../src/sec/types.js';
import companyTickersFixture from './fixtures/sec/company-tickers.json';
// Helper to create mock response
function createMockResponse(data: unknown, ok = true, status = 200) {
  let contentType: string;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<feed') || trimmed.startsWith('<ownershipDocument')) {
      contentType = 'application/xml';
    } else if (trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE html')) {
      contentType = 'text/html';
    } else {
      contentType = 'application/json';
    }
  } else {
    contentType = 'application/json';
  }
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  };
}

// RSS feed fixture (raw XML string matching SEC EDGAR Atom format)
const rssFeedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:sec="http://www.sec.gov/edgar">
  <title>SEC EDGAR Form 4 Filings</title>
  <updated>2024-01-15T14:30:00Z</updated>
  <id>https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&count=100&output=atom</id>
  <link rel="self" href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&count=100&output=atom"/>
  <entry>
    <title>Form 4 - 2024-01-15 - Apple Inc.</title>
    <link href="https://www.sec.gov/Archives/edgar/data/320193/000119312524000123/0001193125-24-000123-index.htm" rel="alternate" type="text/html"/>
    <id>urn:uuid:12345678-1234-1234-1234-123456789012</id>
    <updated>2024-01-15T14:30:00Z</updated>
    <content type="html"><p>Form 4 filed by Timothy D. Cook on 2024-01-15 for Apple Inc. (AAPL)</p></content>
    <sec:cik>0000320193</sec:cik>
    <sec:form-type>4</sec:form-type>
    <sec:filing-date>2024-01-15</sec:filing-date>
    <sec:period-of-report>2024-01-12</sec:period-of-report>
  </entry>
  <entry>
    <title>Form 4 - 2024-01-15 - Microsoft Corporation</title>
    <link href="https://www.sec.gov/Archives/edgar/data/789019/000119312524000124/0001193125-24-000124-index.htm" rel="alternate" type="text/html"/>
    <id>urn:uuid:12345678-1234-1234-1234-123456789013</id>
    <updated>2024-01-15T14:25:00Z</updated>
    <content type="html"><p>Form 4 filed by Satya Nadella on 2024-01-15 for Microsoft Corporation (MSFT)</p></content>
    <sec:cik>0000789019</sec:cik>
    <sec:form-type>4</sec:form-type>
    <sec:filing-date>2024-01-15</sec:filing-date>
    <sec:period-of-report>2024-01-12</sec:period-of-report>
  </entry>
  <entry>
    <title>Form 4 - 2024-01-14 - NVIDIA Corporation</title>
    <link href="https://www.sec.gov/Archives/edgar/data/1045810/000119312524000125/0001193125-24-000125-index.htm" rel="alternate" type="text/html"/>
    <id>urn:uuid:12345678-1234-1234-1234-123456789014</id>
    <updated>2024-01-14T18:00:00Z</updated>
    <content type="html"><p>Form 4 filed by Jensen Huang on 2024-01-14 for NVIDIA Corporation (NVDA)</p></content>
    <sec:cik>0001045810</sec:cik>
    <sec:form-type>4</sec:form-type>
    <sec:filing-date>2024-01-14</sec:filing-date>
    <sec:period-of-report>2024-01-11</sec:period-of-report>
  </entry>
</feed>`;

// XML fixture for Form 4 (matching SEC's X0306 schema with <value> sub-tags)
const form4Xml = `<?xml version="1.0" encoding="UTF-8"?>
<ownershipDocument>
  <schemaVersion>X0306</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2024-01-15</periodOfReport>
  <notSubjectToSection16>0</notSubjectToSection16>
  <issuer>
    <issuerCik><value>0000320193</value></issuerCik>
    <issuerName><value>Apple Inc.</value></issuerName>
    <issuerTradingSymbol><value>AAPL</value></issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik><value>0001417755</value></rptOwnerCik>
      <rptOwnerName><value>Cook Timothy D</value></rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerAddress>
      <rptOwnerStreet1><value>ONE APPLE PARK WAY</value></rptOwnerStreet1>
      <rptOwnerCity><value>CUPERTINO</value></rptOwnerCity>
      <rptOwnerState><value>CA</value></rptOwnerState>
      <rptOwnerZipCode><value>95014</value></rptOwnerZipCode>
      <rptOwnerStateDescription><value>California</value></rptOwnerStateDescription>
    </reportingOwnerAddress>
    <reportingOwnerRelationship>
      <isDirector><value>1</value></isDirector>
      <isOfficer><value>1</value></isOfficer>
      <isTenPercentOwner><value>0</value></isTenPercentOwner>
      <officerTitle><value>Chief Executive Officer</value></officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-01-12</value></transactionDate>
      <transactionCode><value>M</value></transactionCode>
      <transactionTimeliness><value/></transactionTimeliness>
      <transactionShares><value>100000</value></transactionShares>
      <transactionPricePerShare><value>0.0000</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>3373327</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-01-12</value></transactionDate>
      <transactionCode><value>F</value></transactionCode>
      <transactionTimeliness><value/></transactionTimeliness>
      <transactionShares><value>48321</value></transactionShares>
      <transactionPricePerShare><value>185.5000</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>3325006</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-01-10</value></transactionDate>
      <transactionCode><value>S</value></transactionCode>
      <transactionTimeliness><value/></transactionTimeliness>
      <transactionShares><value>50000</value></transactionShares>
      <transactionPricePerShare><value>187.2500</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>3275006</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Stock Option (Right to Buy)</value></securityTitle>
      <conversionOrExercisePrice><value>150.0000</value></conversionOrExercisePrice>
      <transactionDate><value>2024-01-12</value></transactionDate>
      <transactionCode><value>M</value></transactionCode>
      <transactionTimeliness><value/></transactionTimeliness>
      <numberOfDerivativeSecurities><value>100000</value></numberOfDerivativeSecurities>
      <exerciseDate><value>2022-01-15</value></exerciseDate>
      <expirationDate><value>2032-01-15</value></expirationDate>
      <underlyingSecurity>
        <underlyingSecurityTitle><value>Common Stock</value></underlyingSecurityTitle>
        <underlyingSecurityShares><value>100000</value></underlyingSecurityShares>
      </underlyingSecurity>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>500000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </derivativeTransaction>
  </derivativeTable>
  <signature>
    <signatureName><value>Timothy D. Cook</value></signatureName>
    <signatureDate><value>2024-01-15</value></signatureDate>
  </signature>
  <accessionNumber><value>0001193125-24-000123</value></accessionNumber>
</ownershipDocument>`;

// Minimal XML for testing missing fields
const minimalForm4Xml = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0306</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2024-01-15</periodOfReport>
  <issuer>
    <issuerCik><value>0000320193</value></issuerCik>
    <issuerName><value>Apple Inc.</value></issuerName>
    <issuerTradingSymbol><value>AAPL</value></issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik><value>0001417755</value></rptOwnerCik>
      <rptOwnerName><value>Cook Timothy D</value></rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector><value>1</value></isDirector>
      <isOfficer><value>1</value></isOfficer>
      <isTenPercentOwner><value>0</value></isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable/>
  <derivativeTable/>
  <signature>
    <signatureName><value>Timothy D. Cook</value></signatureName>
    <signatureDate><value>2024-01-15</value></signatureDate>
  </signature>
</ownershipDocument>`;

describe('SecAdapter', () => {
  let adapter: ReturnType<typeof createSecAdapter>;

  beforeEach(() => {
    mockFetch.mockReset();
    adapter = createSecAdapter({
      baseUrl: 'https://www.sec.gov',
      userAgent: 'MarketIntelligence/1.0 (basim@example.com)',
      rateLimitRps: 10,
      timeoutMs: 10000,
      maxRetries: 3,
      retryBackoffMs: 1000,
      rssFeedUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&count=100&output=atom',
      companyTickersUrl: 'https://www.sec.gov/files/company_tickers.json',
    });
  });

  describe('Rate Limiter', () => {
    it('should enforce rate limit of 10 req/sec', async () => {
      const fastAdapter = createSecAdapter({ rateLimitRps: 10, maxRetries: 0, retryBackoffMs: 0, timeoutMs: 5000 });
      mockFetch.mockResolvedValue(createMockResponse({}));

      const start = Date.now();
      const promises = Array(5).fill(null).map(() => fastAdapter.fetchRssFeed());
      await Promise.all(promises);
      const elapsed = Date.now() - start;

      // Should complete quickly with mocked rate limiter
      expect(elapsed).toBeLessThan(2000);
    });

    it('should consume tokens and wait when exhausted', async () => {
      const slowAdapter = createSecAdapter({ rateLimitRps: 2, maxRetries: 0, retryBackoffMs: 0, timeoutMs: 5000 });
      mockFetch.mockResolvedValue(createMockResponse({}));

      const start = Date.now();
      await Promise.all([slowAdapter.fetchRssFeed(), slowAdapter.fetchRssFeed(), slowAdapter.fetchRssFeed()]);
      const elapsed = Date.now() - start;

      // With mocked rate limiter, should be instant
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('fetchRssFeed', () => {
    it('should fetch and parse RSS feed', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(rssFeedXml));

      const result = await adapter.fetchRssFeed();
      expect(result).toBeDefined();
      expect(result.feed).toBeDefined();
      expect(result.feed.entry).toHaveLength(3);
      expect(result.feed.entry[0]).toMatchObject({
        title: 'Form 4 - 2024-01-15 - Apple Inc.',
        'sec:cik': '0000320193',
        'sec:form-type': '4',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should cache RSS feed', async () => {
      mockFetch.mockResolvedValue(createMockResponse(rssFeedXml));

      await adapter.fetchRssFeed();
      await adapter.fetchRssFeed();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle network errors with retry', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockResolvedValueOnce(createMockResponse(rssFeedXml));

      const result = await adapter.fetchRssFeed();
      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw on non-retryable errors', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 404));

      await expect(adapter.fetchRssFeed()).rejects.toThrow('Not found');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchCompanyTickers', () => {
    it('should fetch and parse company tickers', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(companyTickersFixture));

      const result = await adapter.fetchCompanyTickers();
      expect(result).toBeDefined();
      expect(result['0'].ticker).toBe('AAPL');
      expect(result['0'].title).toBe('Apple Inc.');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should cache company tickers', async () => {
      mockFetch.mockResolvedValue(createMockResponse(companyTickersFixture));

      await adapter.fetchCompanyTickers();
      await adapter.fetchCompanyTickers();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTickerForCik', () => {
    it('should resolve CIK to ticker', async () => {
      mockFetch.mockResolvedValue(createMockResponse(companyTickersFixture));

      const ticker = await adapter.getTickerForCik('0000320193');
      expect(ticker).toBe('AAPL');
    });

    it('should return fallback for unknown CIK', async () => {
      mockFetch.mockResolvedValue(createMockResponse(companyTickersFixture));

      const ticker = await adapter.getTickerForCik('999999999');
      expect(ticker).toBe('UNKNOWN');
    });
  });

  describe('fetchAndParseForm4', () => {
    it('should parse Form 4 XML into structured filing', async () => {
      // First call: index page with link to XML
      // Second call: the actual XML
      mockFetch
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/Archives/edgar/data/320193/000119312524000123/primary-doc.xml">Form 4</a></html>`))
        .mockResolvedValueOnce(createMockResponse(form4Xml));

      const filing = await adapter.fetchAndParseForm4('https://example.com/index.htm');
      expect(filing).not.toBeNull();
      expect(filing!.accessionNumber).toBe('0001193125-24-000123');
      expect(filing!.issuer.issuerCik).toBe('0000320193');
      expect(filing!.issuer.issuerTradingSymbol).toBe('AAPL');
      expect(filing!.reportingOwner.rptOwnerCik).toBe('0001417755');
      expect(filing!.reportingOwner.rptOwnerName).toBe('Cook Timothy D');
      expect(filing!.nonDerivativeTable).toHaveLength(3);
      expect(filing!.derivativeTable).toHaveLength(1);
    });

    it('should handle missing optional fields gracefully', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/Archives/edgar/data/320193/000119312524000123/primary-doc.xml">Form 4</a></html>`))
        .mockResolvedValueOnce(createMockResponse(minimalForm4Xml));

      const filing = await adapter.fetchAndParseForm4('https://example.com/index.htm');
      expect(filing).not.toBeNull();
      expect(filing!.nonDerivativeTable).toHaveLength(0);
      expect(filing!.derivativeTable).toHaveLength(0);
    });
  });

  describe('normalizeForm4', () => {
    it('should normalize Form 4 into insider trades', async () => {
      mockFetch
        // First call: index page with link to XML
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/Archives/edgar/data/320193/000119312524000123/primary-doc.xml">Form 4</a></html>`))
        // Second call: the actual XML
        .mockResolvedValueOnce(createMockResponse(form4Xml))
        // Third call: tickers for normalization
        .mockResolvedValueOnce(createMockResponse(companyTickersFixture));

      const filing = await adapter.fetchAndParseForm4('https://example.com/index.htm');
      expect(filing).not.toBeNull();
      const trades = adapter.normalizeForm4(filing!);

      expect(trades).toHaveLength(4); // 3 non-derivative + 1 derivative

      // Check first trade (M - exercise, acquired at $0)
      expect(trades[0]).toMatchObject({
        symbol: 'AAPL',
        issuerCik: '0000320193',
        ownerCik: '0001417755',
        ownerName: 'Cook Timothy D',
        transactionCode: 'M',
        transactionType: 'M',
        shares: 100000,
        pricePerShare: 0,
        value: 0,
        isDerivative: false,
        directOrIndirect: 'D',
        source: 'sec',
      });
      expect(trades[0].uid).toMatch(/^sec:form4:000119312524000123:\d+$/);

      // Check second trade (F - tax withholding)
      expect(trades[1]).toMatchObject({
        transactionCode: 'F',
        transactionType: 'F',
        shares: 48321,
        pricePerShare: 185.50,
        value: 48321 * 185.50,
      });

      // Check third trade (S - sale)
      expect(trades[2]).toMatchObject({
        transactionCode: 'S',
        transactionType: 'S',
        shares: 50000,
        pricePerShare: 187.25,
        value: 50000 * 187.25,
      });

      // Check derivative trade
      expect(trades[3]).toMatchObject({
        isDerivative: true,
        transactionCode: 'M',
        transactionType: 'M',
        securityTitle: 'Stock Option (Right to Buy)',
        shares: 100000,
        pricePerShare: 150.00,
        conversionPrice: 150.00,
        underlyingSecurityTitle: 'Common Stock',
        underlyingShares: 100000,
      });
      expect(trades[3].exerciseDate).toBeInstanceOf(Date);
      expect(trades[3].expirationDate).toBeInstanceOf(Date);
    });

    it('should map all transaction codes correctly', async () => {
      mockFetch.mockResolvedValue(createMockResponse(companyTickersFixture));

      const codes = ['P', 'S', 'A', 'D', 'M', 'F', 'G', 'J', 'K', 'U', 'V'];
      for (const code of codes) {
        const xml = form4Xml.replace('<value>M</value>', `<value>${code}</value>`);
        mockFetch
          .mockResolvedValueOnce(createMockResponse(`<html><a href="/primary-doc.xml">Form 4</a></html>`))
          .mockResolvedValueOnce(createMockResponse(xml));
        const filing = await adapter.fetchAndParseForm4('https://example.com/index.htm');
        expect(filing).not.toBeNull();
        const trades = adapter.normalizeForm4(filing!);
        expect(trades[0].transactionType).toBe(code);
      }
    });

    it('should handle unknown transaction codes as "other"', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/primary-doc.xml">Form 4</a></html>`))
        .mockResolvedValueOnce(createMockResponse(form4Xml.replace('<value>M</value>', '<value>X</value>')))
        .mockResolvedValueOnce(createMockResponse(companyTickersFixture));

      const filing = await adapter.fetchAndParseForm4('https://example.com/index.htm');
      expect(filing).not.toBeNull();
      const trades = adapter.normalizeForm4(filing!);
      expect(trades[0].transactionType).toBe('other');
    });
  });

  describe('healthCheck', () => {
    it('should report healthy when fetch succeeds', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, true, 200));

      const health = await adapter.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.lastChecked).toBeInstanceOf(Date);
    });

    it('should report degraded when fetch fails with retryable error', async () => {
      const timeoutAdapter = createSecAdapter({ maxRetries: 0, retryBackoffMs: 0 });
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const health = await timeoutAdapter.healthCheck();
      expect(health.status).toBe('degraded');
    });

    it('should report unhealthy when fetch fails with non-retryable error', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 404));

      const health = await adapter.healthCheck();
      expect(health.status).toBe('unhealthy');
    });
  });

  describe('idempotency', () => {
    it('should generate deterministic IDs for insider trades', () => {
      const id = SecAdapter.generateInsiderTradeId('0001193125-24-000123', 0);
      expect(id).toBe('sec:form4:000119312524000123:0');
    });

    it('should generate deterministic IDs for different sequences', () => {
      const id1 = SecAdapter.generateInsiderTradeId('0001193125-24-000123', 0);
      const id2 = SecAdapter.generateInsiderTradeId('0001193125-24-000123', 1);
      expect(id1).not.toBe(id2);
      expect(id2).toBe('sec:form4:000119312524000123:1');
    });
  });

  describe('error handling', () => {
    it('should handle rate limits', async () => {
      const limitedAdapter = createSecAdapter({ maxRetries: 0, retryBackoffMs: 0 });
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 429));

      await expect(limitedAdapter.fetchRssFeed()).rejects.toThrow('Rate limited');
    });

    it('should handle server errors', async () => {
      const limitedAdapter = createSecAdapter({ maxRetries: 0, retryBackoffMs: 0 });
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 500));

      await expect(limitedAdapter.fetchRssFeed()).rejects.toThrow('Server error');
    });

    it('should handle timeouts', async () => {
      const timeoutAdapter = createSecAdapter({ maxRetries: 0, retryBackoffMs: 0, timeoutMs: 10 });
      mockFetch.mockImplementationOnce(() => new Promise((_, reject) =>
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 20)
      ));

      await expect(timeoutAdapter.fetchRssFeed()).rejects.toThrow('Request timeout');
    });

    it('should handle unauthorized errors', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 401));

      await expect(adapter.fetchRssFeed()).rejects.toThrow('Unauthorized');
    });
  });

  describe('fact envelopes', () => {
    it('should create insider trade fact envelope', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/primary-doc.xml">Form 4</a></html>`))
        .mockResolvedValueOnce(createMockResponse(form4Xml))
        .mockResolvedValueOnce(createMockResponse(companyTickersFixture));

      const filing = await adapter.fetchAndParseForm4('https://example.com/index.htm');
      expect(filing).not.toBeNull();
      const trades = adapter.normalizeForm4(filing!);
      const trade = trades[0];

      const envelope = SecAdapter.createInsiderTradeFactEnvelope(
        trade,
        { id: 'sec', type: 'sec' },
        ['evidence-1']
      );

      expect(envelope).toMatchObject({
        schema_version: '0.1',
        source: 'sec',
        source_record_id: trade.uid,
        asset_uid: trade.uid,
        quality: 'ok',
        evidence_ref_ids: ['evidence-1'],
      });
      expect(envelope.data).toEqual(trade);
      expect(envelope.payload_hash).toBeDefined();
      expect(envelope.event_time).toBe(trade.transactionDate.toISOString());
    });

    it('should produce deterministic payload hashes', () => {
      const trade: InsiderTradeNormalized = {
        uid: 'sec:form4:test:0',
        symbol: 'AAPL',
        issuerCik: '0000320193',
        issuerName: 'Apple Inc.',
        ownerCik: '0001417755',
        ownerName: 'Cook Timothy D',
        isDirector: true,
        isOfficer: true,
        isTenPercentOwner: false,
        transactionDate: new Date('2024-01-12'),
        transactionCode: 'M',
        transactionType: 'M',
        securityTitle: 'Common Stock',
        shares: 100000,
        pricePerShare: 0,
        value: 0,
        sharesOwnedAfter: 3373327,
        directOrIndirect: 'D',
        isDerivative: false,
        source: 'sec',
      };

      const envelope1 = SecAdapter.createInsiderTradeFactEnvelope(trade, { id: 'sec', type: 'sec' });
      const envelope2 = SecAdapter.createInsiderTradeFactEnvelope(trade, { id: 'sec', type: 'sec' });
      expect(envelope1.payload_hash).toBe(envelope2.payload_hash);
    });
  });

  describe('fetchAndParseLatestFilings', () => {
    it('should fetch RSS, then fetch and parse each Form 4', async () => {
      // Mock chain: RSS -> HTML1 -> XML1 -> HTML2 -> XML2 -> companyTickers (for normalize)
      mockFetch
        .mockResolvedValueOnce(createMockResponse(rssFeedXml))  // RSS feed
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/primary-doc.xml">Form 4</a></html>`))  // Index page #1
        .mockResolvedValueOnce(createMockResponse(form4Xml))  // Form 4 XML #1
        .mockResolvedValueOnce(createMockResponse(`<html><a href="/primary-doc.xml">Form 4</a></html>`))  // Index page #2
        .mockResolvedValueOnce(createMockResponse(form4Xml))  // Form 4 XML #2
        .mockResolvedValueOnce(createMockResponse(companyTickersFixture));  // companyTickers for normalizeForm4

      const filings = await adapter.fetchAndParseLatestFilings(2);

      expect(filings).toHaveLength(2);
      expect(filings[0].accessionNumber).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });
});
