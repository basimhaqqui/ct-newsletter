import { describe, expect, it } from 'vitest';
import { emptyState, runEngine, type EngineOptions, type FactSet } from '../src/index.js';
import {
  AAPL,
  BTC,
  COHORT,
  HYPE,
  NOW,
  USER,
  catalyst,
  congress,
  divergenceScenario,
  emptyFacts,
  form4,
  leaderboardAgg,
  mention,
  observation,
  taFact,
  whale,
} from './fixtures.js';

function opts(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return { now: NOW, cohort: COHORT, state: emptyState(), user: USER, ...overrides };
}

describe('CROWD_DIVERGENCE (spec §2.1 worked example)', () => {
  it('fires long when whales long and funding negative', () => {
    const result = runEngine(divergenceScenario(), opts());
    const div = result.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    expect(div).toBeDefined();
    expect(div!.direction).toBe('long');
    expect(div!.asset.asset_uid).toBe(HYPE.asset_uid);
    expect(div!.dimension).toBe('crowd');
    expect(div!.origin).toBe('deterministic');
    expect(div!.levels.reference_price).toBe(46.12);
    expect(div!.levels.target).not.toBeNull(); // ATR geometry from TA fact
    expect(div!.levels.invalidation).not.toBeNull();
    expect(div!.horizon.class).toBe('crypto_swing');
    expect(div!.horizon.seconds).toBe(259_200);
    expect(div!.evidence.length).toBeGreaterThanOrEqual(2); // whales + observation
    expect(div!.trigger.inputs['whales_long']).toBe(4);
  });

  it('does not fire when funding is neutral', () => {
    const facts = divergenceScenario();
    facts.observations[0].funding_annual_pct = 5;
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE')).toBeUndefined();
  });

  it('fires short when whales short into extreme positive funding', () => {
    const facts = emptyFacts();
    facts.positioning = [
      whale(HYPE, '0xaaa', 'short'),
      whale(HYPE, '0xbbb', 'short'),
      whale(HYPE, '0xccc', 'short'),
    ];
    facts.observations = [observation({ asset: HYPE, funding_annual_pct: 40 })];
    const result = runEngine(facts, opts());
    const div = result.signals.find((s) => s.family_id === 'CROWD_DIVERGENCE');
    expect(div?.direction).toBe('short');
  });
});

describe('POS_WHALE_CONSENSUS', () => {
  it('requires consensus_min distinct actors', () => {
    const facts = emptyFacts();
    facts.positioning = [
      whale(HYPE, '0xaaa', 'long'),
      whale(HYPE, '0xaaa', 'long'), // same actor twice
      whale(HYPE, '0xbbb', 'long'),
    ];
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'POS_WHALE_CONSENSUS')).toBeUndefined();
  });

  it('ignores positions below the notional floor (spec §1.3)', () => {
    const facts = emptyFacts();
    facts.positioning = [
      whale(HYPE, '0xaaa', 'long', 10_000),
      whale(HYPE, '0xbbb', 'long', 10_000),
      whale(HYPE, '0xccc', 'long', 10_000),
    ];
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'POS_WHALE_CONSENSUS')).toBeUndefined();
  });

  it('records ABSTAIN_DIRECTION on an even split (spec §3.5-6)', () => {
    const facts = emptyFacts();
    facts.positioning = [
      whale(HYPE, '0xaaa', 'long'),
      whale(HYPE, '0xbbb', 'long'),
      whale(HYPE, '0xccc', 'short'),
      whale(HYPE, '0xddd', 'short'),
    ];
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts());
    const abst = result.abstentions.find((s) => s.family_id === 'POS_WHALE_CONSENSUS');
    expect(abst).toBeDefined();
    expect(abst!.abstention_reason).toBe('ABSTAIN_DIRECTION');
    expect(abst!.abstained).toBe(true);
  });
});

describe('POS_WHALE_FLIP', () => {
  it('fires when net side flips with both snapshots above floor', () => {
    const facts = emptyFacts();
    facts.prev_whale_positions = [whale(HYPE, '0xaaa', 'short', 400_000)];
    facts.positioning = [whale(HYPE, '0xaaa', 'long', 500_000)];
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts());
    const flip = result.signals.find((s) => s.family_id === 'POS_WHALE_FLIP');
    expect(flip).toBeDefined();
    expect(flip!.direction).toBe('long');
  });

  it('does not fire without a prior snapshot', () => {
    const facts = emptyFacts();
    facts.positioning = [whale(HYPE, '0xaaa', 'long', 500_000)];
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'POS_WHALE_FLIP')).toBeUndefined();
  });
});

