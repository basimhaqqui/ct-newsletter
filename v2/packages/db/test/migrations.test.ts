import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MigrationRunner, runMigrationTests } from '../src/migrate.js';
import { createPool, closePool, healthCheck, query, queryOne, getAllTables, getTableColumns } from '../src/pool.js';

const RUN_DB_INTEGRATION = process.env.RUN_DB_INTEGRATION === '1';
const describeDb = RUN_DB_INTEGRATION ? describe : describe.skip;

// Test database configuration - uses environment variables
const TEST_DB_CONFIG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5432'),
  database: process.env.TEST_DB_NAME || 'market_intel_test',
  user: process.env.TEST_DB_USER || 'postgres',
  password: process.env.TEST_DB_PASSWORD || 'postgres',
  max: 5,
};

describeDb('Database Migrations', () => {
  beforeAll(async () => {
    createPool(TEST_DB_CONFIG);
    
    // Wait for database to be ready
    let retries = 30;
    while (retries > 0) {
      const health = await healthCheck();
      if (health.healthy) break;
      await new Promise(r => setTimeout(r, 1000));
      retries--;
    }
    
    const health = await healthCheck();
    if (!health.healthy) {
      throw new Error(`Test database not available: ${health.error}`);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  describe('Migration integrity', () => {
    it('should apply all migrations cleanly', async () => {
      const runner = new MigrationRunner();
      const applied = await runner.migrate();
      expect(applied.length).toBeGreaterThan(0);
      console.log(`Applied ${applied.length} migrations`);
    });

    it('should verify migration integrity', async () => {
      const runner = new MigrationRunner();
      const integrity = await runner.verifyIntegrity();
      expect(integrity.valid).toBe(true);
      if (!integrity.valid) {
        console.error('Mismatches:', integrity.mismatches);
      }
    });

    it('should have all expected tables', async () => {
      const tables = await getAllTables();
      const expectedTables = [
        'assets',
        'raw_snapshots',
        'observations',
        'positioning_events',
        'catalysts',
        'social_claims',
        'evidence_refs',
        'source_health',
        'jobs',
        'signals',
        'abstentions',
        'grades',
        'outbox',
        'schema_migrations'
      ];

      for (const expected of expectedTables) {
        expect(tables).toContain(expected);
      }
    });

    it('should have columns on all tables', async () => {
      const tables = await getAllTables();
      for (const table of tables) {
        if (table === 'schema_migrations') continue;
        const columns = await getTableColumns(table);
        expect(columns.length).toBeGreaterThan(0);
      }
    });

    it('should have correct primary keys', async () => {
      // Test a few key tables
      const assetsCols = await getTableColumns('assets');
      const pkCol = assetsCols.find(c => c.column_name === 'asset_uid');
      expect(pkCol).toBeDefined();
      expect(pkCol?.is_nullable).toBe('NO');

      const signalsCols = await getTableColumns('signals');
      const sigPk = signalsCols.find(c => c.column_name === 'id');
      expect(sigPk).toBeDefined();
    });

    it('should have foreign key constraints', async () => {
      const fks = await query<{ table_name: string; column_name: string; foreign_table: string }>(`
        SELECT
          tc.table_name,
          kcu.column_name,
          ccu.table_name AS foreign_table
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      `);

      // Should have FKs from observations -> assets, positioning_events -> assets, etc.
      expect(fks.rows.length).toBeGreaterThan(0);
    });

    it('should have indexes on key columns', async () => {
      const indexes = await query<{ indexname: string; tablename: string }>(`
        SELECT indexname, tablename
        FROM pg_indexes
        WHERE schemaname = 'public'
        AND indexname NOT LIKE '%_pkey'
      `);

      const indexNames = indexes.rows.map(r => r.indexname);
      
      // Check for critical indexes
      expect(indexNames.some(i => i.includes('observations_asset'))).toBe(true);
      expect(indexNames.some(i => i.includes('signals_asset'))).toBe(true);
      expect(indexNames.some(i => i.includes('positioning_asset'))).toBe(true);
      expect(indexNames.some(i => i.includes('jobs_status'))).toBe(true);
      expect(indexNames.some(i => i.includes('outbox_unpublished'))).toBe(true);
    });
  });

  describe('Schema constraints', () => {
    it('should enforce asset_type check constraint', async () => {
      await expect(query(`
        INSERT INTO assets (asset_uid, symbol, name, asset_type, venue)
        VALUES ('test:bad', 'BAD', 'Bad', 'invalid_type', 'test')
      `)).rejects.toThrow();
    });

    it('should enforce quality check constraint', async () => {
      await expect(query(`
        INSERT INTO raw_snapshots (source, source_record_id, event_time, observed_time, payload, payload_hash, quality)
        VALUES ('test', 'rec1', NOW(), NOW(), '{}', 'hash', 'invalid_quality')
      `)).rejects.toThrow();
    });

    it('should enforce signal direction check constraint', async () => {
      await expect(query(`
        INSERT INTO signals (signal_id, schema_version, cohort_version, family_id, dimension, asset_class, asset_uid, symbol, venue, direction, event_time, observed_time, detected_time, source_latency_seconds, trigger_rule, trigger_inputs, reference_price, horizon_class, horizon_seconds, severity_score, novelty_score, personal_relevance_score, priority_score, evidence_ref_ids, abstained, origin)
        VALUES ('sig_test', 'signal/2.0.0', 'cohort/2026.07.0', 'TEST', 'crowd', 'crypto', 'crypto:hl:BTC', 'BTC', 'hyperliquid', 'invalid_dir', NOW(), NOW(), NOW(), 0, '{}', 100, 'crypto_swing', 86400, 0.5, 0.5, 0.5, 0.5, '{}', false, 'deterministic')
      `)).rejects.toThrow();
    });

    it('should enforce unique constraints', async () => {
      // Insert a valid asset first
      await query(`
        INSERT INTO assets (asset_uid, symbol, name, asset_type, venue)
        VALUES ('crypto:hl:TEST', 'TEST', 'Test Asset', 'crypto', 'hyperliquid')
        ON CONFLICT (asset_uid) DO NOTHING
      `);

      // Try to insert duplicate asset_uid
      await expect(query(`
        INSERT INTO assets (asset_uid, symbol, name, asset_type, venue)
        VALUES ('crypto:hl:TEST', 'TEST2', 'Test Asset 2', 'crypto', 'hyperliquid')
      `)).rejects.toThrow();
    });
  });

  describe('Migration runner', () => {
    it('should report correct status', async () => {
      const runner = new MigrationRunner();
      const status = await runner.getStatus();
      expect(status.applied.length).toBeGreaterThan(0);
      expect(status.pending.length).toBe(0); // All should be applied
    });

    it('should have applied all 13 migrations', async () => {
      const runner = new MigrationRunner();
      const status = await runner.getStatus();
      expect(status.applied.length).toBe(13);
    });
  });
});

describeDb('Database connectivity', () => {
  it('should respond to health check', async () => {
    const health = await healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.latencyMs).toBeLessThan(1000);
  });

  it('should return database info', async () => {
    const info = await (await import('../src/pool.js')).getDbInfo();
    expect(info.version).toContain('PostgreSQL');
    expect(info.currentDatabase).toBe(TEST_DB_CONFIG.database);
  });
});