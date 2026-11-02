// Must load first so HTTP, Express and pg are instrumented (no-op unless OTEL_ENABLED=true).
import { shutdownTelemetry } from './observability/register';
import app from './app';
import { runMigrations } from './db/migrations';
import { closePool } from './db/client';
import { setupAgentCheckpointer } from './db/agent-checkpointer';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '10000', 10);

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
      await shutdownTelemetry();
      process.exit(0);
    });
    // server.close() waits for every open connection; idle keep-alive sockets (proxies, pooled
    // clients) would hold it until the orchestrator's stop timeout and a SIGKILL that skips the
    // cleanup above. Close idle sockets now, and force an exit if in-flight requests overrun.
    server.closeIdleConnections();
    setTimeout(() => {
      console.warn('[Server] Shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
