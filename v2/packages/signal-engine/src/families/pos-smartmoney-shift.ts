// POS_SMARTMONEY_SHIFT (spec §1.2): leaderboard-aggregate pct_long swings >=
// `swing`, crosses `strong_consensus`, or net notional flips >= flip_min_usd.
// Ported from v1 smartmoney.mjs RADAR mode. The leaderboard aggregate arrives
// as `leaderboard_aggregate` positioning facts carrying pct_long / trader_count
// / net_notional_usd; the previous snapshot arrives in prev_whale_positions.

import { famNum } from '../cohort.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet, PositioningFact } from '../types.js';
import { baseCandidate, positioningEvidence, referencePriceFor } from './shared.js';

function aggregates(list: PositioningFact[]): Map<string, PositioningFact> {
  const out = new Map<string, PositioningFact>();
  for (const p of list) {
    if (p.event_type !== 'leaderboard_aggregate') continue;
    const prev = out.get(p.asset.asset_uid);
    if (!prev || p.observed_time > prev.observed_time) out.set(p.asset.asset_uid, p);
  }
  return out;
}

export function detectSmartmoneyShift(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const strong = famNum(cohort, 'POS_SMARTMONEY_SHIFT', 'strong_consensus');
  const swing = famNum(cohort, 'POS_SMARTMONEY_SHIFT', 'swing');
  const flipMin = famNum(cohort, 'POS_SMARTMONEY_SHIFT', 'flip_min_usd');
  const minTraders = famNum(cohort, 'POS_SMARTMONEY_SHIFT', 'min_traders');
  const refNotional = famNum(cohort, 'POS_SMARTMONEY_SHIFT', 'reference_notional_usd');

  const cur = aggregates(facts.positioning);
  const prev = aggregates(facts.prev_whale_positions);

  const out: Candidate[] = [];
  for (const [uid, c] of cur) {
    if (c.pct_long === null || c.trader_count === null || c.net_notional_usd === null) continue;
    if (c.trader_count < minTraders) continue;
    const p = prev.get(uid);

    let kind: 'flip' | 'consensus' | 'swing' | 'new' | null = null;
    if (!p || p.pct_long === null || p.net_notional_usd === null) {
      // first sighting: only a fresh strong consensus is an event (v1 "new")
      if (c.pct_long >= strong || c.pct_long <= 1 - strong) kind = 'new';
    } else {
      const flipped =
        (p.net_notional_usd >= 0) !== (c.net_notional_usd >= 0) &&
        Math.abs(c.net_notional_usd) >= flipMin &&
        Math.abs(p.net_notional_usd) >= flipMin;
      const newStrong =
        (c.pct_long >= strong && p.pct_long < strong) ||
        (c.pct_long <= 1 - strong && p.pct_long > 1 - strong);
      const swung = Math.abs(c.pct_long - p.pct_long) >= swing;
      kind = flipped ? 'flip' : newStrong ? 'consensus' : swung ? 'swing' : null;
    }
    if (kind === null) continue;

    const direction = c.net_notional_usd >= 0 ? 'long' : 'short';
    const kindWeight = kind === 'flip' ? 1 : kind === 'consensus' ? 0.85 : kind === 'new' ? 0.7 : 0.55;
    const severity = clamp01(
      kindWeight * (0.5 + 0.5 * notionalSeverity(Math.abs(c.net_notional_usd), refNotional)),
    );

    out.push(
      baseCandidate({
        family_id: 'POS_SMARTMONEY_SHIFT',
        asset: c.asset,
        direction,
        event_time: c.event_time,
        observed_time: c.observed_time,
        trigger: {
          rule: `smartmoney_${kind} (strong=${strong}, swing=${swing}, flip_min=${flipMin})`,
          inputs: {
            kind,
            pct_long: +c.pct_long.toFixed(3),
            prev_pct_long: p?.pct_long !== null && p?.pct_long !== undefined ? +p.pct_long.toFixed(3) : -1,
            net_notional_usd: Math.round(c.net_notional_usd),
            trader_count: c.trader_count,
          },
        },
        severity,
        evidence: [positioningEvidence(c)],
        reference_price: referencePriceFor(facts, uid, now),
        trigger_bucket: kind,
      }),
    );
  }
  return out;
}
