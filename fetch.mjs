// Pulls last-24h tweets via Apify (kaitoeasyapi tweet scraper), filters noise,
// tags each tweet with its source, dedupes, ranks by engagement, prints
// digest-ready JSON to stdout.
//
// Two sources, each one Apify call (Apify has a min-charge PER call):
//   1. list      — your curated Twitter List (high-trust voices)
//   2. trending  — a broad viral-crypto search across all of Twitter
//                  (general CT pulse; gated by a min_faves floor)
// Trending is ON by default; disable with TRENDING=off.
//
// Usage: APIFY_TOKEN=... TWITTER_LIST_ID=... node fetch.mjs > tweets.json

import { readFile } from "node:fs/promises";

const TOKEN = process.env.APIFY_TOKEN;
const LIST_ID = process.env.TWITTER_LIST_ID;
const ACTOR = process.env.APIFY_ACTOR || "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
const HOURS = Number(process.env.WINDOW_HOURS || 24);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 200);

// Trending (general CT) config
const TRENDING_ON = (process.env.TRENDING || "on").toLowerCase() !== "off";
const TRENDING_QUERY =
  process.env.TRENDING_QUERY ||
  "(crypto OR bitcoin OR ethereum OR altcoin) min_faves:500 lang:en -is:reply -is:retweet";
const TRENDING_MAX = Number(process.env.TRENDING_MAX_ITEMS || 60);

if (!TOKEN) {
  console.error("Missing APIFY_TOKEN env var.");
  process.exit(1);
}

const sinceSec = String(Math.floor((Date.now() - HOURS * 3600 * 1000) / 1000));
const cutoff = Date.now() - HOURS * 3600 * 1000;

// One Apify call → cleaned, source-tagged tweets. Returns [] on failure so one
// dead source never sinks the whole digest.
async function pull(input, source) {
  // maxItems is the platform charge cap — actor reads it from the query string, not the body.
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${TOKEN}&maxItems=${input.maxItems || 50}`;
  let raw;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.error(`Apify ${source} error ${res.status}: ${await res.text()}`);
      return [];
    }
    raw = await res.json();
  } catch (e) {
    console.error(`Apify ${source} fetch threw: ${e.message}`);
    return [];
  }

  return raw
    // drop the actor's injected "no results" mock notice
    .filter((t) => t && t.text && !/From KaitoEasyAPI/i.test(t.text))
    .map((t) => ({
      source,
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
}

// --- Source 1: the curated List (or a from: OR-query fallback) ---
let listInput;
if (LIST_ID) {
  listInput = { list: String(LIST_ID), maxItems: MAX_ITEMS, queryType: "Latest", since_time: sinceSec };
} else {
  const handles = (await readFile("handles.txt", "utf8").catch(() => ""))
    .split("\n").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
  if (!handles.length) {
    console.error("Set TWITTER_LIST_ID, or populate handles.txt. Neither found.");
    process.exit(1);
  }
  const q = "(" + handles.map((h) => `from:${h}`).join(" OR ") + ")";
  listInput = { searchTerms: [q], maxItems: MAX_ITEMS, queryType: "Latest", since_time: sinceSec };
}

// --- Source 2: general CT (broad viral search) ---
const trendingInput = {
  searchTerms: [TRENDING_QUERY],
  maxItems: TRENDING_MAX,
  queryType: "Latest",
  since_time: sinceSec,
};

// Fire both calls in parallel.
const [listTweets, trendingTweets] = await Promise.all([
  pull(listInput, "list"),
  TRENDING_ON ? pull(trendingInput, "trending") : Promise.resolve([]),
]);

// Merge with List first so that on a cross-source duplicate the List copy wins
// (keeps the trusted-voice attribution rather than the viral one).
const merged = [...listTweets, ...trendingTweets];

const seen = new Set();
const deduped = merged.filter((t) => {
  const key = t.handle + "|" + t.text.slice(0, 80).toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Rank by engagement (replies weighted as strong signal of discourse).
const score = (t) => t.likes + t.retweets * 2 + t.replies * 1.5 + t.quotes * 2;
deduped.sort((a, b) => score(b) - score(a));

const bySource = (s) => deduped.filter((t) => t.source === s).length;
console.error(`list: ${bySource("list")}, trending: ${bySource("trending")}, total: ${deduped.length}`);

console.log(JSON.stringify({
  count: deduped.length,
  window_hours: HOURS,
  sources: { list: bySource("list"), trending: bySource("trending") },
  tweets: deduped,
}, null, 2));
