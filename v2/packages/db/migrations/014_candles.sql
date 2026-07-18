-- Migration 014: OHLC candles for leakage-free grading (true first-touch
-- ordering needs intrabar highs/lows, not just observation points).

CREATE TABLE IF NOT EXISTS candles (
    id TEXT PRIMARY KEY,                      -- '<venue>:candle:<SYM>:<interval>:<openUnix>'
    asset_uid TEXT NOT NULL,
    symbol TEXT NOT NULL,
    venue TEXT NOT NULL,
    bar_interval TEXT NOT NULL,               -- '1m' | '5m' | '1h' | '1d'
    open_time TIMESTAMPTZ NOT NULL,
    open NUMERIC(38, 18) NOT NULL,
    high NUMERIC(38, 18) NOT NULL,
    low NUMERIC(38, 18) NOT NULL,
    close NUMERIC(38, 18) NOT NULL,
    volume NUMERIC(38, 8),
    source TEXT NOT NULL,
    quality TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok', 'degraded', 'stale')),
    ingested_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (asset_uid, venue, bar_interval, open_time)
);

CREATE INDEX IF NOT EXISTS idx_candles_series
    ON candles(asset_uid, venue, bar_interval, open_time);
