// CROWD_FUNDING_EXTREME (spec §1.2): annualized funding >= funding_pos or
// <= funding_neg with OI >= floor. Contrarian: extreme positive funding
// (crowd over-long) → short bias; extreme negative → long bias.

import { famNum } from '../cohort.js';
import { clamp01, notionalSeverity } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet, ObservationFact } from '../types.js';
import { baseCandidate, observationEvidence } from './shared.js';

export function detectFundingExtreme(
  facts: FactSet,
  cohort: CohortConfig,
  _now: number,
): Candidate[] {
  const fundingPos = famNum(cohort, 'CROWD_FUNDING_EXTREME', 'funding_pos');
  const fundingNeg = famNum(cohort, 'CROWD_FUNDING_EXTREME', 'funding_neg');
  const oiFloor = famNum(cohort, 'CROWD_FUNDING_EXTREME', 'oi_floor_usd');
  const norm = famNum(cohort, 'CROWD_FUNDING_EXTREME', 'funding_norm_pct');

  // latest observation per asset
  const latest = new Map<string, ObservationFact>();
  for (const o of facts.observations) {
    const prev = latest.get(o.asset.asset_uid);
    if (!prev || o.observed_time > prev.observed_time) latest.set(o.asset.asset_uid, o);
  }

  const out: Candidate[] = [];
  for (const o of latest.values()) {
    if (o.funding_annual_pct === null) continue;
    const funding = o.funding_annual_pct;
    const extreme = funding >= fundingPos || funding <= fundingNeg;
    if (!extreme) continue;
    // liquidity floor is also re-checked by the §3.5-5 abstention path; the
    // family itself skips illiquid books so they don't churn state
    if (o.open_interest_usd === null || o.open_interest_usd < oiFloor) continue;

    const direction = funding >= fundingPos ? 'short' : 'long';
    const overshoot =
      direction === 'short' ? (funding - fundingPos) / norm : (fundingNeg - funding) / norm;
    const severity = clamp01(
      (0.6 * clamp01(overshoot) + 0.4) * clamp01(0.5 + 0.5 * notionalSeverity(o.open_interest_usd, 10 * oiFloor)),
    );

    out.push(
      baseCandidate({
        family_id: 'CROWD_FUNDING_EXTREME',
        asset: o.asset,
        direction,
        event_time: o.event_time,
        observed_time: o.observed_time,
        trigger: {
          rule:
            direction === 'short'
              ? `funding_annual>=${fundingPos} && oi>=${oiFloor}`
              : `funding_annual<=${fundingNeg} && oi>=${oiFloor}`,
          inputs: {
            funding_annual_pct: +funding.toFixed(2),
            oi_usd: Math.round(o.open_interest_usd),
          },
        },
        severity,
        evidence: [observationEvidence(o)],
        reference_price: o.price,
      }),
    );
  }
  return out;
}
