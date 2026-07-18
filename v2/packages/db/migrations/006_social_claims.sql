-- Migration 006: Create social_claims table
-- Social media posts, tweets, reddit posts with engagement metrics

CREATE TABLE IF NOT EXISTS social_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id TEXT NOT NULL UNIQUE,            -- stable ID: 'claim_<ulid>'
    asset_uids TEXT[] NOT NULL DEFAULT '{}',  -- assets mentioned
    symbols TEXT[] NOT NULL DEFAULT '{}',     -- cashtags/symbols extracted
    author_id TEXT NOT NULL,                  -- platform user ID
    author_handle TEXT NOT NULL,              -- @handle
    author_followers BIGINT,                  -- follower count
    author_verified BOOLEAN DEFAULT FALSE,    -- verified status
    platform TEXT NOT NULL CHECK (platform IN ('x', 'reddit', 'discord', 'telegram', 'farcaster', 'lens', 'youtube')),
    content TEXT NOT NULL,                    -- full text content
    content_hash TEXT NOT NULL,               -- SHA256 for dedupe
    urls TEXT[] DEFAULT '{}',                 -- links in post
    media_urls TEXT[] DEFAULT '{}',           -- images/videos
    engagement JSONB DEFAULT '{}',            -- {likes, retweets, replies, views, quotes}
    sentiment_score NUMERIC(4, 3),            -- -1 to 1 if analyzed
    sentiment_label TEXT CHECK (sentiment_label IN ('bullish', 'bearish', 'neutral', 'mixed')),
    language TEXT DEFAULT 'en',
    parent_claim_id TEXT,                     -- reply/quote/retweet parent
    conversation_id TEXT,                     -- thread ID
    source TEXT NOT NULL,                     -- 'apify_x', 'pushshift_reddit', 'farcaster'
    source_record_id TEXT NOT NULL,           -- tweet ID, reddit ID, etc.
    event_time TIMESTAMPTZ NOT NULL,          -- when posted
    observed_time TIMESTAMPTZ NOT NULL,       -- when scraped
    ingested_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    quality TEXT NOT NULL CHECK (quality IN ('ok', 'degraded', 'stale')),
    raw_snapshot_id UUID REFERENCES raw_snapshots(id),
    metadata JSONB DEFAULT '{}',              -- platform-specific fields
    UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_social_claims_assets ON social_claims USING GIN(asset_uids);
CREATE INDEX IF NOT EXISTS idx_social_claims_symbols ON social_claims USING GIN(symbols);
CREATE INDEX IF NOT EXISTS idx_social_claims_author ON social_claims(author_handle);
CREATE INDEX IF NOT EXISTS idx_social_claims_platform ON social_claims(platform);
CREATE INDEX IF NOT EXISTS idx_social_claims_event_time ON social_claims(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_social_claims_ingested ON social_claims(ingested_time);
CREATE INDEX IF NOT EXISTS idx_social_claims_content_hash ON social_claims(content_hash);
CREATE INDEX IF NOT EXISTS idx_social_claims_quality ON social_claims(quality);