describe('POS_SMARTMONEY_SHIFT', () => {
  it('flags a net-notional flip', () => {
    const facts = emptyFacts();
    facts.prev_whale_positions = [leaderboardAgg(BTC, 0.55, 12, 5_000_000)];
    facts.positioning = [leaderboardAgg(BTC, 0.35, 12, -4_000_000)];
    facts.observations = [observation({ asset: BTC, price: 64_000 })];
    const result = runEngine(facts, opts());
    const shift = result.signals.find((s) => s.family_id === 'POS_SMARTMONEY_SHIFT');
    expect(shift).toBeDefined();
    expect(shift!.direction).toBe('short');
    expect(shift!.trigger.inputs['kind']).toBe('flip');
    expect(shift!.horizon.class).toBe('crypto_position');
  });

  it('ignores books with too few traders', () => {
    const facts = emptyFacts();
    facts.prev_whale_positions = [leaderboardAgg(BTC, 0.5, 3, 5_000_000)];
    facts.positioning = [leaderboardAgg(BTC, 0.9, 3, 9_000_000)];
    facts.observations = [observation({ asset: BTC, price: 64_000 })];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'POS_SMARTMONEY_SHIFT')).toBeUndefined();
  });
});

describe('POS_INSIDER_CLUSTER', () => {
  it('fires on >=3 distinct net buyers over the aggregate floor', () => {
    const facts = emptyFacts();
    facts.positioning = [
      form4(AAPL, 'cik1', 'buy', 300_000),
      form4(AAPL, 'cik2', 'buy', 200_000),
      form4(AAPL, 'cik3', 'buy', 150_000),
    ];
    facts.observations = [observation({ asset: AAPL, price: 230 })];
    const result = runEngine(facts, opts());
    const sig = result.signals.find((s) => s.family_id === 'POS_INSIDER_CLUSTER');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
    expect(sig!.asset_class).toBe('stock');
    expect(sig!.horizon.class).toBe('stock_swing');
    // 5 trading days resolved via calendar — seconds span >= 5 calendar days
    expect(sig!.horizon.seconds).toBeGreaterThanOrEqual(5 * 86_400);
  });

  it('nets out sellers per insider', () => {
    const facts = emptyFacts();
    facts.positioning = [
      form4(AAPL, 'cik1', 'buy', 300_000),
      form4(AAPL, 'cik1', 'sell', 400_000), // net seller
      form4(AAPL, 'cik2', 'buy', 200_000),
      form4(AAPL, 'cik3', 'buy', 150_000),
    ];
    facts.observations = [observation({ asset: AAPL, price: 230 })];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'POS_INSIDER_CLUSTER')).toBeUndefined();
  });
});

describe('POS_CONGRESS_DISCLOSURE', () => {
  it('fires on a large single trade', () => {
    const facts = emptyFacts();
    facts.positioning = [congress(AAPL, 'member1', 'buy', 250_000)];
    facts.observations = [observation({ asset: AAPL, price: 230 })];
    const result = runEngine(facts, opts());
    const sig = result.signals.find((s) => s.family_id === 'POS_CONGRESS_DISCLOSURE');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
  });

  it('auto-abstains when the disclosure is too stale to trade (spec §5.2)', () => {
    const facts = emptyFacts();
    facts.positioning = [
      congress(AAPL, 'member1', 'buy', 250_000, {
        event_time: NOW - 44 * 86_400, // 44-day-old trade
        observed_time: NOW - 3600,
      }),
    ];
    facts.observations = [observation({ asset: AAPL, price: 230 })];
    const result = runEngine(facts, opts());
    const abst = result.abstentions.find((s) => s.family_id === 'POS_CONGRESS_DISCLOSURE');
    expect(abst).toBeDefined();
    expect(abst!.abstention_reason).toBe('ABSTAIN_LATENCY');
  });
});

describe('CROWD_MENTION_SPIKE', () => {
  it('learns the baseline silently on first run (v1 radar semantics)', () => {
    const facts = emptyFacts();
    facts.mentions = [mention(HYPE, 10)];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'CROWD_MENTION_SPIKE')).toBeUndefined();
    expect(result.state.mention_baseline[HYPE.asset_uid]).toBe(10);
  });

  it('fires when mentions spike over the EMA baseline', () => {
    const state = emptyState();
    state.mention_baseline = { [HYPE.asset_uid]: 3 };
    const facts = emptyFacts();
    facts.mentions = [mention(HYPE, 12)]; // 4x baseline, >= min_mentions
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts({ state }));
    const sig = result.signals.find((s) => s.family_id === 'CROWD_MENTION_SPIKE');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('neutral'); // attention, not direction
    // EMA update: 3*0.6 + 12*0.4 = 6.6
    expect(result.state.mention_baseline[HYPE.asset_uid]).toBeCloseTo(6.6, 2);
  });

  it('stays quiet below the spike ratio', () => {
    const state = emptyState();
    state.mention_baseline = { [HYPE.asset_uid]: 6 };
    const facts = emptyFacts();
    facts.mentions = [mention(HYPE, 8)]; // < 2.5x baseline
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts({ state }));
    expect(result.signals.find((s) => s.family_id === 'CROWD_MENTION_SPIKE')).toBeUndefined();
  });
});

