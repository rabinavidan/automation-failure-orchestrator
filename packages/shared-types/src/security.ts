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
  vendor: z.enum(['splunk', 'sentinel', 'wazuh', 'generic']),
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
/**
 * Microsoft Sentinel alert as posted by a Logic App / automation rule
 * ("When a Microsoft Sentinel alert is triggered"). `Entities` arrives either as
 * an array or as a JSON string, depending on the connector.
 */
export const SentinelAlertSchema = z
  .object({
    SystemAlertId: z.string().min(1),
    AlertDisplayName: z.string().min(1),
    AlertType: z.string().optional(),
    Severity: z.string().optional(),
    Description: z.string().optional(),
    ProductName: z.string().optional(),
    StartTimeUtc: z.string().optional(),
    TimeGenerated: z.string().optional(),
    Tactics: z.union([z.string(), z.array(z.string())]).optional(),
    Techniques: z.union([z.string(), z.array(z.string())]).optional(),
    Entities: z.union([z.string(), z.array(z.record(z.unknown()))]).optional(),
    AlertUri: z.string().url().optional(),
  })
  .passthrough();

/** Wazuh alert as sent by a custom integration (ossec.conf <integration>). */
export const WazuhAlertSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.string().optional(),
    rule: z.object({
      id: z.string().min(1),
      level: z.number().int().min(0).max(16),
      description: z.string().min(1),
      groups: z.array(z.string()).optional(),
      mitre: z
        .object({
          id: z.array(z.string()).optional(),
          tactic: z.array(z.string()).optional(),
        })
        .optional(),
    }),
    agent: z
      .object({ id: z.string().optional(), name: z.string().optional(), ip: z.string().optional() })
      .optional(),
    data: z.record(z.unknown()).optional(),
    syscheck: z.record(z.unknown()).optional(),
  })
  .passthrough();

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

// ---------------------------------------------------------------------------
// SOC triage (M3): policy-as-code + deterministic triage result
// ---------------------------------------------------------------------------

/**
 * Criteria are ANDed; every field is optional but at least one must be set.
 * `ruleId` supports `*` wildcards. `indicator.value` for type `ip` may be an
 * IPv4 CIDR. Hosts/users are compared after identity normalization
 * (FQDN -> short host, DOMAIN\user / UPN -> user).
 */
export const TriageMatchSchema = z
  .object({
    ruleId: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    indicator: z.object({ type: IndicatorTypeSchema, value: z.string().min(1) }).optional(),
  })
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'a policy entry must set at least one match criterion',
  });

export const TriagePolicyEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  owner: z.string().min(1),
  /** Allowlists must expire; reviewed entries are renewed, stale ones stop matching. */
  expiresAt: z.string().datetime({ offset: true }),
  match: TriageMatchSchema,
});

export const TriagePolicySchema = z.object({
  version: z.string().min(1),
  /** Activity that is never a threat (e.g. our own vulnerability scanner) -> false_positive. */
  allowlist: z.array(TriagePolicyEntrySchema).default([]),
  /** Real detections of expected, sanctioned activity -> benign_true_positive. */
  knownBenign: z.array(TriagePolicyEntrySchema).default([]),
});

export const TriageDispositionSchema = z.enum([
  'false_positive',
  'duplicate',
  'true_positive',
  'benign_true_positive',
  'needs_investigation',
]);

export const TriagePrioritySchema = z.enum(['P1', 'P2', 'P3', 'P4']);

export const TriageActionSchema = z.enum(['escalate', 'investigate', 'close', 'suppress']);

// ---------------------------------------------------------------------------
// Response playbooks (M5)
// ---------------------------------------------------------------------------

/** Allowlisted response actions; anything else is rejected at playbook load time. */
export const ResponseActionTypeSchema = z.enum([
  'ticket.create',
  'slack.notify',
  'firewall.block_ip',
  'edr.isolate_host',
  'edr.kill_process',
]);

/** Containment changes production state: these can never run without a human decision. */
export const CONTAINMENT_ACTIONS = ['firewall.block_ip', 'edr.isolate_host', 'edr.kill_process'];

export const PlaybookStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    action: ResponseActionTypeSchema,
    description: z.string().min(1),
    /** Which alert entity the action targets. */
    target: z
      .object({
        indicator: IndicatorTypeSchema,
        role: z.enum(['source', 'destination', 'target', 'observed']).optional(),
      })
      .optional(),
    approval: z.enum(['none', 'required']),
  })
  .refine((s) => !CONTAINMENT_ACTIONS.includes(s.action) || s.approval === 'required', {
    message: 'containment actions must set approval: required',
  })
  .refine((s) => !CONTAINMENT_ACTIONS.includes(s.action) || s.target !== undefined, {
    message: 'containment actions must declare a target',
  });

export const PlaybookSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.number().int().positive(),
  description: z.string().min(1),
  owner: z.string().min(1),
  trigger: z.object({
    dispositions: z.array(TriageDispositionSchema).min(1),
    /** ATT&CK techniques (parent match). Omit to match any technique. */
    techniques: z.array(z.string().regex(/^T\d{4}(\.\d{3})?$/)).optional(),
    /** Only run for alerts at this priority or more urgent. */
    maxPriority: TriagePrioritySchema.optional(),
  }),
  steps: z.array(PlaybookStepSchema).min(1),
});

export const ResponseActionStatusSchema = z.enum([
  'pending_approval',
  'approved',
  'rejected',
  'succeeded',
  'failed',
  'blocked_by_guard',
  'rolled_back',
]);
