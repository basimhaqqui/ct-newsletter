// Grader tests (spec §4): outcomes, MFE/MAE, AMBIGUOUS handling, leakage
// rejection, neutral track, determinism.

import { describe, expect, it } from 'vitest';
import {
  GRADER_VERSION,
  LeakageRejectError,
  annualizedVolPct,
  computeExcursions,
  firstTouchOutcome,
  gradeSignal,
  type Bar,
  type GradableSignal,
  type GradeInputs,
} from '../src/index.js';

const T0 = 1_784_086_130;
const HOUR = 3600;

function bars(specs: [number, number, number, number][], startT = T0, intervalS = HOUR): Bar[] {
  return specs.map(([o, h, l, c], i) => ({ t: startT + i * intervalS, o, h, l, c }));
}

function signal(overrides: Partial<GradableSignal> = {}): GradableSignal {
  return {
    signal_id: 'sig_test0001',
    cohort_version: 'cohort/2026.07.0',
    family_id: 'CROWD_DIVERGENCE',
    asset_class: 'crypto',
    direction: 'long',
    detected_time: T0,
    event_time: T0 - 30,
    horizon: { class: 'crypto_swing', seconds: 24 * HOUR },
    levels: {
      reference_price: 100,
      target: 110,
      invalidation: 95,
      atr_ref: 4,
      target_r_multiple: 2,
    },
    origin: 'deterministic',
    abstained: false,
    ...overrides,
  };
}

function inputs(overrides: Partial<GradeInputs> = {}): GradeInputs {
  return {
    signal: signal(),
    bars: [],
    barsSource: 'hyperliquid:1h',
    barIntervalS: HOUR,
    gradedAt: T0 + 25 * HOUR,
    haircutR: 0.05,
    ...overrides,
  };
}

describe('first-touch outcomes (spec §4.3)', () => {
  it('TARGET_HIT when target touched before invalidation', () => {
    const b = bars([
      [100, 103, 99, 102],
      [102, 111, 101, 108], // touches 110
      [108, 112, 94, 96], // would touch invalidation later — irrelevant
    ]);
    const g = gradeSignal(inputs({ bars: b }));
    expect(g.outcome).toBe('TARGET_HIT');
    expect(g.realized_r).toBeCloseTo(2 - 0.05, 6); // +target_R net of haircut
  });

  it('INVALIDATED when stop touched first, realized R = -1 - haircut', () => {
    const b = bars([
      [100, 102, 98, 99],
      [99, 101, 94, 95], // touches 95
      [95, 115, 95, 114],
    ]);
    const g = gradeSignal(inputs({ bars: b }));
    expect(g.outcome).toBe('INVALIDATED');
    expect(g.realized_r).toBeCloseTo(-1.05, 6);
  });

  it('TIMEOUT_WIN / TIMEOUT_LOSS at horizon end', () => {
    const win = gradeSignal(inputs({ bars: bars([[100, 104, 99, 103], [103, 105, 102, 104]]) }));
    expect(win.outcome).toBe('TIMEOUT_WIN');
    expect(win.end_r).toBeCloseTo((104 - 100) / 5 - 0.05, 6);

    const loss = gradeSignal(inputs({ bars: bars([[100, 101, 97, 98], [98, 99, 96.5, 97]]) }));
    expect(loss.outcome).toBe('TIMEOUT_LOSS');
    expect(loss.end_r).toBeCloseTo((97 - 100) / 5 - 0.05, 6);
  });

  it('AMBIGUOUS when both levels fall inside one bar — never guesses (spec §4.3)', () => {
    const b = bars([[100, 111, 94, 100]]); // touches 110 AND 95
    const g = gradeSignal(inputs({ bars: b }));
    expect(g.outcome).toBe('AMBIGUOUS');
    expect(g.realized_r).toBeNull();
    expect(g.mfe).not.toBeNull(); // MFE/MAE kept for AMBIGUOUS
  });

  it('resolves AMBIGUOUS with finer bars', () => {
    const coarse = bars([[100, 111, 94, 100]]);
    const finer = bars(
      [
        [100, 105, 99, 104],
        [104, 111, 103, 110], // target first at finer granularity
        [110, 110, 94, 95],
      ],
      T0,
      HOUR / 4,
    );
    const g = gradeSignal(inputs({ bars: coarse, finerBars: finer }));
    expect(g.outcome).toBe('TARGET_HIT');
  });

  it('short direction mirrors the geometry', () => {
    const b = bars([
      [100, 101, 96, 97],
      [97, 98, 89, 90], // short target 90 touched
    ]);
    const g = gradeSignal(
      inputs({
        signal: signal({ direction: 'short', levels: { reference_price: 100, target: 90, invalidation: 105, atr_ref: 4, target_r_multiple: 2 } }),
        bars: b,
      }),
    );
    expect(g.outcome).toBe('TARGET_HIT');
  });
});

