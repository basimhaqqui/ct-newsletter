// POS_CONGRESS_DISCLOSURE (spec §1.2): new congressional disclosure with
// single-trade $ >= threshold, or clustered disclosures on one issuer.
// Congressional data is structurally laggy (up to 45 days); §5.2 latency
// abstention is applied downstream by the orchestrator.

import { famNum } from '../cohort.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet } from '../types.js';
import { baseCandidate, groupBy, maxTime, positioningEvidence, referencePriceFor } from './shared.js';

export function detectCongressDisclosure(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const minTrade = famNum(cohort, 'POS_CONGRESS_DISCLOSURE', 'min_trade_usd');
  const clusterMin = famNum(cohort, 'POS_CONGRESS_DISCLOSURE', 'cluster_min');
  const windowS = famNum(cohort, 'POS_CONGRESS_DISCLOSURE', 'window_s');
  const refNotional = famNum(cohort, 'POS_CONGRESS_DISCLOSURE', 'reference_notional_usd');

  const disclosures = facts.positioning.filter(
    (p) =>
      p.event_type === 'congressional_disclosure' &&
      p.observed_time >= now - windowS &&
      (p.direction === 'buy' || p.direction === 'sell'),
  );

  const out: Candidate[] = [];
  for (const [uid, group] of groupBy(disclosures, (p) => p.asset.asset_uid)) {
    const buys = group.filter((p) => p.direction === 'buy');
    const sells = group.filter((p) => p.direction === 'sell');
    // dominant side wins; equal-weight conflict → skip (not a §3.5-6 case:
    // congress trades are individually meaningful, but a tie has no direction)
    const side = buys.length > sells.length ? buys : sells.length > buys.length ? sells : null;
    if (side === null) continue;

    const bigSingle = side.some((p) => Math.abs(p.notional_usd) >= minTrade);
    const distinctMembers = new Set(side.map((p) => p.actor_id)).size;
    const clustered = distinctMembers >= clusterMin;
    if (!bigSingle && !clustered) continue;

    const aggregate = side.reduce((s, p) => s + Math.abs(p.notional_usd), 0);
    const direction = side === buys ? 'long' : 'short';
    const asset = group[0].asset;
    const severity = clamp01(
      0.7 * notionalSeverity(aggregate, refNotional) + 0.3 * clamp01(distinctMembers / (2 * clusterMin)),
    );

    out.push(
      baseCandidate({
        family_id: 'POS_CONGRESS_DISCLOSURE',
        asset,
        direction,
        ...maxTime(side),
        trigger: {
          rule: `congress_${direction === 'long' ? 'buy' : 'sell'} (single>=${minTrade} || members>=${clusterMin})`,
          inputs: {
            distinct_members: distinctMembers,
            aggregate_usd: Math.round(aggregate),
            big_single_trade: bigSingle,
            clustered,
          },
        },
        severity,
        evidence: side.map(positioningEvidence),
        reference_price: referencePriceFor(facts, uid, now),
      }),
    );
  }
  return out;
}
