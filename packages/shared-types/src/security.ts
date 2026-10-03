import { z } from 'zod';

/**
 * Security alert contract (SOC automation track).
 *
 * Vendor payloads (Splunk, Sentinel, ...) are parsed into this normalized
 * shape before fingerprinting, deduplication, and classification, so every
 * downstream stage is vendor-agnostic.
 */

export const SecuritySeveritySchema = z.enum([
  'informational',
  'low',
  'medium',
  'high',
  'critical',
]);

export const IndicatorTypeSchema = z.enum([
  'ip',
  'domain',
  'url',
  'file_hash',
  'email',
  'user',
  'host',
  'process',
]);

export const IndicatorSchema = z.object({
  type: IndicatorTypeSchema,
  value: z.string().min(1),
  role: z.enum(['source', 'destination', 'target', 'observed']).optional(),
});

export const MitreAttackSchema = z.object({
  tactics: z.array(z.string()).default([]),
  techniques: z.array(z.string().regex(/^T\d{4}(\.\d{3})?$/)).default([]),
});

export const AlertSourceSchema = z.object({
  vendor: z.enum(['splunk', 'sentinel', 'generic']),
  product: z.string().optional(),
  searchName: z.string().optional(),
  resultsLink: z.string().url().optional(),
});

export const SecurityAlertSchema = z.object({
  schemaVersion: z.string(),
  alertId: z.string().min(1),
  source: AlertSourceSchema,
  ruleId: z.string().min(1),
  ruleName: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  severity: SecuritySeveritySchema,
  detectedAt: z.string().datetime({ offset: true }),
  host: z.string().optional(),
  user: z.string().optional(),
  indicators: z.array(IndicatorSchema).default([]),
  mitre: MitreAttackSchema.optional(),
  eventCount: z.number().int().nonnegative().optional(),
  raw: z.record(z.unknown()).optional(),
});

/**
 * Splunk "Webhook" alert action payload.
 * https://docs.splunk.com/Documentation/Splunk/latest/Alert/Webhooks
 * `result` holds the first result row; field names follow the Splunk CIM.
 */
export const SplunkAlertWebhookSchema = z.object({
  sid: z.string().min(1),
  search_name: z.string().min(1),
  app: z.string().optional(),
  owner: z.string().optional(),
  results_link: z.string().url().optional(),
  result: z.record(z.unknown()),
});

/**
 * Response of the Python enrichment service (`POST /enrich`,
 * apps/enrichment-service). Validated at the boundary so a contract drift in
 * the Python service fails loudly instead of persisting malformed data.
 */
export const EnrichmentVerdictSchema = z.enum(['malicious', 'suspicious', 'benign', 'unknown']);

export const ProviderResultSchema = z.object({
  provider: z.string(),
  verdict: EnrichmentVerdictSchema,
  score: z.number().int().min(0).max(100),
  summary: z.string(),
  details: z.record(z.unknown()).default({}),
  cached: z.boolean().default(false),
  error: z.string().nullable().optional(),
});

export const IndicatorEnrichmentSchema = z.object({
  indicator: IndicatorSchema.extend({ role: IndicatorSchema.shape.role.nullable() }),
  normalizedValue: z.string(),
  verdict: EnrichmentVerdictSchema,
  score: z.number().int().min(0).max(100),
  skippedReason: z.string().nullable().optional(),
  results: z.array(ProviderResultSchema),
});

export const EnrichmentSummarySchema = z.object({
  verdict: EnrichmentVerdictSchema,
  maxScore: z.number().int().min(0).max(100),
  malicious: z.number().int().nonnegative(),
  suspicious: z.number().int().nonnegative(),
  enriched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  providerErrors: z.number().int().nonnegative(),
});

export const EnrichmentResponseSchema = z.object({
  alertId: z.string().nullable().optional(),
  mode: z.enum(['mock', 'live']),
  summary: EnrichmentSummarySchema,
  enrichments: z.array(IndicatorEnrichmentSchema),
});
