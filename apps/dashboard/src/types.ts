import type { KnowledgeStatus, ObservabilitySummary } from '@orchestrator/shared-types';

/**
 * Shapes the dashboard reads that have no schema in shared-types: the agent audit endpoint
 * (not yet published as a schema) and the mock Jira/Slack APIs (demo-only, not part of the
 * ingestion contract). Published read models are imported from @orchestrator/shared-types.
 */

export type AgentExecution = {
  thread_id: string;
  run_id: string;
  model: string;
  model_backend?: string | null;
  orchestration?: string;
  graph_version?: string;
  model_calls?: string;
  prompt_tokens?: string;
  completion_tokens?: string;
  model_ms?: string;
  status: string;
  started_at: string;
  finished_at?: string;
  events: Array<{
    id: string;
    node: string;
    status: string;
    details: Record<string, unknown>;
    created_at: string;
  }>;
};

export type JiraIssue = {
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string };
    labels: string[];
    priority?: { name?: string };
  };
  comments: Array<{ body: string; created: string }>;
  created: string;
};

export type SlackMessage = {
  id: string;
  channel: string;
  payload: { text?: string; blocks?: Array<{ text?: { text?: string } }> };
  receivedAt: string;
};

export type KnowledgeMatch = {
  sourcePath: string;
  chunkIndex: number;
  content: string;
  score: number;
};

export const emptyObservability: ObservabilitySummary = {
  window: '24h',
  executions: { total: 0, completed: 0, failed: 0, paused: 0, avg_duration_ms: 0 },
  modelCalls: { calls: 0, prompt_tokens: 0, completion_tokens: 0, avg_call_duration_ms: 0 },
  byNode: [],
  recentCalls: [],
};

export const emptyKnowledge: KnowledgeStatus = {
  chunkCount: 0,
  sourceCount: 0,
  embeddingModel: '',
  activeModelChunkCount: 0,
  latestRun: null,
};
