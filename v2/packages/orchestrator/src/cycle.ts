// The product loop (t_efb36ee3):
//   runCycle : scheduler tick → ingestion → feature prep → signal engine →
//              persist signals/abstentions → tiered Telegram alerts → state save
//   gradeDue : find signals past horizon → in-window price series → pure
//              grader → append-only grade rows
// Every step is injected and deterministic given repos content + clock.

import type { ObservationRow, RepositoryFactory, SignalRow } from '@market-intel/db';
import { gradeSignal, type Bar, type GradeRecord } from '@market-intel/grading-ledger';
import { buildFactSet, type IngestionScheduler } from '@market-intel/ingestion';
import {
  runEngine,
  validateCohort,
  type CohortConfig,
  type UserContext,
} from '@market-intel/signal-engine';
import { formatBatch, type TelegramSender } from '@market-intel/telegram';
import { abstentionToRow, gradeToRow, rowToGradable, signalToRow } from './mapping.js';
import type { StateStore } from './state-store.js';

export interface CycleDeps {
  repos: RepositoryFactory;
  scheduler: IngestionScheduler | null; // null = ingestion ran elsewhere
  cohort: unknown;
  user: UserContext;
  stateStore: StateStore;
  telegram: TelegramSender;
  now: () => Date;
  cycleS?: number;
  /** treat every observed asset as covered (0.3 relevance floor) — useful
      until a watch/position store feeds the user context */
  coverAllObserved?: boolean;
}

export interface CycleReport {
  ingestionRuns: number;
  signalsFired: number;
  abstentions: number;
  suppressed: number;
  alertsSent: { push: boolean; queue: boolean; logOnly: number };
}

export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const now = deps.now();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const cohort: CohortConfig = validateCohort(deps.cohort);

  // 1. ingestion (due jobs only; failures isolated per job)
  let ingestionRuns = 0;
  if (deps.scheduler) {
    const runs = await deps.scheduler.tick(now);
    ingestionRuns = runs.length;
  }

  // 2. deterministic feature prep
  const facts = await buildFactSet(deps.repos, { now, cycleS: deps.cycleS ?? 1800 });

  // 3. detection
  const state = await deps.stateStore.load();
  const user = deps.coverAllObserved
    ? {
        ...deps.user,
        covered_asset_uids: [
          ...new Set([
            ...deps.user.covered_asset_uids,
            ...facts.observations.map((o) => o.asset.asset_uid),
          ]),
        ].sort(),
      }
    : deps.user;
  const result = runEngine(facts, { now: nowUnix, cohort, state, user });

  // 4. persistence — signals immutable, abstentions first-class
  for (const s of result.signals) {
    await deps.repos.signals.upsert(signalToRow(s));
  }
  for (const a of result.abstentions) {
    await deps.repos.signals.upsert(signalToRow(a));
    const row = abstentionToRow(a);
    if (!(await deps.repos.abstentions.exists(row.id))) {
      await deps.repos.abstentions.insert(row);
    }
  }

  // 5. tiered alerting: P0 push, P1 queue, P2 log-only (spec §3.4)
  const batch = formatBatch(result.signals, nowUnix);
  let pushSent = false;
  let queueSent = false;
  if (batch.push) pushSent = (await deps.telegram.send(batch.push)).ok;
  if (batch.queue) queueSent = (await deps.telegram.send(batch.queue)).ok;

  // 6. persist deterministic state for the next cycle
  await deps.stateStore.save(result.state);

  return {
    ingestionRuns,
    signalsFired: result.signals.length,
    abstentions: result.abstentions.length,
    suppressed: result.suppressed,
    alertsSent: { push: pushSent, queue: queueSent, logOnly: batch.logOnlyCount },
  };
}

// ---------------------------------------------------------------------------
// Grading runner
// ---------------------------------------------------------------------------

export interface GradeDeps {
  repos: RepositoryFactory;
  cohort: unknown;
  now: () => Date;
  /** bar interval the stored series approximates, seconds */
  barIntervalS?: number;
}

