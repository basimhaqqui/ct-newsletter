import { runAgent } from "./agent.js";

// Telegram command bot on Cloudflare Workers (webhook).
// Instant commands hit Hyperliquid/CoinGecko directly; heavy ones (digest,
// scorecard, leaderboard, X) trigger the repo's GitHub Actions workflows.
// /track, /untrack, /mute edit repo files via the GitHub API (single source
// of truth: wallets.json + state/mute.json).
//
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WEBHOOK_SECRET, GITHUB_TOKEN.
// Vars: GITHUB_REPO = "basimhaqqui/ct-newsletter".

const INFO = "https://api.hyperliquid.xyz/info";
const CG = "https://api.coingecko.com/api/v3";

// Fallback watchlist if the repo read fails (keep roughly in sync with wallets.json).
const WALLETS_FALLBACK = [
  { addr: "0x57f2819c959abbcf22623d5ec1d3164b213e9711", label: "jefefefe" },
  { addr: "0x3705121529bf40d77e8e7b625120551b151d9af2", label: "0x3705…9af2" },
  { addr: "0xdd54150be70967523a256f92db193845acf58714", label: "0xdd54…8714" },
  { addr: "0xc914267b2b98cabf20ef904de5fbb326c982855d", label: "0xc914…855d" },
];
const MIN_NOTIONAL = 25000;
const CONSENSUS_MIN = 3;

