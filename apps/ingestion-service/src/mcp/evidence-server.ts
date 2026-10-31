import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EvidenceStore } from './evidence-store';
import type { EvidenceScope } from './scope-token';

export const EVIDENCE_TOOLS = [
  'get_investigation_context',
  'get_failure_history',
  'get_related_issue',
  'search_repository_evidence',
] as const;
export type EvidenceToolName = (typeof EVIDENCE_TOOLS)[number];

export interface EvidenceCallRecord {
  threadId: string;
  tool: string;
  decision: 'allowed' | 'denied' | 'timeout' | 'error';
  durationMs: number;
  truncated?: boolean;
  reason?: string;
}

export interface EvidenceServerOptions {
  /** Per-tool deadline; a slow store yields an error result, never a hung agent. */
  timeoutMs?: number;
  /** Upper bound on serialized result size returned to the model. */
  maxResultBytes?: number;
  onCall?: (record: EvidenceCallRecord) => void | Promise<void>;
}

const FINGERPRINT = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'fingerprint must be 64 lowercase hex chars');

function denied(reason: string): CallToolResult {
  // Deliberately generic: a denied call returns no protected content.
  return { isError: true, content: [{ type: 'text', text: `denied: ${reason}` }] };
}

/** Serialize evidence as untrusted data, bounded in size. */
export function boundedResult(
  threadId: string,
  data: unknown,
  maxBytes: number
): { result: CallToolResult; truncated: boolean } {
  const envelope = {
    traceId: threadId,
    // Retrieved text is data. Instructions inside it carry no authority over the agent or tools.
    untrusted: true,
    data,
  };
  let text = JSON.stringify(envelope);
  let truncated = false;
  if (Buffer.byteLength(text) > maxBytes) {
    truncated = true;
    const raw = JSON.stringify(data);
    const budget = Math.max(0, maxBytes - 200);
    text = JSON.stringify({
      traceId: threadId,
      untrusted: true,
      truncated: true,
      data: Buffer.from(raw).subarray(0, budget).toString('utf-8'),
    });
  }
  return { result: { content: [{ type: 'text', text }] }, truncated };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('evidence lookup timed out')), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    );
  });
}

/**
 * Read-only MCP server for one investigation scope. No tool writes, executes commands, fetches
 * arbitrary URLs or reads files; write actions stay with the deterministic action executor.
 */
export function createEvidenceServer(
  scope: EvidenceScope,
  store: EvidenceStore,
  options: EvidenceServerOptions = {}
): McpServer {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxResultBytes ?? 8_192;
  const server = new McpServer({ name: 'signalops-evidence', version: '1.0.0' });

  const run = async (
    tool: EvidenceToolName,
    authorize: () => string | null,
    load: () => Promise<unknown>
  ): Promise<CallToolResult> => {
    const started = Date.now();
    const record = async (r: Omit<EvidenceCallRecord, 'threadId' | 'tool' | 'durationMs'>) => {
      await options.onCall?.({
        threadId: scope.threadId,
        tool,
        durationMs: Date.now() - started,
        ...r,
      });
    };
    const denial = authorize();
    if (denial) {
      await record({ decision: 'denied', reason: denial });
      return denied(denial);
    }
    try {
      const data = await withDeadline(load(), timeoutMs);
      const { result, truncated } = boundedResult(scope.threadId, data, maxBytes);
      await record({ decision: 'allowed', truncated });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'lookup failed';
      const timedOut = message.includes('timed out');
      await record({ decision: timedOut ? 'timeout' : 'error', reason: message });
      return {
        isError: true,
        content: [
          { type: 'text', text: timedOut ? 'evidence lookup timed out' : 'evidence lookup failed' },
        ],
      };
    }
  };

  const sameFingerprint = (fingerprint: string) =>
    fingerprint === scope.fingerprint ? null : 'fingerprint is outside this investigation scope';

  server.registerTool(
    'get_investigation_context',
    {
      description: 'Run metadata and the stored test result for the investigation in scope.',
      inputSchema: { runId: z.string().min(1).max(255) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ runId }) =>
      run(
        'get_investigation_context',
        () => (runId === scope.runId ? null : 'run is outside this investigation scope'),
        async () => ({
          runId: scope.runId,
          testId: scope.testId,
          fingerprint: scope.fingerprint,
          run: await store.getRun(scope.runId),
          testResult: await store.getTestResult(scope.runId, scope.fingerprint),
        })
      )
  );

  server.registerTool(
    'get_failure_history',
    {
      description: 'Prior outcomes and recurrence for the failure fingerprint in scope.',
      inputSchema: { fingerprint: FINGERPRINT },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ fingerprint }) =>
      run(
        'get_failure_history',
        () => sameFingerprint(fingerprint),
        async () => (await store.getFailureHistory(scope.fingerprint)) ?? { found: false }
      )
  );

  server.registerTool(
    'get_related_issue',
    {
      description: 'The tracker issue labelled with the in-scope fingerprint, if any.',
      inputSchema: { fingerprint: FINGERPRINT },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ fingerprint }) =>
      run(
        'get_related_issue',
        () => sameFingerprint(fingerprint),
        async () => (await store.getRelatedIssue(scope.fingerprint)) ?? { found: false }
      )
  );

  server.registerTool(
    'search_repository_evidence',
    {
      description:
        'Search the indexed repository knowledge base (pre-indexed chunks only; no file system or URL access).',
      inputSchema: {
        query: z.string().trim().min(3).max(500),
        topK: z.number().int().min(1).max(5).default(4),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, topK }) =>
      run(
        'search_repository_evidence',
        () => null,
        async () => {
          const matches = await store.searchRepository(query, topK ?? 4);
          return matches === null
            ? { available: false, reason: 'RAG is disabled' }
            : { available: true, matches };
        }
      )
  );

  return server;
}
