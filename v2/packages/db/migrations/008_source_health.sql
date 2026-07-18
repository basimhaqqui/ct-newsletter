-- Migration 008: Create source_health table
-- Per-source health tracking with SLA monitoring

CREATE TABLE IF NOT EXISTS source_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL UNIQUE,              -- 'hyperliquid', 'apify_x', 'coingecko', 'alpaca', 'sec_edgar'
    status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
    last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_success TIMESTAMPTZ,                 -- last successful fetch
    last_failure TIMESTAMPTZ,                 -- last failure
    consecutive_failures INTEGER DEFAULT 0,
    consecutive_successes INTEGER DEFAULT 0,
    total_requests BIGINT DEFAULT 0,
    successful_requests BIGINT DEFAULT 0,
    failed_requests BIGINT DEFAULT 0,
    avg_latency_ms NUMERIC(10, 2),            -- rolling average
    p95_latency_ms NUMERIC(10, 2),            -- p95 latency
    rate_limit_remaining INTEGER,             -- current rate limit remaining
    rate_limit_reset TIMESTAMPTZ,             -- when rate limit resets
    errors JSONB DEFAULT '[]',                -- recent errors: [{type, message, timestamp, metadata}]
    sla_completeness NUMERIC(5, 2),           -- % of expected data received (0-100)
    sla_freshness_seconds NUMERIC(10, 2),     -- avg age of data at ingestion
    sla_uptime NUMERIC(5, 2),                 -- uptime % over window
    config JSONB DEFAULT '{}',                -- source-specific config
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_health_status ON source_health(status);
CREATE INDEX IF NOT EXISTS idx_source_health_last_checked ON source_health(last_checked);

-- Trigger for updated_at
CREATE TRIGGER update_source_health_updated_at
    BEFORE UPDATE ON source_health
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();