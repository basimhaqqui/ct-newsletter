// Database connection pool and utilities

import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function createPool(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}): pg.Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max || 10,
    idleTimeoutMillis: config.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err);
  });

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Pool not initialized. Call createPool() first.');
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 100) {
    console.log(`Slow query (${duration}ms):`, text.substring(0, 100));
  }
  return result;
}

export async function execute(text: string, params?: any[]): Promise<void> {
  await query(text, params);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] || null;
}

export async function queryMany<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

export async function healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  try {
    const start = Date.now();
    await query('SELECT 1');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (error) {
    return { healthy: false, latencyMs: -1, error: String(error) };
  }
}

export async function getDbInfo(): Promise<{ version: string; currentDatabase: string; currentUser: string }> {
  const versionResult = await queryOne<{ version: string }>('SELECT version()');
  const dbResult = await queryOne<{ current_database: string; current_user: string }>('SELECT current_database(), current_user');
  
  return {
    version: versionResult?.version || 'Unknown',
    currentDatabase: dbResult?.current_database || 'Unknown',
    currentUser: dbResult?.current_user || 'Unknown',
  };
}

export async function getAllTables(): Promise<string[]> {
  const result = await query<{ tablename: string }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  return result.rows.map(r => r.tablename);
}

export async function getTableColumns(tableName: string): Promise<Array<{
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}>> {
  const result = await query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows;
}

export async function getAppliedMigrations(): Promise<string[]> {
  try {
    const result = await query<{ migration_name: string }>(`
      SELECT migration_name
      FROM schema_migrations
      ORDER BY applied_at
    `);
    return result.rows.map(r => r.migration_name);
  } catch {
    // Table might not exist yet
    return [];
  }
}