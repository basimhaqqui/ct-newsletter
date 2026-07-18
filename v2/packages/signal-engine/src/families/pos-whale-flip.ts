// POS_WHALE_FLIP (spec §1.2): tracked-wallet net side on a coin flips vs the
// last snapshot, both snapshots >= min_notional.

import { famNum } from '../cohort.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet, PositioningFact } from '../types.js';
import { baseCandidate, groupBy, maxTime, positioningEvidence, referencePriceFor } from './shared.js';

function netNotional(group: PositioningFact[], minNotional: number): number {
  let net = 0;
  for (const p of group) {
    if (Math.abs(p.notional_usd) < minNotional) continue;
    if (p.direction === 'long') net += Math.abs(p.notional_usd);
    else if (p.direction === 'short') net -= Math.abs(p.notional_usd);
  }
  return net;
}

export function detectWhaleFlip(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const minNotional = famNum(cohort, 'POS_WHALE_FLIP', 'min_notional_usd');
  const refNotional = famNum(cohort, 'POS_WHALE_FLIP', 'reference_notional_usd');

  const isWhale = (p: PositioningFact) => p.event_type === 'whale_position';
  const current = groupBy(facts.positioning.filter(isWhale), (p) => p.asset.asset_uid);
  const previous = groupBy(facts.prev_whale_positions.filter(isWhale), (p) => p.asset.asset_uid);

  const out: Candidate[] = [];
  for (const [uid, curGroup] of current) {
    const prevGroup = previous.get(uid);
    if (!prevGroup || prevGroup.length === 0) continue;

    const curNet = netNotional(curGroup, minNotional);
    const prevNet = netNotional(prevGroup, minNotional);

    // both snapshots must clear the noise floor and the sign must flip
    if (Math.abs(curNet) < minNotional || Math.abs(prevNet) < minNotional) continue;
    if ((curNet >= 0) === (prevNet >= 0)) continue;

    const direction = curNet > 0 ? 'long' : 'short';
    const asset = curGroup[0].asset;
    const severity = clamp01(
      0.5 * notionalSeverity(Math.abs(curNet), refNotional) +
        0.5 * notionalSeverity(Math.abs(prevNet), refNotional),
    );

    out.push(
      baseCandidate({
        family_id: 'POS_WHALE_FLIP',
        asset,
        direction,
        ...maxTime(curGroup),
        trigger: {
          rule: `whale_net flips ${prevNet >= 0 ? 'long' : 'short'}->${direction} && |net|>=${minNotional}`,
          inputs: {
            prev_net_notional_usd: Math.round(prevNet),
            net_notional_usd: Math.round(curNet),
            min_notional_usd: minNotional,
          },
        },
        severity,
        evidence: curGroup.map(positioningEvidence),
        reference_price: referencePriceFor(facts, uid, now),
      }),
    );
  }
  return out;
}
