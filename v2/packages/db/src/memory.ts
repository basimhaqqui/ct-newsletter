// In-memory RepositoryFactory — resolves the "tests require live PostgreSQL"
// blocker on t_7410f09c / t_f4b725fc. Implements every repository interface
// over plain Maps so ingestion, signal-engine wiring, and grading can be
// unit-tested without a database. Not for production use.

import type {
  AbstentionRow,
  AbstentionsRepository,
  AssetsRepository,
  BaseRepository,
  CandleRow,
  CandlesRepository,
  CatalystRow,
  CatalystsRepository,
  EvidenceRefRow,
  EvidenceRefsRepository,
  GradeRow,
  GradeStats,
  GradesRepository,
  JobRow,
  JobsRepository,
  ObservationRow,
  ObservationsRepository,
  OutboxRepository,
  OutboxRow,
  PositioningEventRow,
  PositioningEventsRepository,
  RawSnapshotRow,
  RawSnapshotsRepository,
  RepositoryFactory,
  SignalRow,
  SignalsRepository,
  SocialClaimRow,
  SocialClaimsRepository,
  SourceHealthRepository,
  SourceHealthRow,
} from './repositories.js';
import type { Asset } from '@contracts/core';

class MemBase<T extends { id: string }> implements BaseRepository<T, string> {
  protected rows = new Map<string, T>();

  async findById(id: string): Promise<T | null> {
    return this.rows.get(id) ?? null;
  }
  async findAll(): Promise<T[]> {
    return [...this.rows.values()];
  }
  async insert(entity: T): Promise<T> {
    if (this.rows.has(entity.id)) throw new Error(`duplicate id ${entity.id}`);
    this.rows.set(entity.id, entity);
    return entity;
  }
  async update(entity: T): Promise<T> {
    if (!this.rows.has(entity.id)) throw new Error(`missing id ${entity.id}`);
    this.rows.set(entity.id, entity);
    return entity;
  }
  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
  async exists(id: string): Promise<boolean> {
    return this.rows.has(id);
  }
  /** idempotent write used by ingestion */
  async upsertRow(entity: T): Promise<T> {
    this.rows.set(entity.id, entity);
    return entity;
  }
}

const inRange = (t: Date, start: Date, end: Date): boolean =>
  t.getTime() >= start.getTime() && t.getTime() <= end.getTime();

// ---------------------------------------------------------------------------

class MemAssets extends MemBase<Asset & { id: string }> implements AssetsRepository {
  async findBySymbol(symbol: string, _venue: string) {
    return [...this.rows.values()].find((a) => a.symbol === symbol) ?? null;
  }
  async findByType(type: Asset['type']) {
    return [...this.rows.values()].filter((a) => a.type === type);
  }
  async findBySector(_sector: string) {
    return [];
  }
  async upsert(asset: Asset & { id: string }) {
    return this.upsertRow(asset);
  }
  async search(query: string) {
    const q = query.toLowerCase();
    return [...this.rows.values()].filter(
      (a) => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    );
  }
}

