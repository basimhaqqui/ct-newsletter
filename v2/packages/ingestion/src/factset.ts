// Deterministic feature preparation (t_7410f09c): DB rows → signal-engine
// FactSet. Dates become unix seconds, funding/OI ride on observations, TA
// facts are computed from stored price series with v1's indicators. Pure
// given repos content + injected `now`.

import type {
  ObservationRow,
  PositioningEventRow,
  RepositoryFactory,
  SocialClaimRow,
} from '@market-intel/db';
import type {
  AssetRef,
  CatalystFact,
  FactSet,
  MentionFact,
  ObservationFact,
  PositioningFact,
  Quality,
  TaFact,
} from '@market-intel/signal-engine';
import { atr, macdHist, rsi, trendRead } from './indicators.js';

const toUnix = (d: Date): number => Math.floor(d.getTime() / 1000);

export function assetRefFromUid(assetUid: string, symbol: string, venue: string): AssetRef {
  return {
    asset_uid: assetUid,
    symbol,
    venue,
    asset_class: assetUid.startsWith('stock:') ? 'stock' : 'crypto',
  };
}

export interface FactSetOptions {
  now: Date;
  /** current-cycle window (seconds) for positioning/mentions */
  cycleS?: number;
  /** how much history feeds TA fact computation */
  taLookbackBars?: number;
  /** venue whose series feeds crypto TA facts */
  cryptoVenue?: string;
}

export async function buildFactSet(
  repos: RepositoryFactory,
  options: FactSetOptions,
): Promise<FactSet> {
  const now = options.now;
  const nowS = toUnix(now);
  const cycleS = options.cycleS ?? 1800;
  const windowStart = new Date((nowS - cycleS) * 1000);
  const prevWindowStart = new Date((nowS - 2 * cycleS) * 1000);

  // --- observations: latest row per asset inside the cycle window ----------
  const allObs = await repos.observations.findAll();
  const latestByAsset = new Map<string, ObservationRow>();
  for (const o of allObs) {
    if (o.observed_time.getTime() > now.getTime()) continue; // never future
    const prev = latestByAsset.get(o.asset_uid);
    if (!prev || o.observed_time.getTime() > prev.observed_time.getTime()) {
      latestByAsset.set(o.asset_uid, o);
    }
  }
  const observations: ObservationFact[] = [...latestByAsset.values()].map((o) => ({
    kind: 'observation',
    asset: assetRefFromUid(o.asset_uid, o.symbol, o.venue),
    price: o.price,
    funding_annual_pct: o.funding_rate_annualized,
    open_interest_usd: o.open_interest_usd,
    volume_24h_usd: o.volume_24h_usd,
    event_time: toUnix(o.event_time),
    observed_time: toUnix(o.observed_time),
    quality: o.quality,
    evidence_ref: o.evidence_ref_ids[0] ?? o.source_record_id,
  }));

  // --- positioning: windowed on observed_time (a filing observed this cycle
  // may describe a days-old transaction — event_time windows would drop it) --
  const allPositioning = await repos.positioningEvents.findAll();
  const inWindow = (p: PositioningEventRow, start: Date, end: Date) =>
    p.observed_time.getTime() > start.getTime() && p.observed_time.getTime() <= end.getTime();
  const positioning = allPositioning
    .filter((p) => inWindow(p, windowStart, now))
    .map(positioningFact);
  const prev_whale_positions = allPositioning
    .filter((p) => inWindow(p, prevWindowStart, windowStart))
    .map(positioningFact);

  // --- mentions: viral-claim tally per asset in the cycle window -----------
  const claims = await repos.socialClaims.findByTimeRange(windowStart, now);
  const mentions = aggregateMentions(claims, nowS);

  // --- catalysts -----------------------------------------------------------
  const catalystRows = await repos.catalysts.findAll();
  const catalysts: CatalystFact[] = catalystRows
    .filter((c) => c.observed_time.getTime() <= now.getTime())
    .map((c) => ({
      kind: 'catalyst',
      asset: assetRefFromUid(c.asset_uid, symbolFromUid(c.asset_uid), venueFromUid(c.asset_uid)),
      catalyst_type: c.catalyst_type,
      scheduled_time: toUnix(c.scheduled_time),
      actual_time: c.actual_time ? toUnix(c.actual_time) : null,
      surprise_pct: c.surprise_pct,
      status: c.status === 'cancelled' ? 'cancelled' : c.status,
      event_time: toUnix(c.event_time),
      observed_time: toUnix(c.observed_time),
      quality: c.quality,
      evidence_ref: c.evidence_ref_ids[0] ?? c.source_record_id,
    }));

  // --- TA facts from stored price series -----------------------------------
  const ta: TaFact[] = [];
  const lookback = options.taLookbackBars ?? 75;
  for (const [uid, latest] of latestByAsset) {
    const series = await repos.observations.getPriceSeries(
      uid,
      latest.venue,
      '1d',
      new Date((nowS - lookback * 86400) * 1000),
      now,
    );
    if (series.length < 35) continue; // not enough bars for a read
    const closes = series.map((s) => s.price);
    const highs = closes; // observation rows carry close-style prices only
    const lows = closes;
    const { trend } = trendRead(closes);
    const price = closes[closes.length - 1];
    const window30 = closes.slice(-30);
    ta.push({
      kind: 'ta',
      asset: assetRefFromUid(uid, latest.symbol, latest.venue),
      price,
      rsi_1d: Math.round(rsi(closes)),
      trend_1d: trend,
      macd_hist_1d: macdHist(closes),
      atr_1d: atr(highs, lows, closes),
      high_30d: Math.max(...window30),
      low_30d: Math.min(...window30),
      support: Math.min(...closes.slice(-14)),
      resistance: Math.max(...closes.slice(-14)),
      oi_rising: oiRising(series),
      event_time: toUnix(latest.event_time),
      observed_time: toUnix(latest.observed_time),
      quality: latest.quality,
      evidence_ref: latest.evidence_ref_ids[0] ?? latest.source_record_id,
    });
  }

  // --- source health -------------------------------------------------------
  const healthRows = await repos.sourceHealth.findAll();
  const source_health: Record<string, Quality> = {};
  for (const h of healthRows) {
    source_health[h.source_id] =
      h.status === 'healthy' ? 'ok' : h.status === 'degraded' ? 'degraded' : 'stale';
  }

  return {
    observations,
    positioning,
    mentions,
    catalysts,
    ta,
    prev_whale_positions,
    source_health,
  };
}

