import { readFileSync } from 'fs';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

/**
 * DB_SSL=require enables TLS with full certificate verification. DB_SSL_CA_FILE points at
 * the RDS CA bundle (baked into the image), since RDS certificates are not publicly trusted.
 */
export function sslConfig(
  env: Record<string, string | undefined> = process.env
): PoolConfig['ssl'] {
  if (env.DB_SSL !== 'require') return undefined;
  return {
    rejectUnauthorized: true,
    ...(env.DB_SSL_CA_FILE ? { ca: readFileSync(env.DB_SSL_CA_FILE, 'utf-8') } : {}),
  };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      // On AWS, RDS credentials arrive as standard PG* variables from Secrets Manager
      // (no connection string with an embedded password); locally DATABASE_URL is used.
      connectionString:
        process.env.DATABASE_URL ??
        (process.env.PGHOST
          ? undefined
          : 'postgresql://orchestrator:orchestrator@localhost:5432/orchestrator'),
      ssl: sslConfig(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });
  }
  return pool;
}

export async function query<T extends object = object>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const client = getPool();
  const result = await client.query<T>(text, params);
  return result.rows;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
