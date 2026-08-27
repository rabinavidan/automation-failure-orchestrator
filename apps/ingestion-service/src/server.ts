import app from './app';
import { runMigrations } from './db/migrations';
import { closePool } from './db/client';
import { setupAgentCheckpointer } from './db/agent-checkpointer';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

async function main(): Promise<void> {
  // Run DB migrations before accepting traffic
  try {
    await runMigrations();
    if (process.env.AI_ENABLED === 'true') await setupAgentCheckpointer();
  } catch (err) {
    console.warn('[Server] Could not run migrations (DB may not be available):', err);
  }

  const server = app.listen(PORT, () => {
    console.log(`[Server] Ingestion service running on port ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
    console.log(`[Server] Runs: http://localhost:${PORT}/api/runs`);
    console.log(`[Server] Failures: http://localhost:${PORT}/api/failures`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Server] ${signal} received, shutting down...`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
