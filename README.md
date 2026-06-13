# CT Newsletter

Crypto market intelligence system: scrapes Crypto Twitter, tracks whale wallets on Hyperliquid, monitors smart-money positioning, and delivers everything through a conversational Telegram bot. Runs fully serverless — GitHub Actions for scheduled jobs, Cloudflare Workers for the bot. Zero npm dependencies; every integration is raw HTTP.

## What it does

**Daily digest (6 AM PT).** Scrapes a curated Twitter List of 30–50 high-signal CT accounts plus a broad viral-crypto search via Apify, dedupes and ranks by engagement, summarizes into themed sections with Claude Sonnet, prepends a BTC/ETH/SOL/HYPE market snapshot, and pushes to Telegram.

**Whale wallet watch (every 30 min).** Polls 8 tracked Hyperliquid wallets — selected from the public leaderboard, including traders with $90M+ accounts and $35M+ monthly PnL — and alerts on every position change: opened, closed, flipped, increased, reduced. Detects consensus moves (3+ wallets aligned on a coin) and divergence when the consensus breaks.

**Trending coin radar (every 6 h).** Tallies cashtag mentions across CT, flags coins spiking 2.5x+ over their rolling baseline, and cross-checks whether each is tradeable as a Hyperliquid perp.

**Smart-money shift radar (every 6 h).** Aggregates net positioning across the top 50 Hyperliquid leaderboard traders and alerts on directional flips and consensus swings.

**Weekly scorecard (Sundays).** Recaps tracked-wallet performance and suggests new top traders to add and decaying ones to prune.

**On-demand technical analysis.** Multi-timeframe TA (EMA, RSI, MACD, ATR across 15m/1h/4h/1d) combined with funding, open interest, and whale positioning, synthesized into a directional read by Claude Opus. Covers all 230+ Hyperliquid perps with a CoinGecko fallback for long-tail spot coins. Every read is logged to build a track record.

## The Telegram bot

A webhook bot on Cloudflare Workers is the front end for everything. Instant commands hit live APIs directly; heavy jobs dispatch GitHub Actions and reply when done.

- **Instant:** `/wallets`, `/wallet <label>`, `/consensus`, `/market`, `/price <coin>`, `/size <coin> <risk$> <stop>` (ATR-aware position sizer)
- **Watchlist:** `/track <0x>` / `/untrack` edit the tracked-wallet list via the GitHub API; `/mute 2h` silences alerts
- **Condition watches:** `/watch hype price<48 rsi<40 whales-long` — one-shot alerts on price, RSI, funding, or whale-positioning conditions
- **Dispatched jobs:** `/digest`, `/ta <coin>`, `/scorecard`, `/leaderboard` (screens the full 31MB leaderboard for copyable traders), `/smartmoney`, `/radar`
- **X tools:** `/x <handle>`, `/ticker <symbol>`, `/search <query>`, `/calls <handle>` (extracts trade callouts), `/trending`, `/discover`
- **Paper trading:** "paper long hype $1000 stop 48" records a hypothetical trade; `/paper` shows open positions and realized PnL
- **Conversational:** free-text questions are handled by an agent with tools for wallets, prices, TA, sizing, watches, and paper trades — plus long-term memory (`/memory`, `/forgetme`)
- **Vision:** send a chart or position screenshot and the bot reads it and replies with analysis

## Architecture

```
GitHub Actions (9 workflows, cron)          Cloudflare Worker (webhook bot)
  daily.yml        digest 6 AM PT             instant commands → HL/CoinGecko APIs
  hl-watch.yml     wallets every 30 min       heavy jobs → dispatch Actions
  radar.yml        cashtag scan every 6 h     memory/paper trades → Workers KV
  sm-radar.yml     positioning every 6 h            │
  hl-scorecard.yml weekly recap                     ▼
  ta / leaderboard / x-command / smartmoney    Telegram chat
        │
        ▼
  state/*.json committed to the repo — single source of truth
  (positions, radar baselines, watches, TA log)
```

Data sources: Apify (X/Twitter), Hyperliquid info API (positions, funding, OI, candles, leaderboard), CoinGecko (spot prices), Anthropic API (Sonnet for digests, Opus for TA, Haiku for chat).

## Setup

1. `cp .env.example .env` and fill in `APIFY_TOKEN`, `ANTHROPIC_API_KEY`, `TWITTER_LIST_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
2. Add the same values as GitHub Actions secrets — the workflows in `.github/workflows/` run on their own from there.
3. For the bot: `cd bot && npx wrangler deploy`, then set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET`, and a fine-grained `GITHUB_TOKEN` (Actions read/write) via `wrangler secret put`. Bind a KV namespace as `MEMORY` for long-term memory and paper trading.

Run any piece locally:

```bash
set -a && . ./.env && set +a
node fetch.mjs && node market.mjs && node summarize.mjs && node telegram.mjs   # full digest
node hl-watch.mjs        # one wallet-watch pass
node ta.mjs HYPE         # TA read on a coin
```

## Key files

- `fetch.mjs` / `summarize.mjs` / `market.mjs` / `telegram.mjs` — the daily digest pipeline
- `hl-watch.mjs`, `divergence.mjs`, `watch-eval.mjs` — whale tracking + condition watches
- `radar.mjs`, `smartmoney.mjs`, `hl-leaderboard.mjs`, `hl-scorecard.mjs` — market scanners
- `ta.mjs` — multi-timeframe technical analysis
- `x-command.mjs` — on-demand X scraping/search/callout extraction
- `bot/` — the Cloudflare Workers Telegram bot
- `wallets.json` — tracked whale list; `state/` — committed runtime state
