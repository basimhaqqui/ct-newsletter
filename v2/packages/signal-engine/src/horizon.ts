// Horizon resolution (spec §5.1). Crypto horizons are wall-clock; stock
// horizons are trading days resolved against an injected market calendar.
// Catalyst windows run event_time -> event_time + settle.

import type { CohortConfig, FamilyId } from './types.js';

/**
 * Market calendar: injected, deterministic. `isTradingDay` receives a UTC
 * day-stamp (unix seconds at 00:00 UTC). Default: Mon–Fri (no holiday feed).
 */
export interface MarketCalendar {
  isTradingDay(dayStartUnix: number): boolean;
}

export const WEEKDAY_CALENDAR: MarketCalendar = {
  isTradingDay(dayStartUnix: number): boolean {
    const dow = new Date(dayStartUnix * 1000).getUTCDay();
    return dow >= 1 && dow <= 5;
  },
};

const DAY_S = 86400;

/** Add N trading days to a unix timestamp using the calendar. */
export function addTradingDays(
  startUnix: number,
  tradingDays: number,
  calendar: MarketCalendar,
): number {
  let t = startUnix;
  let remaining = tradingDays;
  // walk forward day by day; a "trading day" consumed only when the day counts
  while (remaining > 0) {
    t += DAY_S;
    const dayStart = t - (t % DAY_S);
    if (calendar.isTradingDay(dayStart)) remaining -= 1;
  }
  return t;
}

export interface ResolvedHorizon {
  class: string;
  seconds: number;
}

/**
 * Resolve a family's horizon into concrete seconds from detected_time.
 * For catalyst windows, pass the catalyst's event/settle context.
 */
export function resolveHorizon(
  family: FamilyId,
  cohort: CohortConfig,
  detectedTime: number,
  calendar: MarketCalendar = WEEKDAY_CALENDAR,
  catalystEventTime?: number,
): ResolvedHorizon {
  const cls = cohort.family_horizons[family];
  const spec = cohort.horizons[cls];
  if (!spec) throw new Error(`no horizon spec for class ${cls}`);
  switch (spec.kind) {
    case 'wallclock':
      return { class: cls, seconds: spec.seconds! };
    case 'trading_days': {
      const end = addTradingDays(detectedTime, spec.days!, calendar);
      return { class: cls, seconds: end - detectedTime };
    }
    case 'event_settle': {
      const evt = catalystEventTime ?? detectedTime;
      const end = Math.max(evt, detectedTime) + spec.settle_s!;
      return { class: cls, seconds: Math.max(0, end - detectedTime) };
    }
  }
}
