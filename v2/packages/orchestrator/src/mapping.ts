// Engine/grader records → DB rows. Pure, lossless where the schema allows.

import type { AbstentionRow, GradeRow, SignalRow } from '@market-intel/db';
import type { Signal } from '@market-intel/signal-engine';
import type { GradableSignal, GradeRecord } from '@market-intel/grading-ledger';

const d = (unix: number): Date => new Date(unix * 1000);

export function signalToRow(s: Signal): SignalRow {
  return {
    id: s.signal_id,
    signal_id: s.signal_id,
    schema_version: s.schema_version,
    cohort_version: s.cohort_version,
    family_id: s.family_id,
    dimension: s.dimension,
    asset_class: s.asset_class,
    asset_uid: s.asset.asset_uid,
    symbol: s.asset.symbol,
    venue: s.asset.venue,
    direction: s.direction,
    event_time: d(s.event_time),
    observed_time: d(s.observed_time),
    detected_time: d(s.detected_time),
    source_latency_seconds: s.source_latency_s,
    trigger_rule: s.trigger.rule,
    trigger_inputs: s.trigger.inputs,
    reference_price: s.levels.reference_price,
    target_price: s.levels.target,
    invalidation_price: s.levels.invalidation,
    atr_ref: s.levels.atr_ref,
    target_r_multiple: s.levels.target_r_multiple,
    horizon_class: s.horizon.class,
    horizon_seconds: s.horizon.seconds,
    severity_score: s.scores.severity,
    novelty_score: s.scores.novelty,
    personal_relevance_score: s.scores.personal_relevance,
    priority_score: s.scores.priority,
    evidence_ref_ids: s.evidence.map((e) => e.ref),
    abstained: s.abstained,
    abstention_reason: s.abstention_reason,
    origin: s.origin,
    narration_text: null,
    narration_model: null,
    narration_prompt_hash: null,
    narration_origin: null,
    created_at: d(s.detected_time),
  };
}

export function abstentionToRow(s: Signal): AbstentionRow {
  return {
    id: `abst_${s.signal_id}`,
    signal_id: s.signal_id,
    cohort_version: s.cohort_version,
    family_id: s.family_id,
    asset_uid: s.asset.asset_uid,
    direction: s.direction,
    reason: s.abstention_reason ?? 'UNKNOWN',
    reason_detail: { trigger: s.trigger.rule, inputs: s.trigger.inputs },
    event_time: d(s.event_time),
    observed_time: d(s.observed_time),
    detected_time: d(s.detected_time),
    evidence_ref_ids: s.evidence.map((e) => e.ref),
    partial_scores: { ...s.scores },
    created_at: d(s.detected_time),
  };
}

export function rowToGradable(row: SignalRow): GradableSignal {
  return {
    signal_id: row.signal_id,
    cohort_version: row.cohort_version,
    family_id: row.family_id,
    asset_class: row.asset_class,
    direction: row.direction,
    detected_time: Math.floor(row.detected_time.getTime() / 1000),
    event_time: Math.floor(row.event_time.getTime() / 1000),
    horizon: { class: row.horizon_class, seconds: row.horizon_seconds },
    levels: {
      reference_price: row.reference_price,
      target: row.target_price,
      invalidation: row.invalidation_price,
      atr_ref: row.atr_ref,
      target_r_multiple: row.target_r_multiple,
    },
    origin: row.origin,
    abstained: row.abstained,
  };
}

export function gradeToRow(g: GradeRecord): GradeRow {
  return {
    id: g.grade_id,
    grade_id: g.grade_id,
    signal_id: g.signal_id,
    cohort_version: g.cohort_version,
    graded_at: d(g.graded_at),
    horizon_end: d(g.horizon_end),
    outcome: g.outcome,
    mfe_abs: g.mfe?.abs ?? null,
    mfe_pct: g.mfe?.pct ?? null,
    mfe_r: g.mfe?.r ?? null,
    mae_abs: g.mae?.abs ?? null,
    mae_pct: g.mae?.pct ?? null,
    mae_r: g.mae?.r ?? null,
    realized_r: g.realized_r,
    haircut_r: g.haircut_r,
    end_price: g.end_price,
    end_r: g.end_r,
    bars_source: g.bars_source,
    bars_count: g.bars_count,
    grader_version: g.grader_version,
    origin: g.origin,
    metadata: g.info_value ? { info_value: g.info_value } : {},
    created_at: d(g.graded_at),
  };
}
