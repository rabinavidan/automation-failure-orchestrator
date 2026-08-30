import type { AgentInvestigation } from '@orchestrator/shared-types';
import { query } from '../db/client';
import type { ExecutionFetcher, ExecutionRecord } from './failure-mode-taxonomy';

interface ExecutionRow {
  thread_id: string;
  run_id: string;
  fingerprint: string;
  test_id: string;
  model: string;
  final_result: AgentInvestigation;
}

export function createDatabaseExecutionFetcher(): ExecutionFetcher {
  return {
    async fetchRecentCompleted(limit: number): Promise<ExecutionRecord[]> {
      const rows = await query<ExecutionRow>(
        `SELECT thread_id, run_id, fingerprint, test_id, model, final_result
         FROM agent_executions
         WHERE status = 'completed' AND final_result IS NOT NULL
         ORDER BY finished_at DESC
         LIMIT $1`,
        [limit]
      );
      return rows.map((row) => ({
        threadId: row.thread_id,
        runId: row.run_id,
        fingerprint: row.fingerprint,
        testId: row.test_id,
        model: row.model,
        finalResult: row.final_result,
      }));
    },
  };
}
