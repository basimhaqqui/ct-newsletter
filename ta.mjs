// /ta <coin> — multi-timeframe technical analysis grounded in real Hyperliquid
// data, fused with perp positioning (funding/OI) and your tracked wallets'
// actual positions, synthesized by Claude into an honest read. Appends each
// read to state/ta-log.json so we can later measure a hit-rate (track record).
//
// Usage: COIN=HYPE ANTHROPIC_API_KEY=... TELEGRAM_*=... node ta.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const INFO = "https://api.hyperliquid.xyz/info";
const COIN = (process.env.COIN || "HYPE").toUpperCase().replace(/^\$/, "");
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;

const num = (x) => Number(x) || 0;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pxf = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3));

async function info(body) {
  const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HL ${r.status}`);
  return r.json();
}
async function send(text) {
  if (!TG || !CHAT) { console.error(text.replace(/<[^>]*>/g, "")); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  const j = await r.json(); if (!j.ok) console.error("TG", JSON.stringify(j));
}

// indicators
const ema = (a, p) => { const k = 2 / (p + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
function rsi(a, p = 14) { let g = 0, l = 0; for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; } return 100 - 100 / (1 + g / (l || 1e-9)); }
function macd(a) { const line = ema(a, 12) - ema(a, 26); const m = a.map((_, i) => i < 26 ? 0 : ema(a.slice(0, i + 1), 12) - ema(a.slice(0, i + 1), 26)).slice(-9); return { line, signal: ema(m, 9), hist: line - ema(m, 9) }; }
function atr(h, l, c, p = 14) { const tr = []; for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); return tr.slice(-p).reduce((s, v) => s + v, 0) / p; }

const IV = { "1h": 3600e3, "4h": 4 * 3600e3, "1d": 86400e3 };
async function candles(interval, count) {
  const end = Date.now(), start = end - IV[interval] * count;
  const c = await info({ type: "candleSnapshot", req: { coin: COIN, interval, startTime: start, endTime: end } });
  return { o: c.map((x) => +x.o), h: c.map((x) => +x.h), l: c.map((x) => +x.l), c: c.map((x) => +x.c), v: c.map((x) => +x.v) };
}
function tfRead(d) {
  if (d.c.length < 30) return null;
  const px = d.c[d.c.length - 1], e20 = ema(d.c.slice(-40), 20), e50 = ema(d.c.slice(-60), 50);
  return { px, rsi: Math.round(rsi(d.c)), e20: +e20.toFixed(4), e50: +e50.toFixed(4), trend: px > e20 && e20 > e50 ? "up" : px < e20 && e20 < e50 ? "down" : "mixed" };
}

try {
  if (!KEY) throw new Error("missing ANTHROPIC_API_KEY");
  // multi-timeframe
  const d1 = await candles("1d", 75), h4 = await candles("4h", 120), h1 = await candles("1h", 120);
  const px = d1.c[d1.c.length - 1];
  const m = macd(d1.c), a = atr(d1.h, d1.l, d1.c);
  const hi30 = Math.max(...d1.h.slice(-30)), lo30 = Math.min(...d1.l.slice(-30));
  const hi14 = Math.max(...d1.h.slice(-14)), lo14 = Math.min(...d1.l.slice(-14));

  // perp positioning
  const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" });
  const ci = meta.universe.findIndex((u) => u.name === COIN);
  const ctx = ci >= 0 ? ctxs[ci] : {};
  const funding = num(ctx.funding), oi = num(ctx.openInterest), mark = num(ctx.markPx) || px;
  const fundingAnnual = (funding * 24 * 365 * 100);

  // whale confluence (tracked wallets)
  let whales = { total: 0, long: 0, short: 0, holders: [] };
  try {
    const wallets = JSON.parse(await readFile("wallets.json", "utf8"));
    whales.total = wallets.length;
    for (const w of wallets) {
      const cs = await info({ type: "clearinghouseState", user: w.addr });
      const p = (cs.assetPositions || []).find((x) => x.position?.coin === COIN && Math.abs(num(x.position?.positionValue)) >= 25000);
      if (p) { const long = num(p.position.szi) > 0; whales[long ? "long" : "short"]++; whales.holders.push(`${w.label} ${long ? "LONG" : "SHORT"} ${p.position.leverage?.value || ""}x`); }
    }
  } catch {}

  const data = {
    coin: COIN, price: px,
    changes: { d1: +((px / d1.c[d1.c.length - 2] - 1) * 100).toFixed(1), d7: +((px / d1.c[d1.c.length - 8] - 1) * 100).toFixed(1), d30: +((px / d1.c[d1.c.length - 31] - 1) * 100).toFixed(1) },
    timeframes: { "1d": tfRead(d1), "4h": tfRead(h4), "1h": tfRead(h1) },
    rsi_1d: Math.round(rsi(d1.c)), macd_hist: +m.hist.toFixed(3), macd_dir: m.line > m.signal ? "bullish" : "bearish",
    atr_1d: +a.toFixed(3), atr_pct: +((a / px) * 100).toFixed(1),
    levels: { resistance: [+hi14.toFixed(3), +hi30.toFixed(3)], support: [+tfRead(d1).e20.toFixed(3), +lo14.toFixed(3), +lo30.toFixed(3)] },
    funding_1h_pct: +(funding * 100).toFixed(4), funding_annual_pct: +fundingAnnual.toFixed(0),
    open_interest_usd: Math.round(oi * mark), premium_pct: +(num(ctx.premium) * 100).toFixed(3),
    whales,
  };

  const sys = `You are a disciplined crypto technical analyst writing a SHORT Telegram read (HTML: <b>,<i>,<a> only). You are given real Hyperliquid data for ${COIN}: multi-timeframe trend/RSI, MACD, ATR, support/resistance, perp funding & open interest, and how many of the user's TRACKED PROVEN WALLETS hold this coin and which side.

Write, concisely:
1) <b>${COIN} $${pxf(px)}</b> + a one-line verdict.
2) <b>Trend</b>: synthesize the 1d/4h/1h (note confluence or divergence).
3) <b>Momentum</b>: RSI + MACD (flag overbought >70 / oversold <30).
4) <b>Positioning</b>: funding (is the move crowded/healthy?) + OI.
5) <b>Whales</b>: do the tracked wallets confirm? (state the count/side).
6) <b>Levels</b>: key resistance & support (use the numbers).
7) <b>Invalidation</b>: the level that would void the bullish/bearish thesis.
8) <b>Scenario</b>: one if-then (e.g. "pullback to $X with whales still long = better R/R than chasing").

