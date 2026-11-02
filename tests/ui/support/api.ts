/**
 * Seeds data through the platform's APIs. UI tests never build state by clicking: the API is
 * faster, deterministic and already covered by the backend suite.
 */
import { randomUUID } from 'crypto';
import { request, type APIRequestContext } from '@playwright/test';

const INGESTION = process.env.INGESTION_URL ?? 'http://localhost:3001';
const MOCK = process.env.MOCK_URL ?? 'http://localhost:3002';
const STUB = process.env.OLLAMA_STUB_URL ?? 'http://localhost:11434';
const SECRET = process.env.WEBHOOK_SECRET ?? 'local-dev-secret';

export const TOKENS = {
  ci_reviewer: process.env.CI_REVIEWER_TOKEN ?? 'demo-ci-reviewer-token-00001',
  soc_responder: process.env.SOC_RESPONDER_TOKEN ?? 'demo-soc-responder-token-0001',
} as const;
export type Role = keyof typeof TOKENS;

export interface SeededFailure {
  runId: string;
  testId: string;
  title: string;
  fingerprint: string;
  classification: string;
  jiraKey?: string;
  threadId?: string;
}

export interface SeededAlert {
  alertId: string;
  host: string;
  sourceIp: string;
  containmentActionId: string;
}

const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export class Api {
  private constructor(private readonly http: APIRequestContext) {}

  static async create(): Promise<Api> {
    return new Api(await request.newContext());
  }

  async dispose(): Promise<void> {
    await this.http.dispose();
  }

  /** A failed test run; `message` selects the deterministic class. */
  async failure(
    options: { message?: string; errorName?: string; title?: string; testId?: string } = {}
  ): Promise<SeededFailure> {
    const testId = options.testId ?? `tests/ui/${unique('checkout')}.spec.ts::submit-order`;
    const title = options.title ?? `Submit order ${unique('ui')}`;
    const now = new Date();
    const payload = {
      schemaVersion: '1.0.0',
      runId: randomUUID(),
      repository: 'acme/shop',
      branch: 'main',
      commitSha: randomUUID().replaceAll('-', '').padEnd(40, '0'),
      environment: 'staging',
      triggeredBy: 'playwright-ui-tests',
      startedAt: new Date(now.getTime() - 30_000).toISOString(),
      finishedAt: now.toISOString(),
      summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
      tests: [
        {
          testId,
          title,
          suite: 'Checkout UI',
          file: 'tests/ui/checkout.spec.ts',
          status: 'failed',
          durationMs: 900,
          retry: 0,
          error: {
            name: options.errorName ?? 'AssertionError',
            message: options.message ?? 'Expected 201, received 500',
          },
          metadata: { service: 'orders-service', endpoint: '/api/orders', severity: 'high' },
        },
      ],
    };
    const response = await this.http.post(`${INGESTION}/api/runs`, {
      data: payload,
      headers: { 'x-webhook-secret': SECRET },
    });
    if (response.status() !== 201) throw new Error(`seed run: ${await response.text()}`);
    const [failure] = (await response.json()).failures;
    return {
      runId: payload.runId,
      testId,
      title,
      fingerprint: failure.fingerprint,
      classification: failure.classification,
      jiraKey: failure.jiraKey,
      threadId: failure.approval?.threadId,
    };
  }

  /**
   * A failure paused for human review: the scripted action specialist reports high risk. The
   * script matches this test's unique ID, so parallel tests never consume each other's replies.
   */
  async failureAwaitingApproval(): Promise<SeededFailure> {
    const testId = `tests/ui/${unique('payments')}.spec.ts::capture-payment`;
    // Later agents see the earlier reports, not the test: each report quotes the test ID so
    // every call in this investigation carries the match token.
    const report = (summary: string) => ({
      summary: `${summary} for ${testId}`,
      findings: [`${summary} for ${testId}`],
      confidence: 0.7,
    });
    await this.http.post(`${STUB}/__scenario/scripts`, {
      data: {
        match: testId,
        responses: [
          report('triage'),
          report('repository'),
          { ...report('action'), proposedAction: 'create_issue', risk: 'high' },
          {
            suspectedRootCause: 'Order service returns 500 after the payment client upgrade',
            evidence: ['Expected 201, received 500'],
            recommendedAction: 'create_issue',
            confidence: 0.82,
            explanation: 'High-risk change: a human should confirm before opening the incident',
          },
        ],
      },
    });
    const failure = await this.failure({ testId });
    if (!failure.threadId) throw new Error('seeded failure did not pause for approval');
    return failure;
  }

  /** A confirmed brute force: triage P1 true_positive, an IP block waiting for approval. */
  async bruteForceAlert(): Promise<SeededAlert> {
    const host = `${unique('ws')}.corp.example.com`;
    const sourceIp = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    const response = await this.http.post(`${INGESTION}/api/alerts/splunk`, {
      headers: { 'x-webhook-secret': SECRET },
      data: {
        sid: unique('ui-sid'),
        search_name: 'Access - Brute Force Access Behavior Detected - Rule',
        result: {
          _time: String(Math.floor(Date.now() / 1000)),
          signature: 'Brute Force Access Behavior Detected',
          src: sourceIp,
          dest: host,
          user: 'jdoe',
          urgency: 'high',
          'annotations.mitre_attack': ['T1110'],
        },
      },
    });
    if (response.status() !== 201) throw new Error(`seed alert: ${await response.text()}`);
    const body = await response.json();
    const block = body.response.actions.find(
      (a: { stepId: string }) => a.stepId === 'block-source-ip'
    );
    return { alertId: body.alertId, host, sourceIp, containmentActionId: block.id };
  }

  async firewallBlocks(): Promise<Record<string, unknown>> {
    return (await (await this.http.get(`${MOCK}/firewall/blocks`)).json()).blocks;
  }

  /** Jira issues correlated to one failure (by its fingerprint label): parallel-safe. */
  async jiraIssuesFor(fingerprint: string): Promise<string[]> {
    const label = `automation-fingerprint-${fingerprint.slice(0, 12)}`;
    const body = await (await this.http.get(`${MOCK}/jira/issues`)).json();
    return body.issues
      .filter((issue: { fields: { labels: string[] } }) => issue.fields.labels.includes(label))
      .map((issue: { key: string }) => issue.key);
  }
}
