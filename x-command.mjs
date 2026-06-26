// Handles the bot's X/Twitter commands. Triggered by x-command.yml with inputs
// MODE (x|ticker|search|trending|calls|discover) and ARG. Scrapes via Apify,
// optionally classifies with Claude, and sends the result to Telegram.
//
// Usage: MODE=ticker ARG=hype APIFY_TOKEN=... TELEGRAM_*=... node x-command.mjs

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_ACTOR || "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const TG = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const MODE = (process.env.MODE || "").toLowerCase().trim();
const ARG = (process.env.ARG || "").trim();

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (x) => Number(x) || 0;

async function send(text) {
  if (!TG || !CHAT) { console.error("No TG creds — would send:\n" + text.replace(/<[^>]*>/g, "")); return; }
  const body = text.length > 3900 ? text.slice(0, 3900) + "\n…" : text;
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: body, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) console.error("TG error", JSON.stringify(j));
}

function clean(t) {
  return {
    text: t.text, handle: t.author?.userName || "", followers: t.author?.followers || 0,
    likes: t.likeCount || 0, retweets: t.retweetCount || 0, replies: t.replyCount || 0,
    createdAt: t.createdAt || null, url: t.url || t.twitterUrl || "",
    isReply: !!t.isReply, isRetweet: !!t.retweeted_tweet,
  };
}
async function apify(input) {
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&maxItems=${input.maxItems || 50}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`Apify ${r.status}: ${(await r.text()).slice(0, 100)}`);
  const raw = await r.json();
  return raw.filter((t) => t && t.text && !/From KaitoEasyAPI/i.test(t.text)).map(clean).filter((t) => !t.isReply && !t.isRetweet);
}
const since = (hrs) => String(Math.floor((Date.now() - hrs * 3600 * 1000) / 1000));
const rank = (a, b) => (b.likes + b.retweets * 2) - (a.likes + a.retweets * 2);
const snippet = (t, n = 110) => esc(t.text.replace(/\n/g, " ").slice(0, n));
const listTweets = (tweets, n = 8) =>
  tweets.slice(0, n).map((t) =>
    `• <a href="${t.url}">@${esc(t.handle)}</a> ❤${t.likes} — ${snippet(t)}`).join("\n");