const num = (x) => Number(x) || 0;
const usd = (n) => {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`;
};
const pxf = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shortAddr = (a) => a.slice(0, 6) + "…" + a.slice(-4);

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("ok");
    if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try { update = await request.json(); } catch { return new Response("ok"); }
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();
    if (!chatId || String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok");
    if (!text) return new Response("ok");
    // Slash commands → fast deterministic handlers. Plain English → conversational agent.
    if (text.startsWith("/")) ctx.waitUntil(handle(text, chatId, env));
    else ctx.waitUntil(runAgent(env, chatId, text));
    return new Response("ok");
  },
};

async function handle(text, chatId, env) {
  const [raw, ...args] = text.split(/\s+/);
  const cmd = raw.split("@")[0].toLowerCase();
  const argStr = args.join(" ").trim();
  const needArg = (usage) => { if (!argStr) { send(env, chatId, usage); return false; } return true; };
  try {
    switch (cmd) {
      case "/start": case "/help": case "/menu": case "/commands":
        return send(env, chatId, helpText());
      // instant (free)
      case "/wallets": return send(env, chatId, await cmdWallets(await getWallets(env)));
      case "/wallet": return send(env, chatId, await cmdWallet(await getWallets(env), args[0]));
      case "/consensus": return send(env, chatId, await cmdConsensus(await getWallets(env)));
      case "/market": return send(env, chatId, await cmdMarket());
      case "/hl": return send(env, chatId, await cmdHl(args[0]));
      case "/price": return send(env, chatId, await cmdPrice(args[0]));
      case "/size": return send(env, chatId, await cmdSize(args));
      case "/status": return send(env, chatId, statusText(env));
      // watchlist edits
      case "/track": return needArg("Usage: /track &lt;0x address&gt; [label]") && send(env, chatId, await cmdTrack(env, args));
      case "/untrack": return needArg("Usage: /untrack &lt;label|0x&gt;") && send(env, chatId, await cmdUntrack(env, argStr));
      // alerts
      case "/mute": return send(env, chatId, await cmdMute(env, args[0]));
      case "/unmute": return send(env, chatId, await cmdMute(env, null, true));
      // dispatched runs
      case "/digest": return send(env, chatId, await dispatch(env, "daily.yml", "📰 Running the full digest — it’ll arrive shortly."));
      case "/scorecard": return send(env, chatId, await dispatch(env, "hl-scorecard.yml", "📊 Running the wallet scorecard — arriving shortly."));
      case "/leaderboard": return send(env, chatId, await dispatch(env, "leaderboard.yml", "🏆 Screening the HL leaderboard — top traders arriving shortly."));
      case "/ta": return needArg("Usage: /ta &lt;coin&gt; (e.g. /ta hype)") && send(env, chatId, await dispatchTa(env, argStr));
      case "/smartmoney": case "/sm": return send(env, chatId, await dispatch(env, "smartmoney.yml", "🧠 Reading top traders’ net positioning — arriving shortly."));
      case "/radar": return send(env, chatId, await dispatch(env, "radar.yml", "🆕 Scanning CT for new movers — I’ll ping you if anything’s heating up."));
      // condition watches
      case "/watch": return needArg(watchUsage()) && send(env, chatId, await cmdWatch(env, args));
      case "/watches": return send(env, chatId, await cmdWatches(env));
      case "/unwatch": return needArg("Usage: /unwatch &lt;id&gt; (see /watches)") && send(env, chatId, await cmdUnwatch(env, args[0]));
      // X / Twitter (Apify cost)
      case "/x": return needArg("Usage: /x &lt;handle&gt;") && send(env, chatId, await dispatchX(env, "x", argStr, `📱 Fetching @${esc(argStr.replace(/^@/, ""))}…`));
      case "/ticker": return needArg("Usage: /ticker &lt;symbol&gt;") && send(env, chatId, await dispatchX(env, "ticker", argStr, `📱 Scanning CT for $${esc(argStr.replace(/^\$/, "").toUpperCase())}…`));
      case "/search": return needArg("Usage: /search &lt;query&gt;") && send(env, chatId, await dispatchX(env, "search", argStr, `🔎 Searching X for “${esc(argStr)}”…`));
      case "/calls": return needArg("Usage: /calls &lt;handle&gt;") && send(env, chatId, await dispatchX(env, "calls", argStr, `🎯 Finding @${esc(argStr.replace(/^@/, ""))}’s recent calls…`));
      case "/trending": return send(env, chatId, await dispatchX(env, "trending", "", "🔥 Pulling CT trending…"));
      case "/discover": return send(env, chatId, await dispatchX(env, "discover", "", "🔭 Discovering caller candidates…"));
      default: return send(env, chatId, `Unknown command ${esc(cmd)}. Try /menu`);
    }
  } catch (e) {
    return send(env, chatId, `⚠️ ${esc(cmd)} failed: ${esc(e.message)}`);
  }
}

// ---- Telegram ----
async function send(env, chatId, textHtml) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.json();
}

// ---- GitHub contents API (read/write repo files) ----
async function ghGet(env, path) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ct-bot" },
  });
  if (!r.ok) return null;
  const j = await r.json();
  try { return { content: JSON.parse(atob(j.content.replace(/\n/g, ""))), sha: j.sha }; }
  catch { return { content: null, sha: j.sha }; }
}
async function ghPut(env, path, obj, sha, message) {
  const body = { message, content: btoa(JSON.stringify(obj, null, 2) + "\n") };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ct-bot", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}
async function getWallets(env) {
  const f = await ghGet(env, "wallets.json");
  return Array.isArray(f?.content) && f.content.length ? f.content : WALLETS_FALLBACK;
}

// ---- Hyperliquid ----
async function positions(addr) {
  const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: addr }) });
  const j = await r.json();
  return (j.assetPositions || []).map((p) => {
    const pos = p.position || {}, szi = num(pos.szi), notional = num(pos.positionValue);
    return { coin: pos.coin, side: szi > 0 ? "LONG" : "SHORT", lev: pos.leverage?.value || 0, notional, uPnl: num(pos.unrealizedPnl) };
  }).filter((p) => Math.abs(p.notional) >= MIN_NOTIONAL).sort((a, b) => b.notional - a.notional);
}
async function allMids() {
  const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
  return r.json();
}

async function cmdWallets(wallets) {
  const all = await Promise.all(wallets.map(async (w) => ({ w, pos: await positions(w.addr) })));
  const lines = ["🐋 <b>Tracked wallets</b>", ""];
  for (const { w, pos } of all) {
    if (!pos.length) { lines.push(`<b>${esc(w.label)}</b>: flat`); continue; }
    const top = pos.slice(0, 4).map((p) => `${p.side} ${p.lev}x ${esc(p.coin)} (${usd(p.notional)})`).join(", ");
    lines.push(`<b>${esc(w.label)}</b>: ${top}${pos.length > 4 ? ` +${pos.length - 4} more` : ""}`);
  }
  const c = consensusFrom(all, wallets.length);
  if (c.length) lines.push("", ...c.map((x) => `🎯 ${x}`));
  return lines.join("\n");
}
async function cmdWallet(wallets, qLabel) {
  if (!qLabel) return "Usage: /wallet &lt;label&gt;";
  const w = wallets.find((x) => x.label.toLowerCase().includes(qLabel.toLowerCase()) || x.addr.toLowerCase() === qLabel.toLowerCase());
  if (!w) return `No tracked wallet matching "${esc(qLabel)}". /wallets to list.`;
  const pos = await positions(w.addr);
  if (!pos.length) return `<b>${esc(w.label)}</b> — flat (no positions ≥ ${usd(MIN_NOTIONAL)}).`;
  const lines = [`🐋 <b>${esc(w.label)}</b>`, `<a href="https://hypurrscan.io/address/${w.addr}">${shortAddr(w.addr)}</a>`, ""];
  for (const p of pos) lines.push(`${p.side} ${p.lev}x ${esc(p.coin)} — ${usd(p.notional)} (uPnL ${usd(p.uPnl)})`);
  return lines.join("\n");
}
async function cmdConsensus(wallets) {
  const all = await Promise.all(wallets.map(async (w) => ({ w, pos: await positions(w.addr) })));
  const c = consensusFrom(all, wallets.length);
  return c.length ? "🎯 <b>Consensus</b>\n" + c.join("\n") : `No ${CONSENSUS_MIN}/${wallets.length}+ consensus right now.`;
}
function consensusFrom(all, total) {
  const m = new Map();
  for (const { w, pos } of all) for (const p of pos) {
    const k = `${p.coin}|${p.side}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(w.label);
  }
  const out = [];
  for (const [k, who] of m) if (who.length >= CONSENSUS_MIN) {
    const [coin, side] = k.split("|");
    out.push(`<b>${who.length}/${total} ${side} ${esc(coin)}</b> (${who.map(esc).join(", ")})`);
  }
  return out;
}

