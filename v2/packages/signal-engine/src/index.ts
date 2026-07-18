// Signal engine orchestrator (spec §2, §3): ingest facts → route to families →
// levels → score → abstain → dedupe/cooldown → emit signals + abstentions +
// updated state. PURE: same facts + state + cohort + clock = byte-identical output.

import { shouldAbstain } from './abstain.js';
import { validateCohort } from './cohort.js';
import { famNum } from './cohort.js';
import {
  cooldownKey,
  idempotencyKey,
  inCooldown,
  pruneCooldowns,
  signalId,
} from './dedupe.js';
import { detectCatalystSurprise } from './families/catalyst-surprise.js';
import { detectCatalystUpcoming } from './families/catalyst-upcoming.js';
import { detectCrowdDivergence } from './families/crowd-divergence.js';
import { detectFundingExtreme } from './families/crowd-funding-extreme.js';
import {
  detectMentionSpike,
  updateMentionBaselines,
} from './families/crowd-mention-spike.js';
import { detectCongressDisclosure } from './families/pos-congress-disclosure.js';
import { detectInsiderCluster } from './families/pos-insider-cluster.js';
import { detectSmartmoneyShift } from './families/pos-smartmoney-shift.js';
import { detectWhaleConsensus } from './families/pos-whale-consensus.js';
import { detectWhaleFlip } from './families/pos-whale-flip.js';
import { detectTaSetup } from './families/ta-setup.js';
import { atrLevels } from './families/shared.js';
import { resolveHorizon, WEEKDAY_CALENDAR, type MarketCalendar } from './horizon.js';
import {
  alertTier,
  noveltyKey,
  noveltyScore,
  personalRelevance,
  priorityScore,
  updateNovelty,
} from './scoring.js';
import {
  FAMILY_DIMENSION,
  type Candidate,
  type CohortConfig,
  type EngineResult,
  type EngineState,
  type FactSet,
  type Signal,
  type UserContext,
} from './types.js';

export * from './types.js';
export { validateCohort, cohortHash, canonicalStringify, famNum, famObj } from './cohort.js';
export * from './dedupe.js';
export * from './scoring.js';
export * from './abstain.js';
export * from './horizon.js';
export { matchTemplate, type TaTemplate } from './families/ta-setup.js';
export { updateMentionBaselines } from './families/crowd-mention-spike.js';

const SCHEMA_VERSION = 'signal/2.0.0';
const COOLDOWN_PRUNE_AGE_S = 30 * 86400;

export interface EngineOptions {
  /** injected clock — unix seconds UTC. The engine never reads a wall clock. */
  now: number;
  cohort: CohortConfig | unknown;
  state: EngineState;
  user: UserContext;
  calendar?: MarketCalendar;
}

