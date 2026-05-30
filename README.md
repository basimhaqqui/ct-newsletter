# CT Newsletter

A daily Crypto Twitter digest: scrape a curated Twitter List → filter/rank →
summarize with Claude → land a Gmail draft each morning.

## Setup

1. **Make a Twitter List** of the 30–50 CT accounts that matter. Grab its URL
   (e.g. `https://twitter.com/i/lists/123456789`).
2. **Get an Apify token** — sign up at apify.com → Settings → API tokens.
3. `cp .env.example .env` and fill in `APIFY_TOKEN` + `TWITTER_LIST_URL`.

## Run the fetch manually

```bash
set -a && . ./.env && set +a
node fetch.mjs > tweets.json
```

`tweets.json` = filtered, deduped, engagement-ranked tweets from the last 24h.

## Daily automation

The summarize + email step runs as a scheduled Claude Code agent using the
prompt in `agent-prompt.md` (it calls `fetch.mjs`, groups into themes, and
creates a Gmail draft via the connected Gmail tool). Delivery starts as a
**draft for review**; flip to auto-send once you trust the output.

## Files

- `fetch.mjs` — Apify fetch + filter/dedupe/rank
- `agent-prompt.md` — the daily editorial + delivery instructions
- `.env` — secrets (gitignored)
