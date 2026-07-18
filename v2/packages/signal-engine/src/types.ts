// Signal engine core types — mirrors docs/specs/signal-and-grading-spec.md §1–§3.
// The engine is PURE: facts + state + cohort + injected clock in, signals/abstentions
// + new state out. No I/O, no Date.now(), no randomness.

export type FamilyId =
  | 'POS_WHALE_CONSENSUS'
  | 'POS_WHALE_FLIP'
  | 'POS_SMARTMONEY_SHIFT'
  | 'POS_INSIDER_CLUSTER'
  | 'POS_CONGRESS_DISCLOSURE'
  | 'CROWD_DIVERGENCE'
  | 'CROWD_MENTION_SPIKE'
  | 'CROWD_FUNDING_EXTREME'
  | 'CATALYST_UPCOMING'
  | 'CATALYST_SURPRISE'
  | 'TA_SETUP';

export type Dimension = 'positioning' | 'crowd' | 'catalyst';
export type AssetClass = 'crypto' | 'stock';
export type Direction = 'long' | 'short' | 'neutral';
export type Quality = 'ok' | 'degraded' | 'stale';

export const FAMILY_DIMENSION: Record<FamilyId, Dimension> = {
  POS_WHALE_CONSENSUS: 'positioning',
  POS_WHALE_FLIP: 'positioning',
  POS_SMARTMONEY_SHIFT: 'positioning',
  POS_INSIDER_CLUSTER: 'positioning',
  POS_CONGRESS_DISCLOSURE: 'positioning',
  CROWD_DIVERGENCE: 'crowd',
  CROWD_MENTION_SPIKE: 'crowd',
  CROWD_FUNDING_EXTREME: 'crowd',
  CATALYST_UPCOMING: 'catalyst',
  CATALYST_SURPRISE: 'catalyst',
  TA_SETUP: 'crowd',
};

// ---------------------------------------------------------------------------
// Fact inputs (normalized, all times Unix seconds UTC — spec §2.2)
// ---------------------------------------------------------------------------

export interface FactTimes {
  event_time: number; // when the fact became true at the source
  observed_time: number; // when the pipeline saw it
}

export interface AssetRef {
  asset_uid: string; // canonical, e.g. "crypto:hl:HYPE" | "stock:us:AAPL"
  symbol: string;
  venue: string;
  asset_class: AssetClass;
}

/** Market observation (price/funding/OI) — from ObservationsRepository. */
export interface ObservationFact extends FactTimes {
  kind: 'observation';
  asset: AssetRef;
  price: number;
  funding_annual_pct: number | null; // annualized funding, percent
  open_interest_usd: number | null;
  volume_24h_usd: number | null;
  quality: Quality;
  evidence_ref: string;
}

/** A tracked-wallet or leaderboard position snapshot / filing event. */
export interface PositioningFact extends FactTimes {
  kind: 'positioning';
  asset: AssetRef;
  event_type:
    | 'whale_position'
    | 'leaderboard_aggregate'
    | 'insider_form4'
    | 'congressional_disclosure';
  direction: 'long' | 'short' | 'buy' | 'sell' | 'neutral';
  notional_usd: number;
  actor_id: string; // wallet address | filer CIK | member id
  actor_label: string | null;
  // leaderboard_aggregate only:
  pct_long: number | null;
  trader_count: number | null;
  net_notional_usd: number | null;
  quality: Quality;
  evidence_ref: string;
}

/** Cashtag mention-velocity aggregate for one asset over the scan window. */
export interface MentionFact extends FactTimes {
  kind: 'mention';
  asset: AssetRef;
  mention_count: number; // viral mentions this window
  quality: Quality;
  evidence_ref: string;
  top_claim_refs: string[];
}

export interface CatalystFact extends FactTimes {
  kind: 'catalyst';
  asset: AssetRef;
  catalyst_type: string;
  scheduled_time: number;
  actual_time: number | null;
  surprise_pct: number | null; // realized vs consensus, when known
  status: 'scheduled' | 'live' | 'completed' | 'cancelled' | 'surprise';
  quality: Quality;
  evidence_ref: string;
}

/** Deterministic multi-timeframe TA read — numbers only, computed upstream. */
export interface TaFact extends FactTimes {
  kind: 'ta';
  asset: AssetRef;
  price: number;
  rsi_1d: number;
  trend_1d: 'up' | 'down' | 'mixed';
  macd_hist_1d: number;
  atr_1d: number;
  high_30d: number;
  low_30d: number;
  support: number | null;
  resistance: number | null;
  oi_rising: boolean | null;
  quality: Quality;
  evidence_ref: string;
}

export type Fact =
  | ObservationFact
  | PositioningFact
  | MentionFact
  | CatalystFact
  | TaFact;

