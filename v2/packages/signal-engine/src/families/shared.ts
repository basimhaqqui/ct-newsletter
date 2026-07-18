// Shared helpers for family detectors. Detectors are pure:
// (facts, cohort, state, now) -> Candidate[]

import { latestObservationPrice } from '../abstain.js';
import type {
  AssetRef,
  Candidate,
  EvidenceRef,
  FactSet,
  ObservationFact,
  PositioningFact,
} from '../types.js';

export function positioningEvidence(p: PositioningFact): EvidenceRef {
  return {
    kind: p.event_type === 'insider_form4' || p.event_type === 'congressional_disclosure'
      ? 'filing'
      : 'positioning_event',
    source: sourceOf(p.evidence_ref),
    ref: p.evidence_ref,
    event_time: p.event_time,
    observed_time: p.observed_time,
    quality: p.quality,
  };
}

export function observationEvidence(o: ObservationFact): EvidenceRef {
  return {
    kind: 'observation',
    source: sourceOf(o.evidence_ref),
    ref: o.evidence_ref,
    event_time: o.event_time,
    observed_time: o.observed_time,
    quality: o.quality,
  };
}

/** evidence refs are "source:...", e.g. "hyperliquid:clearinghouseState:0xabc:HYPE@ts" */
export function sourceOf(ref: string): string {
  const idx = ref.indexOf(':');
  return idx > 0 ? ref.slice(0, idx) : ref;
}

export function referencePriceFor(
  facts: FactSet,
  assetUid: string,
  now: number,
): number | null {
  return latestObservationPrice(facts, assetUid, now);
}

/** Latest observation fact (not just price) for an asset. */
export function latestObservation(
  facts: FactSet,
  assetUid: string,
): ObservationFact | null {
  let best: ObservationFact | null = null;
  for (const o of facts.observations) {
    if (o.asset.asset_uid !== assetUid) continue;
    if (best === null || o.observed_time > best.observed_time) best = o;
  }
  return best;
}

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = out.get(k);
    if (arr) arr.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function maxTime(facts: { event_time: number; observed_time: number }[]): {
  event_time: number;
  observed_time: number;
} {
  let event_time = 0;
  let observed_time = 0;
  for (const f of facts) {
    if (f.event_time > event_time) event_time = f.event_time;
    if (f.observed_time > observed_time) observed_time = f.observed_time;
  }
  return { event_time, observed_time };
}

/** ATR-derived target/invalidation geometry for a directional candidate. */
export function atrLevels(
  ref: number,
  atr: number,
  direction: 'long' | 'short',
  targetMult: number,
  invalidationMult: number,
): { target: number; invalidation: number } {
  if (direction === 'long') {
    return { target: ref + targetMult * atr, invalidation: ref - invalidationMult * atr };
  }
  return { target: ref - targetMult * atr, invalidation: ref + invalidationMult * atr };
}

export function baseCandidate(
  partial: Omit<Candidate, 'reference_price' | 'atr_ref' | 'target' | 'invalidation' | 'abstain_reason'> &
    Partial<Pick<Candidate, 'reference_price' | 'atr_ref' | 'target' | 'invalidation' | 'abstain_reason'>>,
): Candidate {
  return {
    reference_price: null,
    atr_ref: null,
    target: null,
    invalidation: null,
    abstain_reason: null,
    ...partial,
  };
}

export function assetKey(a: AssetRef): string {
  return a.asset_uid;
}
