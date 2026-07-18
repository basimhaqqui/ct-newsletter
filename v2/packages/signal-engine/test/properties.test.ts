// Property tests (spec CI gates): determinism, idempotency, dedupe/cooldown,
// leakage boundary, scoring bounds, abstention completeness.

import { describe, expect, it } from 'vitest';
import {
  canonicalStringify,
  emptyState,
  runEngine,
  validateCohort,
  type EngineOptions,
} from '../src/index.js';
import {
  COHORT,
  HYPE,
  NOW,
  USER,
  divergenceScenario,
  emptyFacts,
  mention,
  observation,
  whale,
} from './fixtures.js';

function opts(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return { now: NOW, cohort: COHORT, state: emptyState(), user: USER, ...overrides };
}

describe('determinism', () => {
  it('same facts + state + cohort + clock → byte-identical output', () => {
    const a = runEngine(divergenceScenario(), opts());
    const b = runEngine(divergenceScenario(), opts());
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('is insensitive to input fact ordering', () => {
    const f1 = divergenceScenario();
    const f2 = divergenceScenario();
    f2.positioning.reverse();
    f2.observations.reverse();
    const a = runEngine(f1, opts());
    const b = runEngine(f2, opts());
    expect(canonicalStringify(a.signals)).toBe(canonicalStringify(b.signals));
  });
});

describe('idempotency & dedupe (spec §2.2, §2.5)', () => {
  it('same condition in the same bucket yields the same signal_id', () => {
    const a = runEngine(divergenceScenario(), opts());
    const b = runEngine(divergenceScenario(), opts());
    const ids = (r: typeof a) => r.signals.map((s) => s.signal_id).sort();
    expect(ids(a)).toEqual(ids(b));
    const keys = a.signals.map((s) => s.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length); // no dupes within a cycle
  });

  it('suppresses re-fires inside the cooldown window', () => {
    const first = runEngine(divergenceScenario(), opts());
    expect(first.signals.length).toBeGreaterThan(0);
    const second = runEngine(divergenceScenario(), opts({ state: first.state, now: NOW + 1800 }));
    expect(second.signals.length).toBe(0);
    expect(second.suppressed).toBeGreaterThan(0);
  });

  it('re-fires after cooldown elapses, with decayed novelty', () => {
    const first = runEngine(divergenceScenario(), opts());
    const later = NOW + 200_000; // > 24h crypto cooldowns
    const second = runEngine(divergenceScenario(), opts({ state: first.state, now: later }));
    const div1 = first.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    const div2 = second.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    expect(div2).toBeDefined();
    expect(div2!.scores.novelty).toBeLessThan(div1!.scores.novelty);
  });
});

describe('leakage boundary (spec §0, §2.4)', () => {
  it('every emitted record is origin: deterministic', () => {
    const result = runEngine(divergenceScenario(), opts());
    for (const s of [...result.signals, ...result.abstentions]) {
      expect(s.origin).toBe('deterministic');
    }
  });

  it('no graded field is future-dated (event_time <= detected_time)', () => {
    const result = runEngine(divergenceScenario(), opts());
    for (const s of result.signals) {
      expect(s.event_time).toBeLessThanOrEqual(s.detected_time);
      for (const e of s.evidence) {
        expect(e.event_time).toBeLessThanOrEqual(s.detected_time);
      }
    }
  });

  it('every fired signal cites >=1 evidence ref (spec §2.3)', () => {
    const result = runEngine(divergenceScenario(), opts());
    for (const s of result.signals) {
      expect(s.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('reference price matches the observation feed (spec §2.2)', () => {
    const facts = divergenceScenario();
    const result = runEngine(facts, opts());
    for (const s of result.signals) {
      if (s.direction === 'neutral') continue;
      expect(s.levels.reference_price).toBe(46.12);
    }
  });
});

describe('scoring bounds & tiers (spec §3)', () => {
  it('all scores live in [0,1] and priority obeys the weighted sum', () => {
    const result = runEngine(divergenceScenario(), opts());
    const { w_sev, w_nov, w_rel } = validateCohort(COHORT).scoring_weights;
    for (const s of [...result.signals, ...result.abstentions]) {
      const { severity, novelty, personal_relevance, priority } = s.scores;
      for (const v of [severity, novelty, personal_relevance, priority]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(priority).toBeCloseTo(
        w_sev * severity + w_nov * novelty + w_rel * personal_relevance,
        3,
      );
    }
  });

  it('assigns tiers by priority thresholds', () => {
    const result = runEngine(divergenceScenario(), opts());
    const cohort = validateCohort(COHORT);
    for (const s of result.signals) {
      const expected =
        s.scores.priority >= cohort.alert_tiers.tier_hi
          ? 'P0'
          : s.scores.priority >= cohort.alert_tiers.tier_mid
            ? 'P1'
            : 'P2';
      expect(s.tier).toBe(expected);
    }
  });
});

describe('abstention rules (spec §3.5)', () => {
  it('abstains on stale-only evidence (ABSTAIN_SOURCE)', () => {
    const facts = divergenceScenario();
    for (const p of facts.positioning) p.quality = 'stale';
    facts.observations[0].quality = 'stale';
    const result = runEngine(facts, opts());
    const div = result.abstentions.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    expect(div?.abstention_reason).toBe('ABSTAIN_SOURCE');
    expect(result.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE')).toBeUndefined();
  });

  it('abstains when reference price is unavailable (ABSTAIN_NO_REFERENCE)', () => {
    const facts = emptyFacts();
    facts.positioning = [
      whale(HYPE, '0xaaa', 'long'),
      whale(HYPE, '0xbbb', 'long'),
      whale(HYPE, '0xccc', 'long'),
    ];
    // no observations at all → no reference cross-check possible
    const result = runEngine(facts, opts());
    const abst = result.abstentions.find((s) => s.family_id === 'POS_WHALE_CONSENSUS');
    expect(abst?.abstention_reason).toBe('ABSTAIN_NO_REFERENCE');
  });

  it('abstains on irrelevant assets below the extreme floor (ABSTAIN_IRRELEVANT)', () => {
    const OTHER = { asset_uid: 'crypto:hl:WIF', symbol: 'WIF', venue: 'hyperliquid', asset_class: 'crypto' as const };
    const state = emptyState();
    state.mention_baseline = { [OTHER.asset_uid]: 2, 'crypto:hl:BTC': 1 };
    const facts = emptyFacts();
    facts.mentions = [mention(OTHER, 8)];
    facts.observations = [observation({ asset: OTHER, price: 2.5 })];
    const result = runEngine(facts, opts({ state }));
    const abst = result.abstentions.find((s) => s.family_id === 'CROWD_MENTION_SPIKE');
    expect(abst?.abstention_reason).toBe('ABSTAIN_IRRELEVANT');
  });

  it('never emits silently: every cycle yields signals or explicit abstentions', () => {
    const facts = divergenceScenario();
    for (const p of facts.positioning) p.quality = 'stale';
    facts.observations[0].quality = 'stale';
    const result = runEngine(facts, opts());
    expect(result.signals.length + result.abstentions.length).toBeGreaterThan(0);
  });
});

describe('cohort validation (spec §5.4)', () => {
  it('accepts the frozen manifest', () => {
    expect(() => validateCohort(COHORT)).not.toThrow();
  });

  it('rejects manifests with missing families or bad weights', () => {
    const bad1 = JSON.parse(JSON.stringify(COHORT));
    delete bad1.families.TA_SETUP;
    expect(() => validateCohort(bad1)).toThrow(/TA_SETUP/);

    const bad2 = JSON.parse(JSON.stringify(COHORT));
    bad2.scoring_weights.w_sev = 0.9;
    expect(() => validateCohort(bad2)).toThrow(/sum to 1/);
  });
});
