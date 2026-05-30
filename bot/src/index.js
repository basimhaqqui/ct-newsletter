// Telegram command bot on Cloudflare Workers (webhook).
// Instant commands hit Hyperliquid/CoinGecko directly; heavy ones (digest,
// scorecard) trigger the repo's GitHub Actions workflows.
//
// Secrets (wrangler secret put ...): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//   WEBHOOK_SECRET, GITHUB_TOKEN (fine-grained PAT, Actions: read+write on the repo).
// Vars (wrangler.toml [vars]): GITHUB_REPO = "basimhaqqui/ct-newsletter".

const INFO = "https://api.hyperliquid.xyz/info";
const CG = "https://api.coingecko.com/api/v3";

// Tracked wallets (keep in sync with wallets.json). /track will manage these later.
const WALLETS = [
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

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("ok"); // health check
    // Verify the request really came from Telegram.
    if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try { update = await request.json(); } catch { return new Response("ok"); }

    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();
    // Allowlist: only the owner's chat may use the bot.
    if (!chatId || String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok");
    if (!text.startsWith("/")) return new Response("ok");

    // Do the work async so we always 200 fast (Telegram retries on non-200).
    ctx.waitUntil(handle(text, chatId, env));
    return new Response("ok");
  },
};

async function handle(text, chatId, env) {
  const [raw, ...args] = text.split(/\s+/);
  const cmd = raw.split("@")[0].toLowerCase(); // strip /cmd@botname
  try {
    switch (cmd) {
      case "/start":
      case "/help": return send(env, chatId, helpText());
      case "/wallets": return send(env, chatId, await cmdWallets());
      case "/wallet": return send(env, chatId, await cmdWallet(args[0]));
      case "/consensus": return send(env, chatId, await cmdConsensus());
      case "/market": return send(env, chatId, await cmdMarket());
      case "/hl": return send(env, chatId, await cmdHl(args[0]));
      case "/price": return send(env, chatId, await cmdPrice(args[0]));
      case "/status": return send(env, chatId, statusText(env));
      case "/digest": return send(env, chatId, await dispatch(env, "daily.yml", "📰 Running the full digest — it’ll arrive shortly."));
      case "/scorecard": return send(env, chatId, await dispatch(env, "hl-scorecard.yml", "📊 Running the wallet scorecard — arriving shortly."));
      default: return send(env, chatId, `Unknown command ${cmd}. Try /help`);
    }
  } catch (e) {
    return send(env, chatId, `⚠️ ${cmd} failed: ${e.message}`);
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

async function cmdWallets() {
  const all = await Promise.all(WALLETS.map(async (w) => ({ w, pos: await positions(w.addr) })));
  const lines = ["🐋 <b>Tracked wallets</b>", ""];
  for (const { w, pos } of all) {
    if (!pos.length) { lines.push(`<b>${w.label}</b>: flat`); continue; }
    const top = pos.slice(0, 4).map((p) => `${p.side} ${p.lev}x ${p.coin} (${usd(p.notional)})`).join(", ");
    lines.push(`<b>${w.label}</b>: ${top}${pos.length > 4 ? ` +${pos.length - 4} more` : ""}`);
  }
  const c = consensusFrom(all);
  if (c.length) { lines.push("", ...c.map((x) => `🎯 ${x}`)); }
  return lines.join("\n");
}

async function cmdWallet(qLabel) {
  if (!qLabel) return "Usage: /wallet &lt;label&gt; (e.g. /wallet jefefefe)";
  const w = WALLETS.find((x) => x.label.toLowerCase().includes(qLabel.toLowerCase()) || x.addr.toLowerCase() === qLabel.toLowerCase());
  if (!w) return `No tracked wallet matching "${qLabel}". /wallets to list.`;
  const pos = await positions(w.addr);
  if (!pos.length) return `<b>${w.label}</b> — flat (no positions ≥ ${usd(MIN_NOTIONAL)}).`;
  const lines = [`🐋 <b>${w.label}</b>`, `<a href="https://hypurrscan.io/address/${w.addr}">${w.addr.slice(0, 10)}…</a>`, ""];
  for (const p of pos) lines.push(`${p.side} ${p.lev}x ${p.coin} — ${usd(p.notional)} (uPnL ${usd(p.uPnl)})`);
  return lines.join("\n");
}

async function cmdConsensus() {
  const all = await Promise.all(WALLETS.map(async (w) => ({ w, pos: await positions(w.addr) })));
  const c = consensusFrom(all);
  return c.length ? "🎯 <b>Consensus</b>\n" + c.join("\n") : `No ${CONSENSUS_MIN}/${WALLETS.length}+ consensus right now.`;
}
function consensusFrom(all) {
  const m = new Map();
  for (const { w, pos } of all) for (const p of pos) {
    const k = `${p.coin}|${p.side}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(w.label);
  }
  const out = [];
  for (const [k, who] of m) if (who.length >= CONSENSUS_MIN) {
    const [coin, side] = k.split("|");
    out.push(`<b>${who.length}/${WALLETS.length} ${side} ${coin}</b> (${who.join(", ")})`);
  }
  return out;
}

// ---- Market ----
async function cmdMarket() {
  const ids = "bitcoin,ethereum,solana,hyperliquid";
  const r = await fetch(`${CG}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
  const d = await r.json();
  const row = (id, sym) => {
    const x = d[id]; if (!x) return null;
    const ch = num(x.usd_24h_change);
    return `${sym} $${pxf(x.usd)} ${ch >= 0 ? "▲" : "▼"}${Math.abs(ch).toFixed(1)}%`;
  };
  return "📊 <b>Markets</b>\n" + ["bitcoin:BTC", "ethereum:ETH", "solana:SOL", "hyperliquid:HYPE"]
    .map((p) => row(...p.split(":"))).filter(Boolean).join("  •  ");
}
async function cmdHl(coin) {
  if (!coin) return "Usage: /hl &lt;coin&gt; (e.g. /hl hype)";
  const mids = await allMids();
  const key = Object.keys(mids).find((k) => k.toLowerCase() === coin.toLowerCase());
  if (!key) return `No Hyperliquid market for "${coin}".`;
  return `⚡ <b>${key}</b> (Hyperliquid mid): $${pxf(num(mids[key]))}`;
}
async function cmdPrice(q) {
  if (!q) return "Usage: /price &lt;coin&gt; (e.g. /price wif)";
  const s = await (await fetch(`${CG}/search?query=${encodeURIComponent(q)}`)).json();
  const coin = (s.coins || [])[0];
  if (!coin) return `No coin found for "${q}".`;
  const p = await (await fetch(`${CG}/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true`)).json();
  const x = p[coin.id]; if (!x) return `No price for ${coin.id}.`;
  const ch = num(x.usd_24h_change);
  return `💲 <b>${coin.symbol.toUpperCase()}</b> ${coin.name}\n$${pxf(x.usd)}  ${ch >= 0 ? "▲" : "▼"}${Math.abs(ch).toFixed(1)}% (24h)`;
}

// ---- GitHub workflow dispatch ----
async function dispatch(env, workflowFile, ackMsg) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "ct-bot",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) return `⚠️ couldn't trigger (${r.status}): ${(await r.text()).slice(0, 120)}`;
  return ackMsg;
}

function statusText(env) {
  return [
    "✅ <b>CT bot online</b>",
    "",
    "Scheduled: digest daily 6 AM PT · wallet watch every 30 min · scorecard Sundays",
    `Tracked wallets: ${WALLETS.map((w) => w.label).join(", ")}`,
    "Run /help for commands.",
  ].join("\n");
}

function helpText() {
  return [
    "🤖 <b>CT Cockpit</b>",
    "",
    "🐋 <b>Wallets</b> (instant)",
    "/wallets — all tracked positions + consensus",
    "/wallet &lt;label&gt; — one wallet's book",
    "/consensus — where wallets align",
    "",
    "💲 <b>Market</b> (instant)",
    "/market — BTC/ETH/SOL/HYPE",
    "/hl &lt;coin&gt; — Hyperliquid mid price",
    "/price &lt;coin&gt; — any coin (CoinGecko)",
    "",
    "📰 <b>On-demand</b> (triggers a run)",
    "/digest — full CT newsletter now",
    "/scorecard — wallet scorecard now",
    "",
    "/status · /help",
    "",
    "<i>Coming soon: /leaderboard, /track, and X commands (/x, /ticker, /trending, /search).</i>",
  ].join("\n");
}
