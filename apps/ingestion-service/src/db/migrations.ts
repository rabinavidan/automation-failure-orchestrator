import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getPool } from './client';

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Find migration files
  const migrationsDir = join(__dirname, '../../../../database/migrations');
  let migrationFiles: string[];

  try {
    migrationFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.warn('[Migrations] Migrations directory not found, skipping migrations');
    return;
  }

  for (const file of migrationFiles) {
    const version = file.replace('.sql', '');

    // Check if already applied
    const applied = await pool.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [version]
    );

    if (applied.rows.length > 0) {
      console.log(`[Migrations] ${version} already applied, skipping`);
      continue;
    }

    // Apply migration
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`[Migrations] Applying ${version}...`);

    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);

    console.log(`[Migrations] ${version} applied successfully`);
  }

  console.log('[Migrations] All migrations applied');
}
