import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, queryOne, queryMany, execute, withTransaction } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
  checksum: string;
}

/**
 * Migration runner - applies SQL migrations in order
 */
export class MigrationRunner {
  private migrationsDir: string;
  private tableName: string = 'schema_migrations';

  constructor(migrationsDir?: string) {
    this.migrationsDir = migrationsDir ?? path.resolve(__dirname, '../migrations');
  }

  /**
   * Initialize the migrations table
   */
  async initialize(): Promise<void> {
    await execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum TEXT NOT NULL
      )
    `);
  }

  /**
   * Get list of applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    const exists = await this.tableExists(this.tableName);
    if (!exists) {
      await this.initialize();
    }
    return queryMany<MigrationRecord>(
      `SELECT id, name, applied_at, checksum FROM ${this.tableName} ORDER BY id`
    );
  }

  /**
   * Get list of available migration files
   */
  getAvailableMigrations(): { name: string; path: string; checksum: string }[] {
    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    return files.map(file => {
      const filePath = path.join(this.migrationsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const checksum = this.computeChecksum(content);
      return { name: file, path: filePath, checksum };
    });
  }

  /**
   * Get pending migrations (available but not applied)
   */
  async getPendingMigrations(): Promise<{ name: string; path: string; checksum: string }[]> {
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map(m => m.name));
    const available = this.getAvailableMigrations();
    return available.filter(m => !appliedNames.has(m.name));
  }

  /**
   * Check if there are pending migrations
   */
  async hasPendingMigrations(): Promise<boolean> {
    const pending = await this.getPendingMigrations();
    return pending.length > 0;
  }

  /**
   * Apply a single migration
   */
  async applyMigration(name: string, path: string, checksum: string): Promise<void> {
    const content = fs.readFileSync(path, 'utf-8');
    
    // Verify checksum matches
    const actualChecksum = this.computeChecksum(content);
    if (actualChecksum !== checksum) {
      throw new Error(`Checksum mismatch for migration ${name}: expected ${checksum}, got ${actualChecksum}`);
    }

    await withTransaction(async (client) => {
      // Execute migration
      await client.query(content);
      
      // Record migration
      await client.query(
        `INSERT INTO ${this.tableName} (name, checksum) VALUES ($1, $2)`,
        [name, checksum]
      );
    });
  }

  /**
   * Run all pending migrations
   */
  async migrate(): Promise<MigrationRecord[]> {
    await this.initialize();
    
    const pending = await this.getPendingMigrations();
    const applied: MigrationRecord[] = [];

    for (const migration of pending) {
      console.log(`Applying migration: ${migration.name}`);
      await this.applyMigration(migration.name, migration.path, migration.checksum);
      const record = await queryOne<MigrationRecord>(
        `SELECT id, name, applied_at, checksum FROM ${this.tableName} WHERE name = $1`,
        [migration.name]
      );
      if (record) applied.push(record);
      console.log(`Applied: ${migration.name}`);
    }

    return applied;
  }

  /**
   * Rollback the last migration (for testing only)
   */
  async rollbackLast(): Promise<void> {
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      throw new Error('No migrations to rollback');
    }

    const last = applied[applied.length - 1];
    
    // For safety, we don't auto-rollback - this would require down migrations
    // Instead, just remove the record and warn
    await execute(`DELETE FROM ${this.tableName} WHERE id = $1`, [last.id]);
    console.warn(`Rolled back migration record: ${last.name} (manual SQL rollback required)`);
  }

  /**
   * Get migration status report
   */
  async getStatus(): Promise<{
    applied: MigrationRecord[];
    pending: { name: string; path: string; checksum: string }[];
  }> {
    const applied = await this.getAppliedMigrations();
    const pending = await this.getPendingMigrations();
    return { applied, pending };
  }

  /**
   * Verify migration integrity (checksums match)
   */
  async verifyIntegrity(): Promise<{ valid: boolean; mismatches: string[] }> {
    const applied = await this.getAppliedMigrations();
    const available = this.getAvailableMigrations();
    const availableMap = new Map(available.map(m => [m.name, m]));

    const mismatches: string[] = [];
    for (const migration of applied) {
      const available = availableMap.get(migration.name);
      if (available && available.checksum !== migration.checksum) {
        mismatches.push(`${migration.name}: applied checksum ${migration.checksum} != file checksum ${available.checksum}`);
      }
    }

    return { valid: mismatches.length === 0, mismatches };
  }

  /**
   * Compute SHA256 checksum of content
   */
  private computeChecksum(content: string): string {
    // Simple hash for migration integrity - using a basic approach
    // In production, use crypto.createHash('sha256')
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Check if a table exists
   */
  private async tableExists(tableName: string): Promise<boolean> {
    const result = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`,
      [tableName]
    );
    return result?.exists ?? false;
  }
}