Rules: be honest and probabilistic, never fake-confident. Use ATR to keep levels realistic. End with one short line: "<i>Not advice · TA is probabilistic · manage risk.</i>". No preamble, no code fences. Keep under ~280 words.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: sys, messages: [{ role: "user", content: "Data:\n" + JSON.stringify(data, null, 2) }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 120)}`);
  const read = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim().replace(/^```(?:html)?/i, "").replace(/```$/i, "").trim();
  await send(`📈 ${read}`);

  // append to track-record log (verification job added later)
  try {
    await mkdir("state", { recursive: true });
    let log = [];
    try { log = JSON.parse(await readFile("state/ta-log.json", "utf8")); } catch {}
    log.push({ ts: Math.floor(Date.now() / 1000), coin: COIN, price: +px.toFixed(4), rsi: data.rsi_1d, trend: data.timeframes["1d"]?.trend, funding_annual_pct: data.funding_annual_pct, whales: `${whales.long}L/${whales.short}S/${whales.total}`, resistance: data.levels.resistance[0], support: data.levels.support[0] });
    await writeFile("state/ta-log.json", JSON.stringify(log, null, 2) + "\n");
    console.error(`logged TA read (${log.length} total)`);
  } catch (e) { console.error("log failed", e.message); }
} catch (e) {
  await send(`⚠️ /ta ${esc(COIN)} failed: ${esc(e.message)}`);
}
