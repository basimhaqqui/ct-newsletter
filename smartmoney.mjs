// Smart-money gauge: screens the HL leaderboard for the top directional traders,
// pulls all their live positions, and aggregates NET positioning per coin —
// a market-wide read on what proven money is actually doing. Sends to Telegram.
//
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node smartmoney.mjs

const LB_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const INFO = "https://api.hyperliquid.xyz/info";
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const N = Number(process.env.SM_TRADERS || 50);      // top traders to poll
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL || 25000);
const MIN_TRADERS = Number(process.env.SM_MIN_TRADERS || 4); // show coins with >= this many
const ACCT_MIN = 100000, MIN_TURNOVER = 3, MAX_TURNOVER = 40, MIN_MONTH_ROI = 0.05;

const num = (x) => Number(x) || 0;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`; };

async function send(text) {
  if (!TG || !CHAT) { console.error(text.replace(/<[^>]*>/g, "")); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  const j = await r.json(); if (!j.ok) console.error("TG", JSON.stringify(j));
}
async function positions(addr) {
  try {
    const j = await (await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: addr }) })).json();
    return (j.assetPositions || []).map((p) => ({ coin: p.position?.coin, szi: num(p.position?.szi), n: num(p.position?.positionValue) })).filter((p) => Math.abs(p.n) >= MIN_NOTIONAL);
  } catch { return []; }
}
const win = (r, name) => { const w = (r.windowPerformances || []).find((x) => x[0] === name); return w ? w[1] : {}; };

try {
  const lb = await (process.env.LB_FILE ? import("node:fs/promises").then((fs) => fs.readFile(process.env.LB_FILE, "utf8")).then(JSON.parse) : fetch(LB_URL).then((r) => r.json()));
  const rows = lb.leaderboardRows || lb;
  const traders = rows.map((r) => {
    const acct = num(r.accountValue), m = win(r, "month");
    return { addr: r.ethAddress, acct, monthPnl: num(m.pnl), monthRoi: num(m.roi), allPnl: num(win(r, "allTime").pnl), turnover: acct > 0 ? num(m.vlm) / acct : Infinity };
  }).filter((r) => r.acct >= ACCT_MIN && r.turnover >= MIN_TURNOVER && r.turnover <= MAX_TURNOVER && r.monthPnl > 0 && r.allPnl > 0 && r.monthRoi >= MIN_MONTH_ROI)
    .sort((a, b) => b.monthRoi - a.monthRoi).slice(0, N);

  // fetch positions in chunks to be gentle on the API
  const all = [];
  for (let i = 0; i < traders.length; i += 12) {
    all.push(...await Promise.all(traders.slice(i, i + 12).map((t) => positions(t.addr))));
  }

  const agg = new Map(); // coin -> {longC, shortC, longN, shortN}
  for (const pos of all) for (const p of pos) {
    if (!p.coin) continue;
    const e = agg.get(p.coin) || { longC: 0, shortC: 0, longN: 0, shortN: 0 };
    if (p.szi > 0) { e.longC++; e.longN += p.n; } else { e.shortC++; e.shortN += Math.abs(p.n); }
    agg.set(p.coin, e);
  }

  const coins = [...agg.entries()].map(([coin, e]) => {
    const traders = e.longC + e.shortC, netN = e.longN - e.shortN, totN = e.longN + e.shortN;
    return { coin, ...e, traders, netN, pctLong: totN > 0 ? e.longN / totN : 0.5 };
  }).filter((c) => c.traders >= MIN_TRADERS)
    .sort((a, b) => (b.longN + b.shortN) - (a.longN + a.shortN)) // most capital first
    .slice(0, 12);

  const lines = [`🧠 <b>Smart-money gauge</b> — top ${traders.length} HL traders`, ""];
  for (const c of coins) {
    const bias = c.pctLong >= 0.6 ? "🟢" : c.pctLong <= 0.4 ? "🔴" : "⚪️";
    const side = c.netN >= 0 ? "long" : "short";
    lines.push(`${bias} <b>${esc(c.coin)}</b> — ${Math.round(c.pctLong * 100)}% long · ${c.longC}L/${c.shortC}S · net ${usd(c.netN)} ${side}`);
  }
  lines.push("", "<i>Net positioning of proven traders. Crowd ≠ certainty — use with /ta.</i>");
  await send(lines.join("\n"));
} catch (e) { await send(`⚠️ /smartmoney failed: ${esc(e.message)}`); }
