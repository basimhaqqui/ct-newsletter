// Pulls the Hyperliquid public leaderboard, screens for *copyable directional
// traders* (not market makers), ranks them, then fetches each finalist's CURRENT
// live positions. Prints a vetted shortlist + writes hl-candidates.json.
//
// Why the filters: raw top-PnL is dominated by market makers doing billions in
// volume for thin ROI — their positions are hedges, useless to copy. We require
// real account size, real returns, consistency, and LOW turnover (vlm/acct).
//
// Usage: node hl-leaderboard.mjs            (downloads the 31MB leaderboard)
//        LB_FILE=/tmp/hl-lb.json node hl-leaderboard.mjs   (use a cached copy)

import { readFile, writeFile } from "node:fs/promises";

const LB_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const INFO = "https://api.hyperliquid.xyz/info";

const ACCT_MIN = Number(process.env.ACCT_MIN || 100000);   // >= $100k real skin
const MIN_TURNOVER = Number(process.env.MIN_TURNOVER || 3); // <3x/mo = passive holder/vault, not a trader
const MAX_TURNOVER = Number(process.env.MAX_TURNOVER || 40); // monthVlm/acct; MMs are 100s+
const MIN_MONTH_ROI = Number(process.env.MIN_MONTH_ROI || 0.05); // >= 5% monthly
const TOP = Number(process.env.TOP || 18);

const num = (x) => Number(x) || 0;
const usd = (n) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
  : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)}k`
  : `$${n.toFixed(0)}`;

// 1) Load leaderboard (cached file or fresh download)
let lb;
if (process.env.LB_FILE) {
  lb = JSON.parse(await readFile(process.env.LB_FILE, "utf8"));
} else {
  const r = await fetch(LB_URL);
  if (!r.ok) { console.error(`leaderboard ${r.status}`); process.exit(1); }
  lb = await r.json();
}
const rows = lb.leaderboardRows || lb;
console.error(`leaderboard rows: ${rows.length}`);

// 2) Flatten window perfs and screen
const win = (r, name) => {
  const w = (r.windowPerformances || []).find((x) => x[0] === name);
  return w ? w[1] : {};
};

const screened = rows
  .map((r) => {
    const acct = num(r.accountValue);
    const month = win(r, "month"), week = win(r, "week"), all = win(r, "allTime");
    const monthVlm = num(month.vlm);
    return {
      addr: r.ethAddress,
      name: r.displayName || null,
      acct,
      allPnl: num(all.pnl), allRoi: num(all.roi),
      monthPnl: num(month.pnl), monthRoi: num(month.roi),
      weekPnl: num(week.pnl),
      turnover: acct > 0 ? monthVlm / acct : Infinity, // monthly turnover multiple
    };
  })
  .filter((r) =>
    r.acct >= ACCT_MIN &&
    r.turnover >= MIN_TURNOVER &&          // actually trades (not a passive holder/vault)
    r.turnover <= MAX_TURNOVER &&          // exclude market makers / HFT
    r.monthPnl > 0 && r.allPnl > 0 &&      // profitable recently AND overall
    r.monthRoi >= MIN_MONTH_ROI            // real returns, not size-only
  )
  .sort((a, b) => b.monthRoi - a.monthRoi) // best risk-adjusted returns first
  .slice(0, TOP);

console.error(`passed screen: ${screened.length} (acct≥${usd(ACCT_MIN)}, ${MIN_TURNOVER}x≤turnover≤${MAX_TURNOVER}x, monthRoi≥${(MIN_MONTH_ROI*100)}%)\n`);

// 3) Fetch current live positions for each finalist
async function positions(addr) {
  try {
    const r = await fetch(INFO, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: addr }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.assetPositions || []).map((p) => {
      const pos = p.position || {};
      const szi = num(pos.szi);
      return {
        coin: pos.coin,
        side: szi > 0 ? "LONG" : szi < 0 ? "SHORT" : "flat",
        lev: pos.leverage?.value ? `${pos.leverage.value}x` : "",
        entry: num(pos.entryPx),
        notional: num(pos.positionValue),
        uPnl: num(pos.unrealizedPnl),
      };
    }).filter((p) => p.side !== "flat");
  } catch { return []; }
}

const withPos = await Promise.all(
  screened.map(async (r) => ({ ...r, positions: await positions(r.addr) }))
);

// 4) Print shortlist
for (const r of withPos) {
  const id = r.name ? `"${r.name}"` : r.addr.slice(0, 8) + "…" + r.addr.slice(-4);
  console.log(`${id}  acct ${usd(r.acct)} · ${r.turnover.toFixed(1)}x turnover`);
  console.log(`   month ${usd(r.monthPnl)} (${(r.monthRoi*100).toFixed(0)}% ROI) · week ${usd(r.weekPnl)} · allTime ${usd(r.allPnl)}`);
  if (r.positions.length) {
    const top = r.positions.sort((a,b)=>Math.abs(b.notional)-Math.abs(a.notional)).slice(0,4);
    console.log(`   holding: ${top.map(p=>`${p.side} ${p.lev} ${p.coin} (${usd(p.notional)}, uPnL ${usd(p.uPnl)})`).join(" · ")}`);
  } else {
    console.log(`   holding: (no open positions right now)`);
  }
  console.log(`   ${r.addr}`);
}

await writeFile("hl-candidates.json", JSON.stringify(withPos, null, 2));
console.error(`\nwrote hl-candidates.json (${withPos.length})`);
