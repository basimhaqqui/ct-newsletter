// Evaluates user-set /watch conditions each cycle and fires a Telegram alert
// when ALL conditions of a watch are met (one-shot, then removed). Run from
// hl-watch.yml every 30 min. Conditions: price</> , rsi</> , funding</> (annual %),
// whales-long|whales-short (>=3 tracked wallets that side).
//
// State: state/watches.json = [{id, coin, conds:[...], created}]
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node watch-eval.mjs

import { readFile, writeFile } from "node:fs/promises";

const INFO = "https://api.hyperliquid.xyz/info";
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const WHALE_MIN = Number(process.env.CONSENSUS_MIN || 3);
const num = (x) => Number(x) || 0;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pxf = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3));

let watches = [];
try { watches = JSON.parse(await readFile("state/watches.json", "utf8")); } catch {}
if (!Array.isArray(watches) || !watches.length) { console.error("no watches."); process.exit(0); }

async function info(body) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.json(); }
function rsi(a, p = 14) { let g = 0, l = 0; for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; } return 100 - 100 / (1 + g / (l || 1e-9)); }
const cmp = (a, op, b) => op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;

const coins = [...new Set(watches.map((w) => w.coin))];
const needRsi = (c) => watches.some((w) => w.coin === c && w.conds.some((x) => /^rsi/.test(x)));

// shared data
const mids = await info({ type: "allMids" });
const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" });
let wallets = [];
try { wallets = JSON.parse(await readFile("wallets.json", "utf8")); } catch {}
const walletPos = await Promise.all(wallets.map(async (w) => (await info({ type: "clearinghouseState", user: w.addr })).assetPositions || []));

async function ctxFor(coin) {
  const key = Object.keys(mids).find((k) => k.toLowerCase() === coin.toLowerCase()) || coin;
  const price = num(mids[key]);
  const ci = meta.universe.findIndex((u) => u.name.toLowerCase() === coin.toLowerCase());
  const fundingAnnual = ci >= 0 ? num(ctxs[ci].funding) * 24 * 365 * 100 : 0;
  let rsiVal = null;
  if (needRsi(coin)) {
    const end = Date.now(), c = await info({ type: "candleSnapshot", req: { coin: key, interval: "1d", startTime: end - 40 * 86400e3, endTime: end } });
    if (Array.isArray(c) && c.length > 15) rsiVal = rsi(c.map((x) => +x.c));
  }
  let wl = 0, ws = 0;
  for (const pos of walletPos) {
    const p = pos.find((x) => x.position?.coin?.toLowerCase() === coin.toLowerCase() && Math.abs(num(x.position?.positionValue)) >= 25000);
    if (p) (num(p.position.szi) > 0 ? wl++ : ws++);
  }
  return { price, fundingAnnual, rsi: rsiVal, whaleLong: wl, whaleShort: ws };
}

function evalCond(cond, c) {
  let m;
  if ((m = cond.match(/^price(<=|>=|<|>)(\d+\.?\d*)$/))) return cmp(c.price, m[1], +m[2]);
  if ((m = cond.match(/^rsi(<=|>=|<|>)(\d+\.?\d*)$/))) return c.rsi != null && cmp(c.rsi, m[1], +m[2]);
  if ((m = cond.match(/^funding(<=|>=|<|>)(-?\d+\.?\d*)$/))) return cmp(c.fundingAnnual, m[1], +m[2]);
  if ((m = cond.match(/^whales-(long|short)$/))) return (m[1] === "long" ? c.whaleLong : c.whaleShort) >= WHALE_MIN;
  return false; // unknown condition never fires
}

const ctxByCoin = {};
for (const coin of coins) ctxByCoin[coin] = await ctxFor(coin);

const fired = [], kept = [];
for (const w of watches) {
  const c = ctxByCoin[w.coin];
  const ok = c && w.conds.every((cond) => evalCond(cond, c));
  (ok ? fired : kept).push(w);
}

if (fired.length) {
  const lines = ["🔔 <b>Watch triggered</b>", ""];
  for (const w of fired) {
    const c = ctxByCoin[w.coin];
    lines.push(`<b>${esc(w.coin)}</b> $${pxf(c.price)} — met: ${w.conds.map(esc).join(", ")}`);
    lines.push(`   now: RSI ${c.rsi != null ? Math.round(c.rsi) : "—"} · funding ${c.fundingAnnual.toFixed(0)}%/yr · whales ${c.whaleLong}L/${c.whaleShort}S`);
  }
  lines.push("", "<i>One-shot — re-add with /watch if you want it again. Not advice.</i>");
  if (TG && CHAT) await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true }) });
  else console.error(lines.join("\n").replace(/<[^>]*>/g, ""));
}

// Persist remaining (fired ones removed). Write only if changed.
if (fired.length) {
  await writeFile("state/watches.json", JSON.stringify(kept, null, 2) + "\n");
  console.error(`fired ${fired.length}, ${kept.length} remain.`);
} else {
  console.error(`no triggers (${watches.length} active).`);
}
