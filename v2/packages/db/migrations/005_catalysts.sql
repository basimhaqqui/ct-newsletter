-- Migration 005: Create catalysts table
-- Scheduled and surprise catalysts (earnings, FOMC, unlocks, etc.)

CREATE TABLE IF NOT EXISTS catalysts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalyst_id TEXT NOT NULL UNIQUE,         -- stable ID: 'cat_<ulid>'
    type TEXT NOT NULL,                       -- 'earnings', 'fomc', 'cpi', 'token_unlock', 'mainnet_launch', 'upgrade', 'sec_filing_deadline'
    category TEXT NOT NULL CHECK (category IN ('macro', 'earnings', 'crypto_event', 'regulatory', 'corporate_action')),
    impact TEXT NOT NULL CHECK (impact IN ('high', 'medium', 'low')),
    title TEXT NOT NULL,                      -- human readable title
    description TEXT,
    -- Timing
    scheduled_time TIMESTAMPTZ NOT NULL,      -- when event is scheduled
    actual_time TIMESTAMPTZ,                  -- when it actually happened (for surprises)
    window_start TIMESTAMPTZ,                 -- lead window start
    window_end TIMESTAMPTZ,                   -- lead window end
    settled_time TIMESTAMPTZ,                 -- when outcome is known
    -- Assets affected
    asset_uids TEXT[] NOT NULL DEFAULT '{}',  -- array of asset_uids
    symbols TEXT[] NOT NULL DEFAULT '{}',     -- denormalized symbols
    -- Source
    source TEXT NOT NULL,                     -- 'earnings_calendar', 'fomc_calendar', 'token_unlock_calendar', 'sec_edgar'
    source_record_id TEXT NOT NULL,           -- source's record ID
    source_url TEXT,                          -- URL to source
    -- Outcome (for surprise catalysts)
    expected_value NUMERIC,                   -- consensus/expectation
    actual_value NUMERIC,                     -- actual result
    surprise NUMERIC,                         -- actual - expected
    surprise_pct NUMERIC,                     -- surprise as %
    -- Quality
    quality TEXT NOT NULL CHECK (quality IN ('ok', 'degraded', 'stale')),
    metadata JSONB DEFAULT '{}',              -- {estimates: [...], consensus_provider: '...'}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_catalysts_scheduled ON catalysts(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_catalysts_type ON catalysts(type);
CREATE INDEX IF NOT EXISTS idx_catalysts_impact ON catalysts(impact);
CREATE INDEX IF NOT EXISTS idx_catalysts_assets ON catalysts USING GIN(asset_uids);
CREATE INDEX IF NOT EXISTS idx_catalysts_source ON catalysts(source, source_record_id);

-- Trigger for updated_at
CREATE TRIGGER update_catalysts_updated_at
    BEFORE UPDATE ON catalysts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();