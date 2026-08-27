import type { AgentInvestigation } from '@orchestrator/shared-types';
import { query } from '../db/client';

export interface AgentAuditEvent {
  node: string;
  status: 'started' | 'completed' | 'bounded' | 'failed';
  details?: Record<string, unknown>;
}

export interface AgentAuditSink {
  record(event: AgentAuditEvent): Promise<void>;
}

export function createDatabaseAuditSink(threadId: string): AgentAuditSink {
  return {
    async record(event) {
      await query(
        `INSERT INTO agent_execution_events (thread_id, node, status, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [threadId, event.node, event.status, JSON.stringify(event.details ?? {})]
      );
    },
  };
}

export async function startAgentExecution(input: {
  threadId: string;
  runId: string;
  fingerprint: string;
  testId: string;
  model: string;
}): Promise<void> {
  await query(
    `INSERT INTO agent_executions (thread_id, run_id, fingerprint, test_id, model)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (thread_id) DO UPDATE SET
       status = 'running', final_result = NULL, finished_at = NULL`,
    [input.threadId, input.runId, input.fingerprint, input.testId, input.model]
  );
}

export async function finishAgentExecution(
  threadId: string,
  status: 'completed' | 'bounded' | 'failed',
  result?: AgentInvestigation
): Promise<void> {
  await query(
    `UPDATE agent_executions
     SET status = $2, final_result = $3::jsonb, finished_at = NOW()
     WHERE thread_id = $1`,
    [threadId, status, result ? JSON.stringify(result) : null]
  );
}