// ---- watchlist edits ----
async function cmdTrack(env, args) {
  const addr = (args[0] || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return "That doesn’t look like a wallet address (need 0x + 40 hex).";
  const label = args.slice(1).join(" ").trim() || shortAddr(addr);
  const f = await ghGet(env, "wallets.json");
  const list = Array.isArray(f?.content) ? f.content : [];
  if (list.some((w) => w.addr.toLowerCase() === addr)) return `Already tracking ${esc(label)}.`;
  // confirm it's a real HL account + show what it holds
  const pos = await positions(addr).catch(() => []);
  list.push({ addr, label, note: "added via bot" });
  const ok = await ghPut(env, "wallets.json", list, f?.sha, `bot: track ${label}`);
  if (!ok) return "⚠️ couldn’t update wallets.json (GitHub write failed).";
  const holding = pos.length ? "\nHolding: " + pos.slice(0, 3).map((p) => `${p.side} ${esc(p.coin)} (${usd(p.notional)})`).join(", ") : "\n(no open positions ≥ $25k right now)";
  return `✅ Now tracking <b>${esc(label)}</b> (${list.length} total).${holding}\nAlerts begin next cycle.`;
}
async function cmdUntrack(env, q) {
  const f = await ghGet(env, "wallets.json");
  const list = Array.isArray(f?.content) ? f.content : [];
  const idx = list.findIndex((w) => w.label.toLowerCase() === q.toLowerCase() || w.addr.toLowerCase() === q.toLowerCase() || w.label.toLowerCase().includes(q.toLowerCase()));
  if (idx < 0) return `No tracked wallet matching "${esc(q)}". /wallets to list.`;
  const [removed] = list.splice(idx, 1);
  const ok = await ghPut(env, "wallets.json", list, f.sha, `bot: untrack ${removed.label}`);
  return ok ? `✅ Untracked <b>${esc(removed.label)}</b> (${list.length} left).` : "⚠️ couldn’t update wallets.json.";
}

// ---- condition watches ----
const COND_RE = /^(price(<=|>=|<|>)\d+\.?\d*|rsi(<=|>=|<|>)\d+\.?\d*|funding(<=|>=|<|>)-?\d+\.?\d*|whales-(long|short))$/;
function watchUsage() {
  return "Usage: /watch &lt;coin&gt; &lt;conditions…&gt;\nConditions: price&lt;55 · rsi&lt;50 · funding&gt;50 · whales-long · whales-short\nEx: <code>/watch hype price&lt;55 rsi&lt;50 whales-long</code>";
}
async function cmdWatch(env, args) {
  const coin = (args[0] || "").toUpperCase().replace(/^\$/, "");
  const conds = args.slice(1).map((c) => c.toLowerCase());
  if (!conds.length) return watchUsage();
  const bad = conds.filter((c) => !COND_RE.test(c));
  if (bad.length) return `Unrecognized condition(s): ${esc(bad.join(", "))}\n\n${watchUsage()}`;
  const f = await ghGet(env, "state/watches.json");
  const list = Array.isArray(f?.content) ? f.content : [];
  const id = "w" + Date.now().toString(36).slice(-4);
  list.push({ id, coin, conds, created: Math.floor(Date.now() / 1000) });
  const ok = await ghPut(env, "state/watches.json", list, f?.sha, `bot: watch ${coin}`);
  if (!ok) return "⚠️ couldn’t save the watch.";
  return `🔔 Watching <b>${esc(coin)}</b> — fires when ALL met: ${conds.map(esc).join(", ")}\n(id <code>${id}</code>, checked every 30 min, one-shot)`;
}
async function cmdWatches(env) {
  const f = await ghGet(env, "state/watches.json");
  const list = Array.isArray(f?.content) ? f.content : [];
  if (!list.length) return "No active watches. Add one with /watch.";
  return "🔔 <b>Active watches</b>\n" + list.map((w) => `<code>${w.id}</code> ${esc(w.coin)}: ${w.conds.map(esc).join(", ")}`).join("\n");
}
async function cmdUnwatch(env, id) {
  const f = await ghGet(env, "state/watches.json");
  const list = Array.isArray(f?.content) ? f.content : [];
  const idx = list.findIndex((w) => w.id === id);
  if (idx < 0) return `No watch with id "${esc(id)}". See /watches.`;
  const [r] = list.splice(idx, 1);
  const ok = await ghPut(env, "state/watches.json", list, f.sha, `bot: unwatch ${r.id}`);
  return ok ? `✅ Removed watch <code>${esc(r.id)}</code> (${esc(r.coin)}).` : "⚠️ couldn’t update watches.";
}

// ---- mute ----
async function cmdMute(env, durArg, unmute = false) {
  const f = await ghGet(env, "state/mute.json");
  let until = null, label = "until you /unmute";
  if (!unmute && durArg) {
    const m = durArg.match(/^(\d+)\s*(m|h|d)$/i);
    if (m) {
      const mult = { m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
      until = Math.floor(Date.now() / 1000) + Number(m[1]) * mult;
      label = `for ${m[1]}${m[2].toLowerCase()}`;
    }
  }
  const obj = unmute ? { muted: false } : { muted: true, until };
  const ok = await ghPut(env, "state/mute.json", obj, f?.sha, unmute ? "bot: unmute" : "bot: mute");
  if (!ok) return "⚠️ couldn’t update mute state.";
  return unmute ? "🔔 Wallet alerts unmuted." : `🔕 Wallet alerts muted ${label}. (Digest still runs.)`;
}

// ---- market ----
async function cmdMarket() {
  const r = await fetch(`${CG}/simple/price?ids=bitcoin,ethereum,solana,hyperliquid&vs_currencies=usd&include_24hr_change=true`);
  const d = await r.json();
  const row = (id, sym) => { const x = d[id]; if (!x) return null; const ch = num(x.usd_24h_change); return `${sym} $${pxf(x.usd)} ${ch >= 0 ? "▲" : "▼"}${Math.abs(ch).toFixed(1)}%`; };
  return "📊 <b>Markets</b>\n" + ["bitcoin:BTC", "ethereum:ETH", "solana:SOL", "hyperliquid:HYPE"].map((p) => row(...p.split(":"))).filter(Boolean).join("  •  ");
}
async function cmdSize(args) {
  if (args.length < 3) return "Usage: /size &lt;coin&gt; &lt;risk$&gt; &lt;stop&gt; [entry]\nEx: <code>/size hype 500 55</code> — risk $500 with a stop at $55";
  const coinIn = args[0].toUpperCase().replace(/^\$/, "");
  const risk = Number(args[1]), stop = Number(args[2]);
  if (!(risk > 0) || !(stop > 0)) return "risk and stop must be positive numbers.";
  const mids = await allMids();
  const key = Object.keys(mids).find((k) => k.toLowerCase() === coinIn.toLowerCase());
  if (!key) return `No Hyperliquid market for "${esc(coinIn)}".`;
  const entry = args[3] ? Number(args[3]) : num(mids[key]);
  if (!(entry > 0)) return "bad entry price.";
  const dist = Math.abs(entry - stop);
  if (dist === 0) return "stop can’t equal entry.";
  // ATR for context
  let atrTxt = "";
  try {
    const end = Date.now();
    const c = await (await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: key, interval: "1d", startTime: end - 20 * 86400e3, endTime: end } }) })).json();
    const tr = []; for (let i = 1; i < c.length; i++) { const h = +c[i].h, l = +c[i].l, pc = +c[i - 1].c; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
    const atr = tr.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, tr.length || 1);
    if (atr > 0) { const mult = dist / atr; atrTxt = `\nStop is ${mult.toFixed(1)}× ATR${mult < 1 ? " ⚠️ tight — easy to get wicked out" : mult > 4 ? " (wide)" : ""}`; }
  } catch {}
  const units = risk / dist, notional = units * entry, side = stop < entry ? "LONG" : "SHORT";
  return [
    `📐 <b>Size — ${esc(key)}</b> (${side})`,
    `Entry $${pxf(entry)} · Stop $${pxf(stop)} · risk ${usd(risk)}`,
    `Stop distance: $${pxf(dist)} (${(dist / entry * 100).toFixed(1)}%)${atrTxt}`,
    `<b>Size: ${units < 1 ? units.toFixed(4) : units.toFixed(2)} ${esc(key)} · notional ${usd(notional)}</b>`,
    `If stopped → −${usd(risk)} (as intended).`,
    `<i>Sizing only — not advice.</i>`,
  ].join("\n");
}
async function cmdHl(coin) {
  if (!coin) return "Usage: /hl &lt;coin&gt;";
  const mids = await allMids();
  const key = Object.keys(mids).find((k) => k.toLowerCase() === coin.toLowerCase());
  return key ? `⚡ <b>${esc(key)}</b> (Hyperliquid mid): $${pxf(num(mids[key]))}` : `No Hyperliquid market for "${esc(coin)}".`;
}
async function cmdPrice(q) {
  if (!q) return "Usage: /price &lt;coin&gt;";
  const s = await (await fetch(`${CG}/search?query=${encodeURIComponent(q)}`)).json();
  const coin = (s.coins || [])[0];
  if (!coin) return `No coin found for "${esc(q)}".`;
  const p = await (await fetch(`${CG}/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true`)).json();
  const x = p[coin.id]; if (!x) return `No price for ${esc(coin.id)}.`;
  const ch = num(x.usd_24h_change);
  return `💲 <b>${esc(coin.symbol.toUpperCase())}</b> ${esc(coin.name)}\n$${pxf(x.usd)}  ${ch >= 0 ? "▲" : "▼"}${Math.abs(ch).toFixed(1)}% (24h)`;
}

