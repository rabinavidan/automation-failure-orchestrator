import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { getPool } from './client';

/** Arbitrary, stable key for the cross-process checkpointer-setup lock. */
const SETUP_LOCK_KEY = 72_310_001;

let checkpointer: PostgresSaver | undefined;
let setupPromise: Promise<void> | undefined;

/**
 * Runs LangGraph's schema setup under a PostgreSQL advisory lock. Its `CREATE TABLE IF NOT
 * EXISTS` is not safe under concurrency: two processes starting on a fresh database (API
 * replicas, the API and the investigation worker) race on the catalog and one fails with a
 * duplicate `pg_type` key, which disables its agent graph.
 */
async function setupWithLock(saver: PostgresSaver): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK_KEY]);
    try {
      await saver.setup();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export async function getAgentCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    checkpointer = new PostgresSaver(getPool(), undefined, { schema: 'langgraph' });
  }
  // A failed setup is not cached, so the next call retries instead of failing forever.
  setupPromise ??= setupWithLock(checkpointer).catch((err: unknown) => {
    setupPromise = undefined;
    throw err;
  });
  await setupPromise;
  return checkpointer;
}

export async function setupAgentCheckpointer(): Promise<void> {
  await getAgentCheckpointer();
  console.log('[LangGraph] PostgreSQL checkpointing ready');
}
