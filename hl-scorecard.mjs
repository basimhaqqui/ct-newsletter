// Weekly Hyperliquid scorecard + watchlist auto-refresh.
//  1. How each tracked wallet (wallets.json) is performing (week/month/allTime).
//  2. Flags tracked wallets that are decaying → suggests pruning.
//  3. Re-screens the leaderboard for NEW top directional traders → suggests adds.
// SUGGESTS ONLY — never edits wallets.json. You stay the approver.
//
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node hl-scorecard.mjs

import { readFile } from "node:fs/promises";

const LB_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const INFO = "https://api.hyperliquid.xyz/info";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

// Same screen the watchlist was built with (keep in sync with hl-leaderboard.mjs).
const ACCT_MIN = Number(process.env.ACCT_MIN || 100000);
const MIN_TURNOVER = Number(process.env.MIN_TURNOVER || 3);
const MAX_TURNOVER = Number(process.env.MAX_TURNOVER || 40);
const MIN_MONTH_ROI = Number(process.env.MIN_MONTH_ROI || 0.05);
const SUGGEST = Number(process.env.SUGGEST_ADDS || 3);

const num = (x) => Number(x) || 0;
const usd = (n) => {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`;
};
const pct = (r) => `${(r * 100).toFixed(0)}%`;
const stamp = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", month: "short", day: "numeric",
}).format(new Date());

const wallets = JSON.parse(await readFile("wallets.json", "utf8"));
const tracked = new Set(wallets.map((w) => w.addr.toLowerCase()));

// Load leaderboard
let lb;
if (process.env.LB_FILE) lb = JSON.parse(await readFile(process.env.LB_FILE, "utf8"));
else {
  const r = await fetch(LB_URL);
  if (!r.ok) { console.error(`leaderboard ${r.status}`); process.exit(1); }
  lb = await r.json();
}
const rows = lb.leaderboardRows || lb;

const win = (r, name) => {
  const w = (r.windowPerformances || []).find((x) => x[0] === name);
  return w ? w[1] : {};
};
const statOf = (r) => {
  const acct = num(r.accountValue), month = win(r, "month");
  return {
    addr: r.ethAddress, name: r.displayName || null, acct,
    day: num(win(r, "day").pnl), week: num(win(r, "week").pnl),
    monthPnl: num(month.pnl), monthRoi: num(month.roi), allPnl: num(win(r, "allTime").pnl),
    turnover: acct > 0 ? num(month.vlm) / acct : Infinity,
  };
};
const byAddr = new Map(rows.map((r) => [r.ethAddress.toLowerCase(), r]));

// 1) Tracked-wallet scorecard + 2) prune verdicts
function verdict(s) {
  if (!s) return { icon: "⚠️", text: "not on leaderboard (inactive?)", prune: true };
  if (s.monthPnl <= 0) return { icon: "🔴", text: "down this month", prune: true };
  if (s.turnover < MIN_TURNOVER) return { icon: "⚠️", text: "barely trading — turned holder", prune: true };
  if (s.monthRoi >= 0.5) return { icon: "🔥", text: "hot", prune: false };
  return { icon: "✅", text: "healthy", prune: false };
}

const cards = wallets.map((w) => {
  const row = byAddr.get(w.addr.toLowerCase());
  const s = row ? statOf(row) : null;
  return { w, s, v: verdict(s) };
});

// 3) New candidates: re-screen, exclude tracked, take top by month PnL
const candidates = rows
  .map(statOf)
  .filter((s) =>
    !tracked.has(s.addr.toLowerCase()) &&
    s.acct >= ACCT_MIN && s.turnover >= MIN_TURNOVER && s.turnover <= MAX_TURNOVER &&
    s.monthPnl > 0 && s.monthRoi >= MIN_MONTH_ROI &&
    s.allPnl > s.monthPnl // PROVEN: profitable in prior months too, not one hot month
  )
  .sort((a, b) => b.monthRoi - a.monthRoi) // high-return profile, like the watchlist
  .slice(0, SUGGEST);

// holdings for suggested adds (few calls)
async function topHoldings(addr) {
  try {
    const r = await fetch(INFO, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: addr }),
    });
    const j = await r.json();
    return (j.assetPositions || [])
      .map((p) => ({ coin: p.position?.coin, side: num(p.position?.szi) > 0 ? "LONG" : "SHORT", n: num(p.position?.positionValue) }))
      .filter((p) => p.n >= 25000)
      .sort((a, b) => b.n - a.n).slice(0, 3);
  } catch { return []; }
}
for (const c of candidates) c.holdings = await topHoldings(c.addr);

// Build message
const lines = [`📊 <b>Weekly Wallet Scorecard</b>  <i>${stamp}</i>`, ""];
for (const { w, s, v } of cards) {
  if (s) {
    lines.push(`${v.icon} <b>${w.label}</b> — ${v.text}`);
    lines.push(`   month ${usd(s.monthPnl)} (${pct(s.monthRoi)}) · week ${usd(s.week)} · allTime ${usd(s.allPnl)}`);
  } else {
    lines.push(`${v.icon} <b>${w.label}</b> — ${v.text}`);
  }
}

const prunes = cards.filter((c) => c.v.prune);
if (prunes.length) {
  lines.push("", `⚠️ <b>Consider pruning:</b> ${prunes.map((c) => c.w.label).join(", ")}`);
}

if (candidates.length) {
  lines.push("", `➕ <b>New top traders to consider</b> (not tracked):`);
  for (const c of candidates) {
    const id = c.name ? `"${c.name}"` : c.addr.slice(0, 8) + "…" + c.addr.slice(-4);
    lines.push(`<a href="https://hypurrscan.io/address/${c.addr}">${id}</a> — month ${usd(c.monthPnl)} (${pct(c.monthRoi)}) · allTime ${usd(c.allPnl)} · acct ${usd(c.acct)}`);
    if (c.holdings.length) lines.push(`   holding: ${c.holdings.map((h) => `${h.side} ${h.coin} (${usd(h.n)})`).join(" · ")}`);
  }
}
lines.push("", "<i>Suggestions only — edit wallets.json to add/remove. Nothing changed automatically.</i>");
const text = lines.join("\n");

if (!TOKEN || !CHAT) { console.error("No Telegram creds — would have sent:\n" + text.replace(/<[^>]*>/g, "")); process.exit(0); }
const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const jr = await res.json();
if (!jr.ok) { console.error(`Telegram error: ${JSON.stringify(jr)}`); process.exit(1); }
console.error("scorecard sent.");
