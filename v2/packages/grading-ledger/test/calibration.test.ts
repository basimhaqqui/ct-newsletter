// Calibration/baseline tests (spec §5.3, §5.5): deterministic baselines,
// bootstrap CIs, ECE, min-sample floors.

import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLES,
  baselineRealizedR,
  calibrationReport,
  edgeVsBaseline,
  mulberry32,
  seedFromString,
  summarize,
  type BaselineContext,
  type Bar,
  type GradeRecord,
} from '../src/index.js';

const T0 = 1_784_086_130;

function ctx(overrides: Partial<BaselineContext> = {}): BaselineContext {
  const barsUp: Bar[] = [
    { t: T0, o: 100, h: 104, l: 99, c: 103 },
    { t: T0 + 3600, o: 103, h: 107, l: 102, c: 106 },
  ];
  return {
    bars: barsUp,
    referencePrice: 100,
    riskAbs: 5,
    trailingReturnSign: 1,
    seedKey: 'sig_x',
    haircutR: 0.05,
    ...overrides,
  };
}

describe('baselines (spec §5.3)', () => {
  it('BASE_ALWAYS_LONG realizes the hold-to-end R', () => {
    const r = baselineRealizedR('BASE_ALWAYS_LONG', ctx());
    expect(r).toBeCloseTo((106 - 100) / 5 - 0.05, 6);
  });

  it('BASE_MOMENTUM follows the trailing return sign', () => {
    const up = baselineRealizedR('BASE_MOMENTUM', ctx({ trailingReturnSign: 1 }));
    const down = baselineRealizedR('BASE_MOMENTUM', ctx({ trailingReturnSign: -1 }));
    expect(up).toBeCloseTo((106 - 100) / 5 - 0.05, 6);
    expect(down).toBeCloseTo((100 - 106) / 5 - 0.05, 6);
    expect(baselineRealizedR('BASE_MOMENTUM', ctx({ trailingReturnSign: 0 }))).toBeNull();
  });

  it('BASE_RANDOM is deterministic per seed key', () => {
    const a = baselineRealizedR('BASE_RANDOM', ctx({ seedKey: 'sig_1' }));
    const b = baselineRealizedR('BASE_RANDOM', ctx({ seedKey: 'sig_1' }));
    expect(a).toBe(b);
    // over many seeds, both directions appear
    const dirs = new Set<number>();
    for (let i = 0; i < 50; i++) {
      dirs.add(baselineRealizedR('BASE_RANDOM', ctx({ seedKey: `sig_${i}` }))!);
    }
    expect(dirs.size).toBe(2);
  });
});

describe('edge & bootstrap CI', () => {
  it('positive-edge sample yields CI excluding 0', () => {
    const signalRs = Array.from({ length: 100 }, (_, i) => 0.8 + (i % 10) * 0.01);
    const baseRs = Array.from({ length: 100 }, (_, i) => 0.1 + (i % 10) * 0.01);
    const report = edgeVsBaseline(signalRs, baseRs, 1000, 'test-seed');
    expect(report).not.toBeNull();
    expect(report!.edge).toBeCloseTo(0.7, 6);
    expect(report!.ci95[0]).toBeGreaterThan(0);
  });

  it('is deterministic for the same seed', () => {
    const s = [1, 0.5, -1, 2, 0.3];
    const b = [0.2, 0.1, -0.5, 0.4, 0];
    const r1 = edgeVsBaseline(s, b, 500, 'seed');
    const r2 = edgeVsBaseline(s, b, 500, 'seed');
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe('calibration & ECE', () => {
  it('a perfectly calibrated sample has ~0 ECE and monotone buckets', () => {
    const rng = mulberry32(seedFromString('calib'));
    const scored = Array.from({ length: 5000 }, () => {
      const score = Math.round(rng() * 10) / 10;
      return { score, won: rng() < score };
    });
    const report = calibrationReport(scored);
    expect(report).not.toBeNull();
    expect(report!.ece).toBeLessThan(0.06);
  });

  it('detects miscalibration', () => {
    const scored = Array.from({ length: 200 }, (_, i) => ({
      score: 0.9,
      won: i % 10 === 0, // 10% realized vs 90% implied
    }));
    const report = calibrationReport(scored);
    expect(report!.ece).toBeGreaterThan(0.5);
  });
});

describe('min-sample floors (spec §5.5)', () => {
  function grade(outcome: GradeRecord['outcome'], realizedR: number | null): GradeRecord {
    return {
      grade_id: 'g',
      signal_id: 's',
      cohort_version: 'cohort/2026.07.0',
      grader_version: 'grader/2.0.0',
      graded_at: T0,
      horizon_end: T0,
      outcome,
      mfe: null,
      mae: null,
      realized_r: realizedR,
      end_price: null,
      end_r: null,
      bars_source: 'test',
      bars_count: 1,
      haircut_r: 0,
      info_value: null,
      not_graded_reason: null,
      origin: 'deterministic',
    };
  }

  it('flags insufficient samples below the 30-grade floor', () => {
    const grades = Array.from({ length: 10 }, () => grade('TARGET_HIT', 1.5));
    const stats = summarize(grades);
    expect(stats.insufficientSample).toBe(true);
    expect(MIN_SAMPLES.family_metrics).toBe(30);
  });

  it('excludes AMBIGUOUS and NOT_GRADED from win-rate (spec §4.3)', () => {
    const grades = [
      ...Array.from({ length: 20 }, () => grade('TARGET_HIT', 1.5)),
      ...Array.from({ length: 10 }, () => grade('INVALIDATED', -1)),
      ...Array.from({ length: 15 }, () => grade('AMBIGUOUS', null)),
      ...Array.from({ length: 5 }, () => grade('NOT_GRADED', null)),
    ];
    const stats = summarize(grades);
    expect(stats.graded).toBe(30);
    expect(stats.winRate).toBeCloseTo(20 / 30, 3); // summarize rounds to 4dp
    expect(stats.insufficientSample).toBe(false);
  });
});