// ---- dispatch ----
async function ghDispatch(env, workflowFile, inputs) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ct-bot", "Content-Type": "application/json" },
    body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
  });
}
async function dispatch(env, workflowFile, ack) {
  const r = await ghDispatch(env, workflowFile);
  return r.status === 204 ? ack : `⚠️ couldn’t trigger (${r.status}): ${(await r.text()).slice(0, 120)}`;
}
async function dispatchX(env, mode, arg, ack) {
  const r = await ghDispatch(env, "x-command.yml", { mode, arg: arg || "" });
  return r.status === 204 ? ack : `⚠️ couldn’t trigger (${r.status}): ${(await r.text()).slice(0, 120)}`;
}
async function dispatchTa(env, coin) {
  const r = await ghDispatch(env, "ta.yml", { coin });
  return r.status === 204 ? `📈 Running TA on ${esc(coin.toUpperCase())} — arriving shortly.` : `⚠️ couldn’t trigger (${r.status}): ${(await r.text()).slice(0, 120)}`;
}

function statusText(env) {
  return ["✅ <b>CT bot online</b>", "", "Scheduled: digest 6 AM PT · wallet watch /30 min · scorecard Sundays", "Run /menu for commands."].join("\n");
}
function helpText() {
  return [
    "🤖 <b>CT Cockpit</b>",
    "", "🐋 <b>Wallets</b> (instant)",
    "/wallets · /wallet &lt;label&gt; · /consensus",
    "/track &lt;0x&gt; [label] · /untrack &lt;label&gt;",
    "", "💲 <b>Market</b> (instant)",
    "/market · /hl &lt;coin&gt; · /price &lt;coin&gt;",
    "/size &lt;coin&gt; &lt;risk$&gt; &lt;stop&gt; — position sizer",
    "", "📈 <b>Analysis</b>",
    "/ta &lt;coin&gt; — full technical read + whale confluence",
    "/smartmoney — top traders’ net positioning per coin",
    "/radar — scan CT for new coins heating up",
    "/watch &lt;coin&gt; &lt;conds&gt; — alert when conditions hit",
    "/watches · /unwatch &lt;id&gt;",
    "", "📰 <b>On-demand</b> (triggers a run)",
    "/digest · /scorecard · /leaderboard",
    "", "📱 <b>X / Twitter</b> (Apify cost)",
    "/trending · /ticker &lt;sym&gt; · /x &lt;handle&gt;",
    "/calls &lt;handle&gt; · /search &lt;query&gt; · /discover",
    "", "⚙️ /mute [30m|2h] · /unmute · /status · /menu",
  ].join("\n");
}
