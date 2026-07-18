-- Migration 010: Create signals table
-- Deterministic signals with full provenance and grading fields

CREATE TABLE IF NOT EXISTS signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id TEXT NOT NULL UNIQUE,           -- stable ULID: 'sig_<ulid>'
    schema_version TEXT NOT NULL DEFAULT 'signal/2.0.0',
    cohort_version TEXT NOT NULL,             -- e.g., 'cohort/2026.07.0'
    family_id TEXT NOT NULL,                  -- 'POS_WHALE_CONSENSUS', 'CROWD_DIVERGENCE', etc.
    dimension TEXT NOT NULL CHECK (dimension IN ('positioning', 'crowd', 'catalyst')),
    asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
    asset_uid TEXT NOT NULL REFERENCES assets(asset_uid),
    symbol TEXT NOT NULL,                     -- denormalized
    venue TEXT NOT NULL,                      -- denormalized
    direction TEXT NOT NULL CHECK (direction IN ('long', 'short', 'neutral')),
    event_time TIMESTAMPTZ NOT NULL,          -- when underlying fact became true
    observed_time TIMESTAMPTZ NOT NULL,       -- when we observed it
    detected_time TIMESTAMPTZ NOT NULL,       -- when detection ran (grading clock start)
    source_latency_seconds INTEGER NOT NULL,  -- observed_time - event_time
    trigger_rule TEXT NOT NULL,               -- e.g., 'whales_long>=3 && funding_annual<=-3'
    trigger_inputs JSONB NOT NULL,            -- {whales_long: 4, funding_annual_pct: -7.2, oi_usd: 1.2e8}
    -- Price levels (deterministic)
    reference_price NUMERIC(38, 18) NOT NULL, -- price at detected_time
    target_price NUMERIC(38, 18),             -- computed target
    invalidation_price NUMERIC(38, 18),       -- computed invalidation
    atr_ref NUMERIC(38, 18),                  -- ATR used for sizing
    target_r_multiple NUMERIC(10, 4),         -- (target-ref)/(ref-invalidation)
    -- Horizon
    horizon_class TEXT NOT NULL,              -- 'crypto_intraday', 'crypto_swing', 'stock_swing', etc.
    horizon_seconds INTEGER NOT NULL,         -- horizon in seconds
    -- Scores (deterministic, for alerting only)
    severity_score NUMERIC(4, 3),             -- 0-1
    novelty_score NUMERIC(4, 3),              -- 0-1
    personal_relevance_score NUMERIC(4, 3),   -- 0-1
    priority_score NUMERIC(4, 3),             -- combined score
    -- Evidence
    evidence_ref_ids TEXT[] NOT NULL DEFAULT '{}',
    -- Status
    abstained BOOLEAN NOT NULL DEFAULT FALSE,
    abstention_reason TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('deterministic', 'llm')),  -- MUST be deterministic
    -- Narration (optional, LLM-authored, never graded)
    narration_text TEXT,
    narration_model TEXT,
    narration_prompt_hash TEXT,
    narration_origin TEXT CHECK (narration_origin IN ('llm')),
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (signal_id)
);

CREATE INDEX IF NOT EXISTS idx_signals_asset_detected ON signals(asset_uid, detected_time);
CREATE INDEX IF NOT EXISTS idx_signals_family ON signals(family_id);
CREATE INDEX IF NOT EXISTS idx_signals_cohort ON signals(cohort_version);
CREATE INDEX IF NOT EXISTS idx_signals_abstained ON signals(abstained);
CREATE INDEX IF NOT EXISTS idx_signals_origin ON signals(origin);
CREATE INDEX IF NOT EXISTS idx_signals_priority ON signals(priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_signals_detected ON signals(detected_time);