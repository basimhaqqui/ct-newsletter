-- Migration 013: Create outbox table
-- Transactional outbox for reliable event publishing (Telegram, webhooks, etc.)

CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id TEXT NOT NULL UNIQUE,            -- ULID: 'evt_<ulid>'
    event_type TEXT NOT NULL,                 -- 'signal_fired', 'signal_graded', 'abstention_logged', 'health_alert', 'job_completed'
    aggregate_id TEXT NOT NULL,               -- signal_id, grade_id, job_id, source_id
    aggregate_type TEXT NOT NULL,             -- 'signal', 'grade', 'abstention', 'job', 'source_health'
    payload JSONB NOT NULL,                   -- full event payload
    metadata JSONB DEFAULT '{}',              -- correlation_id, causation_id, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,                 -- when successfully published
    published BOOLEAN NOT NULL DEFAULT FALSE,
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 10,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox(published, next_retry_at) WHERE published = FALSE;
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_event_type ON outbox(event_type);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);