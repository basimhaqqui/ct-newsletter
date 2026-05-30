// Reads tweets.json + digest-prompt.txt, calls the Anthropic Messages API,
// writes Telegram-flavored HTML to digest.html. Zero dependencies (native fetch).
// Usage: ANTHROPIC_API_KEY=... node summarize.mjs

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const TWEETS = process.env.TWEETS_FILE || "tweets.json";
const BRIEF = process.env.BRIEF_FILE || "digest-prompt.txt";
const OUT = process.env.DIGEST_FILE || "digest.html";

if (!KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var.");
  process.exit(1);
}

const data = JSON.parse(await readFile(TWEETS, "utf8"));
const tweets = data.tweets || [];

// Quiet day: skip the API call entirely.
if (!tweets.length) {
  await writeFile(OUT, "🧵 <b>CT Digest</b> — quiet day, nothing notable.\n");
  console.error("0 tweets — wrote quiet-day digest, no API call.");
  process.exit(0);
}

const brief = await readFile(BRIEF, "utf8");

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
    system: brief,
    messages: [
      {
        role: "user",
        content:
          `Here are today's cleaned, deduped, engagement-ranked tweets ` +
          `(last ${data.window_hours || 24}h, ${tweets.length} total). ` +
          `Write the digest now. Output ONLY the Telegram-flavored HTML, ` +
          `no preamble, no code fences.\n\n` +
          JSON.stringify(tweets, null, 2),
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`Anthropic error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const json = await res.json();
const digest = (json.content || [])
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("")
  .trim()
  // strip accidental code fences if the model wraps the output
  .replace(/^```(?:html)?\s*/i, "")
  .replace(/\s*```$/i, "")
  .trim();

if (!digest) {
  console.error("Model returned empty text. Full response:");
  console.error(JSON.stringify(json, null, 2));
  process.exit(1);
}

await writeFile(OUT, digest + "\n");
console.error(`Wrote ${OUT} (${digest.length} chars) via ${MODEL}.`);
