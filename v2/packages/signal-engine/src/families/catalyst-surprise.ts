// CATALYST_SURPRISE (spec §1.2): realized catalyst value deviates from
// consensus by >= threshold (earnings beat/miss, CPI surprise; crypto:
// unlock-vs-float). Directional: beat → long, miss → short.

import { famNum } from '../cohort.js';
import { clamp01 } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet } from '../types.js';
import { baseCandidate, referencePriceFor, sourceOf } from './shared.js';

export function detectCatalystSurprise(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const minPct = famNum(cohort, 'CATALYST_SURPRISE', 'surprise_min_pct');
  const normPct = famNum(cohort, 'CATALYST_SURPRISE', 'surprise_norm_pct');

  const out: Candidate[] = [];
  for (const c of facts.catalysts) {
    if (c.surprise_pct === null) continue;
    if (c.status !== 'completed' && c.status !== 'surprise') continue;
    if (Math.abs(c.surprise_pct) < minPct) continue;

    const direction = c.surprise_pct > 0 ? 'long' : 'short';
    const severity = clamp01(0.4 + 0.6 * clamp01(Math.abs(c.surprise_pct) / normPct));

    out.push(
      baseCandidate({
        family_id: 'CATALYST_SURPRISE',
        asset: c.asset,
        direction,
        event_time: c.actual_time ?? c.event_time,
        observed_time: c.observed_time,
        trigger: {
          rule: `|surprise_pct|>=${minPct}`,
          inputs: {
            catalyst_type: c.catalyst_type,
            surprise_pct: +c.surprise_pct.toFixed(2),
          },
        },
        severity,
        evidence: [
          {
            kind: 'catalyst',
            source: sourceOf(c.evidence_ref),
            ref: c.evidence_ref,
            event_time: c.event_time,
            observed_time: c.observed_time,
            quality: c.quality,
          },
        ],
        reference_price: referencePriceFor(facts, c.asset.asset_uid, now),
        trigger_bucket: `${c.catalyst_type}@${c.actual_time ?? c.scheduled_time}`,
      }),
    );
  }
  return out;
}
