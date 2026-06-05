// Conversational agent: Haiku orchestrates tools; the technical_analysis tool
// makes a nested Opus call for deep reads. Memory in KV (env.MEMORY).
// Anthropic via raw fetch (Worker has no SDK; everything else here is fetch too).

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const INFO = "https://api.hyperliquid.xyz/info";
const CG = "https://api.coingecko.com/api/v3";
const CHAT_MODEL = "claude-haiku-4-5";
const TA_MODEL = "claude-opus-4-8";

const WALLETS_FALLBACK = [
  { addr: "0x57f2819c959abbcf22623d5ec1d3164b213e9711", label: "jefefefe" },
  { addr: "0x3705121529bf40d77e8e7b625120551b151d9af2", label: "0x3705…9af2" },
  { addr: "0xdd54150be70967523a256f92db193845acf58714", label: "0xdd54…8714" },
  { addr: "0xc914267b2b98cabf20ef904de5fbb326c982855d", label: "0xc914…855d" },
];
const MIN_NOTIONAL = 25000, CONSENSUS_MIN = 3;
const num = (x) => Number(x) || 0;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pxf = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const usd = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${a.toFixed(0)}`; };

async function info(b) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.json(); }
async function ghGet(env, path) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ct-bot" } });
  if (!r.ok) return null;
  const j = await r.json();
  try { return { content: JSON.parse(atob(j.content.replace(/\n/g, ""))), sha: j.sha }; } catch { return { content: null, sha: j.sha }; }
}
async function ghPut(env, path, obj, sha, message) {
  const body = { message, content: btoa(JSON.stringify(obj, null, 2) + "\n") }; if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, { method: "PUT", headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ct-bot", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.ok;
}
async function getWallets(env) { const f = await ghGet(env, "wallets.json"); return Array.isArray(f?.content) && f.content.length ? f.content : WALLETS_FALLBACK; }

// ---- persistent per-user profile (long-term memory, no TTL) ----
async function getProfile(env, chatId) {
  if (!env.MEMORY) return { notes: [] };
  try { return JSON.parse((await env.MEMORY.get(`profile:${chatId}`)) || '{"notes":[]}'); } catch { return { notes: [] }; }
}
async function saveProfile(env, chatId, p) {
  if (env.MEMORY) await env.MEMORY.put(`profile:${chatId}`, JSON.stringify({ notes: (p.notes || []).slice(-30), updatedAt: Math.floor(Date.now() / 1000) }));
}

// ---- paper trading (hypothetical, persisted in KV) ----
async function getPaper(env, chatId) {
  if (!env.MEMORY) return { open: [], closed: [], realized: 0 };
  try { return JSON.parse((await env.MEMORY.get(`paper:${chatId}`)) || '{"open":[],"closed":[],"realized":0}'); } catch { return { open: [], closed: [], realized: 0 }; }
}
async function savePaper(env, chatId, p) { if (env.MEMORY) await env.MEMORY.put(`paper:${chatId}`, JSON.stringify(p)); }
const pnlOf = (t, cur) => (cur / t.entry - 1) * t.notional * (t.side === "long" ? 1 : -1);
async function positions(addr) {
  const j = await info({ type: "clearinghouseState", user: addr });
  return (j.assetPositions || []).map((p) => { const pos = p.position || {}, szi = num(pos.szi), n = num(pos.positionValue); return { coin: pos.coin, side: szi > 0 ? "LONG" : "SHORT", lev: pos.leverage?.value || 0, notional: n, entry: num(pos.entryPx), uPnl: num(pos.unrealizedPnl) }; }).filter((p) => Math.abs(p.notional) >= MIN_NOTIONAL);
}
async function candles(coin, interval, count) {
  const iv = { "15m": 9e5, "1h": 3600e3, "4h": 4 * 3600e3, "1d": 86400e3 }[interval], end = Date.now();
  const c = await info({ type: "candleSnapshot", req: { coin, interval, startTime: end - iv * count, endTime: end } });
  return { o: c.map((x) => +x.o), h: c.map((x) => +x.h), l: c.map((x) => +x.l), c: c.map((x) => +x.c), t: c.map((x) => +x.t) };
}
const ema = (a, p) => { const k = 2 / (p + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
const rsi = (a, p = 14) => { let g = 0, l = 0; for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d >= 0) g += d; else l -= d; } return 100 - 100 / (1 + g / (l || 1e-9)); };

// CoinGecko fallback for coins NOT on Hyperliquid (Solana/long-tail tokens on Bullpen).
// Resolves ticker → CG id (best symbol match by market cap), returns daily/hourly closes.
async function cgResolve(coin) {
  const r = await fetch(`${CG}/search?query=${encodeURIComponent(coin)}`); if (!r.ok) return null;
  const j = await r.json(); const sym = coin.toLowerCase();
  const exact = (j.coins || []).filter((c) => (c.symbol || "").toLowerCase() === sym);
  const pick = (exact.length ? exact : j.coins || []).sort((a, b) => (a.market_cap_rank || 1e9) - (b.market_cap_rank || 1e9))[0];
  return pick ? { id: pick.id, name: pick.name, symbol: (pick.symbol || coin).toUpperCase() } : null;
}
async function cgCloses(id, days) {
  const r = await fetch(`${CG}/coins/${id}/market_chart?vs_currency=usd&days=${days}`); if (!r.ok) return null;
  const j = await r.json(); return (j.prices || []).map((p) => +p[1]);
}

async function callClaude(env, { model, system, messages, tools, max_tokens }) {
  const body = { model, max_tokens, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages };
  if (tools) body.tools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
  const h = { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(ANTHROPIC, { method: "POST", headers: h, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    // Retry transient rate-limit (429) / overloaded (529) with backoff; respect retry-after.
    if ((r.status === 429 || r.status === 529) && attempt < 3) {
      const ra = Number(r.headers.get("retry-after"));
      const wait = Math.min((ra || 2 ** (attempt + 1)), 12) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    const txt = (await r.text()).slice(0, 150);
    const err = new Error(`Anthropic ${r.status}: ${txt}`);
    err.status = r.status;
    throw err;
  }
}

// ---- tools ----
const TOOLS = [
  { name: "get_wallets", description: "Current positions of all tracked Hyperliquid whale wallets + where they reach consensus. Use for 'what are the whales doing', 'are they long X', positioning questions.", input_schema: { type: "object", properties: {} } },
  { name: "get_coin", description: "Live price, 24h change, perp funding (annualized %), and open interest for one coin. Quick price/funding lookups.", input_schema: { type: "object", properties: { coin: { type: "string" } }, required: ["coin"] } },
  { name: "get_market", description: "Snapshot of BTC/ETH/SOL/HYPE prices + 24h change.", input_schema: { type: "object", properties: {} } },
  { name: "technical_analysis", description: "Deep multi-timeframe technical read for ANY coin the user can trade on Bullpen. HL-listed coins (230+ perps) get full data: trend, RSI, key levels, funding, whale confirmation. Non-HL coins (Solana/long-tail spot) auto-fall back to a CoinGecko price-action read (no funding/whales). Use whenever the user asks for analysis, 'what's the play', an entry, levels, or whether to buy/sell — never refuse a ticker, just call this. Returns a finished expert read — present it as-is.", input_schema: { type: "object", properties: { coin: { type: "string" } }, required: ["coin"] } },
  { name: "position_size", description: "Risk-based position sizing. Given coin, dollar risk, stop price (and optional entry), returns units + notional.", input_schema: { type: "object", properties: { coin: { type: "string" }, risk: { type: "number" }, stop: { type: "number" }, entry: { type: "number" } }, required: ["coin", "risk", "stop"] } },
  { name: "set_watch", description: "Create a one-shot alert that fires when ALL conditions hold (checked ~every 30 min). Conditions are strings like 'price<55', 'rsi<50', 'funding>50', 'whales-long', 'whales-short'.", input_schema: { type: "object", properties: { coin: { type: "string" }, conditions: { type: "array", items: { type: "string" } } }, required: ["coin", "conditions"] } },
  { name: "paper_open", description: "Record a HYPOTHETICAL (paper) trade for practice — NOT a real order. Use when the user wants to simulate entering (e.g. 'paper long hype $1000 stop 48'). Entry defaults to current price if not given.", input_schema: { type: "object", properties: { coin: { type: "string" }, side: { type: "string", enum: ["long", "short"] }, notional: { type: "number", description: "position size in USD" }, entry: { type: "number" }, stop: { type: "number" } }, required: ["coin", "side", "notional"] } },
  { name: "paper_close", description: "Close a paper trade at the current price and book realized P&L. Identify by coin or id.", input_schema: { type: "object", properties: { coin: { type: "string" }, id: { type: "string" } } } },
  { name: "paper_status", description: "Show open paper trades with live unrealized P&L + total realized. Use for 'how's my paper portfolio'.", input_schema: { type: "object", properties: {} } },
  { name: "remember", description: "Save a durable fact about THIS user to long-term memory — their HL wallet address, default risk size, an open position they tell you about, or a stated preference. Use whenever they share something worth recalling in future conversations. Don't save one-off chatter or market data.", input_schema: { type: "object", properties: { note: { type: "string", description: "short fact, e.g. 'HL wallet: 0xabc…' or 'default risk: $1000' or 'long HYPE from $52'" } }, required: ["note"] } },
  { name: "forget", description: "Remove remembered fact(s) that are no longer true (matched by a phrase). Use when something changes — e.g. they closed a position or changed their risk size: forget the stale note, then remember the new one.", input_schema: { type: "object", properties: { match: { type: "string" } }, required: ["match"] } },
  { name: "run_job", description: "Trigger a background job; result arrives in the chat shortly. jobs: digest (full CT newsletter), scorecard (wallet performance), smartmoney (top-50 net positioning), leaderboard (top traders), radar (scan CT for new coins heating up). Or an X scrape: set job to x|ticker|trending|search|calls|discover and pass arg.", input_schema: { type: "object", properties: { job: { type: "string" }, arg: { type: "string" } }, required: ["job"] } },
];

const allMids = () => info({ type: "allMids" });
async function midKey(coin) { const m = await allMids(); const k = Object.keys(m).find((x) => x.toLowerCase() === coin.toLowerCase()); return k ? { key: k, price: num(m[k]) } : null; }
async function fundingOI(coin) { const [meta, ctxs] = await info({ type: "metaAndAssetCtxs" }); const i = meta.universe.findIndex((u) => u.name.toLowerCase() === coin.toLowerCase()); if (i < 0) return null; const c = ctxs[i]; return { fundingAnnual: num(c.funding) * 24 * 365 * 100, oi: num(c.openInterest) * num(c.markPx), mark: num(c.markPx) }; }

async function gatherWhaleSide(env, coin) {
  const wallets = await getWallets(env); let long = 0, short = 0, who = [];
  for (const w of wallets) { const pos = (await positions(w.addr)).find((p) => p.coin.toLowerCase() === coin.toLowerCase()); if (pos) { (pos.side === "LONG" ? long++ : short++); who.push(`${w.label} ${pos.side} ${pos.lev}x @ $${pxf(pos.entry)}`); } }
  return { long, short, total: wallets.length, who };
}

async function execTool(env, chatId, name, input) {
  if (name === "get_wallets") {
    const wallets = await getWallets(env);
    const all = await Promise.all(wallets.map(async (w) => ({ w, pos: await positions(w.addr) })));
    const cons = new Map();
    const lines = all.map(({ w, pos }) => { for (const p of pos) { const k = `${p.coin}|${p.side}`; cons.set(k, (cons.get(k) || 0) + 1); } return `${w.label}: ${pos.length ? pos.slice(0, 5).map((p) => `${p.side} ${p.lev}x ${p.coin} ${usd(p.notional)}`).join(", ") : "flat"}`; });
    const consensus = [...cons].filter(([, n]) => n >= CONSENSUS_MIN).map(([k, n]) => { const [c, s] = k.split("|"); return `${n}/${wallets.length} ${s} ${c}`; });
    return lines.join("\n") + (consensus.length ? "\nCONSENSUS: " + consensus.join("; ") : "");
  }
  if (name === "get_coin") {
    const mk = await midKey(input.coin);
    if (!mk) {
      const meta = await cgResolve(input.coin); const dc = meta ? await cgCloses(meta.id, 2) : null; const px = dc && dc.length ? dc[dc.length - 1] : null;
      if (px) return `${meta.symbol} $${pxf(px)} (CoinGecko spot — not an HL perp, so no funding/OI; tradeable on Bullpen. Offer price-action TA via technical_analysis if they want a read).`;
      return `${input.coin} not found on HL or CoinGecko — check the ticker.`;
    }
    const f = await fundingOI(mk.key);
    return `${mk.key}: $${pxf(mk.price)}${f ? ` · funding ${f.fundingAnnual.toFixed(0)}%/yr · OI ${usd(f.oi)}` : ""}`;
  }
  if (name === "get_market") {
    const d = await (await fetch(`${CG}/simple/price?ids=bitcoin,ethereum,solana,hyperliquid&vs_currencies=usd&include_24hr_change=true`)).json();
    return ["bitcoin:BTC", "ethereum:ETH", "solana:SOL", "hyperliquid:HYPE"].map((p) => { const [id, sym] = p.split(":"); const x = d[id]; return x ? `${sym} $${pxf(x.usd)} ${num(x.usd_24h_change) >= 0 ? "+" : ""}${num(x.usd_24h_change).toFixed(1)}%` : null; }).filter(Boolean).join(" · ");
  }
  if (name === "position_size") {
    const mk = await midKey(input.coin); if (!mk) return `No market for ${input.coin}.`;
    const entry = input.entry || mk.price, dist = Math.abs(entry - input.stop); if (!dist) return "stop can't equal entry.";
    const units = input.risk / dist;
    return `${mk.key} ${input.stop < entry ? "LONG" : "SHORT"}: entry $${pxf(entry)}, stop $${pxf(input.stop)}, risk ${usd(input.risk)} → size ${units < 1 ? units.toFixed(4) : units.toFixed(2)} ${mk.key} (notional ${usd(units * entry)}). Stop ${(dist / entry * 100).toFixed(1)}% away.`;
  }
  if (name === "set_watch") {
    const re = /^(price(<=|>=|<|>)\d+\.?\d*|rsi(<=|>=|<|>)\d+\.?\d*|funding(<=|>=|<|>)-?\d+\.?\d*|whales-(long|short))$/;
    const conds = (input.conditions || []).map((c) => String(c).toLowerCase());
    const bad = conds.filter((c) => !re.test(c)); if (!conds.length || bad.length) return `Invalid conditions: ${bad.join(", ") || "none given"}. Use price<55, rsi<50, funding>50, whales-long, whales-short.`;
    const f = await ghGet(env, "state/watches.json"); const list = Array.isArray(f?.content) ? f.content : [];
    const id = "w" + Date.now().toString(36).slice(-4); list.push({ id, coin: input.coin.toUpperCase(), conds, created: Math.floor(Date.now() / 1000) });
    const ok = await ghPut(env, "state/watches.json", list, f?.sha, `bot: watch ${input.coin}`);
    return ok ? `Watch ${id} set on ${input.coin.toUpperCase()} (${conds.join(", ")}). Fires once when all hold; checked ~every 30 min.` : "Failed to save watch.";
  }
  if (name === "run_job") {
    const map = { digest: ["daily.yml", {}], scorecard: ["hl-scorecard.yml", {}], smartmoney: ["smartmoney.yml", {}], leaderboard: ["leaderboard.yml", {}], radar: ["radar.yml", {}] };
    let file, inputs;
    if (map[input.job]) { [file, inputs] = map[input.job]; }
    else if (["x", "ticker", "trending", "search", "calls", "discover"].includes(input.job)) { file = "x-command.yml"; inputs = { mode: input.job, arg: input.arg || "" }; }
    else return `Unknown job '${input.job}'.`;
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${file}/dispatches`, { method: "POST", headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "ct-bot", "Content-Type": "application/json" }, body: JSON.stringify(Object.keys(inputs).length ? { ref: "main", inputs } : { ref: "main" }) });
    return r.status === 204 ? `Triggered '${input.job}' — result will arrive in the chat shortly.` : `Couldn't trigger (${r.status}).`;
  }
  if (name === "paper_open") {
    const mk = await midKey(input.coin); if (!mk) return `No HL market for ${input.coin}.`;
    const entry = input.entry || mk.price, id = "p" + Date.now().toString(36).slice(-4);
    const t = { id, coin: mk.key, side: (input.side || "long").toLowerCase(), entry, notional: input.notional, stop: input.stop || null, openedAt: Math.floor(Date.now() / 1000) };
    const p = await getPaper(env, chatId); p.open.push(t); await savePaper(env, chatId, p);
    return `📝 Paper ${t.side.toUpperCase()} ${t.coin} — entry $${pxf(entry)}, size ${usd(t.notional)}${t.stop ? `, stop $${pxf(t.stop)}` : ""} (id ${id}). Hypothetical — not a real order.`;
  }
  if (name === "paper_close") {
    const p = await getPaper(env, chatId);
    const idx = p.open.findIndex((t) => (input.id && t.id === input.id) || (input.coin && t.coin.toLowerCase() === input.coin.toLowerCase()));
    if (idx < 0) return "No matching open paper trade. Ask for /paper to list them.";
    const t = p.open[idx], mk = await midKey(t.coin), cur = mk ? mk.price : t.entry, pnl = pnlOf(t, cur);
    p.open.splice(idx, 1); p.closed.push({ ...t, closePx: cur, pnl: +pnl.toFixed(2), closedAt: Math.floor(Date.now() / 1000) });
    p.realized = +((p.realized || 0) + pnl).toFixed(2); await savePaper(env, chatId, p);
    const pct = (cur / t.entry - 1) * 100 * (t.side === "long" ? 1 : -1);
    return `Closed paper ${t.side.toUpperCase()} ${t.coin}: $${pxf(t.entry)} → $${pxf(cur)} = ${usd(pnl)} (${pct.toFixed(1)}%). Total realized: ${usd(p.realized)}`;
  }
  if (name === "paper_status") {
    const p = await getPaper(env, chatId);
    if (!p.open.length && !p.closed.length) return "No paper trades yet. Say e.g. “paper long hype $1000 stop 48”.";
    let unreal = 0; const lines = [];
    for (const t of p.open) { const mk = await midKey(t.coin), cur = mk ? mk.price : t.entry, pnl = pnlOf(t, cur); unreal += pnl; lines.push(`${t.side.toUpperCase()} ${t.coin} @ $${pxf(t.entry)} (now $${pxf(cur)}) → ${usd(pnl)} [${t.id}]`); }
    return `📝 Paper portfolio\nOpen:\n${lines.join("\n") || "  none"}\nUnrealized ${usd(unreal)} · Realized ${usd(p.realized || 0)} · ${p.closed.length} closed`;
  }
  if (name === "remember") {
    const p = await getProfile(env, chatId);
    const note = String(input.note || "").slice(0, 200);
    if (!note) return "nothing to remember.";
    p.notes = [...(p.notes || []).filter((n) => n !== note), note].slice(-30);
    await saveProfile(env, chatId, p);
    return `Saved to memory: "${note}"`;
  }
  if (name === "forget") {
    const p = await getProfile(env, chatId);
    const m = String(input.match || "").toLowerCase();
    const before = (p.notes || []).length;
    p.notes = (p.notes || []).filter((n) => !n.toLowerCase().includes(m));
    await saveProfile(env, chatId, p);
    return `Removed ${before - p.notes.length} note(s) matching "${esc(input.match)}".`;
  }
  if (name === "technical_analysis") return technicalAnalysis(env, chatId, input.coin);
  return `Unknown tool ${name}`;
}

