import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { query } from '../db/client';
import { createDatabaseEvidenceStore, type EvidenceStore } from '../mcp/evidence-store';
import {
  createEvidenceServer,
  type EvidenceCallRecord,
  type EvidenceServerOptions,
} from '../mcp/evidence-server';
import { mcpScopeSecret, verifyScopeToken } from '../mcp/scope-token';

/** Records each MCP tool call in the investigation's audit trail (best effort). */
async function auditCall(record: EvidenceCallRecord): Promise<void> {
  try {
    await query(
      `INSERT INTO agent_execution_events (thread_id, node, status, details)
       SELECT $1, $2, $3, $4::jsonb WHERE EXISTS (SELECT 1 FROM agent_executions WHERE thread_id = $1)`,
      [
        record.threadId,
        `mcp:${record.tool}`,
        record.decision === 'allowed' ? 'completed' : 'failed',
        JSON.stringify({
          transport: 'mcp',
          decision: record.decision,
          durationMs: record.durationMs,
          ...(record.truncated ? { truncated: true } : {}),
          ...(record.reason ? { reason: record.reason } : {}),
        }),
      ]
    );
  } catch (error) {
    console.error('[MCP] audit write failed:', error instanceof Error ? error.message : error);
  }
}

export function createMcpRouter(
  store: EvidenceStore = createDatabaseEvidenceStore(),
  options: EvidenceServerOptions = { onCall: auditCall }
): Router {
  const router = Router();

  // Stateless Streamable HTTP: one server per request, scoped by the bearer token.
  router.post('/', async (req, res) => {
    const secret = mcpScopeSecret();
    if (!secret) {
      res.status(503).json({ error: 'MCP evidence endpoint disabled (MCP_SCOPE_SECRET not set)' });
      return;
    }
    const header = req.header('authorization') ?? '';
    const scope = verifyScopeToken(header.replace(/^Bearer\s+/i, ''), secret);
    if (!scope) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'invalid or expired evidence scope token' },
        id: null,
      });
      return;
    }
    const server = createEvidenceServer(scope, store, options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  });

  router.all('/', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
  });

  return router;
}
