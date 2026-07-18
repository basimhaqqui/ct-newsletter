// Mock fact fixtures matching the frozen contracts — integration with real
// ingestion (t_7410f09c) becomes a wiring step.

import type {
  AssetRef,
  CatalystFact,
  FactSet,
  MentionFact,
  ObservationFact,
  PositioningFact,
  TaFact,
  UserContext,
} from '../src/types.js';
import { readFileSync } from 'node:fs';

export const COHORT: unknown = JSON.parse(
  readFileSync(new URL('../cohort/cohort-2026.07.0.json', import.meta.url), 'utf8'),
);
export const NOW = 1_784_086_130; // matches the spec's worked example era

export const HYPE: AssetRef = {
  asset_uid: 'crypto:hl:HYPE',
  symbol: 'HYPE',
  venue: 'hyperliquid',
  asset_class: 'crypto',
};
export const BTC: AssetRef = {
  asset_uid: 'crypto:hl:BTC',
  symbol: 'BTC',
  venue: 'hyperliquid',
  asset_class: 'crypto',
};
export const AAPL: AssetRef = {
  asset_uid: 'stock:us:AAPL',
  symbol: 'AAPL',
  venue: 'nasdaq',
  asset_class: 'stock',
};

export function emptyFacts(): FactSet {
  return {
    observations: [],
    positioning: [],
    mentions: [],
    catalysts: [],
    ta: [],
    prev_whale_positions: [],
    source_health: {},
  };
}

export function observation(overrides: Partial<ObservationFact> & { asset: AssetRef }): ObservationFact {
  return {
    kind: 'observation',
    price: 46.12,
    funding_annual_pct: null,
    open_interest_usd: 120_000_000,
    volume_24h_usd: 300_000_000,
    event_time: NOW - 30,
    observed_time: NOW - 5,
    quality: 'ok',
    evidence_ref: `hyperliquid:assetCtx:${overrides.asset.symbol}@${NOW - 5}`,
    ...overrides,
  };
}

export function whale(
  asset: AssetRef,
  actor: string,
  direction: 'long' | 'short',
  notional = 100_000,
  overrides: Partial<PositioningFact> = {},
): PositioningFact {
  return {
    kind: 'positioning',
    asset,
    event_type: 'whale_position',
    direction,
    notional_usd: notional,
    actor_id: actor,
    actor_label: actor,
    pct_long: null,
    trader_count: null,
    net_notional_usd: null,
    event_time: NOW - 60,
    observed_time: NOW - 10,
    quality: 'ok',
    evidence_ref: `hyperliquid:clearinghouseState:${actor}:${asset.symbol}@${NOW - 10}`,
    ...overrides,
  };
}

export function leaderboardAgg(
  asset: AssetRef,
  pctLong: number,
  traderCount: number,
  netNotional: number,
  overrides: Partial<PositioningFact> = {},
): PositioningFact {
  return {
    kind: 'positioning',
    asset,
    event_type: 'leaderboard_aggregate',
    direction: netNotional >= 0 ? 'long' : 'short',
    notional_usd: Math.abs(netNotional),
    actor_id: 'leaderboard',
    actor_label: 'HL leaderboard top',
    pct_long: pctLong,
    trader_count: traderCount,
    net_notional_usd: netNotional,
    event_time: NOW - 60,
    observed_time: NOW - 10,
    quality: 'ok',
    evidence_ref: `hyperliquid:leaderboard:${asset.symbol}@${NOW - 10}`,
    ...overrides,
  };
}

export function form4(
  asset: AssetRef,
  insider: string,
  direction: 'buy' | 'sell',
  notional: number,
  overrides: Partial<PositioningFact> = {},
): PositioningFact {
  return {
    kind: 'positioning',
    asset,
    event_type: 'insider_form4',
    direction,
    notional_usd: notional,
    actor_id: insider,
    actor_label: insider,
    pct_long: null,
    trader_count: null,
    net_notional_usd: null,
    event_time: NOW - 86_400,
    observed_time: NOW - 3600,
    quality: 'ok',
    evidence_ref: `sec_edgar:form4:${insider}:${asset.symbol}@${NOW - 3600}`,
    ...overrides,
  };
}

export function congress(
  asset: AssetRef,
  member: string,
  direction: 'buy' | 'sell',
  notional: number,
  overrides: Partial<PositioningFact> = {},
): PositioningFact {
  return {
    kind: 'positioning',
    asset,
    event_type: 'congressional_disclosure',
    direction,
    notional_usd: notional,
    actor_id: member,
    actor_label: member,
    pct_long: null,
    trader_count: null,
    net_notional_usd: null,
    event_time: NOW - 10 * 86_400,
    observed_time: NOW - 3600,
    quality: 'ok',
    evidence_ref: `congress:ptr:${member}:${asset.symbol}@${NOW - 3600}`,
    ...overrides,
  };
}

export function mention(
  asset: AssetRef,
  count: number,
  overrides: Partial<MentionFact> = {},
): MentionFact {
  return {
    kind: 'mention',
    asset,
    mention_count: count,
    event_time: NOW - 1800,
    observed_time: NOW - 60,
    quality: 'ok',
    evidence_ref: `apify_x:mentions:${asset.symbol}@${NOW - 60}`,
    top_claim_refs: [`apify_x:tweet:123:${asset.symbol}`],
    ...overrides,
  };
}

export function catalyst(
  asset: AssetRef,
  type: string,
  scheduledIn: number,
  overrides: Partial<CatalystFact> = {},
): CatalystFact {
  return {
    kind: 'catalyst',
    asset,
    catalyst_type: type,
    scheduled_time: NOW + scheduledIn,
    actual_time: null,
    surprise_pct: null,
    status: 'scheduled',
    event_time: NOW - 3600,
    observed_time: NOW - 600,
    quality: 'ok',
    evidence_ref: `earnings:cal:${asset.symbol}@${NOW - 600}`,
    ...overrides,
  };
}

export function taFact(asset: AssetRef, overrides: Partial<TaFact> = {}): TaFact {
  return {
    kind: 'ta',
    asset,
    price: 46.12,
    rsi_1d: 50,
    trend_1d: 'mixed',
    macd_hist_1d: 0,
    atr_1d: 2.1,
    high_30d: 52,
    low_30d: 40,
    support: 44.5,
    resistance: 51,
    oi_rising: null,
    event_time: NOW - 120,
    observed_time: NOW - 30,
    quality: 'ok',
    evidence_ref: `hyperliquid:candles:${asset.symbol}@${NOW - 30}`,
    ...overrides,
  };
}

export const USER: UserContext = {
  tracked_asset_uids: [HYPE.asset_uid, AAPL.asset_uid],
  cluster_asset_uids: [],
  covered_asset_uids: [HYPE.asset_uid, BTC.asset_uid, AAPL.asset_uid],
};

/** The spec §2.1 worked example: 4 whales long HYPE, funding -7.2%/yr. */
export function divergenceScenario(): FactSet {
  const facts = emptyFacts();
  facts.positioning = [
    whale(HYPE, '0xaaa', 'long', 120_000),
    whale(HYPE, '0xbbb', 'long', 90_000),
    whale(HYPE, '0xccc', 'long', 250_000),
    whale(HYPE, '0xddd', 'long', 60_000),
  ];
  facts.observations = [
    observation({ asset: HYPE, price: 46.12, funding_annual_pct: -7.2, open_interest_usd: 120_000_000 }),
  ];
  facts.ta = [taFact(HYPE)];
  facts.source_health = { hyperliquid: 'ok' };
  return facts;
}
