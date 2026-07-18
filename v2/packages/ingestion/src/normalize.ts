// Adapter output → typed DB rows. Deterministic: row ids derive from source
// record identity, never from randomness or ingestion order.

import type { ObservationRow, PositioningEventRow, RawSnapshotRow } from '@market-intel/db';

const HOURS_PER_YEAR = 24 * 365;

export interface HlObservationInput {
  symbol: string;
  markPrice: number;
  midPrice: number;
  fundingRate: number; // per-hour rate from HL
  openInterest: number; // contracts
  dayVolume: number; // USD notional
  observedAt: Date;
}

/** Canonical crypto uid per spec §2.1: crypto:hl:<SYMBOL>. */
export function hlAssetUid(symbol: string): string {
  return `crypto:hl:${symbol.toUpperCase()}`;
}

export function hlObservationRow(input: HlObservationInput): ObservationRow {
  const uid = hlAssetUid(input.symbol);
  const ts = Math.floor(input.observedAt.getTime() / 1000);
  const price = input.midPrice > 0 ? input.midPrice : input.markPrice;
  return {
    id: `hl:obs:${input.symbol.toUpperCase()}:${ts}`,
    asset_uid: uid,
    symbol: input.symbol.toUpperCase(),
    venue: 'hyperliquid',
    price,
    bid: null,
    ask: null,
    mark_price: input.markPrice,
    index_price: null,
    funding_rate: input.fundingRate,
    funding_rate_annualized: input.fundingRate * HOURS_PER_YEAR * 100, // percent/yr
    open_interest: input.openInterest,
    open_interest_usd: input.openInterest * price,
    volume_24h: null,
    volume_24h_usd: input.dayVolume,
    basis: null,
    basis_annualized: null,
    event_time: input.observedAt,
    observed_time: input.observedAt,
    ingested_time: input.observedAt,
    source: 'hyperliquid',
    source_record_id: `hl:assetCtx:${input.symbol.toUpperCase()}:${ts}`,
    quality: 'ok',
    evidence_ref_ids: [`hyperliquid:assetCtx:${input.symbol.toUpperCase()}@${ts}`],
  };
}

export interface HlWhalePositionInput {
  symbol: string;
  walletAddress: string;
  walletLabel: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  leverage: number;
  positionValue: number;
  observedAt: Date;
}

export function hlWhalePositionRow(input: HlWhalePositionInput): PositioningEventRow {
  const ts = Math.floor(input.observedAt.getTime() / 1000);
  return {
    id: `hl:pos:${input.walletAddress.toLowerCase()}:${input.symbol.toUpperCase()}:${ts}`,
    asset_uid: hlAssetUid(input.symbol),
    event_type: 'whale_position',
    direction: input.side === 'LONG' ? 'long' : 'short',
    size: input.size,
    notional_usd: Math.abs(input.positionValue),
    entry_price: input.entryPrice,
    leverage: input.leverage,
    wallet_address: input.walletAddress.toLowerCase(),
    wallet_label: input.walletLabel,
    filer_name: null,
    filer_cik: null,
    filing_accession: null,
    filing_date: null,
    transaction_date: null,
    is_derivative: false,
    expiration_date: null,
    strike_price: null,
    option_type: null,
    raw_data: {},
    source: 'hyperliquid',
    source_record_id: `hl:clearinghouseState:${input.walletAddress.toLowerCase()}:${input.symbol.toUpperCase()}:${ts}`,
    event_time: input.observedAt,
    observed_time: input.observedAt,
    ingested_time: input.observedAt,
    quality: 'ok',
    evidence_ref_ids: [
      `hyperliquid:clearinghouseState:${input.walletAddress.toLowerCase()}:${input.symbol.toUpperCase()}@${ts}`,
    ],
  };
}

export interface AlpacaBarInput {
  symbol: string;
  timestamp: Date; // bar open
  close: number;
  volume: number;
  vwap: number;
  timeframe: string;
  observedAt: Date;
}

export function stockAssetUid(symbol: string): string {
  return `stock:us:${symbol.toUpperCase()}`;
}

export function alpacaObservationRow(input: AlpacaBarInput): ObservationRow {
  const ts = Math.floor(input.timestamp.getTime() / 1000);
  return {
    id: `alpaca:obs:${input.symbol.toUpperCase()}:${input.timeframe}:${ts}`,
    asset_uid: stockAssetUid(input.symbol),
    symbol: input.symbol.toUpperCase(),
    venue: 'alpaca',
    price: input.close,
    bid: null,
    ask: null,
    mark_price: null,
    index_price: null,
    funding_rate: null,
    funding_rate_annualized: null,
    open_interest: null,
    open_interest_usd: null,
    volume_24h: input.volume,
    volume_24h_usd: input.volume * input.vwap,
    basis: null,
    basis_annualized: null,
    event_time: input.timestamp,
    observed_time: input.observedAt,
    ingested_time: input.observedAt,
    source: 'alpaca',
    source_record_id: `alpaca:bar:${input.symbol.toUpperCase()}:${input.timeframe}:${ts}`,
    quality: 'ok',
    evidence_ref_ids: [`alpaca:bar:${input.symbol.toUpperCase()}:${input.timeframe}:${ts}`],
  };
}

export interface InsiderTradeInput {
  ticker: string;
  insiderName: string;
  insiderCik: string;
  accessionNumber: string;
  direction: 'buy' | 'sell';
  shares: number;
  price: number;
  transactionDate: Date;
  filingDate: Date;
  isDerivative: boolean;
  observedAt: Date;
  sequence: number;
}

export function secInsiderRow(input: InsiderTradeInput): PositioningEventRow {
  return {
    id: `sec:form4:${input.accessionNumber}:${input.sequence}`,
    asset_uid: stockAssetUid(input.ticker),
    event_type: 'insider_form4',
    direction: input.direction,
    size: input.shares,
    notional_usd: input.shares * input.price,
    entry_price: input.price,
    leverage: null,
    wallet_address: null,
    wallet_label: null,
    filer_name: input.insiderName,
    filer_cik: input.insiderCik,
    filing_accession: input.accessionNumber,
    filing_date: input.filingDate,
    transaction_date: input.transactionDate,
    is_derivative: input.isDerivative,
    expiration_date: null,
    strike_price: null,
    option_type: null,
    raw_data: {},
    source: 'sec_edgar',
    // event_time = transaction date; observed = when we saw the filing —
    // the gap IS the reporting latency the spec grades on (§5.2)
    source_record_id: `sec:form4:${input.accessionNumber}:${input.sequence}`,
    event_time: input.transactionDate,
    observed_time: input.observedAt,
    ingested_time: input.observedAt,
    quality: 'ok',
    evidence_ref_ids: [`sec_edgar:form4:${input.accessionNumber}:${input.sequence}`],
  };
}

export function rawSnapshotRow(
  source: string,
  sourceRecordId: string,
  assetUid: string | null,
  payload: Record<string, unknown>,
  payloadHash: string,
  eventTime: Date,
  observedAt: Date,
): RawSnapshotRow {
  return {
    id: `raw:${sourceRecordId}`,
    source,
    source_record_id: sourceRecordId,
    asset_uid: assetUid,
    event_time: eventTime,
    observed_time: observedAt,
    ingested_time: observedAt,
    payload,
    payload_hash: payloadHash,
    quality: 'ok',
    evidence_ref_ids: [sourceRecordId],
    metadata: {},
  };
}
