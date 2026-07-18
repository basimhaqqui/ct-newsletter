// Abstention rules (spec §3.5). Every rule is explicit and logged — silent
// "no data" is forbidden. Abstentions are first-class records, never alerted,
// never graded as directional calls.

import { famNum } from './cohort.js';
import type { Candidate, CohortConfig, FactSet, UserContext } from './types.js';

export type AbstainReason =
  | 'NO_SETUP' // §3.5-1: TA template matched nothing
  | 'ABSTAIN_SOURCE' // §3.5-2: all evidence stale / source degraded past SLA
  | 'ABSTAIN_IRRELEVANT' // §3.5-3: relevance 0 and severity below extreme floor
  | 'ABSTAIN_NO_REFERENCE' // §3.5-4: reference price unavailable / cross-check failed
  | 'ABSTAIN_LIQUIDITY' // §3.5-5: OI/volume below family floor
  | 'ABSTAIN_DIRECTION' // §3.5-6: direction undeterminable
  | 'ABSTAIN_LATENCY'; // §5.2: source latency exceeds family max_useful_latency

const REFERENCE_TOLERANCE_PCT = 0.5;

export interface AbstainCheck {
  reason: AbstainReason | null;
}

/**
 * Evaluate the ordered abstention rules for a candidate. Family-internal
 * abstentions (NO_SETUP, ABSTAIN_DIRECTION) arrive via candidate.abstain_reason.
 */
export function shouldAbstain(
  c: Candidate,
  facts: FactSet,
  cohort: CohortConfig,
  user: UserContext,
  relevance: number,
  detectedTime: number,
): AbstainReason | null {
  // 1/6. family-raised deterministic abstention
  if (c.abstain_reason !== null) return c.abstain_reason as AbstainReason;

  // 2. evidence quality: all stale, or every cited source degraded
  if (c.evidence.length > 0) {
    const allStale = c.evidence.every((e) => e.quality === 'stale');
    const allBadHealth = c.evidence.every(
      (e) => (facts.source_health[e.source] ?? 'ok') !== 'ok',
    );
    if (allStale || allBadHealth) return 'ABSTAIN_SOURCE';
  }

  // §5.2 latency: no tradeable edge left
  const latency = c.observed_time - c.event_time;
  const maxLatency = famNum(cohort, c.family_id, 'max_useful_latency_s');
  if (latency > maxLatency) return 'ABSTAIN_LATENCY';

  // 3. relevance floor
  if (relevance === 0 && c.severity < cohort.extreme_severity_floor) {
    return 'ABSTAIN_IRRELEVANT';
  }

  // 4. reference price cross-check (directional signals only)
  if (c.direction !== 'neutral') {
    if (c.reference_price === null || !(c.reference_price > 0)) {
      return 'ABSTAIN_NO_REFERENCE';
    }
    const obs = latestObservationPrice(facts, c.asset.asset_uid, detectedTime);
    if (obs === null) return 'ABSTAIN_NO_REFERENCE';
    const devPct = Math.abs((c.reference_price - obs) / obs) * 100;
    if (devPct > REFERENCE_TOLERANCE_PCT) return 'ABSTAIN_NO_REFERENCE';
  }

  // 5. liquidity floor (families with an OI floor param)
  const oiFloor = optionalFamNum(cohort, c.family_id, 'oi_floor_usd');
  if (oiFloor !== null) {
    const oi = latestOiUsd(facts, c.asset.asset_uid);
    if (oi === null || oi < oiFloor) return 'ABSTAIN_LIQUIDITY';
  }

  return null;
}

function optionalFamNum(cohort: CohortConfig, family: Candidate['family_id'], key: string): number | null {
  const v = cohort.families[family]?.[key];
  return typeof v === 'number' ? v : null;
}

export function latestObservationPrice(
  facts: FactSet,
  assetUid: string,
  notAfter: number,
): number | null {
  let best: { t: number; price: number } | null = null;
  for (const o of facts.observations) {
    if (o.asset.asset_uid !== assetUid) continue;
    if (o.observed_time > notAfter) continue; // no future-dated reference
    if (best === null || o.observed_time > best.t) best = { t: o.observed_time, price: o.price };
  }
  return best?.price ?? null;
}

function latestOiUsd(facts: FactSet, assetUid: string): number | null {
  let best: { t: number; oi: number | null } | null = null;
  for (const o of facts.observations) {
    if (o.asset.asset_uid !== assetUid) continue;
    if (best === null || o.observed_time > best.t) best = { t: o.observed_time, oi: o.open_interest_usd };
  }
  return best?.oi ?? null;
}
