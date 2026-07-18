// Ingestion types (Kanban t_7410f09c). The pipeline is: poll adapter →
// RawSnapshotRow (retention) → normalize → typed rows → upsert via repos →
// deterministic feature prep (FactSet) for the signal engine.
//
// Everything is injectable: clock, adapters, repos — unit tests run without
// Postgres against the in-memory repository factory (@market-intel/db/memory).

import type {
  ObservationRow,
  PositioningEventRow,
  RawSnapshotRow,
  RepositoryFactory,
} from '@market-intel/db';

export type Clock = () => Date;

export interface TrackedWallet {
  addr: string;
  label: string;
}

export interface IngestionContext {
  repos: RepositoryFactory;
  clock: Clock;
}

export interface IngestionResult {
  source: string;
  rawSnapshots: number;
  observations: number;
  positioningEvents: number;
  errors: string[];
}

/** A pollable source pipeline. */
export interface IngestionJob {
  name: string;
  source: string;
  /** poll cadence in seconds — the runner fires when due */
  intervalS: number;
  run(ctx: IngestionContext): Promise<IngestionResult>;
}

export interface NormalizedBatch {
  raw: RawSnapshotRow[];
  observations: ObservationRow[];
  positioning: PositioningEventRow[];
}
