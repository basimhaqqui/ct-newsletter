// POS_INSIDER_CLUSTER (spec §1.2): >= N distinct insiders (Form 4) net-buy the
// same issuer within the window, min aggregate dollars. Stocks only.

import { famNum } from '../cohort.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet } from '../types.js';
import { baseCandidate, groupBy, maxTime, positioningEvidence, referencePriceFor } from './shared.js';

export function detectInsiderCluster(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const minInsiders = famNum(cohort, 'POS_INSIDER_CLUSTER', 'min_insiders');
  const windowS = famNum(cohort, 'POS_INSIDER_CLUSTER', 'window_s');
  const minAggregate = famNum(cohort, 'POS_INSIDER_CLUSTER', 'min_aggregate_usd');
  const refNotional = famNum(cohort, 'POS_INSIDER_CLUSTER', 'reference_notional_usd');

  const filings = facts.positioning.filter(
    (p) => p.event_type === 'insider_form4' && p.event_time >= now - windowS,
  );

  const out: Candidate[] = [];
  for (const [uid, group] of groupBy(filings, (p) => p.asset.asset_uid)) {
    // net-buy per distinct insider inside the window
    const perInsider = new Map<string, number>();
    for (const f of group) {
      const signed = f.direction === 'buy' ? Math.abs(f.notional_usd) : -Math.abs(f.notional_usd);
      perInsider.set(f.actor_id, (perInsider.get(f.actor_id) ?? 0) + signed);
    }
    const netBuyers = [...perInsider.entries()].filter(([, v]) => v > 0);
    if (netBuyers.length < minInsiders) continue;

    const aggregate = netBuyers.reduce((s, [, v]) => s + v, 0);
    if (aggregate < minAggregate) continue;

    const asset = group[0].asset;
    const buyerIds = new Set(netBuyers.map(([id]) => id));
    const evidence = group.filter((f) => buyerIds.has(f.actor_id)).map(positioningEvidence);
    const severity = clamp01(
      0.6 * notionalSeverity(aggregate, refNotional) +
        0.4 * clamp01(netBuyers.length / (2 * minInsiders)),
    );

    out.push(
      baseCandidate({
        family_id: 'POS_INSIDER_CLUSTER',
        asset,
        direction: 'long',
        ...maxTime(group),
        trigger: {
          rule: `insiders_net_buy>=${minInsiders} within ${windowS}s && aggregate>=${minAggregate}`,
          inputs: {
            distinct_net_buyers: netBuyers.length,
            aggregate_usd: Math.round(aggregate),
            window_s: windowS,
          },
        },
        severity,
        evidence,
        reference_price: referencePriceFor(facts, uid, now),
      }),
    );
  }
  return out;
}