/** Everything one detection cycle sees. */
export interface FactSet {
  observations: ObservationFact[];
  positioning: PositioningFact[];
  mentions: MentionFact[];
  catalysts: CatalystFact[];
  ta: TaFact[];
  /** Previous-cycle whale net side per asset_uid, for POS_WHALE_FLIP. */
  prev_whale_positions: PositioningFact[];
  source_health: Record<string, Quality>; // source name -> health
}

// ---------------------------------------------------------------------------
// Cohort config (frozen, versioned — spec §5.4)
// ---------------------------------------------------------------------------

export interface HorizonSpec {
  kind: 'wallclock' | 'trading_days' | 'event_settle';
  seconds?: number;
  days?: number;
  settle_s?: number;
}

export interface CohortConfig {
  version: string;
  schema_version: string;
  families: Record<string, Record<string, unknown>>;
  scoring_weights: { w_sev: number; w_nov: number; w_rel: number };
  alert_tiers: { tier_hi: number; tier_mid: number };
  extreme_severity_floor: number;
  novelty_decay: number;
  horizons: Record<string, HorizonSpec>;
  family_horizons: Record<FamilyId, string>;
  haircut_r: { crypto: number; stock: number };
  baselines: string[];
}

// ---------------------------------------------------------------------------
// Detector state (deterministic, persisted between cycles — spec §2.5, §3.2)
// ---------------------------------------------------------------------------

export interface EngineState {
  /** idempotency/cooldown: dedupe key -> unix time last fired */
  cooldowns: Record<string, number>;
  /** novelty EMA: family|asset|direction -> decayed fire count */
  novelty: Record<string, number>;
  /** mention-spike rolling EMA baseline per asset_uid */
  mention_baseline: Record<string, number>;
  /** active divergence keys (asset|bull / asset|bear), v1 semantics */
  active_divergences: string[];
}

export function emptyState(): EngineState {
  return { cooldowns: {}, novelty: {}, mention_baseline: {}, active_divergences: [] };
}

// ---------------------------------------------------------------------------
// User context for personal relevance (spec §3.3)
// ---------------------------------------------------------------------------

export interface UserContext {
  tracked_asset_uids: string[]; // tracked set, open positions, active /watch
  cluster_asset_uids: string[]; // same sector/narrative as a held asset
  covered_asset_uids: string[]; // covered universe
}

// ---------------------------------------------------------------------------
// Outputs (spec §2.1)
// ---------------------------------------------------------------------------

export interface EvidenceRef {
  kind: 'observation' | 'positioning_event' | 'social_claim' | 'catalyst' | 'filing';
  source: string;
  ref: string;
  event_time: number;
  observed_time: number;
  quality: Quality;
  url?: string;
}

export interface SignalLevels {
  reference_price: number;
  target: number | null;
  invalidation: number | null;
  atr_ref: number | null;
  target_r_multiple: number | null;
}

export interface SignalScores {
  severity: number;
  novelty: number;
  personal_relevance: number;
  priority: number;
}

export type AlertTier = 'P0' | 'P1' | 'P2';

export interface Signal {
  signal_id: string;
  idempotency_key: string;
  schema_version: string;
  cohort_version: string;
  family_id: FamilyId;
  dimension: Dimension;
  asset_class: AssetClass;
  asset: AssetRef;
  direction: Direction;
  event_time: number;
  observed_time: number;
  detected_time: number;
  source_latency_s: number;
  trigger: { rule: string; inputs: Record<string, number | string | boolean> };
  levels: SignalLevels;
  horizon: { class: string; seconds: number };
  scores: SignalScores;
  tier: AlertTier;
  evidence: EvidenceRef[];
  abstained: boolean;
  abstention_reason: string | null;
  origin: 'deterministic';
}

/** Raw candidate emitted by a family detector, before scoring/dedupe. */
export interface Candidate {
  family_id: FamilyId;
  asset: AssetRef;
  direction: Direction;
  event_time: number;
  observed_time: number;
  trigger: { rule: string; inputs: Record<string, number | string | boolean> };
  /** family-specific severity in [0,1] — spec §3.1 */
  severity: number;
  evidence: EvidenceRef[];
  /** reference price if the family computed one; orchestrator cross-checks */
  reference_price: number | null;
  atr_ref: number | null;
  target: number | null;
  invalidation: number | null;
  /** deterministic abstention raised inside the family (e.g. NO_SETUP) */
  abstain_reason: string | null;
  /** dedupe bucket discriminator (defaults to '') */
  trigger_bucket?: string;
}

export interface EngineResult {
  signals: Signal[]; // fired (alertable, gradable)
  abstentions: Signal[]; // abstained: true, first-class records (spec §3.5)
  suppressed: number; // dropped by dedupe/cooldown (same condition, same bucket)
  state: EngineState; // updated deterministic state
}
