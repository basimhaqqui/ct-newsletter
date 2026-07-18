// Baselines, edge, bootstrap CIs, calibration/ECE, min-sample floors
// (spec §5.3, §5.5). All randomness is a seeded, deterministic PRNG —
// same inputs = same CIs.

import type { Bar, GradeRecord, GradeStatsSummary } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — seeded, never Math.random()
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Baseline strategies (§5.3) — graded on the same asset/horizon windows
// ---------------------------------------------------------------------------

export type BaselineId = 'BASE_RANDOM' | 'BASE_ALWAYS_LONG' | 'BASE_MOMENTUM';

export interface BaselineContext {
  /** per-signal: bars in the same grading window the signal was graded on */
  bars: Bar[];
  referencePrice: number;
  /** risk unit matching the signal's geometry, for comparable R */
  riskAbs: number;
  /** trailing return sign for BASE_MOMENTUM (last N-day return before detection) */
  trailingReturnSign: 1 | -1 | 0;
  /** deterministic seed (e.g. signal_id) for BASE_RANDOM */
  seedKey: string;
  haircutR: number;
}

/** Realized R of holding `direction` from reference to window end. */
function holdR(ctx: BaselineContext, direction: 'long' | 'short'): number | null {
  if (ctx.bars.length === 0 || !(ctx.riskAbs > 0)) return null;
  const end = ctx.bars[ctx.bars.length - 1].c;
  const signed = direction === 'long' ? end - ctx.referencePrice : ctx.referencePrice - end;
  return signed / ctx.riskAbs - ctx.haircutR;
}

export function baselineRealizedR(id: BaselineId, ctx: BaselineContext): number | null {
  switch (id) {
    case 'BASE_ALWAYS_LONG':
      return holdR(ctx, 'long');
    case 'BASE_RANDOM': {
      const rng = mulberry32(seedFromString(`BASE_RANDOM|${ctx.seedKey}`));
      return holdR(ctx, rng() < 0.5 ? 'long' : 'short');
    }
    case 'BASE_MOMENTUM': {
      if (ctx.trailingReturnSign === 0) return null;
      return holdR(ctx, ctx.trailingReturnSign > 0 ? 'long' : 'short');
    }
  }
}

// ---------------------------------------------------------------------------
// Edge vs baseline with bootstrap CI (§5.3)
// ---------------------------------------------------------------------------

export interface EdgeReport {
  signalMeanR: number;
  baselineMeanR: number;
  edge: number;
  ci95: [number, number];
  n: number;
  bootstrapN: number;
}

export function edgeVsBaseline(
  signalRs: number[],
  baselineRs: number[],
  bootstrapN = 1000,
  seedKey = 'edge',
): EdgeReport | null {
  const n = Math.min(signalRs.length, baselineRs.length);
  if (n === 0) return null;
  const pairs = signalRs.slice(0, n).map((r, i) => r - baselineRs[i]);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  const rng = mulberry32(seedFromString(seedKey));
  const bootMeans: number[] = [];
  for (let b = 0; b < bootstrapN; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pairs[Math.floor(rng() * n)];
    bootMeans.push(sum / n);
  }
  bootMeans.sort((a, b) => a - b);
  const lo = bootMeans[Math.floor(0.025 * bootstrapN)];
  const hi = bootMeans[Math.min(bootstrapN - 1, Math.floor(0.975 * bootstrapN))];

  return {
    signalMeanR: round4(mean(signalRs.slice(0, n))),
    baselineMeanR: round4(mean(baselineRs.slice(0, n))),
    edge: round4(mean(pairs)),
    ci95: [round4(lo), round4(hi)],
    n,
    bootstrapN,
  };
}

// ---------------------------------------------------------------------------
// Calibration: score deciles vs realized win rate, ECE (§5.3)
// ---------------------------------------------------------------------------

export interface CalibrationBucket {
  bucket: number; // 0..9 decile by score
  meanScore: number;
  realizedWinRate: number;
  n: number;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  ece: number; // expected calibration error, sample-weighted |score - winrate|
  monotone: boolean;
  n: number;
}

export function calibrationReport(
  scored: { score: number; won: boolean }[],
  bucketCount = 10,
): CalibrationReport | null {
  if (scored.length === 0) return null;
  const buckets: { scores: number[]; wins: number; n: number }[] = Array.from(
    { length: bucketCount },
    () => ({ scores: [], wins: 0, n: 0 }),
  );
  for (const s of scored) {
    const b = Math.min(bucketCount - 1, Math.floor(s.score * bucketCount));
    buckets[b].scores.push(s.score);
    buckets[b].n += 1;
    if (s.won) buckets[b].wins += 1;
  }
  const out: CalibrationBucket[] = [];
  let ece = 0;
  for (let i = 0; i < bucketCount; i++) {
    const b = buckets[i];
    if (b.n === 0) continue;
    const meanScore = b.scores.reduce((s, x) => s + x, 0) / b.n;
    const winRate = b.wins / b.n;
    ece += (b.n / scored.length) * Math.abs(meanScore - winRate);
    out.push({ bucket: i, meanScore: round4(meanScore), realizedWinRate: round4(winRate), n: b.n });
  }
  let monotone = true;
  for (let i = 1; i < out.length; i++) {
    if (out[i].realizedWinRate < out[i - 1].realizedWinRate) monotone = false;
  }
  return { buckets: out, ece: round4(ece), monotone, n: scored.length };
}

// ---------------------------------------------------------------------------
// Stats + min-sample floors (§5.5)
// ---------------------------------------------------------------------------

export const MIN_SAMPLES = {
  family_metrics: 30, // per-family win-rate / mean-R
  baseline_edge: 50, // edge CI per family
  calibration: 100, // ECE across >=3 severity buckets
  cohort_promotion: 200,
} as const;

const DECISIVE: ReadonlySet<string> = new Set([
  'TARGET_HIT',
  'INVALIDATED',
  'TIMEOUT_WIN',
  'TIMEOUT_LOSS',
]);

export function summarize(grades: GradeRecord[]): GradeStatsSummary {
  const byOutcome: Record<string, number> = {};
  const rs: number[] = [];
  const mfeRs: number[] = [];
  const maeRs: number[] = [];
  let wins = 0;
  let decisive = 0;
  for (const g of grades) {
    byOutcome[g.outcome] = (byOutcome[g.outcome] ?? 0) + 1;
    if (DECISIVE.has(g.outcome)) {
      decisive += 1;
      if (g.outcome === 'TARGET_HIT' || g.outcome === 'TIMEOUT_WIN') wins += 1;
      if (g.realized_r !== null) rs.push(g.realized_r);
    }
    if (g.mfe?.r != null) mfeRs.push(g.mfe.r);
    if (g.mae?.r != null) maeRs.push(g.mae.r);
  }
  const mean = (xs: number[]) => (xs.length ? round4(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  return {
    total: grades.length,
    graded: decisive,
    byOutcome,
    winRate: decisive > 0 ? round4(wins / decisive) : null,
    avgRealizedR: mean(rs),
    avgMfeR: mean(mfeRs),
    avgMaeR: mean(maeRs),
    insufficientSample: decisive < MIN_SAMPLES.family_metrics,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
