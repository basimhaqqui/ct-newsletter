// Repository interfaces for database operations
// These define the contract for data access - implementations use pg directly

import type { Asset } from '@contracts/core';

/**
 * Base repository interface with common operations
 */
export interface BaseRepository<T, ID> {
  findById(id: ID): Promise<T | null>;
  findAll(): Promise<T[]>;
  insert(entity: T): Promise<T>;
  update(entity: T): Promise<T>;
  delete(id: ID): Promise<boolean>;
  exists(id: ID): Promise<boolean>;
}

/**
 * Assets repository
 */
export interface AssetsRepository extends BaseRepository<Asset, string> {
  findBySymbol(symbol: string, venue: string): Promise<Asset | null>;
  findByType(type: Asset['type']): Promise<Asset[]>;
  findBySector(sector: string): Promise<Asset[]>;
  upsert(asset: Asset): Promise<Asset>;
  search(query: string): Promise<Asset[]>;
}

/**
 * Raw snapshots repository
 */
export interface RawSnapshotsRepository extends BaseRepository<RawSnapshotRow, string> {
  findBySource(source: string, limit?: number, offset?: number): Promise<RawSnapshotRow[]>;
  findByAsset(assetUid: string, limit?: number): Promise<RawSnapshotRow[]>;
  findByTimeRange(start: Date, end: Date): Promise<RawSnapshotRow[]>;
  findByQuality(quality: 'ok' | 'degraded' | 'stale'): Promise<RawSnapshotRow[]>;
  countBySource(source: string): Promise<number>;
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export interface RawSnapshotRow {
  id: string;
  source: string;
  source_record_id: string;
  asset_uid: string | null;
  event_time: Date;
  observed_time: Date;
  ingested_time: Date;
  payload: Record<string, unknown>;
  payload_hash: string;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
  metadata: Record<string, unknown>;
}

/**
 * Observations repository
 */
export interface ObservationsRepository extends BaseRepository<ObservationRow, string> {
  findByAsset(assetUid: string, limit?: number): Promise<ObservationRow[]>;
  findByAssetAndTimeRange(assetUid: string, start: Date, end: Date): Promise<ObservationRow[]>;
  findLatestByAsset(assetUid: string): Promise<ObservationRow | null>;
  findByVenueAndInterval(venue: string, interval: string, limit?: number): Promise<ObservationRow[]>;
  bulkInsert(observations: ObservationRow[]): Promise<number>;
  getPriceSeries(assetUid: string, venue: string, interval: string, start: Date, end: Date): Promise<ObservationRow[]>;
}

export interface ObservationRow {
  id: string;
  asset_uid: string;
  symbol: string;
  venue: string;
  price: number;
  bid: number | null;
  ask: number | null;
  mark_price: number | null;
  index_price: number | null;
  funding_rate: number | null;
  funding_rate_annualized: number | null;
  open_interest: number | null;
  open_interest_usd: number | null;
  volume_24h: number | null;
  volume_24h_usd: number | null;
  basis: number | null;
  basis_annualized: number | null;
  event_time: Date;
  observed_time: Date;
  ingested_time: Date;
  source: string;
  source_record_id: string;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
}

/**
 * Positioning events repository
 */
export interface PositioningEventsRepository extends BaseRepository<PositioningEventRow, string> {
  findByAsset(assetUid: string, limit?: number): Promise<PositioningEventRow[]>;
  findByWallet(walletAddress: string): Promise<PositioningEventRow[]>;
  findByFiler(filerName: string): Promise<PositioningEventRow[]>;
  findByType(eventType: PositioningEventRow['event_type']): Promise<PositioningEventRow[]>;
  findByTimeRange(start: Date, end: Date): Promise<PositioningEventRow[]>;
  getWhalePositions(assetUid: string): Promise<PositioningEventRow[]>;
  getLeaderboardAggregates(): Promise<PositioningEventRow[]>;
  getInsiderFilings(assetUid?: string): Promise<PositioningEventRow[]>;
  getCongressionalDisclosures(assetUid?: string): Promise<PositioningEventRow[]>;
}

export interface PositioningEventRow {
  id: string;
  asset_uid: string;
  event_type: 'whale_position' | 'leaderboard_aggregate' | 'insider_form4' | 'congressional_disclosure' | 'thirteen_f' | 'wallet_transfer';
  direction: 'long' | 'short' | 'buy' | 'sell' | 'neutral';
  size: number;
  notional_usd: number | null;
  entry_price: number | null;
  leverage: number | null;
  wallet_address: string | null;
  wallet_label: string | null;
  filer_name: string | null;
  filer_cik: string | null;
  filing_accession: string | null;
  filing_date: Date | null;
  transaction_date: Date | null;
  is_derivative: boolean;
  expiration_date: Date | null;
  strike_price: number | null;
  option_type: 'call' | 'put' | null;
  raw_data: Record<string, unknown>;
  source: string;
  source_record_id: string;
  event_time: Date;
  observed_time: Date;
  ingested_time: Date;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
}

/**
 * Catalysts repository
 */
export interface CatalystsRepository extends BaseRepository<CatalystRow, string> {
  findByAsset(assetUid: string, limit?: number): Promise<CatalystRow[]>;
  findByType(catalystType: CatalystRow['catalyst_type']): Promise<CatalystRow[]>;
  findUpcoming(limit?: number): Promise<CatalystRow[]>; // scheduled > now
  findByTimeRange(start: Date, end: Date): Promise<CatalystRow[]>;
  findByStatus(status: CatalystRow['status']): Promise<CatalystRow[]>;
  getSurprises(since: Date): Promise<CatalystRow[]>; // actual_time != scheduled_time
  upsert(catalyst: CatalystRow): Promise<CatalystRow>;
}

export interface CatalystRow {
  id: string;
  catalyst_id: string;
  catalyst_type: 'earnings' | 'fomc' | 'cpi' | 'ppi' | 'nfp' | 'token_unlock' | 'mainnet_launch' | 'protocol_upgrade' | 'token_generation_event' | 'exchange_listing' | 'sec_filing_deadline' | 'congressional_deadline' | 'options_expiry' | 'index_rebalance' | 'dividend_ex_date' | 'stock_split' | 'merger_acquisition' | 'other';
  asset_uid: string;
  title: string;
  description: string | null;
  impact: 'high' | 'medium' | 'low';
  status: 'scheduled' | 'live' | 'completed' | 'cancelled' | 'surprise';
  scheduled_time: Date;
  actual_time: Date | null;
  settle_time: Date | null;
  consensus_estimate: Record<string, unknown> | null;
  actual_value: Record<string, unknown> | null;
  surprise_pct: number | null;
  source: string;
  source_record_id: string;
  event_time: Date;
  observed_time: Date;
  ingested_time: Date;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
  metadata: Record<string, unknown>;
}

/**
 * Social claims repository
 */
export interface SocialClaimsRepository extends BaseRepository<SocialClaimRow, string> {
  findByAsset(assetUid: string, limit?: number): Promise<SocialClaimRow[]>;
  findByAuthor(authorHandle: string): Promise<SocialClaimRow[]>;
  findByPlatform(platform: SocialClaimRow['platform']): Promise<SocialClaimRow[]>;
  findByTimeRange(start: Date, end: Date): Promise<SocialClaimRow[]>;
  findMentionsSpike(assetUid: string, windowMinutes: number): Promise<SocialClaimRow[]>;
  findByContentHash(contentHash: string): Promise<SocialClaimRow | null>;
  getTopEngagement(limit: number): Promise<SocialClaimRow[]>;
}

export interface SocialClaimRow {
  id: string;
  claim_id: string;
  asset_uids: string[];
  cashtags: string[];
  hashtags: string[];
  author_id: string;
  author_handle: string;
  author_followers: number | null;
  author_verified: boolean;
  content: string;
  content_hash: string;
  platform: 'x' | 'reddit' | 'discord' | 'telegram' | 'youtube' | 'farcaster' | 'lens';
  post_type: 'post' | 'reply' | 'quote' | 'retweet' | 'thread' | 'video' | 'image' | null;
  engagement: Record<string, unknown>;
  sentiment_score: number | null;
  sentiment_label: 'bullish' | 'bearish' | 'neutral' | 'mixed' | null;
  language: string;
  urls: string[];
  media_urls: string[];
  parent_claim_id: string | null;
  conversation_id: string | null;
  source: string;
  source_record_id: string;
  event_time: Date;
  observed_time: Date;
  ingested_time: Date;
  quality: 'ok' | 'degraded' | 'stale';
  evidence_ref_ids: string[];
  metadata: Record<string, unknown>;
}

/**
 * Evidence refs repository
 */
export interface EvidenceRefsRepository extends BaseRepository<EvidenceRefRow, string> {
  findByAsset(assetUid: string): Promise<EvidenceRefRow[]>;
  findByKind(kind: EvidenceRefRow['kind']): Promise<EvidenceRefRow[]>;
  findBySource(source: string): Promise<EvidenceRefRow[]>;
  findByIds(ids: string[]): Promise<EvidenceRefRow[]>;
  findByTimeRange(start: Date, end: Date): Promise<EvidenceRefRow[]>;
}

export interface EvidenceRefRow {
  id: string;
  evidence_id: string;
  kind: 'observation' | 'positioning_event' | 'social_claim' | 'catalyst' | 'filing' | 'document' | 'link' | 'media' | 'onchain_tx';
  source: string;
  source_record_id: string;
  asset_uids: string[];
  url: string | null;
  title: string | null;
  description: string | null;
  content_hash: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  event_time: Date;
  observed_time: Date;
  ingested_time: Date;
  quality: 'ok' | 'degraded' | 'stale';
  metadata: Record<string, unknown>;
}

/**
 * Source health repository
 */
export interface SourceHealthRepository extends BaseRepository<SourceHealthRow, string> {
  findByStatus(status: SourceHealthRow['status']): Promise<SourceHealthRow[]>;
  updateHealth(sourceId: string, updates: Partial<SourceHealthRow>): Promise<SourceHealthRow>;
  recordError(sourceId: string, error: { type: string; message: string; timestamp: Date; metadata?: Record<string, unknown> }): Promise<void>;
  recordSuccess(sourceId: string, latencyMs: number): Promise<void>;
}

export interface SourceHealthRow {
  id: string;
  source_id: string;
  source_name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  last_checked: Date;
  last_success: Date | null;
  last_failure: Date | null;
  consecutive_failures: number;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  rate_limit_remaining: number | null;
  rate_limit_reset: Date | null;
  errors: Array<{ type: string; message: string; timestamp: Date; metadata?: Record<string, unknown> }>;
  config: Record<string, unknown>;
  sla: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Jobs repository
 */
export interface JobsRepository extends BaseRepository<JobRow, string> {
  findByStatus(status: JobRow['status']): Promise<JobRow[]>;
  findPending(limit?: number): Promise<JobRow[]>;
  findByType(type: string): Promise<JobRow[]>;
  findRetryable(): Promise<JobRow[]>;
  claimJob(jobId: string, lockToken: string): Promise<JobRow | null>;
  releaseJob(jobId: string, lockToken: string): Promise<boolean>;
  completeJob(jobId: string, result: Record<string, unknown>): Promise<JobRow>;
  failJob(jobId: string, error: string, nextRetryAt?: Date): Promise<JobRow>;
  cleanupOlderThan(cutoff: Date): Promise<number>;
}

export interface JobRow {
  id: string;
  job_id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled';
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  scheduled_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
  lock_token: string | null;
  locked_at: Date | null;
}

/**
 * Signals repository
 */
export interface SignalsRepository extends BaseRepository<SignalRow, string> {
  findByAsset(assetUid: string, limit?: number): Promise<SignalRow[]>;
  findByFamily(familyId: string): Promise<SignalRow[]>;
  findByCohort(cohortVersion: string): Promise<SignalRow[]>;
  findActive(limit?: number): Promise<SignalRow[]>; // not abstained
  findAbstained(limit?: number): Promise<SignalRow[]>;
  findByTimeRange(start: Date, end: Date): Promise<SignalRow[]>;
  findByDedupeKey(dedupeKey: string): Promise<SignalRow | null>;
  getForGrading(since: Date): Promise<SignalRow[]>;
  getPrioritySignals(limit: number): Promise<SignalRow[]>;
  upsert(signal: SignalRow): Promise<SignalRow>;
}

export interface SignalRow {
  id: string;
  signal_id: string;
  schema_version: string;
  cohort_version: string;
  family_id: string;
  dimension: 'positioning' | 'crowd' | 'catalyst';
  asset_class: 'crypto' | 'stock';
  asset_uid: string;
  symbol: string;
  venue: string;
  direction: 'long' | 'short' | 'neutral';
  event_time: Date;
  observed_time: Date;
  detected_time: Date;
  source_latency_seconds: number;
  trigger_rule: string;
  trigger_inputs: Record<string, unknown>;
  reference_price: number;
  target_price: number | null;
  invalidation_price: number | null;
  atr_ref: number | null;
  target_r_multiple: number | null;
  horizon_class: string;
  horizon_seconds: number;
  severity_score: number | null;
  novelty_score: number | null;
  personal_relevance_score: number | null;
  priority_score: number | null;
  evidence_ref_ids: string[];
  abstained: boolean;
  abstention_reason: string | null;
  origin: 'deterministic' | 'llm';
  narration_text: string | null;
  narration_model: string | null;
  narration_prompt_hash: string | null;
  narration_origin: 'llm' | null;
  created_at: Date;
}

/**
 * Abstentions repository
 */
export interface AbstentionsRepository extends BaseRepository<AbstentionRow, string> {
  findBySignalId(signalId: string): Promise<AbstentionRow | null>;
  findByAsset(assetUid: string): Promise<AbstentionRow[]>;
  findByReason(reason: string): Promise<AbstentionRow[]>;
  findByCohort(cohortVersion: string): Promise<AbstentionRow[]>;
  findByFamily(familyId: string): Promise<AbstentionRow[]>;
  countByReason(): Promise<Record<string, number>>;
}

export interface AbstentionRow {
  id: string;
  signal_id: string;
  cohort_version: string;
  family_id: string;
  asset_uid: string;
  direction: 'long' | 'short' | 'neutral';
  reason: string;
  reason_detail: Record<string, unknown>;
  event_time: Date;
  observed_time: Date;
  detected_time: Date;
  evidence_ref_ids: string[];
  partial_scores: Record<string, unknown> | null;
  created_at: Date;
}

/**
 * Grades repository
 */
export interface GradesRepository extends BaseRepository<GradeRow, string> {
  findBySignalId(signalId: string): Promise<GradeRow | null>;
  findByCohort(cohortVersion: string): Promise<GradeRow[]>;
  findByOutcome(outcome: GradeRow['outcome']): Promise<GradeRow[]>;
  findByTimeRange(start: Date, end: Date): Promise<GradeRow[]>;
  getStats(cohortVersion: string): Promise<GradeStats>;
  getFamilyStats(cohortVersion: string, familyId: string): Promise<GradeStats>;
}

export interface GradeRow {
  id: string;
  grade_id: string;
  signal_id: string;
  cohort_version: string;
  graded_at: Date;
  horizon_end: Date;
  outcome: 'TARGET_HIT' | 'INVALIDATED' | 'TIMEOUT_WIN' | 'TIMEOUT_LOSS' | 'AMBIGUOUS' | 'NOT_GRADED';
  mfe_abs: number | null;
  mfe_pct: number | null;
  mfe_r: number | null;
  mae_abs: number | null;
  mae_pct: number | null;
  mae_r: number | null;
  realized_r: number | null;
  haircut_r: number | null;
  end_price: number | null;
  end_r: number | null;
  bars_source: string;
  bars_count: number | null;
  grader_version: string;
  origin: 'deterministic';
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface GradeStats {
  total: number;
  byOutcome: Record<string, number>;
  avgMfeR: number;
  avgMaeR: number;
  avgRealizedR: number;
  winRate: number;
  hitRate: number;
}

/**
 * Outbox repository
 */
export interface OutboxRepository extends BaseRepository<OutboxRow, string> {
  findUnpublished(limit?: number): Promise<OutboxRow[]>;
  findByAggregate(aggregateType: string, aggregateId: string): Promise<OutboxRow[]>;
  markPublished(eventId: string): Promise<OutboxRow>;
  markFailed(eventId: string, error: string, nextRetryAt: Date): Promise<OutboxRow>;
  cleanupPublishedOlderThan(cutoff: Date): Promise<number>;
}

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
  published: boolean;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_retry_at: Date | null;
}

/**
 * Candles repository — OHLC bars for grading (true first-touch ordering)
 */
export interface CandlesRepository extends BaseRepository<CandleRow, string> {
  upsertMany(candles: CandleRow[]): Promise<number>;
  getSeries(
    assetUid: string,
    venue: string,
    interval: string,
    start: Date,
    end: Date,
  ): Promise<CandleRow[]>;
  latestOpenTime(assetUid: string, venue: string, interval: string): Promise<Date | null>;
}

export interface CandleRow {
  id: string;
  asset_uid: string;
  symbol: string;
  venue: string;
  bar_interval: string;
  open_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
  quality: 'ok' | 'degraded' | 'stale';
  ingested_time: Date;
}

/**
 * Repository factory interface - implemented by the concrete database layer
 */
export interface RepositoryFactory {
  assets: AssetsRepository;
  rawSnapshots: RawSnapshotsRepository;
  observations: ObservationsRepository;
  positioningEvents: PositioningEventsRepository;
  catalysts: CatalystsRepository;
  socialClaims: SocialClaimsRepository;
  evidenceRefs: EvidenceRefsRepository;
  sourceHealth: SourceHealthRepository;
  jobs: JobsRepository;
  signals: SignalsRepository;
  abstentions: AbstentionsRepository;
  grades: GradesRepository;
  outbox: OutboxRepository;
  candles: CandlesRepository;
  
  // Transaction support
  transaction<T>(fn: (factory: RepositoryFactory) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}