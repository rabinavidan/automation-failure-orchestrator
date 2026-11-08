/**
 * Exports the Zod contracts as JSON Schema (draft 2020-12) into contracts/json-schema/.
 *
 * The Zod schemas stay the single source of truth. Non-TypeScript consumers (the pytest suite,
 * the Playwright reporter's output check, external producers) validate against these files,
 * and CI fails if they are stale: `npm run contracts:check`.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import {
  API_OPERATIONS,
  AgentInvestigationSchema,
  ApprovalListSchema,
  EnrichmentResponseSchema,
  FailureListSchema,
  KnowledgeStatusSchema,
  ObservabilitySummarySchema,
  PlaybookSchema,
  ProcessingResultSchema,
  RunListSchema,
  SecurityAlertSchema,
  SentinelAlertSchema,
  SplunkAlertWebhookSchema,
  TriagePolicySchema,
  WazuhAlertSchema,
  WebhookPayloadSchema,
} from '../src';

const OUT = join(__dirname, '../../../contracts/json-schema');

// Inputs: what a producer may send (fields with defaults are optional on the wire).
const contracts: Record<string, z.ZodType> = {
  'webhook-payload': WebhookPayloadSchema,
  'security-alert': SecurityAlertSchema,
  'splunk-alert-webhook': SplunkAlertWebhookSchema,
  'sentinel-alert': SentinelAlertSchema,
  'wazuh-alert': WazuhAlertSchema,
  // What the Python enrichment service returns (apps/enrichment-service), as TypeScript reads it.
  'enrichment-response': EnrichmentResponseSchema,
  // Configuration as code: response playbooks (config/playbooks) and the triage policy.
  playbook: PlaybookSchema,
  'triage-policy': TriagePolicySchema,
};

// Outputs: what the API returns, validated against live responses by the pytest contract layer.
const responses: Record<string, z.ZodType> = {
  'processing-result': ProcessingResultSchema,
  'agent-investigation': AgentInvestigationSchema,
  'run-list': RunListSchema,
  'failure-list': FailureListSchema,
  'approval-list': ApprovalListSchema,
  'knowledge-status': KnowledgeStatusSchema,
  'observability-summary': ObservabilitySummarySchema,
};

mkdirSync(OUT, { recursive: true });
const all = [
  ...Object.entries(contracts).map(([name, schema]) => [name, schema, 'input'] as const),
  ...Object.entries(responses).map(([name, schema]) => [name, schema, 'output'] as const),
];
for (const [name, schema, io] of all) {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  const document = {
    $id: `https://signalops.local/contracts/${name}.schema.json`,
    title: name,
    description: `Generated from @orchestrator/shared-types. Do not edit: run npm run contracts:export.`,
    ...json,
  };
  writeFileSync(join(OUT, `${name}.schema.json`), `${JSON.stringify(document, null, 2)}\n`);
  console.log(`[contracts] ${name}.schema.json`);
}

// OpenAPI 3.1 (JSON Schema 2020-12 compatible) generated from the API registry in src/api.ts.
const SECURITY: Record<string, Array<Record<string, string[]>>> = {
  none: [],
  'webhook-secret': [{ webhookSecret: [] }],
  reviewer: [{ reviewerToken: [] }],
  'mcp-scope-token': [{ mcpScopeToken: [] }],
};
const paths: Record<string, Record<string, unknown>> = {};
for (const op of API_OPERATIONS) {
  const path = op.path.replace(/:([A-Za-z]+)/g, '{$1}');
  const params = [...op.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  const status = String(op.successStatus ?? 200);
  const responses: Record<string, unknown> = {
    [status]: {
      description: op.response ? 'Success' : 'Success (response schema not yet published)',
      content: {
        'application/json': {
          schema: op.response
            ? z.toJSONSchema(op.response, { io: 'output', unrepresentable: 'any' })
            : {},
        },
      },
    },
  };
  if (op.requestBody || params.length) responses['400'] = { description: 'Invalid request' };
  if (op.auth.kind !== 'none') responses['401'] = { description: 'Missing or invalid credentials' };
  if (op.auth.kind === 'reviewer')
    responses['403'] = { description: `Requires the ${op.auth.role} role` };
  paths[path] = {
    ...(paths[path] ?? {}),
    [op.method]: {
      tags: [op.tag],
      summary: op.summary,
      security: SECURITY[op.auth.kind],
      ...(op.auth.kind === 'reviewer' ? { 'x-required-role': op.auth.role } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(op.requestBody
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: z.toJSONSchema(op.requestBody, { io: 'input', unrepresentable: 'any' }),
                },
              },
            },
          }
        : {}),
      responses,
    },
  };
}
const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'SignalOps ingestion service',
    version: '1.0.0',
    description:
      'Generated from packages/shared-types/src/api.ts. Do not edit: run npm run contracts:export.',
  },
  servers: [{ url: 'http://localhost:3001' }],
  components: {
    securitySchemes: {
      webhookSecret: { type: 'apiKey', in: 'header', name: 'x-webhook-secret' },
      reviewerToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Reviewer identity (REVIEWER_TOKENS)',
      },
      mcpScopeToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Per-investigation MCP scope token',
      },
    },
  },
  paths,
};
writeFileSync(join(OUT, '..', 'openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
console.log(`[contracts] openapi.json (${API_OPERATIONS.length} operations)`);