async function run() {
  if (!APIFY_TOKEN) throw new Error("missing APIFY_TOKEN");

  if (MODE === "x") {
    const h = ARG.replace(/^@/, "");
    if (!h) return send("Usage: /x &lt;handle&gt;");
    const tweets = (await apify({ from: h, maxItems: 30, queryType: "Latest", since_time: since(168) })).sort(rank);
    if (!tweets.length) return send(`No recent tweets from @${esc(h)}.`);
    return send(`📱 <b>@${esc(h)}</b> — recent (last 7d)\n\n${listTweets(tweets, 8)}`);
  }

  if (MODE === "ticker") {
    const sym = ARG.replace(/^\$/, "");
    if (!sym) return send("Usage: /ticker &lt;symbol&gt;");
    const q = `($${sym} OR #${sym}) min_faves:50 -is:reply -is:retweet lang:en`;
    const tweets = (await apify({ searchTerms: [q], maxItems: 40, queryType: "Latest", since_time: since(24) })).sort(rank);
    if (!tweets.length) return send(`Nothing notable on $${esc(sym)} in the last 24h.`);
    return send(`📱 <b>CT on $${esc(sym.toUpperCase())}</b> — last 24h (${tweets.length})\n\n${listTweets(tweets, 8)}`);
  }

  if (MODE === "search") {
    if (!ARG) return send("Usage: /search &lt;query&gt;");
    const tweets = (await apify({ searchTerms: [ARG], maxItems: 40, queryType: "Latest", since_time: since(48) })).sort(rank);
    if (!tweets.length) return send(`No results for "${esc(ARG)}".`);
    return send(`🔎 <b>${esc(ARG)}</b> — last 48h (${tweets.length})\n\n${listTweets(tweets, 8)}`);
  }

  if (MODE === "trending") {
    const q = "(crypto OR bitcoin OR ethereum OR altcoin) min_faves:500 lang:en -is:reply -is:retweet";
    const tweets = (await apify({ searchTerms: [q], maxItems: 60, queryType: "Latest", since_time: since(24) })).sort(rank);
    if (!tweets.length) return send("Quiet across CT right now.");
    return send(`🔥 <b>Trending across CT</b> — last 24h\n\n${listTweets(tweets, 10)}`);
  }

  if (MODE === "calls") {
    const h = ARG.replace(/^@/, "");
    if (!h) return send("Usage: /calls &lt;handle&gt;");
    const tweets = await apify({ from: h, maxItems: 40, queryType: "Latest", since_time: since(168) });
    if (!tweets.length) return send(`No recent tweets from @${esc(h)}.`);
    if (!KEY) return send(`📱 @${esc(h)} recent (no classifier key set):\n\n${listTweets(tweets.sort(rank), 8)}`);
    const sys = `Extract genuine TRADE CALLOUTS (actionable directional calls on a specific token) from these tweets by @${h}. Output ONLY a JSON array of {ticker,direction,conviction,quote(<=120 chars),url}. Skip pure commentary/news/memes. Empty array if none.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: sys, messages: [{ role: "user", content: JSON.stringify(tweets.map((t) => ({ text: t.text, url: t.url }))) }] }),
    });
    const j = await r.json();
    let calls = [];
    try { calls = JSON.parse((j.content || []).map((b) => b.text).join("").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()); } catch {}
    if (!Array.isArray(calls) || !calls.length) return send(`No clear trade callouts from @${esc(h)} in the last 7d (mostly commentary/TA).`);
    const body = calls.slice(0, 8).map((c) => `• <a href="${c.url}"><b>${esc((c.direction || "").toUpperCase())} $${esc(c.ticker)}</b></a> [${esc(c.conviction || "")}] — ${esc(c.quote || "")}`).join("\n");
    return send(`🎯 <b>@${esc(h)} — recent calls</b>\n\n${body}`);
  }

  if (MODE === "discover") {
    const q = '("aping" OR "full port" OR "long here" OR "longing" OR "entry here" OR "accumulating" OR "loaded up" OR "my entry") (crypto OR bitcoin OR sol OR $) min_faves:100 -is:reply -is:retweet lang:en';
    const tweets = await apify({ searchTerms: [q], maxItems: 200, queryType: "Latest", since_time: since(72) });
    const by = new Map();
    const tick = /\$[A-Za-z]{2,10}\b/g;
    for (const t of tweets) {
      const e = by.get(t.handle) || { handle: t.handle, followers: 0, calls: 0, tickers: new Set() };
      e.followers = Math.max(e.followers, t.followers); e.calls++;
      for (const m of t.text.match(tick) || []) e.tickers.add(m.toUpperCase());
      by.set(t.handle, e);
    }
    const ranked = [...by.values()].filter((e) => e.followers >= 10000)
      .sort((a, b) => (Math.log10(b.followers) + b.calls + b.tickers.size) - (Math.log10(a.followers) + a.calls + a.tickers.size)).slice(0, 10);
    if (!ranked.length) return send("No clear caller candidates surfaced.");
    const body = ranked.map((e) => `• <a href="https://x.com/${esc(e.handle)}">@${esc(e.handle)}</a> ${(e.followers / 1000).toFixed(0)}k · ${e.calls} calls · ${[...e.tickers].slice(0, 5).join(",")}`).join("\n");
    return send(`🔭 <b>Caller candidates</b> (vet before trusting)\n\n${body}`);
  }

  return send(`Unknown X mode: ${esc(MODE)}`);
}

run().catch((e) => send(`⚠️ /${esc(MODE)} failed: ${esc(e.message)}`));
