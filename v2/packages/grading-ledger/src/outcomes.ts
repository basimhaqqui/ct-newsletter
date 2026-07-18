// Target-vs-invalidation first-touch outcome (spec §4.3). Path-dependent,
// never guesses bar-internal ordering: if both levels fall inside the same
// bar, the caller may retry with finer bars; if still ambiguous → AMBIGUOUS
// (excluded from win-rate, MFE/MAE kept).

import type { Bar, Outcome } from './types.js';

export interface OutcomeResult {
  outcome: Outcome;
  touch_time: number | null;
  end_price: number | null;
  end_r: number | null;
  realized_r: number | null;
  ambiguous_bar_t: number | null;
}

export function firstTouchOutcome(
  bars: Bar[],
  referencePrice: number,
  direction: 'long' | 'short',
  target: number,
  invalidation: number,
  targetRMultiple: number,
  haircutR: number,
): OutcomeResult {
  const risk = Math.abs(referencePrice - invalidation);
  if (!(risk > 0)) {
    return { outcome: 'NOT_GRADED', touch_time: null, end_price: null, end_r: null, realized_r: null, ambiguous_bar_t: null };
  }

  const touchesTarget = (b: Bar): boolean =>
    direction === 'long' ? b.h >= target : b.l <= target;
  const touchesInvalidation = (b: Bar): boolean =>
    direction === 'long' ? b.l <= invalidation : b.h >= invalidation;

  for (const b of bars) {
    const tgt = touchesTarget(b);
    const inv = touchesInvalidation(b);
    if (tgt && inv) {
      // both inside one bar — cannot order at this granularity (§4.3)
      return {
        outcome: 'AMBIGUOUS',
        touch_time: b.t,
        end_price: null,
        end_r: null,
        realized_r: null,
        ambiguous_bar_t: b.t,
      };
    }
    if (tgt) {
      return {
        outcome: 'TARGET_HIT',
        touch_time: b.t,
        end_price: target,
        end_r: null,
        realized_r: round4(targetRMultiple - haircutR),
        ambiguous_bar_t: null,
      };
    }
    if (inv) {
      return {
        outcome: 'INVALIDATED',
        touch_time: b.t,
        end_price: invalidation,
        end_r: null,
        realized_r: round4(-1 - haircutR),
        ambiguous_bar_t: null,
      };
    }
  }

  // neither touched: timeout at horizon end
  if (bars.length === 0) {
    return { outcome: 'NOT_GRADED', touch_time: null, end_price: null, end_r: null, realized_r: null, ambiguous_bar_t: null };
  }
  const endPrice = bars[bars.length - 1].c;
  const signedMove = direction === 'long' ? endPrice - referencePrice : referencePrice - endPrice;
  const endR = round4(signedMove / risk - haircutR);
  return {
    outcome: endR > 0 ? 'TIMEOUT_WIN' : 'TIMEOUT_LOSS',
    touch_time: null,
    end_price: endPrice,
    end_r: endR,
    realized_r: endR,
    ambiguous_bar_t: null,
  };
}

/**
 * Resolve an AMBIGUOUS bar with finer bars covering just that bar's span
 * (spec §4.3 "drop to finer bars"). Returns null if still ambiguous.
 */
export function resolveAmbiguousWithFinerBars(
  finerBars: Bar[],
  referencePrice: number,
  direction: 'long' | 'short',
  target: number,
  invalidation: number,
  targetRMultiple: number,
  haircutR: number,
): OutcomeResult | null {
  const result = firstTouchOutcome(
    finerBars,
    referencePrice,
    direction,
    target,
    invalidation,
    targetRMultiple,
    haircutR,
  );
  if (result.outcome === 'AMBIGUOUS' || result.outcome === 'NOT_GRADED') return null;
  // finer bars only decide the touch ordering — timeouts are impossible inside
  // the ambiguous bar's span (a touch is guaranteed); treat as unresolved
  if (result.outcome === 'TIMEOUT_WIN' || result.outcome === 'TIMEOUT_LOSS') return null;
  return result;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
