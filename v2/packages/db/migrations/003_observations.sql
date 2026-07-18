-- Migration 003: Create observations table
-- Normalized price/funding/OI observations from raw snapshots

CREATE TABLE IF NOT EXISTS observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_uid TEXT NOT NULL REFERENCES assets(asset_uid),
    symbol TEXT NOT NULL,                     -- denormalized for queries
    venue TEXT NOT NULL,                      -- denormalized
    price NUMERIC(38, 18) NOT NULL,           -- mid price or mark price
    bid NUMERIC(38, 18),                      -- best bid
    ask NUMERIC(38, 18),                      -- best ask
    funding_rate NUMERIC(18, 10),             -- 8hr funding rate (crypto perps)
    funding_rate_annualized NUMERIC(18, 10),  -- annualized funding %
    open_interest NUMERIC(38, 4),             -- open interest in base asset units
    open_interest_usd NUMERIC(38, 4),         -- open interest in USD
    volume_24h NUMERIC(38, 4),                -- 24h volume in base asset
    volume_24h_usd NUMERIC(38, 4),            -- 24h volume in USD
    mark_price NUMERIC(38, 18),               -- mark price (perps)
    index_price NUMERIC(38, 18),              -- index price (perps)
    basis NUMERIC(18, 10),                    -- basis = mark - index
    basis_annualized NUMERIC(18, 10),         -- annualized basis %
    event_time TIMESTAMPTZ NOT NULL,          -- source timestamp (exchange time)
    observed_time TIMESTAMPTZ NOT NULL,       -- when we observed it
    ingested_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,                     -- 'hyperliquid', 'coingecko', 'alpaca', etc.
    source_record_id TEXT NOT NULL,           -- source's record ID
    quality TEXT NOT NULL CHECK (quality IN ('ok', 'degraded', 'stale')),
    raw_snapshot_id UUID REFERENCES raw_snapshots(id), -- link to raw
    metadata JSONB DEFAULT '{}',              -- extra: funding_interval_h, next_funding_time, etc.
    UNIQUE (asset_uid, venue, event_time, source)
);

CREATE INDEX IF NOT EXISTS idx_observations_asset_event ON observations(asset_uid, event_time);
CREATE INDEX IF NOT EXISTS idx_observations_venue_time ON observations(venue, event_time);
CREATE INDEX IF NOT EXISTS idx_observations_ingested ON observations(ingested_time);
CREATE INDEX IF NOT EXISTS idx_observations_quality ON observations(quality);
CREATE INDEX IF NOT EXISTS idx_observations_source_record ON observations(source, source_record_id);