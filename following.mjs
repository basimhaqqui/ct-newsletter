// One-time: scrape the accounts a user follows → write handles.txt (one @ per line).
// Your account/following must be PUBLIC for this to work.
// Usage: APIFY_TOKEN=... TWITTER_USER=nadeem_basim node following.mjs

import { writeFile } from "node:fs/promises";

const TOKEN = process.env.APIFY_TOKEN;
const USER = process.env.TWITTER_USER;
// actor that extracts a profile's "following" set
const ACTOR = process.env.FOLLOWING_ACTOR || "apidojo~twitter-user-scraper";

if (!TOKEN || !USER) {
  console.error("Missing APIFY_TOKEN or TWITTER_USER env vars.");
  process.exit(1);
}

const input = {
  startUrls: [{ url: `https://x.com/${USER}/following` }],
  getFollowing: true,
  maxItems: Number(process.env.MAX_FOLLOWING || 1000),
};

const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${TOKEN}`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
});

if (!res.ok) {
  console.error(`Apify error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const raw = await res.json();
const pick = (o, keys) => keys.map((k) => o?.[k]).find((v) => v != null);

const handles = [
  ...new Set(
    raw
      .map((r) => pick(r, ["userName", "screen_name", "username", "handle"]))
      .filter(Boolean)
      .map((h) => h.replace(/^@/, "")),
  ),
];

if (!handles.length) {
  console.error("No handles found. Is the following list public? Check actor output shape.");
  process.exit(1);
}

await writeFile("handles.txt", handles.join("\n") + "\n");
console.error(`Wrote ${handles.length} handles to handles.txt — prune it before daily runs.`);