// Deep tool: gather data + nested Opus call → finished read
async function technicalAnalysis(env, chatId, coin) {
  const mk = await midKey(coin); if (!mk) return technicalAnalysisCG(env, chatId, coin); // not on HL → CoinGecko price-action fallback
  await typing(env, chatId); // deep read is the slow step (~10s Opus call) — keep the indicator alive
  const key = mk.key;
  const d1 = await candles(key, "1d", 60), h4 = await candles(key, "4h", 80);
  const px = d1.c[d1.c.length - 1];
  const f = await fundingOI(key);
  const whales = await gatherWhaleSide(env, key);
  const data = {
    coin: key, price: px,
    change_24h_7d_30d: [((px / d1.c[d1.c.length - 2] - 1) * 100).toFixed(1), ((px / d1.c[d1.c.length - 8] - 1) * 100).toFixed(1), ((px / d1.c[d1.c.length - 31] - 1) * 100).toFixed(1)],
    rsi_1d: Math.round(rsi(d1.c)), rsi_4h: Math.round(rsi(h4.c)),
    ema20_1d: +ema(d1.c.slice(-40), 20).toFixed(3), ema50_1d: +ema(d1.c.slice(-55), 50).toFixed(3),
    resistance: +Math.max(...d1.h.slice(-14)).toFixed(3), support: [+ema(d1.c.slice(-40), 20).toFixed(3), +Math.min(...d1.l.slice(-14)).toFixed(3)],
    funding_annual_pct: f ? +f.fundingAnnual.toFixed(0) : null, open_interest_usd: f ? Math.round(f.oi) : null,
    whales: `${whales.long}L/${whales.short}S of ${whales.total} (${whales.who.join("; ") || "none"})`,
  };
  const sys = `You are a sharp crypto trader writing a SHORT Telegram read (HTML: <b>,<i>,<a> only) for ${key}, from real Hyperliquid data. LEAD WITH THE TRADE — do not bury it in caution.

Structure:
1) <b>Setup</b>: one line — <b>LONG</b>, <b>SHORT</b>, or <b>NO TRADE</b>. Weigh short and long EQUALLY. If it's overbought (RSI>70) at resistance with whale conviction fading/not-confirming, that IS a short setup — say "short", don't just say "don't chase". If oversold at support with whales long, that's a long.
2) <b>Entry / Stop / Target</b>: concrete numbers — entry zone, a stop just beyond invalidation (sized to ATR), a realistic target.
3) <b>Why</b>: the evidence — trend (1d/4h), momentum (RSI/MACD), funding (crowded vs healthy), whale confluence.
4) <b>Invalidation</b>: the level that kills the thesis.

Be direct and specific. State a <b>conviction</b> (low/med/high) and never pretend certainty. If there's genuinely no clean edge, say "no trade — wait for X" (don't force one). End with "<i>Not advice · probabilistic · manage risk.</i>". Output only the read — no preamble, no code fences. Under ~240 words.`;
  const j = await callClaude(env, { model: TA_MODEL, system: sys, max_tokens: 1500, messages: [{ role: "user", content: "Data:\n" + JSON.stringify(data, null, 2) }] });
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// Fallback TA for coins not on HL: CoinGecko price action only (no funding/OI/whales).
async function technicalAnalysisCG(env, chatId, coin) {
  const meta = await cgResolve(coin);
  if (!meta) return `Couldn't find ${coin} on Hyperliquid OR CoinGecko — double-check the ticker.`;
  await typing(env, chatId); // CG fetch + Opus call is the slow step
  const dc = await cgCloses(meta.id, 365), hc = await cgCloses(meta.id, 14); // daily + hourly closes
  if (!dc || dc.length < 35) return `Found ${meta.name} (${meta.symbol}) but couldn't pull enough price history for a clean read.`;
  const px = dc[dc.length - 1], h4 = (hc || []).filter((_, i) => i % 4 === 0), last14 = dc.slice(-14);
  const data = {
    coin: meta.symbol, name: meta.name, price: px,
    source: "CoinGecko spot — NO perp funding/OI, NO whale data (Bullpen long-tail/Solana token, not on HL)",
    change_24h_7d_30d: [((px / dc[dc.length - 2] - 1) * 100).toFixed(1), ((px / dc[dc.length - 8] - 1) * 100).toFixed(1), ((px / dc[dc.length - 31] - 1) * 100).toFixed(1)],
    rsi_1d: Math.round(rsi(dc)), rsi_4h: h4.length > 16 ? Math.round(rsi(h4)) : null,
    ema20_1d: +ema(dc.slice(-40), 20).toFixed(6), ema50_1d: +ema(dc.slice(-55), 50).toFixed(6),
    resistance_approx: +Math.max(...last14).toFixed(6), support_approx: +Math.min(...last14).toFixed(6),
  };
  const sys = `You are a sharp crypto trader writing a SHORT Telegram read (HTML: <b>,<i>,<a> only) for ${meta.symbol} (${meta.name}) — a token the user trades on Bullpen that is NOT on Hyperliquid, so you have CoinGecko PRICE ACTION ONLY: no perp funding, no open interest, no whale positioning, and levels are approximate (from spot closes). Be upfront it's technicals-only. LEAD WITH THE TRADE — don't bury it.

Structure:
1) <b>Setup</b>: one line — <b>LONG</b>, <b>SHORT</b>, or <b>NO TRADE</b>. Weigh short and long EQUALLY.
2) <b>Entry / Stop / Target</b>: concrete numbers from the price action.
3) <b>Why</b>: trend (daily EMA20/50), momentum (RSI 1d/4h), recent 30d range. Explicitly note you lack funding/whale confirmation.
4) <b>Invalidation</b>: the level that kills the thesis.

State a <b>conviction</b> (low/med/high) — lean LOWER than usual since you have no funding/whale confirmation, only spot price. Never pretend certainty; if no clean edge say "no trade — wait for X". End with "<i>Price-action only · no funding/whale data · not advice · manage risk.</i>". Output only the read — no preamble, no code fences. Under ~220 words.`;
  const j = await callClaude(env, { model: TA_MODEL, system: sys, max_tokens: 1500, messages: [{ role: "user", content: "Data:\n" + JSON.stringify(data, null, 2) }] });
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const SYSTEM = `You are the user's personal Crypto Twitter + Hyperliquid trading cockpit, accessed via Telegram chat. You help them read the market and their tracked on-chain whale wallets, and you drive their bot's tools.

WHERE THE USER TRADES: the user trades on Bullpen. Bullpen's perps route through Hyperliquid (same 230+ perp markets), so your HL data — price, funding, OI, whale positioning — applies DIRECTLY to their Bullpen perp trades. Treat the full HL perp universe (230+ coins: BTC, ETH, SOL, ZEC, and most majors/alts) as in-scope and tradeable for them. Bullpen also has Solana/spot long-tail tokens that aren't on HL — for those, technical_analysis STILL works (it auto-falls back to a CoinGecko price-action read), it just won't have funding/whale data. So you can analyze ANY ticker the user names; never refuse one.

NEVER claim a coin is "not on HL", "not available", "not on your platform", or "off-chain noise" from memory — you will be wrong (HL lists 230+ perps). If the user names ANY ticker, CHECK it first by calling get_coin (or technical_analysis). Only say a coin is unavailable if a tool actually returns "No HL market" — and even then, offer the TA you CAN do. Never dismiss a setup you haven't verified, and never editorialize a coin as "noise."

Style: concise, direct, a little sharp — like a sharp trading buddy texting back. Plain text or light Telegram HTML (<b>, <i>). No long essays.

Use tools to answer with REAL data — never guess prices, positions, levels, OR whether a coin is tradeable. For any analysis / "what's the play" / entry / buy-or-sell question, call technical_analysis and present its read (it's an expert Opus analysis — relay it, don't rewrite or second-guess it). For positioning questions use get_wallets. For quick prices use get_coin/get_market. For sizing use position_size. To set alerts use set_watch. To run the digest/scorecard/smartmoney/leaderboard or scrape X, use run_job.

Memory: you have long-term memory about this user — anything in <known_about_user> below is what you already know. Reference it naturally (e.g. use their saved default risk size when sizing; mention their open positions). Use the remember tool when they share a durable fact (HL wallet, default risk, an open position, a preference); use forget when something changes (closed a position, new risk size — forget the stale note, remember the new). Don't remember market data or one-off chatter.

Paper trading: the user is practicing with HYPOTHETICAL trades while they wait to fund their real account. When they describe entering/exiting a simulated position, use paper_open/paper_close; for "how's my paper portfolio" use paper_status. Always make clear these are paper (not real) trades. Encourage small, disciplined sizing as if it were real.

Be DIRECT and actionable — when there's a setup, name it (long, short, or no-trade) with entry/stop/target; weigh shorts EQUALLY with longs; don't soft-pedal or bury the trade under caution (e.g. don't just say "don't chase" when the real read is "short it here"). Still honest: state your conviction, never pretend certainty, and call the invalidation. This is decision support, not financial advice; the user trades manually — remind lightly when it matters, don't lecture.`;

const KV_TTL = 7200; // 2h conversation memory

export async function runAgent(env, chatId, userText) {
  if (!env.ANTHROPIC_API_KEY) return tg(env, chatId, "⚠️ Conversational mode needs ANTHROPIC_API_KEY set on the worker.");
  let history = [];
  try { if (env.MEMORY) history = JSON.parse((await env.MEMORY.get(`chat:${chatId}`)) || "[]"); } catch {}
  const messages = [...history, { role: "user", content: userText }];
  // Inject long-term profile into the system prompt so the bot "knows" the user.
  const profile = await getProfile(env, chatId);
  const sys = SYSTEM + (profile.notes?.length ? `\n\n<known_about_user>\n${profile.notes.map((n) => "- " + n).join("\n")}\n</known_about_user>` : "");
  try {
    await typing(env, chatId); // immediate "got it, working…" signal
    for (let i = 0; i < 5; i++) {
      await typing(env, chatId);
      const resp = await callClaude(env, { model: CHAT_MODEL, system: sys, tools: TOOLS, max_tokens: 1024, messages });
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason !== "tool_use") {
        const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim() || "…";
        await tg(env, chatId, text);
        const newHist = [...history, { role: "user", content: userText }, { role: "assistant", content: text }].slice(-8);
        if (env.MEMORY) { try { await env.MEMORY.put(`chat:${chatId}`, JSON.stringify(newHist), { expirationTtl: KV_TTL }); } catch {} }
        return;
      }
      const results = [];
      await typing(env, chatId); // tools (esp. the Opus deep-analysis) can take several seconds
      for (const b of resp.content) if (b.type === "tool_use") { let out; try { out = await execTool(env, chatId, b.name, b.input || {}); } catch (e) { out = `tool error: ${e.message}`; } results.push({ type: "tool_result", tool_use_id: b.id, content: String(out).slice(0, 6000) }); }
      messages.push({ role: "user", content: results });
    }
    await tg(env, chatId, "Hit my reasoning limit on that — try asking more directly?");
  } catch (e) {
    const msg = (e.status === 429 || e.status === 529 || /rate.?limit|overloaded/i.test(e.message))
      ? "⏳ Rate-limited (a lot of requests in a short window). Give it ~30s and resend — or send one message at a time."
      : `⚠️ Something went wrong: ${esc((e.message || "").slice(0, 160))}`;
    await tg(env, chatId, msg);
  }
}

// Build a QuickChart price-line image (price + resistance/support/EMA levels).
// Native "Bot is typing…" indicator — re-fire periodically (it fades after ~5s).
async function typing(env, chatId) {
  try { await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, action: "typing" }) }); } catch {}
}

async function tg(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const t = (text || "…").slice(0, 4000); // Telegram hard limit is 4096
  // Haiku tends to emit Markdown (**bold**, *italic*) — convert to Telegram HTML so it renders.
  const html = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "<i>$1</i>");
  const send = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let r = await send({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  if (!r.ok) {
    // Malformed-HTML 400 fallback — strip tags + markdown so a reply always lands.
    r = await send({ chat_id: chatId, text: t.replace(/<[^>]+>/g, "").replace(/\*\*/g, ""), disable_web_page_preview: true });
  }
  return r;
}
