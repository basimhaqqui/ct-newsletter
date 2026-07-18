// POS_WHALE_CONSENSUS (spec §1.2): >= consensus_min tracked wallets on the
// same side of a coin, each position >= min_notional. Ported from v1
// divergence.mjs consensus tally.

import { famNum } from '../cohort.js';
import type { CohortConfig } from '../types.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, FactSet } from '../types.js';
import { baseCandidate, groupBy, maxTime, positioningEvidence, referencePriceFor } from './shared.js';

export function detectWhaleConsensus(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const minNotional = famNum(cohort, 'POS_WHALE_CONSENSUS', 'min_notional_usd');
  const consensusMin = famNum(cohort, 'POS_WHALE_CONSENSUS', 'consensus_min');
  const refNotional = famNum(cohort, 'POS_WHALE_CONSENSUS', 'reference_notional_usd');

  const whales = facts.positioning.filter(
    (p) =>
      p.event_type === 'whale_position' &&
      (p.direction === 'long' || p.direction === 'short') &&
      Math.abs(p.notional_usd) >= minNotional,
  );

  const out: Candidate[] = [];
  for (const [, group] of groupBy(whales, (p) => p.asset.asset_uid)) {
    const longs = group.filter((p) => p.direction === 'long');
    const shorts = group.filter((p) => p.direction === 'short');

    // distinct actors only — one wallet can't be its own consensus
    const longActors = new Set(longs.map((p) => p.actor_id)).size;
    const shortActors = new Set(shorts.map((p) => p.actor_id)).size;

    let side: 'long' | 'short' | null = null;
    if (longActors >= consensusMin && longActors > shortActors) side = 'long';
    else if (shortActors >= consensusMin && shortActors > longActors) side = 'short';

    // §3.5-6: split below consensus on both sides → direction undeterminable,
    // but only when there is real two-sided conflict worth recording.
    if (side === null) {
      if (longActors > 0 && shortActors > 0 && longActors === shortActors) {
        const asset = group[0].asset;
        out.push(
          baseCandidate({
            family_id: 'POS_WHALE_CONSENSUS',
            asset,
            direction: 'neutral',
            ...maxTime(group),
            trigger: {
              rule: `whales split ${longActors}L/${shortActors}S below consensus_min=${consensusMin}`,
              inputs: { whales_long: longActors, whales_short: shortActors, consensus_min: consensusMin },
            },
            severity: 0,
            evidence: group.map(positioningEvidence),
            abstain_reason: 'ABSTAIN_DIRECTION',
          }),
        );
      }
      continue;
    }

    const sided = side === 'long' ? longs : shorts;
    const actors = side === 'long' ? longActors : shortActors;
    const aggNotional = sided.reduce((s, p) => s + Math.abs(p.notional_usd), 0);
    const asset = group[0].asset;
    const severity = clamp01(
      0.6 * notionalSeverity(aggNotional, refNotional) + 0.4 * clamp01(actors / (2 * consensusMin)),
    );

    out.push(
      baseCandidate({
        family_id: 'POS_WHALE_CONSENSUS',
        asset,
        direction: side,
        ...maxTime(sided),
        trigger: {
          rule: `whales_${side}>=${consensusMin} && each_notional>=${minNotional}`,
          inputs: {
            whales_long: longActors,
            whales_short: shortActors,
            aggregate_notional_usd: Math.round(aggNotional),
            consensus_min: consensusMin,
          },
        },
        severity,
        evidence: sided.map(positioningEvidence),
        reference_price: referencePriceFor(facts, asset.asset_uid, now),
      }),
    );
  }
  return out;
}
