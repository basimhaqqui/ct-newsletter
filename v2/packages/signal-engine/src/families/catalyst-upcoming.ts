// CATALYST_UPCOMING (spec §1.2, §4.4): a Catalyst enters [now, now+lead] for a
// covered asset. Direction: neutral — graded on the information-value track.

import { famNum, famObj } from '../cohort.js';
import { clamp01 } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet } from '../types.js';
import { baseCandidate, sourceOf } from './shared.js';

export function detectCatalystUpcoming(
  facts: FactSet,
  cohort: CohortConfig,
  now: number,
): Candidate[] {
  const leadS = famNum(cohort, 'CATALYST_UPCOMING', 'lead_s');
  const weights = famObj<Record<string, number>>(cohort, 'CATALYST_UPCOMING', 'event_weights');

  const out: Candidate[] = [];
  for (const c of facts.catalysts) {
    if (c.status !== 'scheduled' && c.status !== 'live') continue;
    if (c.scheduled_time < now || c.scheduled_time > now + leadS) continue;

    const weight = weights[c.catalyst_type] ?? weights['default'] ?? 0.4;
    // §3.1 catalyst severity: event weight × proximity
    const proximity = clamp01(1 - (c.scheduled_time - now) / leadS);
    const severity = clamp01(weight * (0.5 + 0.5 * proximity));

    out.push(
      baseCandidate({
        family_id: 'CATALYST_UPCOMING',
        asset: c.asset,
        direction: 'neutral',
        event_time: c.event_time,
        observed_time: c.observed_time,
        trigger: {
          rule: `catalyst in [now, now+${leadS}s]`,
          inputs: {
            catalyst_type: c.catalyst_type,
            scheduled_time: c.scheduled_time,
            lead_s: c.scheduled_time - now,
            event_weight: weight,
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
        // neutral signals carry no levels (§2.2) but keep a reference price null
        // day bucket so one event alerts once per lead window
        trigger_bucket: `${c.catalyst_type}@${c.scheduled_time}`,
      }),
    );
  }
  return out;
}
