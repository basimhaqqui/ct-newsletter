# Daily CT Newsletter — scheduled agent prompt

You are generating my daily Crypto Twitter digest. Do this end-to-end:

1. Load env from `~/Desktop/ct-newsletter/.env`, then run:
   `cd ~/Desktop/ct-newsletter && set -a && . ./.env && set +a && node fetch.mjs > tweets.json`
   If the fetch fails or returns 0 tweets, create a Gmail draft titled
   "CT Digest — fetch failed (DATE)" with the error and stop.

2. Read `tweets.json`. Group the tweets into themes. Typical CT buckets:
   - **Macro / majors** (BTC, ETH, rates, ETF flows)
   - **New launches / narratives** (tokens, projects, sectors heating up)
   - **Alpha / threads worth reading** (longform, research, calls)
   - **Drama / discourse** (fights, drama, governance)
   Skip any bucket with nothing in it. Invent a bucket if the day calls for it.

3. For each theme, write 2–5 bullets. Each bullet = one tight sentence of
   signal (not a paraphrase of the tweet) + the @handle + a markdown link to
   the tweet. Lead with what actually moved or matters. Cut filler.

4. Open with a 2–3 sentence "Today in CT" TLDR — the single most important
   thing(s) someone should know if they read nothing else.

5. Create a Gmail draft (do NOT send) to me with subject
   "CT Digest — <Mon DD>" and the digest as the body. Keep it skimmable:
   short headers, bullets, links. No preamble, no sign-off.

Editorial rules: ruthless signal over volume. If 50 accounts all said the same
thing, that's ONE bullet noting consensus. Prefer specific claims/numbers over
vibes. Never pad a thin day — a short honest digest beats a bloated one.
