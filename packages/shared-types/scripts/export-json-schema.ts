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
  AgentInvestigationSchema,
  EnrichmentResponseSchema,
  PlaybookSchema,
  ProcessingResultSchema,
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
