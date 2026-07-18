-- Migration 012: Create grades table
-- Post-horizon grading results (append-only ledger)

CREATE TABLE IF NOT EXISTS grades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grade_id TEXT NOT NULL UNIQUE,            -- 'grd_<ulid>'
    signal_id TEXT NOT NULL REFERENCES signals(signal_id), -- reference to signal
    cohort_version TEXT NOT NULL,
    graded_at TIMESTAMPTZ NOT NULL,           -- when grading ran
    horizon_end TIMESTAMPTZ NOT NULL,         -- detected_time + horizon_seconds
    -- Outcome (primary label)
    outcome TEXT NOT NULL CHECK (outcome IN ('TARGET_HIT', 'INVALIDATED', 'TIMEOUT_WIN', 'TIMEOUT_LOSS', 'AMBIGUOUS', 'NOT_GRADED')),
    -- Excursion metrics (MFE/MAE in price, %, and R)
    mfe_abs NUMERIC(38, 18),                  -- max favorable excursion (absolute)
    mfe_pct NUMERIC(10, 4),                   -- max favorable excursion (%)
    mfe_r NUMERIC(10, 4),                     -- max favorable excursion (R-multiple)
    mae_abs NUMERIC(38, 18),                  -- max adverse excursion (absolute)
    mae_pct NUMERIC(10, 4),                   -- max adverse excursion (%)
    mae_r NUMERIC(10, 4),                     -- max adverse excursion (R-multiple)
    -- Realized R (net of haircut)
    realized_r NUMERIC(10, 4),
    haircut_r NUMERIC(10, 4),                 -- slippage/fee haircut in R
    end_price NUMERIC(38, 18),                -- price at horizon end
    end_r NUMERIC(10, 4),                     -- R at horizon end (for timeouts)
    -- Price series info
    bars_source TEXT NOT NULL,                -- 'hyperliquid:1h', 'alpaca:1d'
    bars_count INTEGER,                       -- number of bars in window
    -- Metadata
    grader_version TEXT NOT NULL,             -- grader code version
    origin TEXT NOT NULL CHECK (origin IN ('deterministic')),
    metadata JSONB DEFAULT '{}',              -- {ambiguity_reason, regrade_of, etc.}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grades_signal ON grades(signal_id);
CREATE INDEX IF NOT EXISTS idx_grades_cohort ON grades(cohort_version);
CREATE INDEX IF NOT EXISTS idx_grades_outcome ON grades(outcome);
CREATE INDEX IF NOT EXISTS idx_grades_graded ON grades(graded_at);
CREATE INDEX IF NOT EXISTS idx_grades_horizon_end ON grades(horizon_end);