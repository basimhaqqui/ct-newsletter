import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

describe('migration files', () => {
  it('contains the complete ordered v2 schema', () => {
    const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toHaveLength(14);
    expect(files[0]).toBe('001_assets.sql');
    expect(files[12]).toBe('013_outbox.sql');
    expect(files[13]).toBe('014_candles.sql');
    expect(files.map((file) => Number(file.slice(0, 3)))).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
  });

  it('defines every required table without empty migrations', () => {
    const expectedTables = [
      'assets', 'raw_snapshots', 'observations', 'positioning_events', 'catalysts',
      'social_claims', 'evidence_refs', 'source_health', 'jobs', 'signals',
      'abstentions', 'grades', 'outbox', 'candles',
    ];
    const sql = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
      .join('\n');

    for (const table of expectedTables) {
      expect(sql).toMatch(new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${table}\\b`, 'i'));
    }
  });
});