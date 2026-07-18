// TA_SETUP (spec §1.4): deterministic multi-timeframe TA state matches a named
// template. NO_SETUP is a deterministic abstention — never graded. The LLM
// narrates the setup; it does not pick it.

import { famNum } from '../cohort.js';
import { clamp01 } from '../scoring.js';
import type { Candidate, CohortConfig, FactSet, TaFact } from '../types.js';
import { atrLevels, baseCandidate, sourceOf } from './shared.js';

export type TaTemplate =
  | 'LONG_OVERSOLD_SUPPORT'
  | 'SHORT_OVERBOUGHT_RESISTANCE'
  | 'MOMENTUM_BREAKOUT'
  | 'MOMENTUM_BREAKDOWN'
  | 'NO_SETUP';

export function matchTemplate(t: TaFact, cohort: CohortConfig): TaTemplate {
  const osLo = famNum(cohort, 'TA_SETUP', 'os_lo');
  const obHi = famNum(cohort, 'TA_SETUP', 'ob_hi');
  const k = famNum(cohort, 'TA_SETUP', 'level_atr_mult');

  const nearSupport =
    t.support !== null && t.atr_1d > 0 && Math.abs(t.price - t.support) <= k * t.atr_1d;
  const nearResistance =
    t.resistance !== null && t.atr_1d > 0 && Math.abs(t.resistance - t.price) <= k * t.atr_1d;

  if ((t.trend_1d === 'up' || t.trend_1d === 'mixed') && t.rsi_1d <= osLo && nearSupport) {
    return 'LONG_OVERSOLD_SUPPORT';
  }
  if ((t.trend_1d === 'down' || t.trend_1d === 'mixed') && t.rsi_1d >= obHi && nearResistance) {
    return 'SHORT_OVERBOUGHT_RESISTANCE';
  }
  if (t.price > t.high_30d && t.macd_hist_1d > 0 && t.oi_rising === true) {
    return 'MOMENTUM_BREAKOUT';
  }
  if (t.price < t.low_30d && t.macd_hist_1d < 0 && t.oi_rising === false) {
    return 'MOMENTUM_BREAKDOWN';
  }
  return 'NO_SETUP';
}

const TEMPLATE_DIRECTION: Record<Exclude<TaTemplate, 'NO_SETUP'>, 'long' | 'short'> = {
  LONG_OVERSOLD_SUPPORT: 'long',
  SHORT_OVERBOUGHT_RESISTANCE: 'short',
  MOMENTUM_BREAKOUT: 'long',
  MOMENTUM_BREAKDOWN: 'short',
};

export function detectTaSetup(
  facts: FactSet,
  cohort: CohortConfig,
  _now: number,
): Candidate[] {
  const targetMult = famNum(cohort, 'TA_SETUP', 'target_atr_mult');
  const invMult = famNum(cohort, 'TA_SETUP', 'invalidation_atr_mult');

  const out: Candidate[] = [];
  for (const t of facts.ta) {
    const template = matchTemplate(t, cohort);
    const evidence = [
      {
        kind: 'observation' as const,
        source: sourceOf(t.evidence_ref),
        ref: t.evidence_ref,
        event_time: t.event_time,
        observed_time: t.observed_time,
        quality: t.quality,
      },
    ];

    if (template === 'NO_SETUP') {
      // deterministic abstention (§1.4, §3.5-1) — recorded, never graded
      out.push(
        baseCandidate({
          family_id: 'TA_SETUP',
          asset: t.asset,
          direction: 'neutral',
          event_time: t.event_time,
          observed_time: t.observed_time,
          trigger: {
            rule: 'no template matched',
            inputs: { template: 'NO_SETUP', rsi_1d: t.rsi_1d, trend_1d: t.trend_1d },
          },
          severity: 0,
          evidence,
          abstain_reason: 'NO_SETUP',
        }),
      );
      continue;
    }

    const direction = TEMPLATE_DIRECTION[template];
    const { target, invalidation } = atrLevels(t.price, t.atr_1d, direction, targetMult, invMult);
    const risk = Math.abs(t.price - invalidation);
    const rMultiple = risk > 0 ? Math.abs(target - t.price) / risk : 0;
    // §3.1 TA severity: r-multiple + RSI stretch confluence
    const rsiStretch =
      direction === 'long'
        ? clamp01((famNum(cohort, 'TA_SETUP', 'os_lo') - t.rsi_1d + 10) / 30)
        : clamp01((t.rsi_1d - famNum(cohort, 'TA_SETUP', 'ob_hi') + 10) / 30);
    const severity = clamp01(0.5 * clamp01(rMultiple / 3) + 0.5 * rsiStretch);

    out.push(
      baseCandidate({
        family_id: 'TA_SETUP',
        asset: t.asset,
        direction,
        event_time: t.event_time,
        observed_time: t.observed_time,
        trigger: {
          rule: `template=${template}`,
          inputs: {
            template,
            rsi_1d: t.rsi_1d,
            trend_1d: t.trend_1d,
            atr_1d: t.atr_1d,
            macd_hist_1d: t.macd_hist_1d,
          },
        },
        severity,
        evidence,
        reference_price: t.price,
        atr_ref: t.atr_1d,
        target,
        invalidation,
        trigger_bucket: template,
      }),
    );
  }
  return out;
}
