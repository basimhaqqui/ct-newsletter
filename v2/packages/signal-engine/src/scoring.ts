// Deterministic scoring (spec §3). All pure functions in [0,1].
// Scores drive alert tiering ONLY — the grader never reads them.

import type {
  AlertTier,
  Candidate,
  CohortConfig,
  EngineState,
  UserContext,
} from './types.js';

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Severity is computed inside each family (§3.1, family-specific) and arrives
 * on the candidate. This helper is the shared log-scaled notional normalizer
 * families use: log-scale notional vs a per-family reference notional.
 */
export function notionalSeverity(aggregateUsd: number, referenceUsd: number): number {
  if (aggregateUsd <= 0 || referenceUsd <= 0) return 0;
  // log-scaled: 0 at 1% of reference, 1 at reference and beyond
  const ratio = aggregateUsd / referenceUsd;
  return clamp01((Math.log10(ratio) + 2) / 2);
}

/**
 * Novelty (§3.2): 1 for a first-seen condition, decaying toward 0 while the
 * same condition persists across cycles. EMA of prior fires per family+asset+direction.
 */
export function noveltyScore(state: EngineState, key: string): number {
  const priorFires = state.novelty[key] ?? 0;
  return clamp01(1 / (1 + priorFires));
}

/** Update the novelty EMA after a cycle (pure — returns new map). */
export function updateNovelty(
  novelty: Record<string, number>,
  firedKeys: string[],
  allKeys: string[],
  decay: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const fired = new Set(firedKeys);
  const seen = new Set(allKeys);
  // decay every tracked key; drop ones that vanished and decayed to ~0
  for (const [k, v] of Object.entries(novelty)) {
    const decayed = seen.has(k) ? v : v * decay;
    if (decayed > 0.05) out[k] = decayed;
  }
  for (const k of fired) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Personal relevance (§3.3): deterministic membership/overlap. */
export function personalRelevance(assetUid: string, user: UserContext): number {
  if (user.tracked_asset_uids.includes(assetUid)) return 1.0;
  if (user.cluster_asset_uids.includes(assetUid)) return 0.6;
  if (user.covered_asset_uids.includes(assetUid)) return 0.3;
  return 0.0;
}

/** priority = w_sev*severity + w_nov*novelty + w_rel*relevance (§3.4). */
export function priorityScore(
  severity: number,
  novelty: number,
  relevance: number,
  cohort: CohortConfig,
): number {
  const { w_sev, w_nov, w_rel } = cohort.scoring_weights;
  return clamp01(w_sev * severity + w_nov * novelty + w_rel * relevance);
}

export function alertTier(priority: number, cohort: CohortConfig): AlertTier {
  if (priority >= cohort.alert_tiers.tier_hi) return 'P0';
  if (priority >= cohort.alert_tiers.tier_mid) return 'P1';
  return 'P2';
}

export function noveltyKey(c: Candidate): string {
  return `${c.family_id}|${c.asset.asset_uid}|${c.direction}`;
}
