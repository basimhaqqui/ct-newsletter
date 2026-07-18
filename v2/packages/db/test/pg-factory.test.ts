// Live-Postgres round-trip tests for the pg RepositoryFactory. Skips
// cleanly when DATABASE_URL is unset (CI runs them via the test-postgres job).

import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/migrate.js';
import { createPool, closePool } from '../src/pool.js';
import { createPgRepositoryFactory } from '../src/pg.js';
import type { ObservationRow, PositioningEventRow, SignalRow } from '../src/repositories.js';

const DB_URL = process.env.DATABASE_URL;
const d = describe.skipIf(!DB_URL);

const T0 = new Date('2026-07-18T12:00:00Z');

function obs(id: string, price: number, t: Date): ObservationRow {
  return {
    id, asset_uid: 'crypto:hl:HYPE', symbol: 'HYPE', venue: 'hyperliquid', price,
    bid: null, ask: null, mark_price: price, index_price: null,
    funding_rate: -0.000008, funding_rate_annualized: -7.2,
    open_interest: 2_600_000, open_interest_usd: 2_600_000 * price,
    volume_24h: null, volume_24h_usd: 3e8, basis: null, basis_annualized: null,
    event_time: t, observed_time: t, ingested_time: t,
    source: 'hyperliquid', source_record_id: id, quality: 'ok', evidence_ref_ids: [id],
  };
}

d('pg RepositoryFactory (live database)', () => {
  it('migrates, round-trips core rows, and enforces idempotency', async () => {
    const url = new URL(DB_URL!);
    const sslmode = url.searchParams.get('sslmode');
    createPool({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: sslmode && sslmode !== 'disable' ? { rejectUnauthorized: false } : undefined,
    });
    const runner = new MigrationRunner();
    await runner.migrate();
    await closePool();

    const repos = await createPgRepositoryFactory({ connectionString: DB_URL! });
    try {
      // observations: upsert twice → one row per (asset, venue, event_time, source)
      await repos.observations.bulkInsert([obs('pgtest:obs:1', 46.12, T0)]);
      await repos.observations.bulkInsert([obs('pgtest:obs:1', 46.5, T0)]);
      const latest = await repos.observations.findLatestByAsset('crypto:hl:HYPE');
      expect(latest).not.toBeNull();
      expect(latest!.price).toBeCloseTo(46.5, 6);
      expect(latest!.funding_rate_annualized).toBeCloseTo(-7.2, 6);

      // positioning: JSONB store round-trip with Date revival
      const pos: PositioningEventRow = {
        id: 'pgtest:pos:1', asset_uid: 'crypto:hl:HYPE',
        event_type: 'whale_position', direction: 'long', size: 2500,
        notional_usd: 120000, entry_price: 44, leverage: 3,
        wallet_address: '0xaaa', wallet_label: 'whale-a',
        filer_name: null, filer_cik: null, filing_accession: null,
        filing_date: null, transaction_date: null, is_derivative: false,
        expiration_date: null, strike_price: null, option_type: null,
        raw_data: {}, source: 'hyperliquid', source_record_id: 'pgtest:pos:1',
        event_time: T0, observed_time: T0, ingested_time: T0,
        quality: 'ok', evidence_ref_ids: ['e1'],
      };
      await repos.positioningEvents.insert(pos);
      await repos.positioningEvents.update({ ...pos, notional_usd: 130000 });
      const whales = await repos.positioningEvents.getWhalePositions('crypto:hl:HYPE');
      const mine = whales.find((w) => w.id === 'pgtest:pos:1');
      expect(mine).toBeDefined();
      expect(mine!.notional_usd).toBe(130000);
      expect(mine!.event_time instanceof Date).toBe(true);
      expect(mine!.event_time.getTime()).toBe(T0.getTime());

      // signals + grades
      const sig: SignalRow = {
        id: 'sig_pgtest', signal_id: 'sig_pgtest', schema_version: 'signal/2.0.0',
        cohort_version: 'cohort/2026.07.0', family_id: 'CROWD_DIVERGENCE',
        dimension: 'crowd', asset_class: 'crypto', asset_uid: 'crypto:hl:HYPE',
        symbol: 'HYPE', venue: 'hyperliquid', direction: 'long',
        event_time: T0, observed_time: T0, detected_time: T0,
        source_latency_seconds: 25, trigger_rule: 'r', trigger_inputs: { a: 1 },
        reference_price: 46.12, target_price: 51, invalidation_price: 43,
        atr_ref: 2.1, target_r_multiple: 1.6, horizon_class: 'crypto_swing',
        horizon_seconds: 259200, severity_score: 0.6, novelty_score: 1,
        personal_relevance_score: 1, priority_score: 0.84,
        evidence_ref_ids: ['e1'], abstained: false, abstention_reason: null,
        origin: 'deterministic', narration_text: null, narration_model: null,
        narration_prompt_hash: null, narration_origin: null, created_at: T0,
      };
      await repos.signals.upsert(sig);
      await repos.signals.upsert(sig); // idempotent
      const active = await repos.signals.findActive(500);
      expect(active.filter((s) => s.signal_id === 'sig_pgtest').length).toBe(1);
      const forGrading = await repos.signals.getForGrading(new Date(0));
      expect(forGrading.some((s) => s.signal_id === 'sig_pgtest')).toBe(true);

      // candles
      await repos.candles.upsertMany([
        {
          id: 'hl:candle:HYPE:1h:1', asset_uid: 'crypto:hl:HYPE', symbol: 'HYPE',
          venue: 'hyperliquid', bar_interval: '1h', open_time: T0,
          open: 46, high: 47, low: 45.5, close: 46.8, volume: 1e6,
          source: 'hyperliquid', quality: 'ok', ingested_time: T0,
        },
      ]);
      const series = await repos.candles.getSeries(
        'crypto:hl:HYPE', 'hyperliquid', '1h',
        new Date(T0.getTime() - 1000), new Date(T0.getTime() + 1000),
      );
      expect(series.length).toBe(1);
      expect(series[0].high).toBeCloseTo(47, 6);

      // source health lifecycle
      await repos.sourceHealth.recordSuccess('pgtest-source', 120);
      const healthy = await repos.sourceHealth.findByStatus('healthy');
      expect(healthy.some((h) => h.source_id === 'pgtest-source')).toBe(true);

      // transaction rollback
      await expect(
        repos.transaction(async (tx) => {
          await tx.signals.upsert({ ...sig, id: 'sig_rollback', signal_id: 'sig_rollback' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await repos.signals.findByDedupeKey('sig_rollback'))).toBeNull();
    } finally {
      // cleanup test rows, keep schema
      await repos.pool.query(`DELETE FROM app_signals WHERE app_id LIKE 'sig_pgtest%'`);
      await repos.pool.query(`DELETE FROM app_positioning_events WHERE app_id LIKE 'pgtest%'`);
      await repos.pool.query(`DELETE FROM app_source_health WHERE app_id LIKE 'health:pgtest%'`);
      await repos.pool.query(`DELETE FROM candles WHERE id LIKE 'hl:candle:HYPE%'`);
      await repos.pool.query(`DELETE FROM observations WHERE source_record_id LIKE 'pgtest%'`);
      await repos.close();
    }
  }, 30_000);
});