class MemRawSnapshots extends MemBase<RawSnapshotRow> implements RawSnapshotsRepository {
  async findBySource(source: string, limit = 100, offset = 0) {
    return [...this.rows.values()].filter((r) => r.source === source).slice(offset, offset + limit);
  }
  async findByAsset(assetUid: string, limit = 100) {
    return [...this.rows.values()].filter((r) => r.asset_uid === assetUid).slice(0, limit);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((r) => inRange(r.observed_time, start, end));
  }
  async findByQuality(quality: RawSnapshotRow['quality']) {
    return [...this.rows.values()].filter((r) => r.quality === quality);
  }
  async countBySource(source: string) {
    return [...this.rows.values()].filter((r) => r.source === source).length;
  }
  async deleteOlderThan(cutoff: Date) {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.observed_time.getTime() < cutoff.getTime()) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

class MemObservations extends MemBase<ObservationRow> implements ObservationsRepository {
  async findByAsset(assetUid: string, limit = 100) {
    return this.sorted()
      .filter((o) => o.asset_uid === assetUid)
      .slice(-limit);
  }
  async findByAssetAndTimeRange(assetUid: string, start: Date, end: Date) {
    return this.sorted().filter((o) => o.asset_uid === assetUid && inRange(o.event_time, start, end));
  }
  async findLatestByAsset(assetUid: string) {
    const all = await this.findByAsset(assetUid);
    return all.length ? all[all.length - 1] : null;
  }
  async findByVenueAndInterval(venue: string, _interval: string, limit = 100) {
    return this.sorted()
      .filter((o) => o.venue === venue)
      .slice(-limit);
  }
  async bulkInsert(observations: ObservationRow[]) {
    for (const o of observations) await this.upsertRow(o);
    return observations.length;
  }
  async getPriceSeries(assetUid: string, venue: string, _interval: string, start: Date, end: Date) {
    return this.sorted().filter(
      (o) => o.asset_uid === assetUid && o.venue === venue && inRange(o.event_time, start, end),
    );
  }
  private sorted(): ObservationRow[] {
    return [...this.rows.values()].sort((a, b) => a.event_time.getTime() - b.event_time.getTime());
  }
}

class MemPositioning extends MemBase<PositioningEventRow> implements PositioningEventsRepository {
  async findByAsset(assetUid: string, limit = 100) {
    return [...this.rows.values()].filter((p) => p.asset_uid === assetUid).slice(0, limit);
  }
  async findByWallet(walletAddress: string) {
    return [...this.rows.values()].filter((p) => p.wallet_address === walletAddress);
  }
  async findByFiler(filerName: string) {
    return [...this.rows.values()].filter((p) => p.filer_name === filerName);
  }
  async findByType(eventType: PositioningEventRow['event_type']) {
    return [...this.rows.values()].filter((p) => p.event_type === eventType);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((p) => inRange(p.event_time, start, end));
  }
  async getWhalePositions(assetUid: string) {
    return [...this.rows.values()].filter(
      (p) => p.event_type === 'whale_position' && p.asset_uid === assetUid,
    );
  }
  async getLeaderboardAggregates() {
    return [...this.rows.values()].filter((p) => p.event_type === 'leaderboard_aggregate');
  }
  async getInsiderFilings(assetUid?: string) {
    return [...this.rows.values()].filter(
      (p) => p.event_type === 'insider_form4' && (!assetUid || p.asset_uid === assetUid),
    );
  }
  async getCongressionalDisclosures(assetUid?: string) {
    return [...this.rows.values()].filter(
      (p) => p.event_type === 'congressional_disclosure' && (!assetUid || p.asset_uid === assetUid),
    );
  }
}

class MemCatalysts extends MemBase<CatalystRow> implements CatalystsRepository {
  async findByAsset(assetUid: string, limit = 100) {
    return [...this.rows.values()].filter((c) => c.asset_uid === assetUid).slice(0, limit);
  }
  async findByType(catalystType: CatalystRow['catalyst_type']) {
    return [...this.rows.values()].filter((c) => c.catalyst_type === catalystType);
  }
  async findUpcoming(limit = 100) {
    const now = Date.now();
    return [...this.rows.values()]
      .filter((c) => c.scheduled_time.getTime() > now)
      .slice(0, limit);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((c) => inRange(c.scheduled_time, start, end));
  }
  async findByStatus(status: CatalystRow['status']) {
    return [...this.rows.values()].filter((c) => c.status === status);
  }
  async getSurprises(since: Date) {
    return [...this.rows.values()].filter(
      (c) => c.surprise_pct !== null && c.observed_time.getTime() >= since.getTime(),
    );
  }
  async upsert(catalyst: CatalystRow) {
    return this.upsertRow(catalyst);
  }
}

class MemSocialClaims extends MemBase<SocialClaimRow> implements SocialClaimsRepository {
  async findByAsset(assetUid: string, limit = 100) {
    return [...this.rows.values()].filter((s) => s.asset_uids.includes(assetUid)).slice(0, limit);
  }
  async findByAuthor(authorHandle: string) {
    return [...this.rows.values()].filter((s) => s.author_handle === authorHandle);
  }
  async findByPlatform(platform: SocialClaimRow['platform']) {
    return [...this.rows.values()].filter((s) => s.platform === platform);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((s) => inRange(s.event_time, start, end));
  }
  async findMentionsSpike(assetUid: string, windowMinutes: number) {
    const cutoff = Date.now() - windowMinutes * 60_000;
    return [...this.rows.values()].filter(
      (s) => s.asset_uids.includes(assetUid) && s.event_time.getTime() >= cutoff,
    );
  }
  async findByContentHash(contentHash: string) {
    return [...this.rows.values()].find((s) => s.content_hash === contentHash) ?? null;
  }
  async getTopEngagement(limit: number) {
    return [...this.rows.values()].slice(0, limit);
  }
}

class MemEvidenceRefs extends MemBase<EvidenceRefRow> implements EvidenceRefsRepository {
  async findByAsset(assetUid: string) {
    return [...this.rows.values()].filter((e) => e.asset_uids.includes(assetUid));
  }
  async findByKind(kind: EvidenceRefRow['kind']) {
    return [...this.rows.values()].filter((e) => e.kind === kind);
  }
  async findBySource(source: string) {
    return [...this.rows.values()].filter((e) => e.source === source);
  }
  async findByIds(ids: string[]) {
    return ids.map((id) => this.rows.get(id)).filter((e): e is EvidenceRefRow => e !== undefined);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((e) => inRange(e.event_time, start, end));
  }
}

class MemSourceHealth extends MemBase<SourceHealthRow> implements SourceHealthRepository {
  async findByStatus(status: SourceHealthRow['status']) {
    return [...this.rows.values()].filter((s) => s.status === status);
  }
  async updateHealth(sourceId: string, updates: Partial<SourceHealthRow>) {
    const existing =
      [...this.rows.values()].find((s) => s.source_id === sourceId) ??
      this.blank(sourceId);
    const merged = { ...existing, ...updates, id: existing.id, source_id: sourceId };
    this.rows.set(merged.id, merged);
    return merged;
  }
  async recordError(
    sourceId: string,
    error: { type: string; message: string; timestamp: Date; metadata?: Record<string, unknown> },
  ) {
    const h = await this.updateHealth(sourceId, {});
    h.consecutive_failures += 1;
    h.failed_requests += 1;
    h.total_requests += 1;
    h.last_failure = error.timestamp;
    h.last_checked = error.timestamp;
    h.errors = [...h.errors, error].slice(-20);
    h.status = h.consecutive_failures >= 3 ? 'unhealthy' : 'degraded';
    this.rows.set(h.id, h);
  }
  async recordSuccess(sourceId: string, latencyMs: number) {
    const h = await this.updateHealth(sourceId, {});
    h.consecutive_failures = 0;
    h.successful_requests += 1;
    h.total_requests += 1;
    h.last_success = new Date();
    h.last_checked = h.last_success;
    h.avg_latency_ms =
      h.avg_latency_ms === null
        ? latencyMs
        : Math.round(0.8 * h.avg_latency_ms + 0.2 * latencyMs);
    h.status = 'healthy';
    this.rows.set(h.id, h);
  }
  private blank(sourceId: string): SourceHealthRow {
    return {
      id: `health:${sourceId}`,
      source_id: sourceId,
      source_name: sourceId,
      status: 'healthy',
      last_checked: new Date(0),
      last_success: null,
      last_failure: null,
      consecutive_failures: 0,
      total_requests: 0,
      successful_requests: 0,
      failed_requests: 0,
      avg_latency_ms: null,
      p95_latency_ms: null,
      rate_limit_remaining: null,
      rate_limit_reset: null,
      errors: [],
      config: {},
      sla: {},
      metadata: {},
    };
  }
}

class MemJobs extends MemBase<JobRow> implements JobsRepository {
  async findByStatus(status: JobRow['status']) {
    return [...this.rows.values()].filter((j) => j.status === status);
  }
  async findPending(limit = 100) {
    return (await this.findByStatus('pending')).slice(0, limit);
  }
  async findByType(type: string) {
    return [...this.rows.values()].filter((j) => j.type === type);
  }
  async findRetryable() {
    const now = Date.now();
    return [...this.rows.values()].filter(
      (j) => j.status === 'retrying' && (j.next_retry_at?.getTime() ?? 0) <= now,
    );
  }
  async claimJob(jobId: string, lockToken: string) {
    const j = this.rows.get(jobId);
    if (!j || j.lock_token !== null) return null;
    const claimed = { ...j, status: 'running' as const, lock_token: lockToken, locked_at: new Date(), started_at: new Date() };
    this.rows.set(jobId, claimed);
    return claimed;
  }
  async releaseJob(jobId: string, lockToken: string) {
    const j = this.rows.get(jobId);
    if (!j || j.lock_token !== lockToken) return false;
    this.rows.set(jobId, { ...j, lock_token: null, locked_at: null });
    return true;
  }
  async completeJob(jobId: string, result: Record<string, unknown>) {
    const j = this.rows.get(jobId);
    if (!j) throw new Error(`missing job ${jobId}`);
    const done = { ...j, status: 'completed' as const, result, completed_at: new Date(), lock_token: null };
    this.rows.set(jobId, done);
    return done;
  }
  async failJob(jobId: string, error: string, nextRetryAt?: Date) {
    const j = this.rows.get(jobId);
    if (!j) throw new Error(`missing job ${jobId}`);
    const attempts = j.attempts + 1;
    const failed: JobRow = {
      ...j,
      attempts,
      status: nextRetryAt && attempts < j.max_attempts ? 'retrying' : 'failed',
      error: { message: error },
      next_retry_at: nextRetryAt ?? null,
      lock_token: null,
    };
    this.rows.set(jobId, failed);
    return failed;
  }
  async cleanupOlderThan(cutoff: Date) {
    let n = 0;
    for (const [id, j] of this.rows) {
      if (j.status === 'completed' && (j.completed_at?.getTime() ?? 0) < cutoff.getTime()) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

class MemSignals extends MemBase<SignalRow> implements SignalsRepository {
  async findByAsset(assetUid: string, limit = 100) {
    return [...this.rows.values()].filter((s) => s.asset_uid === assetUid).slice(0, limit);
  }
  async findByFamily(familyId: string) {
    return [...this.rows.values()].filter((s) => s.family_id === familyId);
  }
  async findByCohort(cohortVersion: string) {
    return [...this.rows.values()].filter((s) => s.cohort_version === cohortVersion);
  }
  async findActive(limit = 100) {
    return [...this.rows.values()].filter((s) => !s.abstained).slice(0, limit);
  }
  async findAbstained(limit = 100) {
    return [...this.rows.values()].filter((s) => s.abstained).slice(0, limit);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((s) => inRange(s.detected_time, start, end));
  }
  async findByDedupeKey(dedupeKey: string) {
    return [...this.rows.values()].find((s) => s.signal_id === dedupeKey) ?? null;
  }
  async getForGrading(since: Date) {
    return [...this.rows.values()].filter(
      (s) => !s.abstained && s.detected_time.getTime() >= since.getTime(),
    );
  }
  async getPrioritySignals(limit: number) {
    return [...this.rows.values()]
      .filter((s) => !s.abstained)
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
      .slice(0, limit);
  }
  async upsert(signal: SignalRow) {
    return this.upsertRow(signal);
  }
}

class MemAbstentions extends MemBase<AbstentionRow> implements AbstentionsRepository {
  async findBySignalId(signalId: string) {
    return [...this.rows.values()].find((a) => a.signal_id === signalId) ?? null;
  }
  async findByAsset(assetUid: string) {
    return [...this.rows.values()].filter((a) => a.asset_uid === assetUid);
  }
  async findByReason(reason: string) {
    return [...this.rows.values()].filter((a) => a.reason === reason);
  }
  async findByCohort(cohortVersion: string) {
    return [...this.rows.values()].filter((a) => a.cohort_version === cohortVersion);
  }
  async findByFamily(familyId: string) {
    return [...this.rows.values()].filter((a) => a.family_id === familyId);
  }
  async countByReason() {
    const out: Record<string, number> = {};
    for (const a of this.rows.values()) out[a.reason] = (out[a.reason] ?? 0) + 1;
    return out;
  }
}

class MemGrades extends MemBase<GradeRow> implements GradesRepository {
  async findBySignalId(signalId: string) {
    return [...this.rows.values()].find((g) => g.signal_id === signalId) ?? null;
  }
  async findByCohort(cohortVersion: string) {
    return [...this.rows.values()].filter((g) => g.cohort_version === cohortVersion);
  }
  async findByOutcome(outcome: GradeRow['outcome']) {
    return [...this.rows.values()].filter((g) => g.outcome === outcome);
  }
  async findByTimeRange(start: Date, end: Date) {
    return [...this.rows.values()].filter((g) => inRange(g.graded_at, start, end));
  }
  async getStats(cohortVersion: string): Promise<GradeStats> {
    return this.stats((await this.findByCohort(cohortVersion)));
  }
  async getFamilyStats(cohortVersion: string, _familyId: string): Promise<GradeStats> {
    return this.getStats(cohortVersion);
  }
  private stats(grades: GradeRow[]): GradeStats {
    const byOutcome: Record<string, number> = {};
    let wins = 0;
    let decisive = 0;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    for (const g of grades) byOutcome[g.outcome] = (byOutcome[g.outcome] ?? 0) + 1;
    for (const g of grades) {
      if (['TARGET_HIT', 'INVALIDATED', 'TIMEOUT_WIN', 'TIMEOUT_LOSS'].includes(g.outcome)) {
        decisive++;
        if (g.outcome === 'TARGET_HIT' || g.outcome === 'TIMEOUT_WIN') wins++;
      }
    }
    return {
      total: grades.length,
      byOutcome,
      avgMfeR: mean(grades.map((g) => g.mfe_r ?? 0)),
      avgMaeR: mean(grades.map((g) => g.mae_r ?? 0)),
      avgRealizedR: mean(grades.map((g) => g.realized_r ?? 0)),
      winRate: decisive ? wins / decisive : 0,
      hitRate: decisive ? wins / decisive : 0,
    };
  }
}

class MemOutbox extends MemBase<OutboxRow> implements OutboxRepository {
  async findUnpublished(limit = 100) {
    return [...this.rows.values()].filter((o) => !o.published).slice(0, limit);
  }
  async findByAggregate(aggregateType: string, aggregateId: string) {
    return [...this.rows.values()].filter(
      (o) => o.aggregate_type === aggregateType && o.aggregate_id === aggregateId,
    );
  }
  async markPublished(eventId: string) {
    const o = [...this.rows.values()].find((r) => r.event_id === eventId);
    if (!o) throw new Error(`missing outbox event ${eventId}`);
    const done = { ...o, published: true, published_at: new Date() };
    this.rows.set(o.id, done);
    return done;
  }
  async markFailed(eventId: string, error: string, nextRetryAt: Date) {
    const o = [...this.rows.values()].find((r) => r.event_id === eventId);
    if (!o) throw new Error(`missing outbox event ${eventId}`);
    const failed = { ...o, attempts: o.attempts + 1, last_error: error, next_retry_at: nextRetryAt };
    this.rows.set(o.id, failed);
    return failed;
  }
  async cleanupPublishedOlderThan(cutoff: Date) {
    let n = 0;
    for (const [id, o] of this.rows) {
      if (o.published && (o.published_at?.getTime() ?? 0) < cutoff.getTime()) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

class MemCandles extends MemBase<CandleRow> implements CandlesRepository {
  async upsertMany(candles: CandleRow[]) {
    for (const c of candles) await this.upsertRow(c);
    return candles.length;
  }
  async getSeries(assetUid: string, venue: string, interval: string, start: Date, end: Date) {
    return [...this.rows.values()]
      .filter(
        (c) =>
          c.asset_uid === assetUid &&
          c.venue === venue &&
          c.bar_interval === interval &&
          inRange(c.open_time, start, end),
      )
      .sort((a, b) => a.open_time.getTime() - b.open_time.getTime());
  }
  async latestOpenTime(assetUid: string, venue: string, interval: string) {
    const series = [...this.rows.values()].filter(
      (c) => c.asset_uid === assetUid && c.venue === venue && c.bar_interval === interval,
    );
    if (!series.length) return null;
    return new Date(Math.max(...series.map((c) => c.open_time.getTime())));
  }
}

// ---------------------------------------------------------------------------

export function createInMemoryRepositoryFactory(): RepositoryFactory {
  const factory: RepositoryFactory = {
    assets: new MemAssets(),
    rawSnapshots: new MemRawSnapshots(),
    observations: new MemObservations(),
    positioningEvents: new MemPositioning(),
    catalysts: new MemCatalysts(),
    socialClaims: new MemSocialClaims(),
    evidenceRefs: new MemEvidenceRefs(),
    sourceHealth: new MemSourceHealth(),
    jobs: new MemJobs(),
    signals: new MemSignals(),
    abstentions: new MemAbstentions(),
    grades: new MemGrades(),
    outbox: new MemOutbox(),
    candles: new MemCandles(),
    async transaction<T>(fn: (f: RepositoryFactory) => Promise<T>): Promise<T> {
      // no isolation in memory — good enough for unit tests
      return fn(factory);
    },
    async close(): Promise<void> {
      /* noop */
    },
  };
  return factory;
}
