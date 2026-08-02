// Read-only shadow-mode evidence accounting. This deliberately reports sample
// progress, not performance claims: promotion still requires the independent
// baseline, CI, calibration, and leakage gates in the frozen specification.

import type { RepositoryFactory } from '@market-intel/db';
import { validateCohort } from '@market-intel/signal-engine';

export interface FamilyEvidenceProgress {
  familyId: string;
  fired: number;
  performanceGraded: number;
  remainingForMetrics: number;
  remainingForEdgeCi: number;
}

export interface EvidenceScorecard {
  cohortVersion: string;
  status: 'INSUFFICIENT_EVIDENCE';
  fired: number;
  performanceGraded: number;
  remainingForCohortPromotion: number;
  families: FamilyEvidenceProgress[];
  sourceHealth: {
    healthy: number;
    degraded: number;
    unhealthy: number;
    unhealthySourceIds: string[];
  };
  promotionBlockedBy: string[];
}

const METRICS_FLOOR = 30;
const EDGE_CI_FLOOR = 50;
const COHORT_PROMOTION_FLOOR = 200;

/**
 * Counts only settled, directional outcomes as performance evidence. Rows
 * marked AMBIGUOUS or NOT_GRADED remain in the immutable ledger but cannot
 * inflate a sample floor. All counts stay isolated to the active cohort.
 */
export async function buildEvidenceScorecard(
  repos: RepositoryFactory,
  rawCohort: unknown,
): Promise<EvidenceScorecard> {
  const cohort = validateCohort(rawCohort);
  const [signals, grades, health] = await Promise.all([
    repos.signals.findByCohort(cohort.version),
    repos.grades.findByCohort(cohort.version),
    repos.sourceHealth.findAll(),
  ]);
  const fired = signals.filter((signal) => !signal.abstained);
  const signalById = new Map(fired.map((signal) => [signal.signal_id, signal]));
  // The ledger permits audited regrades under a new grader version. Evidence
  // floors count signals, never grade rows, so retain only the latest row.
  const latestGradeBySignal = new Map<string, (typeof grades)[number]>();
  for (const grade of grades) {
    const current = latestGradeBySignal.get(grade.signal_id);
    if (!current || grade.graded_at > current.graded_at) latestGradeBySignal.set(grade.signal_id, grade);
  }
  const performanceGrades = [...latestGradeBySignal.values()].filter((grade) => {
    const signal = signalById.get(grade.signal_id);
    return signal !== undefined && grade.outcome !== 'AMBIGUOUS' && grade.outcome !== 'NOT_GRADED';
  });
  const gradeFamilyBySignal = new Map(
    performanceGrades.map((grade) => [grade.signal_id, signalById.get(grade.signal_id)!.family_id]),
  );

  const families = Object.keys(cohort.families)
    .sort()
    .map((familyId) => {
      const firedCount = fired.filter((signal) => signal.family_id === familyId).length;
      const gradedCount = [...gradeFamilyBySignal.values()].filter((id) => id === familyId).length;
      return {
        familyId,
        fired: firedCount,
        performanceGraded: gradedCount,
        remainingForMetrics: Math.max(0, METRICS_FLOOR - gradedCount),
        remainingForEdgeCi: Math.max(0, EDGE_CI_FLOOR - gradedCount),
      };
    });
  const unhealthySourceIds = health
    .filter((source) => source.status === 'unhealthy')
    .map((source) => source.source_id)
    .sort();
  const familyGates = families.filter((family) => family.remainingForMetrics > 0);

  return {
    cohortVersion: cohort.version,
    status: 'INSUFFICIENT_EVIDENCE',
    fired: fired.length,
    performanceGraded: performanceGrades.length,
    remainingForCohortPromotion: Math.max(0, COHORT_PROMOTION_FLOOR - performanceGrades.length),
    families,
    sourceHealth: {
      healthy: health.filter((source) => source.status === 'healthy').length,
      degraded: health.filter((source) => source.status === 'degraded').length,
      unhealthy: unhealthySourceIds.length,
      unhealthySourceIds,
    },
    promotionBlockedBy: [
      ...(performanceGrades.length < COHORT_PROMOTION_FLOOR
        ? ['cohort graded-sample floor']
        : []),
      ...(familyGates.length > 0 ? ['per-family graded-sample floor'] : []),
      'baseline edge CI and calibration gates are not evaluated by this counter',
      'cutover remains explicitly supervised',
    ],
  };
}
