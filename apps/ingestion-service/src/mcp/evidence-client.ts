import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FailureHistory } from '@orchestrator/shared-types';
import type { JiraIssue } from '../services/jira-adapter';
import type { KnowledgeMatch } from '../services/repository-knowledge';

/**
 * Evidence the investigation agent can request through its tools. Two implementations return
 * the same data: `direct` (in-process, from the investigation context) and `mcp` (over MCP).
 */
export interface EvidenceProvider {
  readonly transport: 'direct' | 'mcp';
  getFailureHistory(): Promise<FailureHistory | { found: false }>;
  getRelatedIssue(): Promise<JiraIssue | { found: false }>;
  searchRepository(
    searchText: string,
    topK: number
  ): Promise<{ available: true; matches: KnowledgeMatch[] } | { available: false; reason: string }>;
  close(): Promise<void>;
}

export function createDirectEvidenceProvider(input: {
  history: FailureHistory | null;
  existingIssue: JiraIssue | null;
  search: ((text: string, topK: number) => Promise<KnowledgeMatch[]>) | null;
}): EvidenceProvider {
  return {
    transport: 'direct',
    async getFailureHistory() {
      return input.history ?? { found: false };
    },
    async getRelatedIssue() {
      return input.existingIssue ?? { found: false };
    },
    async searchRepository(searchText, topK) {
      if (!input.search) return { available: false, reason: 'RAG is disabled' };
      return { available: true, matches: await input.search(searchText, topK) };
    },
    async close() {},
  };
}

export class EvidenceToolError extends Error {}

function parseEnvelope(result: unknown): unknown {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new EvidenceToolError(text || 'evidence tool failed');
  const envelope = JSON.parse(text) as { data: unknown; truncated?: boolean };
  if (envelope.truncated) throw new EvidenceToolError('evidence result truncated by server bound');
  return envelope.data;
}

/** MCP-backed provider. The scope (token) is fixed at creation; tool arguments cannot change it. */
export async function createMcpEvidenceProvider(input: {
  scope: { runId: string; fingerprint: string };
  transport?: Transport;
  url?: string;
  token?: string;
  timeoutMs?: number;
}): Promise<EvidenceProvider> {
  const transport =
    input.transport ??
    new StreamableHTTPClientTransport(new URL(input.url!), {
      requestInit: { headers: { authorization: `Bearer ${input.token}` } },
    });
  const client = new Client({ name: 'signalops-investigation-agent', version: '1.0.0' });
  await client.connect(transport);
  const timeout = input.timeoutMs ?? 10_000;
  const call = async (name: string, args: Record<string, unknown>) =>
    parseEnvelope(await client.callTool({ name, arguments: args }, undefined, { timeout }));

  return {
    transport: 'mcp',
    async getFailureHistory() {
      return (await call('get_failure_history', { fingerprint: input.scope.fingerprint })) as
        FailureHistory | { found: false };
    },
    async getRelatedIssue() {
      return (await call('get_related_issue', { fingerprint: input.scope.fingerprint })) as
        JiraIssue | { found: false };
    },
    async searchRepository(searchText, topK) {
      return (await call('search_repository_evidence', {
        query: searchText.slice(0, 500),
        topK: Math.min(Math.max(topK, 1), 5),
      })) as { available: true; matches: KnowledgeMatch[] } | { available: false; reason: string };
    },
    async close() {
      await client.close();
    },
  };
}