export function runEngine(facts: FactSet, options: EngineOptions): EngineResult {
  const cohort = validateCohort(options.cohort);
  const { now, state, user } = options;
  const calendar = options.calendar ?? WEEKDAY_CALENDAR;

  // 1. detection — every family, deterministic order
  const candidates: Candidate[] = [
    ...detectWhaleConsensus(facts, cohort, now),
    ...detectWhaleFlip(facts, cohort, now),
    ...detectSmartmoneyShift(facts, cohort, now),
    ...detectInsiderCluster(facts, cohort, now),
    ...detectCongressDisclosure(facts, cohort, now),
    ...detectCrowdDivergence(facts, cohort, now),
    ...detectMentionSpike(facts, cohort, state, now),
    ...detectFundingExtreme(facts, cohort, now),
    ...detectCatalystUpcoming(facts, cohort, now),
    ...detectCatalystSurprise(facts, cohort, now),
    ...detectTaSetup(facts, cohort, now),
  ];

  // stable ordering for byte-identical output — input fact order must not
  // leak into emitted records (determinism CI gate)
  for (const c of candidates) {
    c.evidence.sort((a, b) => (a.kind + a.ref).localeCompare(b.kind + b.ref));
  }
  candidates.sort((a, b) =>
    `${a.family_id}|${a.asset.asset_uid}|${a.direction}|${a.trigger_bucket ?? ''}`.localeCompare(
      `${b.family_id}|${b.asset.asset_uid}|${b.direction}|${b.trigger_bucket ?? ''}`,
    ),
  );

  // 2. derive levels for directional candidates that lack them (ATR template)
  const taByAsset = new Map(facts.ta.map((t) => [t.asset.asset_uid, t]));
  for (const c of candidates) {
    if (c.direction === 'neutral' || c.target !== null || c.reference_price === null) continue;
    const ta = taByAsset.get(c.asset.asset_uid);
    if (!ta || !(ta.atr_1d > 0)) continue;
    const levels = atrLevels(
      c.reference_price,
      ta.atr_1d,
      c.direction,
      famNum(cohort, 'TA_SETUP', 'target_atr_mult'),
      famNum(cohort, 'TA_SETUP', 'invalidation_atr_mult'),
    );
    c.target = levels.target;
    c.invalidation = levels.invalidation;
    c.atr_ref = ta.atr_1d;
  }

  const signals: Signal[] = [];
  const abstentions: Signal[] = [];
  let suppressed = 0;
  const firedNoveltyKeys: string[] = [];
  const seenNoveltyKeys: string[] = [];
  const newCooldowns: Record<string, number> = { ...state.cooldowns };

  for (const c of candidates) {
    seenNoveltyKeys.push(noveltyKey(c));

    const relevance = personalRelevance(c.asset.asset_uid, user);
    const abstainReason = shouldAbstain(c, facts, cohort, user, relevance, now);
    const novelty = noveltyScore(state, noveltyKey(c));
    const priority = priorityScore(c.severity, novelty, relevance, cohort);
    const cooldownS = famNum(cohort, c.family_id, 'cooldown_s');
    const idem = idempotencyKey(c, cohort.version);
    const horizon = resolveHorizon(
      c.family_id,
      cohort,
      now,
      calendar,
      c.family_id === 'CATALYST_UPCOMING'
        ? Number(c.trigger.inputs['scheduled_time'])
        : undefined,
    );

    const record: Signal = {
      signal_id: signalId(idem, now),
      idempotency_key: idem,
      schema_version: SCHEMA_VERSION,
      cohort_version: cohort.version,
      family_id: c.family_id,
      dimension: FAMILY_DIMENSION[c.family_id],
      asset_class: c.asset.asset_class,
      asset: c.asset,
      direction: c.direction,
      event_time: c.event_time,
      observed_time: c.observed_time,
      detected_time: now,
      source_latency_s: Math.max(0, c.observed_time - c.event_time),
      trigger: c.trigger,
      levels: {
        reference_price: c.reference_price ?? 0,
        target: c.direction === 'neutral' ? null : c.target,
        invalidation: c.direction === 'neutral' ? null : c.invalidation,
        atr_ref: c.atr_ref,
        target_r_multiple: rMultiple(c),
      },
      horizon: { class: horizon.class, seconds: horizon.seconds },
      scores: {
        severity: round4(c.severity),
        novelty: round4(novelty),
        personal_relevance: relevance,
        priority: round4(priority),
      },
      tier: alertTier(priority, cohort),
      evidence: c.evidence,
      abstained: abstainReason !== null,
      abstention_reason: abstainReason,
      origin: 'deterministic',
    };

    if (abstainReason !== null) {
      // abstentions are first-class, never alerted, never in cooldown state
      abstentions.push(record);
      continue;
    }

    // §2.5 dedupe (same condition, same bucket) + cooldown (family+asset+direction)
    if (inCooldown(state, c, now, cooldownS)) {
      suppressed += 1;
      continue;
    }

    signals.push(record);
    firedNoveltyKeys.push(noveltyKey(c));
    newCooldowns[cooldownKey(c)] = now;
  }

  // 3. deterministic state update
  const nextState: EngineState = {
    cooldowns: pruneCooldowns(newCooldowns, now, COOLDOWN_PRUNE_AGE_S),
    novelty: updateNovelty(state.novelty, firedNoveltyKeys, seenNoveltyKeys, cohort.novelty_decay),
    mention_baseline: updateMentionBaselines(state.mention_baseline, facts, cohort),
    active_divergences: signals
      .concat(abstentions)
      .filter((s) => s.family_id === 'CROWD_DIVERGENCE')
      .map((s) => `${s.asset.asset_uid}|${s.direction === 'long' ? 'bull' : 'bear'}`)
      .sort(),
  };

  return { signals, abstentions, suppressed, state: nextState };
}

function rMultiple(c: Candidate): number | null {
  if (c.direction === 'neutral' || c.reference_price === null || c.target === null || c.invalidation === null) {
    return null;
  }
  const risk = Math.abs(c.reference_price - c.invalidation);
  if (!(risk > 0)) return null;
  return round4(Math.abs(c.target - c.reference_price) / risk);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
