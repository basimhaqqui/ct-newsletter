// CROWD_MENTION_SPIKE (spec §1.2): cashtag viral-mention count >= min_mentions
// AND >= spike_ratio x rolling EMA baseline. New tickers (no baseline) fire on
// raw count alone. Ported from v1 radar.mjs (incl. EMA baseline update).

import { famNum } from '../cohort.js';
import { clamp01 } from '../scoring.js';
import type { Candidate, CohortConfig, EngineState, FactSet } from '../types.js';
import { baseCandidate, referencePriceFor, sourceOf } from './shared.js';

export function detectMentionSpike(
  facts: FactSet,
  cohort: CohortConfig,
  state: EngineState,
  now: number,
): Candidate[] {
  const minMentions = famNum(cohort, 'CROWD_MENTION_SPIKE', 'min_mentions');
  const spikeRatio = famNum(cohort, 'CROWD_MENTION_SPIKE', 'spike_ratio');

  // v1 radar: first run establishes the baseline silently, never alerts
  const firstRun = Object.keys(state.mention_baseline).length === 0;

  const out: Candidate[] = [];
  for (const m of facts.mentions) {
    if (firstRun) break;
    const base = state.mention_baseline[m.asset.asset_uid] ?? 0;
    const isNew = base < 1;
    const hot = m.mention_count >= minMentions && (isNew || m.mention_count >= spikeRatio * base);
    if (!hot) continue;

    const ratio = isNew ? spikeRatio : m.mention_count / Math.max(base, 0.1);
    const severity = clamp01(
      0.5 * clamp01(m.mention_count / (4 * minMentions)) + 0.5 * clamp01(ratio / (2 * spikeRatio)),
    );

    out.push(
      baseCandidate({
        family_id: 'CROWD_MENTION_SPIKE',
        asset: m.asset,
        // mention velocity is attention, not direction — graded on the
        // information track unless a directional family confirms
        direction: 'neutral',
        event_time: m.event_time,
        observed_time: m.observed_time,
        trigger: {
          rule: `mentions>=${minMentions} && mentions>=${spikeRatio}x_baseline`,
          inputs: {
            mentions: m.mention_count,
            baseline: +base.toFixed(2),
            spike_ratio: +ratio.toFixed(2),
            new_on_radar: isNew,
          },
        },
        severity,
        evidence: [
          {
            kind: 'social_claim',
            source: sourceOf(m.evidence_ref),
            ref: m.evidence_ref,
            event_time: m.event_time,
            observed_time: m.observed_time,
            quality: m.quality,
          },
          ...m.top_claim_refs.map((ref) => ({
            kind: 'social_claim' as const,
            source: sourceOf(ref),
            ref,
            event_time: m.event_time,
            observed_time: m.observed_time,
            quality: m.quality,
          })),
        ],
        reference_price: referencePriceFor(facts, m.asset.asset_uid, now),
      }),
    );
  }
  return out;
}

/**
 * v1 radar EMA baseline update: v = 0.6*prev + 0.4*count for seen tickers,
 * decay-only for unseen; prune below 0.3. Pure — returns the new baseline map.
 */
export function updateMentionBaselines(
  baseline: Record<string, number>,
  facts: FactSet,
  cohort: CohortConfig,
): Record<string, number> {
  const alpha = famNum(cohort, 'CROWD_MENTION_SPIKE', 'ema_alpha');
  const counts = new Map<string, number>();
  for (const m of facts.mentions) counts.set(m.asset.asset_uid, m.mention_count);

  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(baseline), ...counts.keys()]);
  for (const k of keys) {
    const raw = counts.get(k) ?? 0;
    const b = baseline[k] ?? 0;
    const v = b ? b * (1 - alpha) + raw * alpha : raw;
    if (v >= 0.3) out[k] = +v.toFixed(2);
  }
  return out;
}
