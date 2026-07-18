// Grading ledger types (spec §4). The grader is pure, post-horizon, and reads
// ONLY in-window bars. Time is injected. Same inputs + same cohort =
// byte-identical grades.

export interface Bar {
  t: number; // bar open time, unix seconds UTC
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Outcome =
  | 'TARGET_HIT'
  | 'INVALIDATED'
  | 'TIMEOUT_WIN'
  | 'TIMEOUT_LOSS'
  | 'AMBIGUOUS'
  | 'NOT_GRADED';

export interface Excursions {
  mfe: { abs: number; pct: number; r: number | null };
  mae: { abs: number; pct: number; r: number | null };
}

/** The ONLY signal fields the grader reads (spec §2.4 leakage boundary). */
export interface GradableSignal {
  signal_id: string;
  cohort_version: string;
  family_id: string;
  asset_class: 'crypto' | 'stock';
  direction: 'long' | 'short' | 'neutral';
  detected_time: number;
  event_time: number;
  horizon: { class: string; seconds: number };
  levels: {
    reference_price: number;
    target: number | null;
    invalidation: number | null;
    atr_ref: number | null;
    target_r_multiple: number | null;
  };
  origin: 'deterministic' | 'llm';
  abstained: boolean;
}

export interface GradeRecord {
  grade_id: string;
  signal_id: string;
  cohort_version: string;
  grader_version: string;
  graded_at: number;
  horizon_end: number;
  outcome: Outcome;
  mfe: { abs: number; pct: number; r: number | null } | null;
  mae: { abs: number; pct: number; r: number | null } | null;
  realized_r: number | null;
  end_price: number | null;
  end_r: number | null;
  bars_source: string;
  bars_count: number;
  haircut_r: number;
  /** neutral/catalyst track (spec §4.4) */
  info_value: {
    realized_vol_pct: number;
    baseline_vol_pct: number;
    vol_ratio: number;
    lead_time_s: number;
  } | null;
  not_graded_reason: string | null;
  origin: 'deterministic';
}

export interface GradeStatsSummary {
  total: number;
  graded: number;
  byOutcome: Record<string, number>;
  winRate: number | null; // TARGET_HIT+TIMEOUT_WIN over decisive outcomes
  avgRealizedR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  insufficientSample: boolean;
}
