// CROWD_DIVERGENCE (spec §1.2): proven capital positioned AGAINST crowd
// funding. whales long + funding <= funding_neg → bullish squeeze fuel;
// whales short + funding >= funding_pos → fading an over-long crowd.
// Direct port of v1 divergence.mjs with the v1-proven thresholds.

import { famNum } from '../cohort.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet } from '../types.js';
import {
  baseCandidate,
  groupBy,
  latestObservation,
  maxTime,
  observationEvidence,
  positioningEvidence,
} from './shared.js';

export function detectCrowdDivergence(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const consensusMin = famNum(cohort, 'CROWD_DIVERGENCE', 'consensus_min');
  const minNotional = famNum(cohort, 'CROWD_DIVERGENCE', 'min_notional_usd');
  const fundingPos = famNum(cohort, 'CROWD_DIVERGENCE', 'funding_pos');
  const fundingNeg = famNum(cohort, 'CROWD_DIVERGENCE', 'funding_neg');

  const whales = facts.positioning.filter(
    (p) =>
      p.event_type === 'whale_position' &&
      (p.direction === 'long' || p.direction === 'short') &&
      Math.abs(p.notional_usd) >= minNotional,
  );

  const out: Candidate[] = [];
  for (const [uid, group] of groupBy(whales, (p) => p.asset.asset_uid)) {
    const obs = latestObservation(facts, uid);
    if (!obs || obs.funding_annual_pct === null) continue;
    const funding = obs.funding_annual_pct;

    const longActors = new Set(group.filter((p) => p.direction === 'long').map((p) => p.actor_id)).size;
    const shortActors = new Set(group.filter((p) => p.direction === 'short').map((p) => p.actor_id)).size;

    let direction: 'long' | 'short' | null = null;
    let rule = '';
    if (longActors >= consensusMin && longActors > shortActors && funding <= fundingNeg) {
      direction = 'long';
      rule = `whales_long>=${consensusMin} && funding_annual<=${fundingNeg}`;
    } else if (shortActors >= consensusMin && shortActors > longActors && funding >= fundingPos) {
      direction = 'short';
      rule = `whales_short>=${consensusMin} && funding_annual>=${fundingPos}`;
    }
    if (direction === null) continue;

    const sided = group.filter((p) => p.direction === direction);
    const aggNotional = sided.reduce((s, p) => s + Math.abs(p.notional_usd), 0);
    const fundingStretch =
      direction === 'long'
        ? clamp01(Math.abs(funding - fundingNeg) / 50)
        : clamp01((funding - fundingPos) / 50);
    const severity = clamp01(
      0.5 * notionalSeverity(aggNotional, 1_000_000) + 0.3 * fundingStretch + 0.2 * clamp01((direction === 'long' ? longActors : shortActors) / (2 * consensusMin)),
    );

    const asset = group[0].asset;
    out.push(
      baseCandidate({
        family_id: 'CROWD_DIVERGENCE',
        asset,
        direction,
        ...maxTime([...sided, obs]),
        trigger: {
          rule,
          inputs: {
            whales_long: longActors,
            whales_short: shortActors,
            funding_annual_pct: +funding.toFixed(2),
            oi_usd: obs.open_interest_usd ?? 0,
          },
        },
        severity,
        evidence: [...sided.map(positioningEvidence), observationEvidence(obs)],
        reference_price: obs.observed_time <= now ? obs.price : null,
        // v1 semantics: one alert per divergence episode (asset|side active set);
        // bucket by side so an ongoing divergence dedupes to one signal
        trigger_bucket: direction === 'long' ? 'bull' : 'bear',
      }),
    );
  }
  return out;
}
