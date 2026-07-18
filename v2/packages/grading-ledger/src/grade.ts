// Grade orchestrator (spec §4). Pure: signal + in-window bars in, GradeRecord
// out. Enforces the leakage boundary (§2.4): rejects llm-origin graded fields
// (LEAKAGE_REJECT), rejects out-of-window bars, never reads narration/scores.

import { computeExcursions } from './excursions.js';
import { firstTouchOutcome, resolveAmbiguousWithFinerBars } from './outcomes.js';
import { gradeInformationValue } from './neutral.js';
import type { Bar, GradableSignal, GradeRecord } from './types.js';

export const GRADER_VERSION = 'grader/2.0.0';

export interface GradeInputs {
  signal: GradableSignal;
  /** bars strictly within [detected_time, detected_time + horizon.seconds] */
  bars: Bar[];
  barsSource: string; // e.g. "hyperliquid:1h"
  barIntervalS: number;
  /** injected grading clock — must be past horizon end */
  gradedAt: number;
  haircutR: number;
  /** finer bars covering an AMBIGUOUS bar's span, if available */
  finerBars?: Bar[];
  /** trailing bars before detected_time — required for neutral signals */
  baselineBars?: Bar[];
}

export class LeakageRejectError extends Error {
  constructor(reason: string) {
    super(`LEAKAGE_REJECT: ${reason}`);
    this.name = 'LeakageRejectError';
  }
}

export function gradeSignal(inputs: GradeInputs): GradeRecord {
  const { signal, bars, barsSource, barIntervalS, gradedAt, haircutR } = inputs;
  const horizonEnd = signal.detected_time + signal.horizon.seconds;

  // ---- leakage boundary (§2.4) ----
  if (signal.origin !== 'deterministic') {
    throw new LeakageRejectError(`signal ${signal.signal_id} graded fields origin=${signal.origin}`);
  }
  if (signal.event_time > signal.detected_time) {
    throw new LeakageRejectError(`signal ${signal.signal_id} has future-dated evidence`);
  }
  // ---- purity guards ----
  if (gradedAt < horizonEnd) {
    throw new Error(`grader ran before horizon end (${gradedAt} < ${horizonEnd})`);
  }
  for (const b of bars) {
    if (b.t < signal.detected_time || b.t > horizonEnd) {
      throw new Error(`bar at ${b.t} outside grading window [${signal.detected_time}, ${horizonEnd}]`);
    }
  }
  if (signal.abstained) {
    return notGraded(signal, gradedAt, horizonEnd, barsSource, bars.length, haircutR, 'abstained signal is never graded as active');
  }

  const gradeId = `grd_${gradedAt.toString(36)}_${signal.signal_id.slice(4)}`;

  // ---- neutral / information-value track (§4.4) ----
  if (signal.direction === 'neutral') {
    const info = gradeInformationValue(
      bars,
      inputs.baselineBars ?? [],
      barIntervalS,
      signal.event_time,
      signal.detected_time,
    );
    return {
      grade_id: gradeId,
      signal_id: signal.signal_id,
      cohort_version: signal.cohort_version,
      grader_version: GRADER_VERSION,
      graded_at: gradedAt,
      horizon_end: horizonEnd,
      outcome: 'NOT_GRADED', // no directional outcome by design
      mfe: null,
      mae: null,
      realized_r: null,
      end_price: bars.length ? bars[bars.length - 1].c : null,
      end_r: null,
      bars_source: barsSource,
      bars_count: bars.length,
      haircut_r: haircutR,
      info_value: info,
      not_graded_reason: null,
      origin: 'deterministic',
    };
  }

  // ---- directional track (§4.2–4.3) ----
  const ref = signal.levels.reference_price;
  const { target, invalidation, target_r_multiple } = signal.levels;
  if (!(ref > 0)) {
    return notGraded(signal, gradedAt, horizonEnd, barsSource, bars.length, haircutR, 'missing reference price');
  }
  if (bars.length === 0) {
    return notGraded(signal, gradedAt, horizonEnd, barsSource, bars.length, haircutR, 'no bars in window');
  }

  const excursions = computeExcursions(bars, ref, signal.direction, invalidation);

  if (target === null || invalidation === null || target_r_multiple === null) {
    // no level geometry → excursions only, no win/loss label
    return {
      grade_id: gradeId,
      signal_id: signal.signal_id,
      cohort_version: signal.cohort_version,
      grader_version: GRADER_VERSION,
      graded_at: gradedAt,
      horizon_end: horizonEnd,
      outcome: 'NOT_GRADED',
      mfe: excursions.mfe,
      mae: excursions.mae,
      realized_r: null,
      end_price: bars[bars.length - 1].c,
      end_r: null,
      bars_source: barsSource,
      bars_count: bars.length,
      haircut_r: haircutR,
      info_value: null,
      not_graded_reason: 'missing target/invalidation levels',
      origin: 'deterministic',
    };
  }

  let result = firstTouchOutcome(bars, ref, signal.direction, target, invalidation, target_r_multiple, haircutR);
  if (result.outcome === 'AMBIGUOUS' && inputs.finerBars && inputs.finerBars.length > 0) {
    const refined = resolveAmbiguousWithFinerBars(
      inputs.finerBars,
      ref,
      signal.direction,
      target,
      invalidation,
      target_r_multiple,
      haircutR,
    );
    if (refined !== null) result = refined;
  }

  return {
    grade_id: gradeId,
    signal_id: signal.signal_id,
    cohort_version: signal.cohort_version,
    grader_version: GRADER_VERSION,
    graded_at: gradedAt,
    horizon_end: horizonEnd,
    outcome: result.outcome,
    mfe: excursions.mfe,
    mae: excursions.mae,
    realized_r: result.realized_r,
    end_price: result.end_price,
    end_r: result.end_r,
    bars_source: barsSource,
    bars_count: bars.length,
    haircut_r: haircutR,
    info_value: null,
    not_graded_reason: null,
    origin: 'deterministic',
  };
}

function notGraded(
  signal: GradableSignal,
  gradedAt: number,
  horizonEnd: number,
  barsSource: string,
  barsCount: number,
  haircutR: number,
  reason: string,
): GradeRecord {
  return {
    grade_id: `grd_${gradedAt.toString(36)}_${signal.signal_id.slice(4)}`,
    signal_id: signal.signal_id,
    cohort_version: signal.cohort_version,
    grader_version: GRADER_VERSION,
    graded_at: gradedAt,
    horizon_end: horizonEnd,
    outcome: 'NOT_GRADED',
    mfe: null,
    mae: null,
    realized_r: null,
    end_price: null,
    end_r: null,
    bars_source: barsSource,
    bars_count: barsCount,
    haircut_r: haircutR,
    info_value: null,
    not_graded_reason: reason,
    origin: 'deterministic',
  };
}