function positioningFact(p: PositioningEventRow): PositioningFact {
  const rawData = p.raw_data as Record<string, unknown>;
  return {
    kind: 'positioning',
    asset: assetRefFromUid(p.asset_uid, symbolFromUid(p.asset_uid), venueFromUid(p.asset_uid)),
    event_type: p.event_type as PositioningFact['event_type'],
    direction: p.direction,
    notional_usd: p.notional_usd ?? 0,
    actor_id: p.wallet_address ?? p.filer_cik ?? p.filer_name ?? 'unknown',
    actor_label: p.wallet_label ?? p.filer_name,
    pct_long: typeof rawData['pct_long'] === 'number' ? (rawData['pct_long'] as number) : null,
    trader_count:
      typeof rawData['trader_count'] === 'number' ? (rawData['trader_count'] as number) : null,
    net_notional_usd:
      typeof rawData['net_notional_usd'] === 'number'
        ? (rawData['net_notional_usd'] as number)
        : null,
    event_time: toUnix(p.event_time),
    observed_time: toUnix(p.observed_time),
    quality: p.quality,
    evidence_ref: p.evidence_ref_ids[0] ?? p.source_record_id,
  };
}

function aggregateMentions(claims: SocialClaimRow[], nowS: number): MentionFact[] {
  const byAsset = new Map<string, { count: number; latest: SocialClaimRow; refs: string[] }>();
  for (const c of claims) {
    for (const uid of c.asset_uids) {
      const entry = byAsset.get(uid) ?? { count: 0, latest: c, refs: [] };
      entry.count += 1;
      if (c.event_time.getTime() > entry.latest.event_time.getTime()) entry.latest = c;
      if (entry.refs.length < 3) entry.refs.push(c.evidence_ref_ids[0] ?? c.source_record_id);
      byAsset.set(uid, entry);
    }
  }
  return [...byAsset.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([uid, e]) => ({
      kind: 'mention' as const,
      asset: assetRefFromUid(uid, symbolFromUid(uid), venueFromUid(uid)),
      mention_count: e.count,
      event_time: toUnix(e.latest.event_time),
      observed_time: Math.min(toUnix(e.latest.observed_time), nowS),
      quality: e.latest.quality,
      evidence_ref: e.refs[0] ?? `social:${uid}`,
      top_claim_refs: e.refs,
    }));
}

function oiRising(series: ObservationRow[]): boolean | null {
  const withOi = series.filter((s) => s.open_interest_usd !== null);
  if (withOi.length < 2) return null;
  const first = withOi[0].open_interest_usd!;
  const last = withOi[withOi.length - 1].open_interest_usd!;
  return last > first;
}

function symbolFromUid(uid: string): string {
  const parts = uid.split(':');
  return parts[parts.length - 1] ?? uid;
}

function venueFromUid(uid: string): string {
  if (uid.startsWith('crypto:hl:')) return 'hyperliquid';
  if (uid.startsWith('stock:us:')) return 'alpaca';
  return 'unknown';
}
