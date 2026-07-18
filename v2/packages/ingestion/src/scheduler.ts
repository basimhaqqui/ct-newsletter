// Tick-driven job scheduler. No setInterval — the host (cron, GitHub Actions,
// a loop) calls tick(now) and due jobs run. Deterministic and test-friendly;
// failures are isolated per job and recorded in source health by the pipeline.

import type { Clock, IngestionContext, IngestionJob, IngestionResult } from './types.js';
import type { RepositoryFactory } from '@market-intel/db';

export interface SchedulerRun {
  job: string;
  result: IngestionResult | null;
  error: string | null;
}

export class IngestionScheduler {
  private readonly jobs: IngestionJob[] = [];
  private readonly lastRun = new Map<string, number>(); // job name -> unix s
  private readonly ctx: IngestionContext;

  constructor(repos: RepositoryFactory, clock: Clock = () => new Date()) {
    this.ctx = { repos, clock };
  }

  register(job: IngestionJob): void {
    if (this.jobs.some((j) => j.name === job.name)) {
      throw new Error(`duplicate job name: ${job.name}`);
    }
    this.jobs.push(job);
  }

  /** Run every job whose interval has elapsed at `now`. */
  async tick(now: Date = this.ctx.clock()): Promise<SchedulerRun[]> {
    const nowS = Math.floor(now.getTime() / 1000);
    const runs: SchedulerRun[] = [];
    for (const job of this.jobs) {
      const last = this.lastRun.get(job.name);
      if (last !== undefined && nowS - last < job.intervalS) continue;
      this.lastRun.set(job.name, nowS);
      try {
        const result = await job.run({ ...this.ctx, clock: () => now });
        runs.push({ job: job.name, result, error: null });
      } catch (err) {
        // job.run should catch internally; this is the belt-and-braces path
        runs.push({
          job: job.name,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return runs;
  }

  dueJobs(now: Date): string[] {
    const nowS = Math.floor(now.getTime() / 1000);
    return this.jobs
      .filter((j) => {
        const last = this.lastRun.get(j.name);
        return last === undefined || nowS - last >= j.intervalS;
      })
      .map((j) => j.name);
  }
}
