// /leaderboard command: screens the HL leaderboard for copyable directional
// traders and sends the top few (with current top position) to Telegram.
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node leaderboard-cmd.mjs

const LB_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const INFO = "https://api.hyperliquid.xyz/info";
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const ACCT_MIN = Number(process.env.ACCT_MIN || 100000);
const MIN_TURNOVER = Number(process.env.MIN_TURNOVER || 3);
const MAX_TURNOVER = Number(process.env.MAX_TURNOVER || 40);
const MIN_MONTH_ROI = Number(process.env.MIN_MONTH_ROI || 0.05);
const TOP = Number(process.env.TOP || 8);

const num = (x) => Number(x) || 0;
const usd = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`; };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(text) {
  if (!TG || !CHAT) { console.error(text.replace(/<[^>]*>/g, "")); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  const j = await r.json(); if (!j.ok) console.error("TG", JSON.stringify(j));
}
async function topPos(addr) {
  try {
    const j = await (await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: addr }) })).json();
    const p = (j.assetPositions || []).map((x) => ({ coin: x.position?.coin, side: num(x.position?.szi) > 0 ? "LONG" : "SHORT", n: num(x.position?.positionValue) })).filter((x) => x.n >= 25000).sort((a, b) => b.n - a.n)[0];
    return p ? `${p.side} ${esc(p.coin)} (${usd(p.n)})` : "flat";
  } catch { return "?"; }
}

const win = (r, name) => { const w = (r.windowPerformances || []).find((x) => x[0] === name); return w ? w[1] : {}; };
try {
  const lb = await (await fetch(LB_URL)).json();
  const rows = lb.leaderboardRows || lb;
  const screened = rows.map((r) => {
    const acct = num(r.accountValue), month = win(r, "month");
    return { addr: r.ethAddress, name: r.displayName || null, acct, monthPnl: num(month.pnl), monthRoi: num(month.roi), allPnl: num(win(r, "allTime").pnl), turnover: acct > 0 ? num(month.vlm) / acct : Infinity };
  }).filter((r) => r.acct >= ACCT_MIN && r.turnover >= MIN_TURNOVER && r.turnover <= MAX_TURNOVER && r.monthPnl > 0 && r.allPnl > 0 && r.monthRoi >= MIN_MONTH_ROI)
    .sort((a, b) => b.monthRoi - a.monthRoi).slice(0, TOP);

  const withPos = await Promise.all(screened.map(async (r) => ({ ...r, pos: await topPos(r.addr) })));
  const lines = ["🏆 <b>HL leaderboard — top directional traders</b>", ""];
  for (const r of withPos) {
    const id = r.name ? esc(r.name) : r.addr.slice(0, 6) + "…" + r.addr.slice(-4);
    lines.push(`<a href="https://hypurrscan.io/address/${r.addr}">${id}</a> — month ${usd(r.monthPnl)} (${Math.round(r.monthRoi * 100)}%) · ${r.pos}`);
  }
  lines.push("", "<i>Add one with /track &lt;0x…&gt;</i>");
  await send(lines.join("\n"));
} catch (e) { await send(`⚠️ /leaderboard failed: ${esc(e.message)}`); }
