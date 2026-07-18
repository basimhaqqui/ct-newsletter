import { describe, expect, it, vi } from 'vitest';
import { TelegramClient } from '../src/client.js';
import { formatBatch, formatSignal } from '../src/format.js';
import type { Signal } from '@market-intel/signal-engine';

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    signal_id: 'sig_test',
    idempotency_key: 'abc',
    schema_version: 'signal/2.0.0',
    cohort_version: 'cohort/2026.07.0',
    family_id: 'CROWD_DIVERGENCE',
    dimension: 'crowd',
    asset_class: 'crypto',
    asset: { asset_uid: 'crypto:hl:HYPE', symbol: 'HYPE', venue: 'hyperliquid', asset_class: 'crypto' },
    direction: 'long',
    event_time: 1_784_086_100,
    observed_time: 1_784_086_125,
    detected_time: 1_784_086_130,
    source_latency_s: 25,
    trigger: {
      rule: 'whales_long>=3 && funding_annual<=-3',
      inputs: { whales_long: 4, whales_short: 0, funding_annual_pct: -7.2, oi_usd: 1.2e8 },
    },
    levels: { reference_price: 46.12, target: 51.37, invalidation: 42.97, atr_ref: 2.1, target_r_multiple: 1.67 },
    horizon: { class: 'crypto_swing', seconds: 259_200 },
    scores: { severity: 0.59, novelty: 1, personal_relevance: 1, priority: 0.84 },
    tier: 'P0',
    evidence: [],
    abstained: false,
    abstention_reason: null,
    origin: 'deterministic',
    ...overrides,
  };
}

describe('formatting', () => {
  it('renders a divergence P0 with levels and provenance', () => {
    const html = formatSignal(signal());
    expect(html).toContain('<b>HYPE</b>');
    expect(html).toContain('🚨');
    expect(html).toContain('4 whales LONG');
    expect(html).toContain('target 51.37');
    expect(html).toContain('sig_test');
  });

  it('escapes HTML in symbols', () => {
    const s = signal();
    s.asset = { ...s.asset, symbol: '<X&Y>' };
    expect(formatSignal(s)).toContain('&lt;X&amp;Y&gt;');
  });

  it('omits levels for neutral signals', () => {
    const s = signal({
      direction: 'neutral',
      family_id: 'CATALYST_UPCOMING',
      trigger: { rule: 'r', inputs: { catalyst_type: 'earnings', lead_s: 86_400 } },
      levels: { reference_price: 0, target: null, invalidation: null, atr_ref: null, target_r_multiple: null },
    });
    const html = formatSignal(s);
    expect(html).toContain('EARNINGS in 24h');
    expect(html).not.toContain('target');
  });

  it('batches by tier: P0 pushes, P1 queues, P2 is log-only', () => {
    const batch = formatBatch(
      [signal({ tier: 'P0' }), signal({ tier: 'P1', signal_id: 'sig_b' }), signal({ tier: 'P2', signal_id: 'sig_c' })],
      1_784_086_130,
    );
    expect(batch.push).toContain('act now');
    expect(batch.queue).toContain('Decision queue');
    expect(batch.logOnlyCount).toBe(1);
    expect(batch.push).not.toContain('sig_b');
  });

  it('returns null messages for empty tiers', () => {
    const batch = formatBatch([], 0);
    expect(batch.push).toBeNull();
    expect(batch.queue).toBeNull();
  });
});

describe('client', () => {
  it('sends via the Bot API with HTML parse mode', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new TelegramClient({ botToken: 't', chatId: 'c', retryBackoffMs: 1 }, mock as unknown as typeof fetch);
    const res = await client.send('<b>hi</b>');
    expect(res).toEqual({ ok: true, delivered: true });
    const body = JSON.parse(String((mock.mock.calls[0][1] as RequestInit).body));
    expect(body.parse_mode).toBe('HTML');
    expect(body.chat_id).toBe('c');
  });

  it('falls back to console when credentials are missing', async () => {
    const logged: string[] = [];
    const client = new TelegramClient({}, undefined, (m) => logged.push(m));
    const res = await client.send('<b>dry run</b>');
    expect(res).toEqual({ ok: true, delivered: false });
    expect(logged[0]).toBe('dry run'); // tags stripped
  });

  it('retries 429/5xx then succeeds', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'flood' }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new TelegramClient({ botToken: 't', chatId: 'c', retryBackoffMs: 1 }, mock as unknown as typeof fetch);
    const res = await client.send('x');
    expect(res.delivered).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does not retry hard 4xx failures', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }),
    );
    const client = new TelegramClient({ botToken: 't', chatId: 'c', retryBackoffMs: 1 }, mock as unknown as typeof fetch);
    const res = await client.send('x');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('chat not found');
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
