-- Migration 001: Create assets table
-- Asset catalog with stable identities across venues

CREATE TABLE IF NOT EXISTS assets (
    asset_uid TEXT PRIMARY KEY,           -- e.g., 'crypto:hl:HYPE', 'stock:nyse:AAPL'
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('crypto', 'stock', 'commodity', 'fx')),
    venue TEXT NOT NULL,                  -- 'hyperliquid', 'nyse', 'nasdaq', 'coinbase', etc.
    decimals INTEGER DEFAULT 18,
    sector TEXT,                          -- for stocks: 'Technology', 'Healthcare', etc.
    industry TEXT,                        -- for stocks: 'Software—Application', etc.
    metadata JSONB DEFAULT '{}',          -- flexible extra fields (contract address, cik, etc.)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (symbol, venue)
);

CREATE INDEX IF NOT EXISTS idx_assets_symbol_venue ON assets(symbol, venue);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_sector ON assets(sector);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_assets_updated_at
    BEFORE UPDATE ON assets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();