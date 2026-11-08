import type { z } from 'zod';
import {
  ApprovalListSchema,
  FailureListSchema,
  KnowledgeStatusSchema,
  ObservabilitySummarySchema,
  RunListSchema,
} from './read-models';
import { WebhookPayloadSchema } from './schemas';
import { SecurityAlertSchema } from './security';
import { ProcessingResultSchema } from './types';

/**
 * The ingestion service's HTTP API as data: every route, how it is authenticated, and the Zod
 * schemas of its body and response where they exist. `npm run contracts:export` turns this into
 * contracts/openapi.json, and a drift test fails when a route registered in Express is missing
 * here (or the other way round), so the published API cannot fall behind the code.
 */
export type ApiAuth =
  | { kind: 'none' }
  | { kind: 'webhook-secret' }
  | { kind: 'reviewer'; role: 'ci_reviewer' | 'soc_responder' | 'admin' }
  | { kind: 'mcp-scope-token' };

export interface ApiOperation {
  method: 'get' | 'post';
  /** Express-style path (`/api/runs/:runId`); converted to `{runId}` for OpenAPI. */
  path: string;
  tag: string;
  summary: string;
  auth: ApiAuth;
  requestBody?: z.ZodType;
  /** Response schema for 200/201; undefined means the shape is not yet published as a schema. */
  response?: z.ZodType;
  successStatus?: 200 | 201;
}

const none: ApiAuth = { kind: 'none' };
const webhook: ApiAuth = { kind: 'webhook-secret' };
const reviewer = (role: 'ci_reviewer' | 'soc_responder' | 'admin'): ApiAuth => ({
  kind: 'reviewer',
  role,
});

export const API_OPERATIONS: ApiOperation[] = [
  {
    method: 'get',
    path: '/health',
    tag: 'platform',
    summary: 'Liveness and database check',
    auth: none,
  },
  {
    method: 'get',
    path: '/api/capabilities',
    tag: 'platform',
    summary: 'Configured and reachable runtime modes (model, integrations, queue); never secrets',
    auth: none,
  },
  {
    method: 'get',
    path: '/api/benchmark/summary',
    tag: 'platform',
    summary: 'Committed benchmark reports, exactly as stored',
    auth: none,
  },
  {
    method: 'post',
    path: '/mcp',
    tag: 'agents',
    summary: 'MCP evidence server (read-only tools, per-investigation scope token)',
    auth: { kind: 'mcp-scope-token' },
  },

  // CI track
  {
    method: 'post',
    path: '/api/runs',
    tag: 'ci',
    summary: 'Ingest a test run: fingerprint, classify, investigate, act by policy',
    auth: webhook,
    requestBody: WebhookPayloadSchema,
    response: ProcessingResultSchema,
    successStatus: 201,
  },
  {
    method: 'get',
    path: '/api/runs',
    tag: 'ci',
    summary: 'Recent runs',
    auth: none,
    response: RunListSchema,
  },
  {
    method: 'get',
    path: '/api/runs/:runId',
    tag: 'ci',
    summary: 'One run with its test results',
    auth: none,
  },
  {
    method: 'get',
    path: '/api/failures',
    tag: 'ci',
    summary: 'Tracked failures with their latest classification and investigation',
    auth: none,
    response: FailureListSchema,
  },
  {
    method: 'get',
    path: '/api/failures/:fingerprint',
    tag: 'ci',
    summary: 'Failure history and recent results for one fingerprint',
    auth: none,
  },
  {
    method: 'get',
    path: '/api/failures/:fingerprint/agent-executions',
    tag: 'ci',
    summary: 'Agent executions and graph events for one fingerprint',
    auth: none,
  },
  {
    method: 'post',
    path: '/api/failures/:fingerprint/reclassify',
    tag: 'ci',
    summary: 'Human reclassification of a failure',
    auth: reviewer('ci_reviewer'),
  },
  {
    method: 'get',
    path: '/api/approvals',
    tag: 'ci',
    summary: 'Investigations paused for human review',
    auth: none,
    response: ApprovalListSchema,
  },
  {
    method: 'post',
    path: '/api/approvals/:threadId/decision',
    tag: 'ci',
    summary: 'Approve or reject a paused investigation; approval executes the planned actions',
    auth: reviewer('ci_reviewer'),
  },

  // Knowledge and observability
  {
    method: 'get',
    path: '/api/knowledge/status',
    tag: 'knowledge',
    summary: 'Repository index status for the active embedding model',
    auth: none,
    response: KnowledgeStatusSchema,
  },
  {
    method: 'post',
    path: '/api/knowledge/search',
    tag: 'knowledge',
    summary: 'Semantic search over the repository index',
    auth: none,
  },
  {
    method: 'post',
    path: '/api/knowledge/reindex',
    tag: 'knowledge',
    summary: 'Rebuild the repository index',
    auth: reviewer('admin'),
    successStatus: 201,
  },
  {
    method: 'get',
    path: '/api/observability/summary',
    tag: 'observability',
    summary: 'Agent executions, model calls, tokens and latency',
    auth: none,
    response: ObservabilitySummarySchema,
  },

  // SOC track
  {
    method: 'post',
    path: '/api/alerts',
    tag: 'soc',
    summary: 'Ingest an alert in the normalized SecurityAlert contract',
    auth: webhook,
    requestBody: SecurityAlertSchema,
    successStatus: 201,
  },
  {
    method: 'post',
    path: '/api/alerts/:vendor',
    tag: 'soc',
    summary: 'Ingest a native SIEM alert (splunk, sentinel, wazuh)',
    auth: webhook,
    successStatus: 201,
  },
  {
    method: 'get',
    path: '/api/alerts',
    tag: 'soc',
    summary: 'Alert queue with filters',
    auth: none,
  },
  { method: 'get', path: '/api/alerts/metrics', tag: 'soc', summary: 'SOC KPIs', auth: none },
  {
    method: 'get',
    path: '/api/alerts/triage-policy',
    tag: 'soc',
    summary: 'The active triage policy and its version',
    auth: none,
  },
  {
    method: 'get',
    path: '/api/alerts/fingerprints/:fingerprint',
    tag: 'soc',
    summary: 'One alert fingerprint with its occurrences',
    auth: none,
  },
  { method: 'get', path: '/api/alerts/:alertId', tag: 'soc', summary: 'One alert', auth: none },
  {
    method: 'get',
    path: '/api/responses/actions',
    tag: 'soc',
    summary: 'Response actions with filters',
    auth: none,
  },
  {
    method: 'get',
    path: '/api/responses/actions/:id',
    tag: 'soc',
    summary: 'One response action',
    auth: none,
  },
  {
    method: 'post',
    path: '/api/responses/actions/:id/decision',
    tag: 'soc',
    summary: 'Approve or reject a containment action',
    auth: reviewer('soc_responder'),
  },
  {
    method: 'post',
    path: '/api/responses/actions/:id/rollback',
    tag: 'soc',
    summary: 'Roll back an executed containment action',
    auth: reviewer('soc_responder'),
  },
  {
    method: 'get',
    path: '/api/responses/playbooks',
    tag: 'soc',
    summary: 'Loaded response playbooks and load errors',
    auth: none,
  },
];
