import { query } from '../db/client';

export interface AgentModelCallMetric {
  node: string;
  promptVersion: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface AgentTelemetrySink {
  recordModelCall(metric: AgentModelCallMetric): Promise<void>;
}

export function createDatabaseTelemetrySink(threadId: string): AgentTelemetrySink {
  return {
    async recordModelCall(metric) {
      await query(
        `INSERT INTO agent_model_calls
          (thread_id, node, prompt_version, model, prompt_tokens, completion_tokens, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          threadId,
          metric.node,
          metric.promptVersion,
          metric.model,
          metric.promptTokens,
          metric.completionTokens,
          metric.durationMs,
        ]
      );
    },
  };
}
