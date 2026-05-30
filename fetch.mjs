// Pulls last-24h tweets via Apify (kaitoeasyapi tweet scraper), filters noise,
// ranks by engagement, prints digest-ready JSON to stdout.
// One API call: prefers a Twitter List id, falls back to an OR'd from: query.
// Usage: APIFY_TOKEN=... TWITTER_LIST_ID=... node fetch.mjs > tweets.json

import { readFile } from "node:fs/promises";

const TOKEN = process.env.APIFY_TOKEN;
const LIST_ID = process.env.TWITTER_LIST_ID;
const ACTOR = process.env.APIFY_ACTOR || "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
const HOURS = Number(process.env.WINDOW_HOURS || 24);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 200);

if (!TOKEN) {
  console.error("Missing APIFY_TOKEN env var.");
  process.exit(1);
}

const sinceSec = String(Math.floor((Date.now() - HOURS * 3600 * 1000) / 1000));

// Build a single-call input. List id = one clean fetch; else OR the handles.
let input;
if (LIST_ID) {
  input = { list: String(LIST_ID), maxItems: MAX_ITEMS, queryType: "Latest", since_time: sinceSec };
} else {
  const handles = (await readFile("handles.txt", "utf8").catch(() => ""))
    .split("\n").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
  if (!handles.length) {
    console.error("Set TWITTER_LIST_ID, or populate handles.txt. Neither found.");
    process.exit(1);
  }
  const q = "(" + handles.map((h) => `from:${h}`).join(" OR ") + ")";
  input = { searchTerms: [q], maxItems: MAX_ITEMS, queryType: "Latest", since_time: sinceSec };
}

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
const cutoff = Date.now() - HOURS * 3600 * 1000;

const tweets = raw
  // drop the actor's injected "no results" mock notice
  .filter((t) => t && t.text && !/From KaitoEasyAPI/i.test(t.text))
  .map((t) => ({
    text: t.text,
    handle: t.author?.userName || "",
    name: t.author?.name || "",
    followers: t.author?.followers || 0,
    likes: t.likeCount || 0,
    retweets: t.retweetCount || 0,
    replies: t.replyCount || 0,
    quotes: t.quoteCount || 0,
    views: t.viewCount || 0,
    createdAt: t.createdAt || null,
    url: t.url || t.twitterUrl || "",
    isReply: !!t.isReply,
    isRetweet: !!t.retweeted_tweet,
    isQuote: !!t.isQuote,
  }))
  .filter((t) => !t.isReply && !t.isRetweet)
  .filter((t) => {
    const ts = t.createdAt ? Date.parse(t.createdAt) : Date.now();
    return Number.isNaN(ts) || ts >= cutoff;
  });

// Dedupe near-identical posts (same author + first 80 chars)
const seen = new Set();
const deduped = tweets.filter((t) => {
  const key = t.handle + "|" + t.text.slice(0, 80).toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Rank by engagement (replies weighted as strong signal of discourse)
const score = (t) => t.likes + t.retweets * 2 + t.replies * 1.5 + t.quotes * 2;
deduped.sort((a, b) => score(b) - score(a));

console.log(JSON.stringify({ count: deduped.length, window_hours: HOURS, tweets: deduped }, null, 2));
