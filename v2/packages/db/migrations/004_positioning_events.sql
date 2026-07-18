-- Migration 004: Create positioning_events table
-- Wallet/whale position changes, insider filings, congressional disclosures

CREATE TABLE IF NOT EXISTS positioning_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_uid TEXT NOT NULL REFERENCES assets(asset_uid),
    symbol TEXT NOT NULL,                     -- denormalized
    venue TEXT NOT NULL,                      -- denormalized
    event_type TEXT NOT NULL CHECK (event_type IN (
        'whale_position',                     -- Hyperliquid whale position
        'leaderboard_aggregate',              -- Hyperliquid leaderboard aggregate
        'insider_form4',                      -- SEC Form 4 insider filing
        'congressional_disclosure',           -- Congressional disclosure
        'thirteen_f',                         -- 13F institutional holding
        'wallet_transfer'                     -- on-chain wallet transfer
    )),
    -- Position details
    side TEXT CHECK (side IN ('long', 'short', 'flat')),  -- for crypto perps
    size NUMERIC(38, 18),                     -- position size (base asset units)
    notional_usd NUMERIC(38, 4),              -- notional value in USD
    entry_price NUMERIC(38, 18),              -- entry/average price
    leverage NUMERIC(10, 2),                  -- leverage used
    unrealized_pnl NUMERIC(38, 4),            -- unrealized PnL
    -- Actor identification
    actor_id TEXT,                            -- wallet address, insider CIK, congress bioguide
    actor_type TEXT CHECK (actor_type IN ('wallet', 'leaderboard_trader', 'insider', 'congress_member', 'institution')),
    actor_name TEXT,                          -- human-readable name
    actor_metadata JSONB DEFAULT '{}',        -- {twitter, entity_name, etc.}
    -- Source info
    source TEXT NOT NULL,                     -- 'hyperliquid', 'sec_edgar', 'congress_gov', 'whale_alert'
    source_record_id TEXT NOT NULL,           -- filing accession, tweet ID, API record ID
    event_time TIMESTAMPTZ NOT NULL,          -- when position was taken/changed (source time)
    observed_time TIMESTAMPTZ NOT NULL,       -- when we observed it
    ingested_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    quality TEXT NOT NULL CHECK (quality IN ('ok', 'degraded', 'stale')),
    raw_snapshot_id UUID REFERENCES raw_snapshots(id),
    metadata JSONB DEFAULT '{}',              -- {filing_type, transaction_code, shares, etc.}
    UNIQUE (source, source_record_id, asset_uid)
);

CREATE INDEX IF NOT EXISTS idx_positioning_asset_event ON positioning_events(asset_uid, event_time);
CREATE INDEX IF NOT EXISTS idx_positioning_actor ON positioning_events(actor_id, actor_type);
CREATE INDEX IF NOT EXISTS idx_positioning_type ON positioning_events(event_type);
CREATE INDEX IF NOT EXISTS idx_positioning_source ON positioning_events(source, source_record_id);
CREATE INDEX IF NOT EXISTS idx_positioning_ingested ON positioning_events(ingested_time);
CREATE INDEX IF NOT EXISTS idx_positioning_quality ON positioning_events(quality);