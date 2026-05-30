// Extracts structured TRADE CALLOUTS from trusted-caller tweets using Claude.
// Trust gate: only tweets whose source is "list" (your hand-vetted accounts)
// are ever considered — never the broad "trending" search.
//
// Input:  tweets.json (from fetch.mjs)
// Output: callouts.json — [{handle, ticker, direction, conviction, contract,
//                           scam_flag, quote, url, createdAt}]
// Usage:  ANTHROPIC_API_KEY=... node detect-callouts.mjs

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const TWEETS = process.env.TWEETS_FILE || "tweets.json";
const OUT = process.env.CALLOUTS_FILE || "callouts.json";

if (!KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var.");
  process.exit(1);
}

const data = JSON.parse(await readFile(TWEETS, "utf8"));
// TRUST GATE: trusted whitelist only.
const trusted = (data.tweets || []).filter((t) => t.source === "list");

if (!trusted.length) {
  await writeFile(OUT, "[]\n");
  console.error("No trusted-source tweets — wrote empty callouts.");
  process.exit(0);
}

const SYSTEM = `You are a trade-callout extractor for Crypto Twitter. You are given tweets ONLY from a hand-vetted list of reputable accounts. Find tweets that are genuine TRADE CALLOUTS — where the author expresses an actionable directional view on a specific token (buying, aping, longing, shorting, accumulating, taking profit, exiting).

For EACH callout, output an object:
- handle: the author's @ (no @)
- ticker: the token symbol, uppercase, no $ (e.g. "HYPE", "WIF"). Use the clearest symbol.
- direction: one of "long" | "short" | "buy" | "accumulate" | "trim" | "exit"
- conviction: "low" | "med" | "high" (based on the author's language/sizing)
- contract: a contract/mint address if the tweet includes one, else null
- scam_flag: true if it smells like a scam/shill/airdrop/"send CA"/paid promo, else false
- quote: a <=160-char verbatim snippet of the callout
- url: the tweet url
- createdAt: the tweet's createdAt

STRICT RULES:
- Only ACTIONABLE directional calls. Skip pure commentary, price predictions with no stance, memes, news, and vague "this is bullish" with no token.
- One object per (author, token, direction). Don't duplicate.
- If a tweet is just hype with no specific token, skip it.
- Output ONLY a JSON array. No prose, no code fences. Empty array [] if none.`;

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Trusted-caller tweets (${trusted.length}). Extract callouts as a JSON array:\n\n` +
          JSON.stringify(
            trusted.map((t) => ({
              handle: t.handle,
              text: t.text,
              url: t.url,
              createdAt: t.createdAt,
              followers: t.followers,
            })),
            null,
            2
          ),
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`Anthropic error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const json = await res.json();
let raw = (json.content || [])
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("")
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/i, "")
  .trim();

let callouts;
try {
  callouts = JSON.parse(raw);
  if (!Array.isArray(callouts)) throw new Error("not an array");
} catch (e) {
  console.error(`Could not parse model output as JSON array: ${e.message}`);
  console.error(raw.slice(0, 500));
  process.exit(1);
}

await writeFile(OUT, JSON.stringify(callouts, null, 2) + "\n");
const clean = callouts.filter((c) => !c.scam_flag);
console.error(
  `callouts: ${callouts.length} (${clean.length} clean, ${callouts.length - clean.length} flagged)`
);
for (const c of clean.slice(0, 12)) {
  console.error(`  @${c.handle} ${c.direction.toUpperCase()} $${c.ticker} [${c.conviction}] — ${c.quote}`);
}
