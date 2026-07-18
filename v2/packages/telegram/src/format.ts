// Deterministic alert formatting: Signal → Telegram HTML, keeping v1's voice
// (emoji lead, bold ticker, terse numbers, honest disclaimer). The LLM never
// touches these strings — narration, if any, is appended separately and
// clearly attributed (spec §0: LLMs explain, they do not compute).

import type { Signal } from '@market-intel/signal-engine';

export const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const usd = (n: number): string => {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}k`;
  return `${sign}$${a.toFixed(0)}`;
};

export const px = (n: number): string =>
  n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? n.toFixed(2) : n.toPrecision(3);

const TIER_EMOJI: Record<Signal['tier'], string> = { P0: '🚨', P1: '🔔', P2: '📋' };
const DIR_EMOJI: Record<Signal['direction'], string> = { long: '🟢', short: '🔴', neutral: '⚪️' };

function headline(s: Signal): string {
  const i = s.trigger.inputs;
  switch (s.family_id) {
    case 'CROWD_DIVERGENCE':
      return s.direction === 'long'
        ? `${i['whales_long']} whales LONG vs funding ${Number(i['funding_annual_pct']).toFixed(0)}%/yr (crowd short). Squeeze fuel.`
        : `${i['whales_short']} whales SHORT vs funding +${Number(i['funding_annual_pct']).toFixed(0)}%/yr (crowd over-long).`;
    case 'POS_WHALE_CONSENSUS':
      return `${i['whales_long'] || i['whales_short']} tracked whales aligned ${s.direction.toUpperCase()} · ${usd(Number(i['aggregate_notional_usd']))} aggregate.`;
    case 'POS_WHALE_FLIP':
      return `Whale net position FLIPPED to ${s.direction.toUpperCase()} · now ${usd(Number(i['net_notional_usd']))}.`;
    case 'POS_SMARTMONEY_SHIFT':
      return `Smart money ${String(i['kind'])} → ${s.direction.toUpperCase()} · ${Math.round(Number(i['pct_long']) * 100)}% long · net ${usd(Number(i['net_notional_usd']))}.`;
    case 'POS_INSIDER_CLUSTER':
      return `${i['distinct_net_buyers']} insiders net-buying · ${usd(Number(i['aggregate_usd']))} aggregate (Form 4 cluster).`;
    case 'POS_CONGRESS_DISCLOSURE':
      return `Congressional ${s.direction === 'long' ? 'buy' : 'sell'} disclosure · ${usd(Number(i['aggregate_usd']))} across ${i['distinct_members']} member(s).`;
    case 'CROWD_MENTION_SPIKE':
      return `${i['mentions']} viral mentions${i['new_on_radar'] ? ' (new on radar)' : ` · ${Number(i['spike_ratio']).toFixed(1)}x baseline`}. Early CT buzz — high noise.`;
    case 'CROWD_FUNDING_EXTREME':
      return `Funding ${Number(i['funding_annual_pct']).toFixed(0)}%/yr at ${usd(Number(i['oi_usd']))} OI — crowd ${s.direction === 'short' ? 'over-long' : 'over-short'}.`;
    case 'CATALYST_UPCOMING':
      return `${String(i['catalyst_type']).toUpperCase()} in ${Math.round(Number(i['lead_s']) / 3600)}h. Position awareness, not a direction call.`;
    case 'CATALYST_SURPRISE':
      return `${String(i['catalyst_type']).toUpperCase()} surprise ${Number(i['surprise_pct']) > 0 ? '+' : ''}${Number(i['surprise_pct']).toFixed(1)}% vs consensus.`;
    case 'TA_SETUP':
      return `${String(i['template'])} · RSI ${i['rsi_1d']} · trend ${String(i['trend_1d'])}.`;
    default:
      return s.trigger.rule;
  }
}

/** One signal → one HTML block. */
export function formatSignal(s: Signal): string {
  const lines: string[] = [];
  lines.push(
    `${TIER_EMOJI[s.tier]} ${DIR_EMOJI[s.direction]} <b>${esc(s.asset.symbol)}</b> — ${esc(headline(s))}`,
  );
  if (s.direction !== 'neutral' && s.levels.target !== null && s.levels.invalidation !== null) {
    lines.push(
      `   ref ${px(s.levels.reference_price)} · target ${px(s.levels.target)} · invalid ${px(s.levels.invalidation)} · ${s.levels.target_r_multiple?.toFixed(1)}R · ${s.horizon.class.replace('_', ' ')}`,
    );
  }
  lines.push(
    `   <i>${esc(s.family_id)} · priority ${s.scores.priority.toFixed(2)} · ${esc(s.signal_id)}</i>`,
  );
  return lines.join('\n');
}

/** A cycle's fired signals → tiered digest messages. P2 is log-only (§3.4). */
export interface AlertBatch {
  push: string | null; // P0 — send immediately
  queue: string | null; // P1 — batched decision queue
  logOnlyCount: number; // P2 — recorded, never sent
}

export function formatBatch(signals: Signal[], nowUnix: number): AlertBatch {
  const p0 = signals.filter((s) => s.tier === 'P0');
  const p1 = signals.filter((s) => s.tier === 'P1');
  const p2 = signals.filter((s) => s.tier === 'P2');

  const stamp = new Date(nowUnix * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const foot = `\n<i>Deterministic signals · cohort ${signals[0]?.cohort_version ?? ''} · ${stamp} UTC · Not advice.</i>`;

  return {
    push: p0.length ? `🧭 <b>Market intel — act now</b>\n\n${p0.map(formatSignal).join('\n\n')}${foot}` : null,
    queue: p1.length ? `🗂 <b>Decision queue</b>\n\n${p1.map(formatSignal).join('\n\n')}${foot}` : null,
    logOnlyCount: p2.length,
  };
}
