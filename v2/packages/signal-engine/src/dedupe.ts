// Idempotency keys, ULID-style signal ids, and cooldown checks (spec §2.2, §2.5).
// Deterministic: signal_id derives from the idempotency key + detected_time,
// never from randomness.

import type { Candidate, EngineState } from './types.js';

/** FNV-1a 64-bit-ish (two 32-bit lanes) — stable across runs/platforms. */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000197);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * idempotency key = hash(family, asset_uid, direction, trigger_bucket, cohort_version).
 * Re-detecting the same condition in the same bucket yields the same key (spec §2.2).
 */
export function idempotencyKey(c: Candidate, cohortVersion: string): string {
  return stableHash(
    [c.family_id, c.asset.asset_uid, c.direction, c.trigger_bucket ?? '', cohortVersion].join('|'),
  );
}

/**
 * Deterministic signal id: time-prefixed (sortable like a ULID) + idempotency hash.
 * Same condition, same bucket → same id. No duplicate rows, no duplicate alerts.
 */
export function signalId(idemKey: string, detectedTime: number): string {
  return `sig_${detectedTime.toString(36).padStart(8, '0')}${idemKey}`;
}

export function cooldownKey(c: Candidate): string {
  return `${c.family_id}|${c.asset.asset_uid}|${c.direction}`;
}

/** True if this family+asset+direction fired within cooldown_s of `now`. */
export function inCooldown(
  state: EngineState,
  c: Candidate,
  now: number,
  cooldownS: number,
): boolean {
  const last = state.cooldowns[cooldownKey(c)];
  return last !== undefined && now - last < cooldownS;
}

/** Prune expired cooldown entries; returns a new map (pure). */
export function pruneCooldowns(
  cooldowns: Record<string, number>,
  now: number,
  maxAgeS: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, ts] of Object.entries(cooldowns)) {
    if (now - ts < maxAgeS) out[k] = ts;
  }
  return out;
}
