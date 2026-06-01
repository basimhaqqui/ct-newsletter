// Smart-money gauge: screens the HL leaderboard for the top directional traders,
// pulls all their live positions, and aggregates NET positioning per coin —
// a market-wide read on what proven money is actually doing. Sends to Telegram.
//
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node smartmoney.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
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
    .sort((a, b) => (b.longN + b.shortN) - (a.longN + a.shortN)); // most capital first

  if (process.env.RADAR === "1") {
    // SHIFT RADAR: diff vs last snapshot, alert when broad positioning moves.
    const STRONG = Number(process.env.SM_STRONG || 0.70);     // % one side = strong consensus
    const SWING = Number(process.env.SM_SWING || 0.20);       // pct-long move to flag
    const FLIP_MIN = Number(process.env.SM_FLIP_MIN_USD || 1e6); // net $ both sides for a "flip"
    let prev = {};
    try { prev = JSON.parse(await readFile("state/smartmoney.json", "utf8")).coins || {}; } catch {}
    const firstRun = !Object.keys(prev).length;
    const snap = {}, events = [];
    for (const c of coins) {
      snap[c.coin] = { pctLong: +c.pctLong.toFixed(3), traders: c.traders, netN: Math.round(c.netN) };
      if (firstRun) continue;
      const p = prev[c.coin];
      if (!p) { if (c.pctLong >= STRONG) events.push({ c, kind: "new" }); else if (c.pctLong <= 1 - STRONG) events.push({ c, kind: "new" }); continue; }
      const flipped = (p.netN >= 0) !== (c.netN >= 0) && Math.abs(c.netN) >= FLIP_MIN && Math.abs(p.netN) >= FLIP_MIN;
      const newStrong = (c.pctLong >= STRONG && p.pctLong < STRONG) || (c.pctLong <= 1 - STRONG && p.pctLong > 1 - STRONG);
      const swing = Math.abs(c.pctLong - p.pctLong) >= SWING;
      if (flipped) events.push({ c, kind: "flip", p });
      else if (newStrong) events.push({ c, kind: "consensus", p });
      else if (swing) events.push({ c, kind: "swing", p });
    }
    if (events.length && !firstRun) {
      events.sort((a, b) => Math.abs(b.c.netN) - Math.abs(a.c.netN));
      const lines = [`🔄 <b>Smart-money shift</b> — top ${traders.length} HL traders`, ""];
      for (const e of events.slice(0, 6)) {
        const c = e.c, pct = Math.round(c.pctLong * 100), em = c.pctLong >= 0.6 ? "🟢" : c.pctLong <= 0.4 ? "🔴" : "⚪️";
        if (e.kind === "flip") lines.push(`${em} <b>${esc(c.coin)}</b> FLIPPED net-${c.netN >= 0 ? "long" : "short"} — now ${pct}% long · ${c.longC}L/${c.shortC}S · net ${usd(c.netN)}`);
        else if (e.kind === "consensus") lines.push(`🎯 <b>${esc(c.coin)}</b> — new ${pct >= 50 ? "LONG" : "SHORT"} consensus, ${pct}% long · ${c.longC}L/${c.shortC}S · net ${usd(c.netN)}`);
        else if (e.kind === "new") lines.push(`🆕 <b>${esc(c.coin)}</b> — top traders piling in, ${pct}% long · net ${usd(c.netN)}`);
        else lines.push(`📈 <b>${esc(c.coin)}</b> — shifted to ${pct}% long (was ${Math.round(e.p.pctLong * 100)}%) · net ${usd(c.netN)}`);
      }
      lines.push("", "<i>Aggregate of proven traders. Confirm with /ta. Not advice.</i>");
      await send(lines.join("\n"));
    }
    await mkdir("state", { recursive: true });
    await writeFile("state/smartmoney.json", JSON.stringify({ coins: snap, updatedAt: Math.floor(Date.now() / 1000) }, null, 2) + "\n");
    console.error(`sm-radar: ${coins.length} coins, ${firstRun ? "baseline established" : events.length + " shifts"}`);
  } else {
    // DISPLAY (/smartmoney command): top coins by capital
    const lines = [`🧠 <b>Smart-money gauge</b> — top ${traders.length} HL traders`, ""];
    for (const c of coins.slice(0, 12)) {
      const bias = c.pctLong >= 0.6 ? "🟢" : c.pctLong <= 0.4 ? "🔴" : "⚪️";
      lines.push(`${bias} <b>${esc(c.coin)}</b> — ${Math.round(c.pctLong * 100)}% long · ${c.longC}L/${c.shortC}S · net ${usd(c.netN)} ${c.netN >= 0 ? "long" : "short"}`);
    }
    lines.push("", "<i>Net positioning of proven traders. Crowd ≠ certainty — use with /ta.</i>");
    await send(lines.join("\n"));
  }
} catch (e) { await send(`⚠️ smartmoney failed: ${esc(e.message)}`); }