describe('MFE/MAE excursions (spec §4.2)', () => {
  it('computes sign-adjusted excursions in abs, %, and R', () => {
    const b = bars([
      [100, 108, 97, 105],
      [105, 109, 103, 104],
    ]);
    const e = computeExcursions(b, 100, 'long', 95);
    expect(e.mfe.abs).toBe(9); // high 109
    expect(e.mfe.pct).toBeCloseTo(9, 6);
    expect(e.mfe.r).toBeCloseTo(9 / 5, 6);
    expect(e.mae.abs).toBe(3); // low 97
    expect(e.mae.r).toBeCloseTo(3 / 5, 6);
  });

  it('floors excursions at zero when price never crosses reference', () => {
    const b = bars([[100, 100, 92, 93]]);
    const e = computeExcursions(b, 100, 'long', 95);
    expect(e.mfe.abs).toBe(0);
    expect(e.mae.abs).toBe(8);
  });
});

describe('leakage boundary & purity (spec §0, §2.4)', () => {
  it('rejects llm-origin graded fields with LEAKAGE_REJECT', () => {
    expect(() => gradeSignal(inputs({ signal: signal({ origin: 'llm' }) }))).toThrow(LeakageRejectError);
  });

  it('rejects future-dated evidence', () => {
    expect(() =>
      gradeSignal(inputs({ signal: signal({ event_time: T0 + 100 }) })),
    ).toThrow(/future-dated/);
  });

  it('refuses to run before the horizon elapses', () => {
    expect(() => gradeSignal(inputs({ gradedAt: T0 + HOUR }))).toThrow(/before horizon end/);
  });

  it('rejects bars outside the grading window', () => {
    const early = bars([[100, 101, 99, 100]], T0 - HOUR);
    expect(() => gradeSignal(inputs({ bars: early }))).toThrow(/outside grading window/);
  });

  it('never grades abstained signals as active', () => {
    const g = gradeSignal(inputs({ signal: signal({ abstained: true }), bars: bars([[100, 101, 99, 100]]) }));
    expect(g.outcome).toBe('NOT_GRADED');
    expect(g.not_graded_reason).toMatch(/abstained/);
  });
});

describe('neutral / information-value track (spec §4.4)', () => {
  it('grades catalysts on realized vol vs baseline, not P&L', () => {
    // calm baseline, violent window
    const baseline = bars(
      Array.from({ length: 24 }, () => [100, 100.3, 99.7, 100] as [number, number, number, number]),
      T0 - 24 * HOUR,
    );
    const window = bars(
      Array.from({ length: 24 }, (_, i) => {
        const p = 100 + (i % 2 === 0 ? 4 : -4);
        return [p, p + 1, p - 1, p] as [number, number, number, number];
      }),
    );
    const g = gradeSignal(
      inputs({
        signal: signal({ direction: 'neutral', family_id: 'CATALYST_UPCOMING', event_time: T0 - 600 }),
        bars: window,
        baselineBars: baseline,
      }),
    );
    expect(g.outcome).toBe('NOT_GRADED'); // by design: no directional label
    expect(g.info_value).not.toBeNull();
    expect(g.info_value!.vol_ratio).toBeGreaterThan(1); // catalyst moved the asset
    expect(g.realized_r).toBeNull(); // never contaminates directional win-rate
  });

  it('annualizedVolPct is zero for constant prices', () => {
    const flat = bars(Array.from({ length: 10 }, () => [100, 100, 100, 100] as [number, number, number, number]));
    expect(annualizedVolPct(flat, HOUR)).toBe(0);
  });
});

describe('determinism & audit trail', () => {
  it('same inputs → byte-identical grade', () => {
    const b = bars([
      [100, 103, 99, 102],
      [102, 111, 101, 108],
    ]);
    const a = gradeSignal(inputs({ bars: b }));
    const c = gradeSignal(inputs({ bars: b }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });

  it('carries cohort + grader versions for regrade lineage (spec §4.5)', () => {
    const g = gradeSignal(inputs({ bars: bars([[100, 101, 99, 100]]) }));
    expect(g.cohort_version).toBe('cohort/2026.07.0');
    expect(g.grader_version).toBe(GRADER_VERSION);
    expect(g.origin).toBe('deterministic');
  });

  it('firstTouchOutcome never grades with zero risk', () => {
    const r = firstTouchOutcome(bars([[100, 101, 99, 100]]), 100, 'long', 110, 100, 2, 0.05);
    expect(r.outcome).toBe('NOT_GRADED');
  });
});
