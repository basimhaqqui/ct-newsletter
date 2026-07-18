-- Migration 011: Create abstentions table
-- Explicit abstention records for calibration and audit trail

CREATE TABLE IF NOT EXISTS abstentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id TEXT NOT NULL UNIQUE,           -- the signal that was abstained
    cohort_version TEXT NOT NULL,
    family_id TEXT NOT NULL,
    asset_uid TEXT NOT NULL REFERENCES assets(asset_uid),
    direction TEXT NOT NULL CHECK (direction IN ('long', 'short', 'neutral')),
    reason TEXT NOT NULL,                     -- 'NO_SETUP', 'SOURCE_DEGRADED', 'NO_PERSONAL_LINK', 'PRICE_UNAVAILABLE', 'LIQUIDITY_FLOOR', 'DIRECTION_AMBIGUOUS', 'LATENCY_EXCEEDED', 'COOLDOWN_ACTIVE'
    reason_detail JSONB DEFAULT '{}',         -- additional context
    event_time TIMESTAMPTZ NOT NULL,
    observed_time TIMESTAMPTZ NOT NULL,
    detected_time TIMESTAMPTZ NOT NULL,       -- when abstention decision made
    evidence_ref_ids TEXT[] NOT NULL DEFAULT '{}',  -- evidence that was available
    partial_scores JSONB,                     -- scores computed before abstaining
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abstentions_asset_detected ON abstentions(asset_uid, detected_time);
CREATE INDEX IF NOT EXISTS idx_abstentions_reason ON abstentions(reason);
CREATE INDEX IF NOT EXISTS idx_abstentions_cohort ON abstentions(cohort_version);
CREATE INDEX IF NOT EXISTS idx_abstentions_family ON abstentions(family_id);
CREATE INDEX IF NOT EXISTS idx_abstentions_signal ON abstentions(signal_id);