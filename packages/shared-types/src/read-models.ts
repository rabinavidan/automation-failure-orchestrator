import { z } from 'zod';
import { AgentInvestigationSchema, FailureClassification, RecommendedActionSchema } from './types';

/**
 * Read models returned by the API's GET endpoints: database rows in snake_case, as the dashboard
 * consumes them. Unknown fields are forbidden in the exported JSON Schema, so a column added,
 * dropped or retyped in a query fails the pytest contract layer before a consumer notices.
 */

const timestamp = z.string();
const page = { total: z.number().int().min(0), limit: z.number().int(), offset: z.number().int() };

export const RunRowSchema = z.object({
  run_id: z.string(),
  repository: z.string(),
  branch: z.string(),
  commit_sha: z.string(),
  environment: z.string(),
  triggered_by: z.string(),
  started_at: timestamp,
  finished_at: timestamp,
  summary: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  created_at: timestamp,
});
export type RunRow = z.infer<typeof RunRowSchema>;
export const RunListSchema = z.object({ runs: z.array(RunRowSchema), ...page });

export const TestOutcomeSchema = z.enum(['passed', 'failed', 'skipped']);

export const FailureRowSchema = z.object({
  id: z.number().int(),
  fingerprint: z.string(),
  test_id: z.string(),
  title: z.string(),
  suite: z.string(),
  run_count: z.number().int(),
  fail_count: z.number().int(),
  pass_count: z.number().int(),
  last_statuses: z.array(TestOutcomeSchema),
  consecutive_passes: z.number().int(),
  jira_issue_key: z.string().nullable(),
  last_seen_at: timestamp,
  first_seen_at: timestamp,
  updated_at: timestamp,
  classification: z.enum(FailureClassification).nullable(),
  agent_investigation: AgentInvestigationSchema.nullable(),
  test_result_created_at: timestamp.nullable(),
});
export type FailureRow = z.infer<typeof FailureRowSchema>;
export const FailureListSchema = z.object({ failures: z.array(FailureRowSchema), ...page });

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  run_id: z.string(),
  fingerprint: z.string(),
  test_id: z.string(),
  classification: z.enum(FailureClassification),
  requested_action: RecommendedActionSchema,
  status: z.enum(['pending', 'approved', 'rejected']),
  investigation: AgentInvestigationSchema,
  reviewer: z.string().nullable(),
  review_comment: z.string().nullable(),
  created_at: timestamp,
  decided_at: timestamp.nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export const ApprovalListSchema = z.object({ approvals: z.array(ApprovalRequestSchema) });

export const KnowledgeStatusSchema = z.object({
  chunkCount: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
  embeddingModel: z.string(),
  activeModelChunkCount: z.number().int().min(0),
  latestRun: z
    .object({
      status: z.enum(['running', 'completed', 'failed']),
      embedding_model: z.string(),
      file_count: z.number().int().nullable(),
      chunk_count: z.number().int().nullable(),
      error: z.string().nullable(),
      started_at: timestamp,
      finished_at: timestamp.nullable(),
    })
    .nullable(),
});
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;

export const ObservabilitySummarySchema = z.object({
  window: z.string(),
  executions: z.object({
    total: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
    paused: z.number().int(),
    avg_duration_ms: z.number(),
  }),
  modelCalls: z.object({
    calls: z.number().int(),
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    avg_call_duration_ms: z.number(),
  }),
  byNode: z.array(
    z.object({
      node: z.string(),
      calls: z.number().int(),
      avg_duration_ms: z.number(),
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
    })
  ),
  recentCalls: z.array(
    z.object({
      id: z.string(),
      thread_id: z.string(),
      node: z.string(),
      prompt_version: z.string(),
      model: z.string(),
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      duration_ms: z.number().int(),
      created_at: timestamp,
    })
  ),
});
export type ObservabilitySummary = z.infer<typeof ObservabilitySummarySchema>;
