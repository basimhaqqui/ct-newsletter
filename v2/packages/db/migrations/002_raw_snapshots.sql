-- Migration 002: Create raw_snapshots table
-- Raw source payloads with provenance and quality metadata

CREATE TABLE IF NOT EXISTS raw_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,                          -- e.g., 'hyperliquid', 'apify_x', 'coingecko', 'alpaca', 'sec_edgar'
    source_record_id TEXT NOT NULL,                -- source's native ID (tweet ID, block number, filing accession, etc.)
    asset_uid TEXT REFERENCES assets(asset_uid),   -- nullable for non-asset-specific sources
    event_time TIMESTAMPTZ NOT NULL,               -- when the event actually happened (source timestamp)
    observed_time TIMESTAMPTZ NOT NULL,            -- when we observed/received it
    ingested_time TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- when we wrote it to DB
    payload JSONB NOT NULL,                        -- full raw payload from source
    payload_hash TEXT NOT NULL,                    -- SHA256 of canonicalized payload for dedupe
    quality TEXT NOT NULL CHECK (quality IN ('ok', 'degraded', 'stale')),
    evidence_ref_ids TEXT[] DEFAULT '{}',          -- array of evidence reference IDs
    metadata JSONB DEFAULT '{}',                   -- source-specific metadata (rate limit, page, cursor, etc.)
    UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_snapshots_source_record ON raw_snapshots(source, source_record_id);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_asset_event ON raw_snapshots(asset_uid, event_time);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_ingested ON raw_snapshots(ingested_time);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_quality ON raw_snapshots(quality);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_payload_hash ON raw_snapshots(payload_hash);