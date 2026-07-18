// Deterministic TA indicators, ported from v1 ta.mjs. Pure functions over
// close/high/low arrays — feature prep uses these to build TaFacts.

export function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  return 100 - 100 / (1 + gains / (losses || 1e-9));
}

export function macdHist(values: number[]): number {
  if (values.length < 35) return 0;
  const line = ema(values, 12) - ema(values, 26);
  const series: number[] = [];
  for (let i = Math.max(26, values.length - 9); i < values.length; i++) {
    series.push(ema(values.slice(0, i + 1), 12) - ema(values.slice(0, i + 1), 26));
  }
  return line - ema(series, 9);
}

export function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  const window = tr.slice(-period);
  if (window.length === 0) return 0;
  return window.reduce((s, v) => s + v, 0) / window.length;
}

export function trendRead(
  closes: number[],
): { trend: 'up' | 'down' | 'mixed'; e20: number; e50: number } {
  const px = closes[closes.length - 1];
  const e20 = ema(closes.slice(-40), 20);
  const e50 = ema(closes.slice(-60), 50);
  const trend = px > e20 && e20 > e50 ? 'up' : px < e20 && e20 < e50 ? 'down' : 'mixed';
  return { trend, e20, e50 };
}
