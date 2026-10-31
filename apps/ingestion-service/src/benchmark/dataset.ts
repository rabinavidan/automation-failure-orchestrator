import { readFileSync } from 'fs';
import { z } from 'zod';
import type {
  EnrichmentResponse,
  FailureHistory,
  SecurityAlert,
  TestResult,
  WebhookPayload,
} from '@orchestrator/shared-types';
import { generateFingerprint } from '@orchestrator/fingerprint-engine';
import type { JiraIssue } from '../services/jira-adapter';

const CiActionSchema = z.enum(['create_issue', 'update_issue', 'notify_only', 'human_review']);
const SocResponseSchema = z.enum(['contain', 'investigate', 'monitor', 'close']);
const VerdictSchema = z.enum(['malicious', 'suspicious', 'clean', 'unknown']);

const CiCaseSchema = z.object({
  id: z.string(),
  track: z.literal('ci'),
  family: z.string(),
  split: z.enum(['dev', 'heldout']),
  ambiguous: z.boolean().optional(),
  note: z.string().optional(),
  ci: z.object({
    status: z.enum(['passed', 'failed']),
    error: z.object({ name: z.string(), message: z.string() }).nullable(),
    retry: z.number().int().nonnegative(),
    history: z
      .object({
        runCount: z.number().int(),
        lastStatuses: z.array(z.enum(['passed', 'failed', 'skipped'])),
        consecutivePasses: z.number().int(),
        jiraIssueKey: z.string().optional(),
      })
      .nullable(),
    existingIssue: z.string().nullable(),
  }),
  expected: z.object({
    classification: z.enum([
      'known_bug',
      'new_regression',
      'flaky',
      'infrastructure',
      'automation_failure',
      'possibly_fixed',
    ]),
    acceptableActions: z.array(CiActionSchema).min(1),
    requiredTools: z.array(z.string()).default([]),
    forbiddenTools: z.array(z.string()).default([]),
  }),
});

const SocCaseSchema = z.object({
  id: z.string(),
  track: z.literal('soc'),
  family: z.string(),
  split: z.enum(['dev', 'heldout']),
  ambiguous: z.boolean().optional(),
  note: z.string().optional(),
  soc: z.object({
    ruleId: z.string(),
    severity: z.enum(['informational', 'low', 'medium', 'high', 'critical']),
    host: z.string().optional(),
    user: z.string().optional(),
    indicators: z.array(
      z.object({
        type: z.enum(['ip', 'domain', 'url', 'file_hash', 'email', 'user', 'host', 'process']),
        value: z.string(),
        role: z.enum(['source', 'destination', 'target', 'observed']).optional(),
        verdict: VerdictSchema.optional(),
        score: z.number().int().min(0).max(100).optional(),
      })
    ),
    techniques: z.array(z.string()),
    suppressed: z.boolean(),
    occurrenceCount: z.number().int().positive(),
    enrichmentUnavailable: z.boolean().optional(),
  }),
  expected: z.object({
    disposition: z.enum([
      'false_positive',
      'duplicate',
      'true_positive',
      'benign_true_positive',
      'needs_investigation',
    ]),
    acceptableResponses: z.array(SocResponseSchema).min(1),
    approvalRequiredIfContain: z.boolean(),
  }),
});

export const BenchmarkCaseSchema = z.discriminatedUnion('track', [CiCaseSchema, SocCaseSchema]);

