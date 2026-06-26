// Trending-coin radar: scans CT for viral tweets, tallies cashtag mentions,
// and flags coins SPIKING vs their rolling baseline (so it catches new movers,
// not steady majors). Cross-checks Hyperliquid tradeability, dedupes via a
// cooldown, pushes a Telegram alert. State in state/radar.json.
//
// Usage: APIFY_TOKEN=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node radar.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_ACTOR || "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const HOURS = Number(process.env.RADAR_HOURS || 6);
const MIN_FAVES = Number(process.env.RADAR_MIN_FAVES || 150);
const MIN_MENTIONS = Number(process.env.RADAR_MIN_MENTIONS || 3); // need this many viral tweets
const SPIKE = Number(process.env.RADAR_SPIKE || 2.5);            // x over baseline to flag an existing coin
const COOLDOWN = Number(process.env.RADAR_COOLDOWN_H || 24) * 3600;
const STABLES = new Set(["USDT", "USDC", "DAI", "USD", "USDE", "BUSD", "TUSD", "FDUSD", "PYUSD", "USDD"]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function send(text) {
  if (!TG || !CHAT) { console.error(text.replace(/<[^>]*>/g, "")); return; }
  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }) });
}

try {
  if (!APIFY_TOKEN) throw new Error("missing APIFY_TOKEN");
  const since = String(Math.floor((Date.now() - HOURS * 3600 * 1000) / 1000));
  const q = `(crypto OR altcoin OR memecoin OR pump OR gem OR ape OR "low cap") min_faves:${MIN_FAVES} -is:reply -is:retweet lang:en`;
  // maxItems is the platform charge cap — actor reads it from the query string, not the body.
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&maxItems=120`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ searchTerms: [q], maxItems: 120, queryType: "Latest", since_time: since }) });
  if (!res.ok) { const b = await res.text(); throw new Error(`Apify ${res.status} ${b.match(/"type":\s*"([^"]+)"/)?.[1] || b.slice(0, 80)}`); }
  const raw = (await res.json()).filter((t) => t && t.text && !/From KaitoEasyAPI/i.test(t.text) && !t.isReply && !t.retweeted_tweet);

  // tally engagement-weighted viral mentions per cashtag
  const tick = /\$([A-Za-z]{2,10})\b/g;
  const counts = {}, best = {};
  for (const t of raw) {
    const likes = t.likeCount || 0;
    const syms = new Set([...(t.text.match(tick) || [])].map((m) => m.slice(1).toUpperCase()));
    for (const s of syms) {
      if (STABLES.has(s)) continue;
      counts[s] = (counts[s] || 0) + 1;
      if (!best[s] || likes > best[s].likes) best[s] = { likes, handle: t.author?.userName || "", text: t.text.replace(/\n/g, " ").slice(0, 90), url: t.url || t.twitterUrl || "" };
    }
  }

  let state = { baseline: {}, alerted: {} };
  try { state = JSON.parse(await readFile("state/radar.json", "utf8")); } catch {}
  const now = Math.floor(Date.now() / 1000);
  const firstRun = !Object.keys(state.baseline || {}).length; // no baseline yet → just learn it, don't alert

  // flag spikes (never on first run — establish baseline silently)
  const flagged = [];
  for (const [s, c] of Object.entries(counts)) {
    if (firstRun) break;
    const base = state.baseline[s] || 0;
    const isNew = base < 1, hot = c >= MIN_MENTIONS && (isNew ? c >= MIN_MENTIONS : c >= SPIKE * base);
    const cooling = state.alerted[s] && now - state.alerted[s] < COOLDOWN;
    if (hot && !cooling) flagged.push({ sym: s, c, base, isNew, best: best[s] });
  }
  flagged.sort((a, b) => b.c - a.c);

  // update EMA baselines (decay unseen), prune tiny
  const baseline = {};
  for (const s of new Set([...Object.keys(state.baseline), ...Object.keys(counts)])) {
    const raw0 = counts[s] || 0, b = state.baseline[s] || 0, v = b ? b * 0.6 + raw0 * 0.4 : raw0;
    if (v >= 0.3) baseline[s] = +v.toFixed(2);
  }
  const alerted = {};
  for (const [s, ts] of Object.entries(state.alerted)) if (now - ts < COOLDOWN) alerted[s] = ts;
  for (const f of flagged) alerted[f.sym] = now;

  if (flagged.length) {
    const meta = await (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "meta" }) })).json();
    const hl = new Set(meta.universe.map((u) => u.name.toUpperCase()));
    const lines = ["🆕 <b>Heating up on CT</b>", ""];
    for (const f of flagged.slice(0, 6)) {
      const tradeable = hl.has(f.sym);
      lines.push(`🔥 <b>$${esc(f.sym)}</b> — ${f.c} viral mentions${f.isNew ? " (new on radar)" : ` (was ~${f.base.toFixed(1)})`}${tradeable ? ` · on HL → /ta ${esc(f.sym)}` : " · not on HL"}`);
      if (f.best) lines.push(`   <a href="${f.best.url}">@${esc(f.best.handle)}</a>: ${esc(f.best.text)}`);
    }
    lines.push("", "<i>Early CT buzz — high noise, verify before acting. Not advice.</i>");
    await send(lines.join("\n"));
  }

  await mkdir("state", { recursive: true });
  await writeFile("state/radar.json", JSON.stringify({ baseline, alerted, updatedAt: now }, null, 2) + "\n");
  console.error(`radar: ${raw.length} tweets, ${Object.keys(counts).length} tickers, ${flagged.length} flagged.`);
} catch (e) { await send(`⚠️ radar failed: ${esc(e.message)}`); }
