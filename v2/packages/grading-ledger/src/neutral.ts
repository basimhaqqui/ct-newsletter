// Neutral / catalyst-awareness grading (spec §4.4): information value, not
// P&L. Did the flagged catalyst actually move the asset (realized vol in
// window vs trailing baseline), and how much lead time did we deliver?

import type { Bar } from './types.js';

export interface InfoValue {
  realized_vol_pct: number; // annualized close-to-close vol inside the window
  baseline_vol_pct: number; // same measure over the trailing baseline bars
  vol_ratio: number; // realized / baseline (1 = no effect)
  lead_time_s: number; // event_time - detected_time
}

/** Annualized close-to-close volatility (%) from a bar series. */
export function annualizedVolPct(bars: Bar[], barIntervalS: number): number {
  if (bars.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    if (prev > 0) rets.push(Math.log(bars[i].c / prev));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const perYear = (365 * 86400) / barIntervalS;
  return round4(Math.sqrt(variance) * Math.sqrt(perYear) * 100);
}

export function gradeInformationValue(
  windowBars: Bar[],
  baselineBars: Bar[],
  barIntervalS: number,
  eventTime: number,
  detectedTime: number,
): InfoValue {
  const realized = annualizedVolPct(windowBars, barIntervalS);
  const baseline = annualizedVolPct(baselineBars, barIntervalS);
  return {
    realized_vol_pct: realized,
    baseline_vol_pct: baseline,
    vol_ratio: baseline > 0 ? round4(realized / baseline) : realized > 0 ? Infinity : 1,
    lead_time_s: Math.max(0, eventTime - detectedTime),
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