describe('CROWD_FUNDING_EXTREME', () => {
  it('shorts extreme positive funding with sufficient OI', () => {
    const facts = emptyFacts();
    facts.observations = [observation({ asset: HYPE, funding_annual_pct: 45 })];
    const result = runEngine(facts, opts());
    const sig = result.signals.find((s) => s.family_id === 'CROWD_FUNDING_EXTREME');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('short');
    expect(sig!.horizon.class).toBe('crypto_intraday');
  });

  it('skips illiquid books (spec §3.5-5)', () => {
    const facts = emptyFacts();
    facts.observations = [
      observation({ asset: HYPE, funding_annual_pct: 45, open_interest_usd: 1_000_000 }),
    ];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'CROWD_FUNDING_EXTREME')).toBeUndefined();
  });
});

describe('CATALYST_UPCOMING', () => {
  it('flags a scheduled catalyst inside the lead window as neutral', () => {
    const facts = emptyFacts();
    facts.catalysts = [catalyst(AAPL, 'earnings', 86_400)];
    const result = runEngine(facts, opts());
    const sig = result.signals.find((s) => s.family_id === 'CATALYST_UPCOMING');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('neutral');
    expect(sig!.levels.target).toBeNull(); // §2.2: neutral carries no levels
    expect(sig!.levels.invalidation).toBeNull();
    expect(sig!.horizon.class).toBe('catalyst_window');
    // window runs to event_time + settle
    expect(sig!.horizon.seconds).toBe(86_400 + 86_400);
  });

  it('ignores catalysts beyond the lead window', () => {
    const facts = emptyFacts();
    facts.catalysts = [catalyst(AAPL, 'earnings', 10 * 86_400)];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'CATALYST_UPCOMING')).toBeUndefined();
  });
});

describe('CATALYST_SURPRISE', () => {
  it('goes long a big earnings beat', () => {
    const facts = emptyFacts();
    facts.catalysts = [
      catalyst(AAPL, 'earnings', -3600, {
        status: 'completed',
        actual_time: NOW - 3600,
        surprise_pct: 12,
      }),
    ];
    facts.observations = [observation({ asset: AAPL, price: 230 })];
    const result = runEngine(facts, opts());
    const sig = result.signals.find((s) => s.family_id === 'CATALYST_SURPRISE');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
  });

  it('ignores small surprises', () => {
    const facts = emptyFacts();
    facts.catalysts = [
      catalyst(AAPL, 'earnings', -3600, {
        status: 'completed',
        actual_time: NOW - 3600,
        surprise_pct: 2,
      }),
    ];
    facts.observations = [observation({ asset: AAPL, price: 230 })];
    const result = runEngine(facts, opts());
    expect(result.signals.find((s) => s.family_id === 'CATALYST_SURPRISE')).toBeUndefined();
  });
});

describe('TA_SETUP', () => {
  it('matches LONG_OVERSOLD_SUPPORT and sets ATR geometry', () => {
    const facts = emptyFacts();
    facts.ta = [taFact(HYPE, { rsi_1d: 25, trend_1d: 'up', price: 45, support: 44.5 })];
    facts.observations = [observation({ asset: HYPE, price: 45 })];
    const result = runEngine(facts, opts());
    const sig = result.signals.find((s) => s.family_id === 'TA_SETUP');
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe('long');
    expect(sig!.trigger.inputs['template']).toBe('LONG_OVERSOLD_SUPPORT');
    expect(sig!.levels.target).toBeCloseTo(45 + 2.5 * 2.1, 6);
    expect(sig!.levels.invalidation).toBeCloseTo(45 - 1.5 * 2.1, 6);
    expect(sig!.levels.target_r_multiple).toBeCloseTo(2.5 / 1.5, 3);
  });

  it('records NO_SETUP as a deterministic abstention (spec §1.4)', () => {
    const facts = emptyFacts();
    facts.ta = [taFact(HYPE)]; // neutral read matches nothing
    facts.observations = [observation({ asset: HYPE })];
    const result = runEngine(facts, opts());
    const abst = result.abstentions.find((s) => s.family_id === 'TA_SETUP');
    expect(abst).toBeDefined();
    expect(abst!.abstention_reason).toBe('NO_SETUP');
    expect(result.signals.find((s) => s.family_id === 'TA_SETUP')).toBeUndefined();
  });
});
