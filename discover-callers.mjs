// Discovers candidate "caller" accounts: people on CT who actually post trade
// callouts right now. One Apify search call → aggregate by author → score by
// reputation signals → print a shortlist to vet. Pure data (no API key needed).
//
// Usage: APIFY_TOKEN=... node discover-callers.mjs

const TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_ACTOR || "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
const HOURS = Number(process.env.DISCOVER_HOURS || 72); // wider window = more signal
const MAX_ITEMS = Number(process.env.DISCOVER_MAX || 200);
const FOLLOWER_MIN = Number(process.env.FOLLOWER_MIN || 10000);

if (!TOKEN) { console.error("Missing APIFY_TOKEN."); process.exit(1); }

// Language that signals an actual position/entry, not just commentary.
const QUERY =
  process.env.DISCOVER_QUERY ||
  '("aping" OR "full port" OR "long here" OR "longing" OR "shorting" OR "entry here" OR "accumulating" OR "loaded up" OR "adding here" OR "my entry" OR "took a position") (crypto OR bitcoin OR sol OR eth OR $) min_faves:100 -is:reply -is:retweet lang:en';

const sinceSec = String(Math.floor((Date.now() - HOURS * 3600 * 1000) / 1000));
const input = { searchTerms: [QUERY], maxItems: MAX_ITEMS, queryType: "Latest", since_time: sinceSec };

const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${TOKEN}&maxItems=${input.maxItems || 50}`;
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
if (!res.ok) { console.error(`Apify ${res.status}: ${await res.text()}`); process.exit(1); }
const raw = await res.json();

const tickRe = /\$[A-Za-z]{2,10}\b/g;
const byHandle = new Map();
for (const t of raw) {
  if (!t || !t.text || /From KaitoEasyAPI/i.test(t.text)) continue;
  if (t.isReply || t.retweeted_tweet) continue;
  const h = t.author?.userName;
  if (!h) continue;
  const e = byHandle.get(h) || {
    handle: h, name: t.author?.name || "", followers: t.author?.followers || 0,
    calls: 0, likes: 0, tickers: new Set(), best: null, bestEng: -1,
  };
  e.followers = Math.max(e.followers, t.author?.followers || 0);
  e.calls += 1;
  const eng = (t.likeCount || 0) + (t.retweetCount || 0) * 2;
  e.likes += t.likeCount || 0;
  for (const m of t.text.match(tickRe) || []) e.tickers.add(m.replace("$", "").toUpperCase());
  if (eng > e.bestEng) { e.bestEng = eng; e.best = { text: t.text.replace(/\n/g, " ").slice(0, 120), url: t.url || t.twitterUrl || "" }; }
  byHandle.set(h, e);
}

// Score: reward following + repeated calling + breadth of tokens (a one-bag
// shiller calls a single ticker; a real trader calls several).
const score = (e) =>
  Math.log10(e.followers + 1) * 2 + e.calls * 1.2 + e.tickers.size * 1.5 + Math.log10(e.likes + 1);

const ranked = [...byHandle.values()]
  .filter((e) => e.followers >= FOLLOWER_MIN) // cut tiny / likely-shill accounts
  .sort((a, b) => score(b) - score(a))
  .slice(0, 25);

console.error(`scanned ${raw.length} callout-style tweets → ${byHandle.size} authors → ${ranked.length} candidates (followers ≥ ${FOLLOWER_MIN})\n`);
for (const e of ranked) {
  const f = e.followers >= 1000 ? Math.round(e.followers / 1000) + "k" : String(e.followers);
  console.log(`@${e.handle}  ${f} followers · ${e.calls} calls · ${e.tickers.size} tickers [${[...e.tickers].slice(0, 6).join(",")}]`);
  console.log(`   ↳ ${e.best?.text || ""}`);
}

// Machine-readable for the next step.
const { writeFile } = await import("node:fs/promises");
await writeFile("caller-candidates.json", JSON.stringify(
  ranked.map((e) => ({ ...e, tickers: [...e.tickers] })), null, 2));