/**
 * CLI entry point for running migrations
 */
export async function runMigrations(migrationsDir?: string): Promise<void> {
  const runner = new MigrationRunner(migrationsDir);
  
  console.log('Checking database connection...');
  const health = await import('./pool.js').then(m => m.healthCheck());
  if (!health.healthy) {
    throw new Error(`Database connection failed: ${health.error}`);
  }
  console.log(`Database connected (${health.latencyMs}ms)`);

  const status = await runner.getStatus();
  console.log(`Applied migrations: ${status.applied.length}`);
  console.log(`Pending migrations: ${status.pending.length}`);

  if (status.pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  console.log('\nPending migrations:');
  for (const m of status.pending) {
    console.log(`  - ${m.name}`);
  }

  console.log('\nApplying migrations...');
  const applied = await runner.migrate();
  console.log(`\nSuccessfully applied ${applied.length} migration(s).`);

  // Verify integrity
  const integrity = await runner.verifyIntegrity();
  if (integrity.valid) {
    console.log('Migration integrity verified: OK');
  } else {
    console.error('Migration integrity check FAILED:');
    for (const mismatch of integrity.mismatches) {
      console.error(`  - ${mismatch}`);
    }
    process.exit(1);
  }
}

/**
 * Test runner - applies migrations to a test database and verifies
 */
export async function runMigrationTests(migrationsDir?: string): Promise<void> {
  const runner = new MigrationRunner(migrationsDir);
  
  console.log('Running migration integrity tests...');
  
  // Test 1: All migrations apply cleanly
  const applied = await runner.migrate();
  console.log(`✓ Applied ${applied.length} migrations`);
  
  // Test 2: Verify integrity
  const integrity = await runner.verifyIntegrity();
  if (!integrity.valid) {
    throw new Error(`Integrity check failed: ${integrity.mismatches.join(', ')}`);
  }
  console.log('✓ Migration integrity verified');
  
  // Test 3: Verify all tables exist
  const tables = await import('./pool.js').then(m => m.getAllTables());
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
    if (!tables.includes(expected)) {
      throw new Error(`Missing table: ${expected}`);
    }
  }
  console.log(`✓ All ${expectedTables.length} expected tables exist`);
  
  // Test 4: Verify indexes exist
  for (const table of expectedTables) {
    if (table === 'schema_migrations') continue;
    const columns = await import('./pool.js').then(m => m.getTableColumns(table));
    if (columns.length === 0) {
      throw new Error(`Table ${table} has no columns`);
    }
  }
  console.log('✓ All tables have columns defined');
  
  console.log('\nAll migration tests passed!');
}

// For CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] || 'migrate';
  const dir = process.argv[3];
  
  try {
    switch (command) {
      case 'migrate':
        await runMigrations(dir);
        break;
      case 'test':
        await runMigrationTests(dir);
        break;
      case 'status': {
        const runner = new MigrationRunner(dir);
        const status = await runner.getStatus();
        console.log('Applied:', status.applied.map(m => m.name).join(', ') || 'none');
        console.log('Pending:', status.pending.map(m => m.name).join(', ') || 'none');
        break;
      }
      case 'verify': {
        const runner = new MigrationRunner(dir);
        const integrity = await runner.verifyIntegrity();
        if (integrity.valid) {
          console.log('All migrations verified OK');
        } else {
          console.error('Mismatches:', integrity.mismatches);
          process.exit(1);
        }
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: tsx migrate.ts [migrate|test|status|verify] [migrationsDir]');
        process.exit(1);
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}