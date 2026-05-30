// Watches the approved Hyperliquid wallets (wallets.json) for position CHANGES
// and pings Telegram. Diffs current positions against the last snapshot in
// state/hl-positions.json; on first run it just establishes a baseline (no spam).
//
// Events: OPENED, CLOSED, FLIPPED (side change), INCREASED/REDUCED (>25% notional).
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node hl-watch.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const INFO = "https://api.hyperliquid.xyz/info";
const STATE = process.env.STATE_FILE || "state/hl-positions.json";
const RESIZE = Number(process.env.RESIZE_PCT || 0.25); // notional move to flag a resize
const MIN_NOTIONAL = Number(process.env.MIN_NOTIONAL || 25000); // ignore dust; only meaningful positions
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const num = (x) => Number(x) || 0;
const usd = (n) => {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M`
    : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k`
    : `${s}$${a.toFixed(0)}`;
};
const px = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3));

const wallets = JSON.parse(await readFile("wallets.json", "utf8"));

async function fetchPositions(addr) {
  const r = await fetch(INFO, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: addr }),
  });
  if (!r.ok) throw new Error(`HL ${r.status} for ${addr}`);
  const j = await r.json();
  const out = {};
  for (const p of j.assetPositions || []) {
    const pos = p.position || {};
    const szi = num(pos.szi);
    if (szi === 0) continue;
    const notional = num(pos.positionValue);
    if (notional < MIN_NOTIONAL) continue; // skip dust — keeps big-book wallets from spamming
    out[pos.coin] = {
      side: szi > 0 ? "LONG" : "SHORT",
      szi,
      lev: pos.leverage?.value || 0,
      entry: num(pos.entryPx),
      mark: Math.abs(szi) > 0 ? notional / Math.abs(szi) : 0,
      notional,
      uPnl: num(pos.unrealizedPnl),
    };
  }
  return out;
}

// Load previous snapshot (absent on first run).
let prev = {};
let firstRun = false;
try {
  prev = JSON.parse(await readFile(STATE, "utf8")).wallets || {};
} catch {
  firstRun = true;
}

const events = [];
const snapshot = {};

for (const w of wallets) {
  let cur;
  try {
    cur = await fetchPositions(w.addr);
  } catch (e) {
    console.error(`skip ${w.label}: ${e.message}`);
    cur = prev[w.addr] || {}; // keep last known on transient error
  }
  snapshot[w.addr] = cur;
  const before = prev[w.addr] || {};

  // opened / flipped / resized
  for (const [coin, c] of Object.entries(cur)) {
    const b = before[coin];
    if (!b) {
      events.push({ w, kind: "OPENED", coin, c });
    } else if (b.side !== c.side) {
      events.push({ w, kind: "FLIPPED", coin, c, b });
    } else {
      const change = b.notional > 0 ? (c.notional - b.notional) / b.notional : 0;
      if (Math.abs(change) >= RESIZE) {
        events.push({ w, kind: change > 0 ? "INCREASED" : "REDUCED", coin, c, b, change });
      }
    }
  }
  // closed
  for (const [coin, b] of Object.entries(before)) {
    if (!cur[coin]) events.push({ w, kind: "CLOSED", coin, b });
  }
}

// Persist ONLY on baseline or a real change — so the workflow commits (and you
// get no churn) only when positions actually move. Minor uPnL drift is ignored.
async function persist() {
  await mkdir(STATE.split("/").slice(0, -1).join("/") || ".", { recursive: true }).catch(() => {});
  await writeFile(STATE, JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), wallets: snapshot }, null, 2) + "\n");
}

if (firstRun) {
  await persist();
  console.error("first run — baseline established, no alerts.");
  process.exit(0);
}
if (!events.length) {
  console.error("no position changes."); // leave state untouched
  process.exit(0);
}
await persist();

// Build one Telegram message for all events this cycle.
const icon = { OPENED: "🟢", CLOSED: "⚪️", FLIPPED: "🔄", INCREASED: "🔼", REDUCED: "🔽" };
const lines = ["🐋 <b>Hyperliquid wallet moves</b>", ""];
for (const e of events) {
  const link = `https://hypurrscan.io/address/${e.w.addr}`;
  const head = `${icon[e.kind]} <a href="${link}"><b>${e.w.label}</b></a> ${e.kind}`;
  if (e.kind === "CLOSED") {
    lines.push(`${head} <b>${e.b.side} ${e.b.lev}x ${e.coin}</b>`);
  } else if (e.kind === "FLIPPED") {
    lines.push(`${head} ${e.b.side}→<b>${e.c.side} ${e.c.lev}x ${e.coin}</b>`);
    lines.push(`   size ${usd(e.c.notional)} · entry $${px(e.c.entry)} · uPnL ${usd(e.c.uPnl)}`);
  } else {
    const c = e.c;
    lines.push(`${head} <b>${c.side} ${c.lev}x ${e.coin}</b>${e.change ? ` (${e.change > 0 ? "+" : ""}${Math.round(e.change * 100)}%)` : ""}`);
    lines.push(`   size ${usd(c.notional)} · entry $${px(c.entry)} · mark $${px(c.mark)} · uPnL ${usd(c.uPnl)}`);
  }
}
lines.push("");
lines.push("<i>Verifiable on-chain. Not advice — high leverage, DYOR.</i>");
const text = lines.join("\n");

if (!TOKEN || !CHAT) {
  console.error("No Telegram creds — would have sent:\n" + text);
  process.exit(0);
}
const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const jr = await res.json();
if (!jr.ok) { console.error(`Telegram error: ${JSON.stringify(jr)}`); process.exit(1); }
console.error(`alerted ${events.length} event(s).`);
