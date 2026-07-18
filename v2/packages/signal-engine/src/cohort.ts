// Cohort manifest loading + validation + stable hashing (spec §5.4).
// Pure: takes a parsed JSON object, never reads disk.

import type { CohortConfig, FamilyId } from './types.js';

const REQUIRED_FAMILIES: FamilyId[] = [
  'POS_WHALE_CONSENSUS',
  'POS_WHALE_FLIP',
  'POS_SMARTMONEY_SHIFT',
  'POS_INSIDER_CLUSTER',
  'POS_CONGRESS_DISCLOSURE',
  'CROWD_DIVERGENCE',
  'CROWD_MENTION_SPIKE',
  'CROWD_FUNDING_EXTREME',
  'CATALYST_UPCOMING',
  'CATALYST_SURPRISE',
  'TA_SETUP',
];

export class CohortValidationError extends Error {
  constructor(message: string) {
    super(`Invalid cohort manifest: ${message}`);
    this.name = 'CohortValidationError';
  }
}

export function validateCohort(raw: unknown): CohortConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new CohortValidationError('not an object');
  }
  const c = raw as Partial<CohortConfig>;
  if (typeof c.version !== 'string' || !/^cohort\/\d{4}\.\d{2}\.\d+$/.test(c.version)) {
    throw new CohortValidationError(`bad version: ${String(c.version)}`);
  }
  if (typeof c.schema_version !== 'string') throw new CohortValidationError('missing schema_version');
  if (typeof c.families !== 'object' || c.families === null) {
    throw new CohortValidationError('missing families');
  }
  for (const fam of REQUIRED_FAMILIES) {
    if (!(fam in c.families)) throw new CohortValidationError(`missing family params: ${fam}`);
    if (!(fam in (c.family_horizons ?? {}))) {
      throw new CohortValidationError(`missing family horizon: ${fam}`);
    }
  }
  const w = c.scoring_weights;
  if (!w || typeof w.w_sev !== 'number' || typeof w.w_nov !== 'number' || typeof w.w_rel !== 'number') {
    throw new CohortValidationError('missing scoring_weights');
  }
  const sum = w.w_sev + w.w_nov + w.w_rel;
  if (Math.abs(sum - 1) > 1e-9) throw new CohortValidationError(`scoring weights must sum to 1, got ${sum}`);
  const tiers = c.alert_tiers;
  if (!tiers || typeof tiers.tier_hi !== 'number' || typeof tiers.tier_mid !== 'number') {
    throw new CohortValidationError('missing alert_tiers');
  }
  if (!(tiers.tier_mid < tiers.tier_hi)) throw new CohortValidationError('tier_mid must be < tier_hi');
  if (typeof c.extreme_severity_floor !== 'number') {
    throw new CohortValidationError('missing extreme_severity_floor');
  }
  if (!c.horizons || typeof c.horizons !== 'object') throw new CohortValidationError('missing horizons');
  for (const fam of REQUIRED_FAMILIES) {
    const h = (c.family_horizons as Record<string, string>)[fam];
    if (!(h in c.horizons)) throw new CohortValidationError(`family ${fam} maps to unknown horizon ${h}`);
  }
  if (!c.haircut_r || typeof c.haircut_r.crypto !== 'number' || typeof c.haircut_r.stock !== 'number') {
    throw new CohortValidationError('missing haircut_r');
  }
  return c as CohortConfig;
}

/** Deterministic FNV-1a hash over canonically-serialized manifest. */
export function cohortHash(cohort: CohortConfig): string {
  const str = canonicalStringify(cohort);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

/** Typed accessor for a family's numeric param. Throws if absent — params are frozen, not defaulted. */
export function famNum(cohort: CohortConfig, family: FamilyId, key: string): number {
  const v = cohort.families[family]?.[key];
  if (typeof v !== 'number') {
    throw new CohortValidationError(`family ${family} missing numeric param ${key}`);
  }
  return v;
}

export function famObj<T>(cohort: CohortConfig, family: FamilyId, key: string): T {
  const v = cohort.families[family]?.[key];
  if (v === undefined) throw new CohortValidationError(`family ${family} missing param ${key}`);
  return v as T;
}