export interface GradeReport {
  considered: number;
  graded: number;
  skippedNotDue: number;
  records: GradeRecord[];
}

/**
 * Grade every fired signal whose horizon has elapsed and which has no grade
 * yet. Bars come from the canonical observation series; observation rows carry
 * a single price, so bars are flat (o=h=l=c) — conservative first-touch, no
 * intrabar wicks. Swap in real OHLC candles when candle ingestion lands.
 */
export async function gradeDue(deps: GradeDeps): Promise<GradeReport> {
  const now = deps.now();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const cohort = validateCohort(deps.cohort);
  const report: GradeReport = { considered: 0, graded: 0, skippedNotDue: 0, records: [] };

  const candidates = await deps.repos.signals.getForGrading(new Date(0));
  for (const row of candidates) {
    report.considered += 1;
    const detected = Math.floor(row.detected_time.getTime() / 1000);
    const horizonEnd = detected + row.horizon_seconds;
    if (horizonEnd > nowUnix) {
      report.skippedNotDue += 1;
      continue;
    }
    if (await deps.repos.grades.findBySignalId(row.signal_id)) continue; // append-only, no regrade here

    // prefer real OHLC candles (true first-touch, intrabar wicks); fall back
    // to flat bars from observation points when no candles are stored
    const candleSeries = await deps.repos.candles.getSeries(
      row.asset_uid,
      row.venue,
      '1h',
      row.detected_time,
      new Date(horizonEnd * 1000),
    );
    let bars: Bar[];
    let barsSource: string;
    let finerBars: Bar[] | undefined;
    if (candleSeries.length > 0) {
      bars = candleSeries
        .map((c) => ({
          t: Math.floor(c.open_time.getTime() / 1000),
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
        }))
        .filter((b) => b.t >= detected && b.t <= horizonEnd);
      barsSource = `${row.venue}:1h`;
      // finer bars for AMBIGUOUS resolution, if stored
      const finer = await deps.repos.candles.getSeries(
        row.asset_uid,
        row.venue,
        '5m',
        row.detected_time,
        new Date(horizonEnd * 1000),
      );
      finerBars = finer.length
        ? finer.map((c) => ({
            t: Math.floor(c.open_time.getTime() / 1000),
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close,
          }))
        : undefined;
    } else {
      const series = await deps.repos.observations.getPriceSeries(
        row.asset_uid,
        row.venue,
        '1h',
        row.detected_time,
        new Date(horizonEnd * 1000),
      );
      bars = toBars(series, detected, horizonEnd);
      barsSource = `${row.venue}:obs`;
    }

    const haircut =
      row.asset_class === 'crypto' ? cohort.haircut_r.crypto : cohort.haircut_r.stock;
    const record = gradeSignal({
      signal: rowToGradable(row),
      bars,
      barsSource,
      barIntervalS: deps.barIntervalS ?? 3600,
      gradedAt: nowUnix,
      haircutR: haircut,
      finerBars,
      baselineBars: await baselineBars(deps.repos, row, detected),
    });

    await deps.repos.grades.insert(gradeToRow(record));
    report.graded += 1;
    report.records.push(record);
  }
  return report;
}

function toBars(series: ObservationRow[], startS: number, endS: number): Bar[] {
  return series
    .map((o) => ({
      t: Math.floor(o.event_time.getTime() / 1000),
      o: o.price,
      h: o.price,
      l: o.price,
      c: o.price,
    }))
    .filter((b) => b.t >= startS && b.t <= endS)
    .sort((a, b) => a.t - b.t);
}

async function baselineBars(
  repos: RepositoryFactory,
  row: SignalRow,
  detectedS: number,
): Promise<Bar[]> {
  if (row.direction !== 'neutral') return [];
  const span = row.horizon_seconds;
  const series = await repos.observations.getPriceSeries(
    row.asset_uid,
    row.venue,
    '1h',
    new Date((detectedS - span) * 1000),
    new Date(detectedS * 1000),
  );
  return toBars(series, detectedS - span, detectedS);
}
