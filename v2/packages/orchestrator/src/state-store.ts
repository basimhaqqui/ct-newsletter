// Engine state persistence between cycles (cooldowns, novelty EMAs, mention
// baselines, active divergences). Interface + in-memory + JSON-file impls.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState, type EngineState } from '@market-intel/signal-engine';

export interface StateStore {
  load(): Promise<EngineState>;
  save(state: EngineState): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  private state: EngineState = emptyState();
  async load(): Promise<EngineState> {
    return JSON.parse(JSON.stringify(this.state)) as EngineState;
  }
  async save(state: EngineState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state)) as EngineState;
  }
}

/** v1-style state file (state/*.json), atomic enough for a single runner. */
export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}
  async load(): Promise<EngineState> {
    if (!existsSync(this.path)) return emptyState();
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as EngineState;
    } catch {
      return emptyState();
    }
  }
  async save(state: EngineState): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2) + '\n');
  }
}
