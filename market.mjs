// Fetches a small market snapshot (BTC/ETH/SOL/HYPE) from CoinGecko (no key)
// and writes market.json: { line, coins }. `line` is a ready-to-use
// Telegram-HTML one-liner the summarizer can put at the top of the digest.
// Resilient: on any failure it writes an empty snapshot so the digest still ships.
// Usage: node market.mjs

import { writeFile } from "node:fs/promises";

// CoinGecko id -> display ticker. Edit COINS env (comma ids) to change coverage.
const DEFAULT = "bitcoin:BTC,ethereum:ETH,solana:SOL,hyperliquid:HYPE";
const pairs = (process.env.COINS || DEFAULT).split(",").map((p) => {
  const [id, sym] = p.split(":");
  return { id: id.trim(), sym: (sym || id).trim() };
});

const OUT = process.env.MARKET_FILE || "market.json";

async function main() {
  const ids = pairs.map((p) => p.id).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const coins = [];
  const parts = [];
  for (const { id, sym } of pairs) {
    const d = data[id];
    if (!d || typeof d.usd !== "number") continue;
    const ch = typeof d.usd_24h_change === "number" ? d.usd_24h_change : 0;
    const arrow = ch >= 0 ? "▲" : "▼";
    const price =
      d.usd >= 100 ? Math.round(d.usd).toLocaleString("en-US") : d.usd.toFixed(2);
    coins.push({ sym, usd: d.usd, change24h: ch });
    parts.push(`${sym} $${price} ${arrow}${Math.abs(ch).toFixed(1)}%`);
  }

  const line = parts.length ? `<b>📊 Markets</b> ${parts.join("  •  ")}` : "";
  await writeFile(OUT, JSON.stringify({ line, coins }, null, 2));
  console.error(`market: ${parts.join(" | ") || "no data"}`);
}

main().catch(async (e) => {
  console.error(`market.mjs failed (non-fatal): ${e.message}`);
  await writeFile(OUT, JSON.stringify({ line: "", coins: [] }, null, 2)).catch(() => {});
});
