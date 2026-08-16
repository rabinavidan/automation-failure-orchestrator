import { z } from 'zod';

export const TestErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

export const TestMetadataSchema = z.object({
  service: z.string().optional(),
  endpoint: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  tags: z.array(z.string()).optional(),
});

export const TestArtifactsSchema = z.object({
  traceUrl: z.string().url().nullable().optional(),
  screenshotUrl: z.string().url().nullable().optional(),
  videoUrl: z.string().url().nullable().optional(),
  logsUrl: z.string().url().nullable().optional(),
});

export const TestResultSchema = z.object({
  testId: z.string(),
  title: z.string(),
  suite: z.string(),
  file: z.string(),
  owner: z.string().optional(),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number(),
  retry: z.number().default(0),
  error: TestErrorSchema.optional(),
  metadata: TestMetadataSchema.optional(),
  artifacts: TestArtifactsSchema.optional(),
});

export const SummarySchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
});

export const WebhookPayloadSchema = z.object({
  schemaVersion: z.string(),
  runId: z.string(),
  repository: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  environment: z.string(),
  triggeredBy: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  reportUrl: z.string().url().optional(),
  summary: SummarySchema,
  tests: z.array(TestResultSchema),
});
