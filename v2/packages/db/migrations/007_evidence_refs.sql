-- Migration 007: Create evidence_refs table
-- Verifiable evidence references for signals and claims

CREATE TABLE IF NOT EXISTS evidence_refs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id TEXT NOT NULL UNIQUE,         -- stable ID: 'ev_<ulid>'
    kind TEXT NOT NULL CHECK (kind IN (
        'observation',         -- price/funding/OI observation
        'positioning_event',   -- whale position, insider filing
        'social_claim',        -- tweet, post
        'catalyst',            -- catalyst event
        'filing',              -- SEC filing, congressional disclosure
        'document',            -- PDF, report, whitepaper
        'link',                -- URL reference
        'media',               -- image, video
        'onchain_tx'           -- on-chain transaction
    )),
    source TEXT NOT NULL,                     -- 'hyperliquid', 'sec_edgar', 'apify_x', 'token_unlocks'
    source_record_id TEXT NOT NULL,           -- source's record ID
    asset_uids TEXT[] NOT NULL DEFAULT '{}',  -- related assets
    url TEXT,                                 -- human-verifiable URL
    title TEXT,                               -- title/description
    description TEXT,                         -- detailed description
    content_hash TEXT,                        -- SHA256 of content
    mime_type TEXT,                           -- for documents/media
    size_bytes BIGINT,                        -- file size
    event_time TIMESTAMPTZ NOT NULL,          -- when evidence event occurred
    observed_time TIMESTAMPTZ NOT NULL,       -- when we observed it
    ingested_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    quality TEXT NOT NULL CHECK (quality IN ('ok', 'degraded', 'stale')),
    metadata JSONB DEFAULT '{}',              -- source-specific metadata
    UNIQUE (source, source_record_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_evidence_refs_asset ON evidence_refs USING GIN(asset_uids);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_kind ON evidence_refs(kind);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_source ON evidence_refs(source);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_event_time ON evidence_refs(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_quality ON evidence_refs(quality);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_content_hash ON evidence_refs(content_hash);