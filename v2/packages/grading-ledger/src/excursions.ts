// MFE/MAE excursions (spec §4.2), sign-adjusted for direction, over in-window
// bars only. R units use the distance to invalidation as the risk unit.

import type { Bar, Excursions } from './types.js';

export function computeExcursions(
  bars: Bar[],
  referencePrice: number,
  direction: 'long' | 'short',
  invalidation: number | null,
): Excursions {
  if (!(referencePrice > 0)) throw new Error('excursions: reference price must be > 0');
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const b of bars) {
    if (b.h > maxHigh) maxHigh = b.h;
    if (b.l < minLow) minLow = b.l;
  }
  if (bars.length === 0) {
    maxHigh = referencePrice;
    minLow = referencePrice;
  }

  // favorable = in the signal's direction; adverse = against it. Floor at 0:
  // "never went our way" is MFE 0, not negative.
  const favorable =
    direction === 'long' ? Math.max(0, maxHigh - referencePrice) : Math.max(0, referencePrice - minLow);
  const adverse =
    direction === 'long' ? Math.max(0, referencePrice - minLow) : Math.max(0, maxHigh - referencePrice);

  const risk = invalidation !== null ? Math.abs(referencePrice - invalidation) : null;
  const toR = (x: number): number | null => (risk !== null && risk > 0 ? round4(x / risk) : null);

  return {
    mfe: { abs: round8(favorable), pct: round4((favorable / referencePrice) * 100), r: toR(favorable) },
    mae: { abs: round8(adverse), pct: round4((adverse / referencePrice) * 100), r: toR(adverse) },
  };
}

export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}