export const BenchmarkDatasetSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    provenance: z.object({
      source: z.string(),
      author: z.string(),
      humanValidated: z.boolean(),
      note: z.string(),
    }),
    splitPolicy: z.string(),
    socNow: z.string(),
    cases: z.array(BenchmarkCaseSchema).min(1),
  })
  .superRefine((dataset, ctx) => {
    const ids = new Set<string>();
    const familySplit = new Map<string, string>();
    for (const c of dataset.cases) {
      if (ids.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate case id ${c.id}` });
      ids.add(c.id);
      const seen = familySplit.get(c.family);
      if (seen && seen !== c.split) {
        ctx.addIssue({
          code: 'custom',
          message: `family ${c.family} appears in both ${seen} and ${c.split}; splits must not leak`,
        });
      }
      familySplit.set(c.family, c.split);
    }
  });

export type BenchmarkDataset = z.infer<typeof BenchmarkDatasetSchema>;
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;
export type CiCase = z.infer<typeof CiCaseSchema>;
export type SocCase = z.infer<typeof SocCaseSchema>;

export function loadDataset(path: string): BenchmarkDataset {
  return BenchmarkDatasetSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

/** Smoke subset: the first case of every family, for fast developer iteration. */
export function smokeSubset(cases: BenchmarkCase[]): BenchmarkCase[] {
  const seen = new Set<string>();
  return cases.filter((c) => (seen.has(c.family) ? false : (seen.add(c.family), true)));
}

const FIXED_TIME = '2026-10-31T12:00:00.000Z';

export function buildCiInputs(c: CiCase) {
  const test: TestResult = {
    testId: `benchmark/${c.family}::${c.id}`,
    title: `${c.family} scenario ${c.id}`,
    suite: 'benchmark',
    file: `tests/${c.family}.spec.ts`,
    status: c.ci.status,
    durationMs: 1200,
    retry: c.ci.retry,
    ...(c.ci.error ? { error: { name: c.ci.error.name, message: c.ci.error.message } } : {}),
    metadata: { service: 'shop-api', severity: 'high' },
  } as TestResult;
  const fingerprint = generateFingerprint({
    testId: test.testId,
    service: 'shop-api',
    errorName: c.ci.error?.name ?? 'none',
    errorMessage: c.ci.error?.message ?? '',
  });
  const history: FailureHistory | null = c.ci.history ? { fingerprint, ...c.ci.history } : null;
  const existingIssue: JiraIssue | null = c.ci.existingIssue
    ? {
        key: c.ci.existingIssue,
        summary: `Tracked failure for ${test.testId}`,
        status: 'Open',
        labels: [`fp-${fingerprint.slice(0, 12)}`],
      }
    : null;
  const run: WebhookPayload = {
    schemaVersion: '1.0.0',
    runId: `benchmark-${c.id}`,
    repository: 'acme/shop',
    branch: 'main',
    commitSha: '0'.repeat(40),
    environment: 'benchmark',
    triggeredBy: 'benchmark',
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,
    summary: {
      total: 1,
      passed: c.ci.status === 'passed' ? 1 : 0,
      failed: c.ci.status === 'failed' ? 1 : 0,
      skipped: 0,
    },
    tests: [test],
  } as WebhookPayload;
  return { test, run, fingerprint, history, existingIssue };
}

export function buildSocInputs(c: SocCase, now: string) {
  const alert: SecurityAlert = {
    schemaVersion: '1.0.0',
    alertId: `benchmark-${c.id}`,
    source: { vendor: 'generic', product: 'benchmark' },
    ruleId: c.soc.ruleId,
    ruleName: c.soc.ruleId,
    title: c.soc.ruleId,
    severity: c.soc.severity,
    detectedAt: now,
    ...(c.soc.host ? { host: c.soc.host } : {}),
    ...(c.soc.user ? { user: c.soc.user } : {}),
    indicators: c.soc.indicators.map(({ type, value, role }) => ({
      type,
      value,
      ...(role ? { role } : {}),
    })),
    mitre: { tactics: [], techniques: c.soc.techniques },
  };
  let enrichment: EnrichmentResponse | null = null;
  if (!c.soc.enrichmentUnavailable && !c.soc.suppressed) {
    const enrichments = c.soc.indicators
      .filter((i) => ['ip', 'domain', 'url', 'file_hash'].includes(i.type))
      .map((i) => {
        const verdict = i.verdict ?? 'unknown';
        const score = i.score ?? 0;
        return {
          indicator: { type: i.type, value: i.value, role: i.role ?? null },
          normalizedValue: i.value.toLowerCase(),
          verdict,
          score,
          skippedReason: null,
          results: [
            {
              provider: 'benchmark-intel',
              verdict,
              score,
              summary: `${verdict} (${score})`,
              details: {},
              cached: false,
            },
          ],
        };
      });
    const count = (v: string) => enrichments.filter((e) => e.verdict === v).length;
    const summaryVerdict = count('malicious')
      ? 'malicious'
      : count('suspicious')
        ? 'suspicious'
        : enrichments.length
          ? 'clean'
          : 'unknown';
    enrichment = {
      alertId: alert.alertId,
      mode: 'mock',
      summary: {
        verdict: summaryVerdict,
        maxScore: Math.max(0, ...enrichments.map((e) => e.score)),
        malicious: count('malicious'),
        suspicious: count('suspicious'),
        enriched: enrichments.length,
        skipped: 0,
        providerErrors: 0,
      },
      enrichments,
    } as EnrichmentResponse;
  }
  return { alert, enrichment };
}
