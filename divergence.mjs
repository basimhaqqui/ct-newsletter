// Smart-money divergence alerts: flags when the tracked wallets' consensus is
// positioned AGAINST the crowd (perp funding) — a contrarian signal.
//   whales LONG  + funding negative (crowd short)      → 🟢 bullish (squeeze fuel)
//   whales SHORT + funding very positive (crowd long)  → ⚠️ bearish (fading over-long crowd)
// Deduped via state/divergence.json so each divergence alerts once. Runs every
// 30 min as a step in hl-watch.yml.
//
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node divergence.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const INFO = "https://api.hyperliquid.xyz/info";
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const CONSENSUS_MIN = Number(process.env.CONSENSUS_MIN || 3);
const FUNDING_POS = Number(process.env.FUNDING_POS || 35);  // annual % = crowd aggressively long
const FUNDING_NEG = Number(process.env.FUNDING_NEG || -3);  // annual % = crowd short
const MIN_NOTIONAL = 25000;

const num = (x) => Number(x) || 0;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function info(b) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.json(); }

let wallets = [];
try { wallets = JSON.parse(await readFile("wallets.json", "utf8")); } catch {}
if (!wallets.length) { console.error("no wallets."); process.exit(0); }

// tracked-wallet consensus per coin
const positions = await Promise.all(wallets.map(async (w) => (await info({ type: "clearinghouseState", user: w.addr })).assetPositions || []));
const cons = new Map(); // coin -> {long, short}
for (const pos of positions) for (const p of pos) {
  if (Math.abs(num(p.position?.positionValue)) < MIN_NOTIONAL) continue;
  const coin = p.position?.coin; if (!coin) continue;
  const e = cons.get(coin) || { long: 0, short: 0 };
  (num(p.position.szi) > 0 ? e.long++ : e.short++);
  cons.set(coin, e);
}

// funding per coin
const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" });
const fundingAnnual = (coin) => { const i = meta.universe.findIndex((u) => u.name === coin); return i >= 0 ? num(ctxs[i].funding) * 24 * 365 * 100 : 0; };

// detect divergences
const active = []; // current divergence keys
const detail = {};
for (const [coin, c] of cons) {
  const fund = fundingAnnual(coin);
  if (c.long >= CONSENSUS_MIN && c.long > c.short && fund <= FUNDING_NEG) {
    active.push(`${coin}|bull`); detail[`${coin}|bull`] = { coin, type: "bull", side: "LONG", c, fund };
  } else if (c.short >= CONSENSUS_MIN && c.short > c.long && fund >= FUNDING_POS) {
    active.push(`${coin}|bear`); detail[`${coin}|bear`] = { coin, type: "bear", side: "SHORT", c, fund };
  }
}

let prev = [];
try { prev = JSON.parse(await readFile("state/divergence.json", "utf8")); } catch {}
const fresh = active.filter((k) => !prev.includes(k));

if (fresh.length) {
  const lines = ["🧭 <b>Smart-money divergence</b>", ""];
  for (const k of fresh) {
    const d = detail[k];
    if (d.type === "bull") lines.push(`🟢 <b>${esc(d.coin)}</b> — ${d.c.long}/${wallets.length} whales LONG, but funding ${d.fund.toFixed(0)}%/yr (crowd short). Squeeze fuel.`);
    else lines.push(`⚠️ <b>${esc(d.coin)}</b> — ${d.c.short}/${wallets.length} whales SHORT, but funding +${d.fund.toFixed(0)}%/yr (crowd over-long). Whales fading the crowd.`);
  }
  lines.push("", "<i>Contrarian signal, not a trigger. Confirm with /ta. Not advice.</i>");
  if (TG && CHAT) await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CHAT, text: lines.join("\n"), parse_mode: "HTML", disable_web_page_preview: true }) });
  else console.error(lines.join("\n").replace(/<[^>]*>/g, ""));
}

// persist current active set (only write on change → keeps commits quiet)
if (JSON.stringify(active.sort()) !== JSON.stringify(prev.sort())) {
  await mkdir("state", { recursive: true });
  await writeFile("state/divergence.json", JSON.stringify(active, null, 2) + "\n");
  console.error(`divergences: ${active.length} active, ${fresh.length} new.`);
} else { console.error(`no divergence change (${active.length} active).`); }
