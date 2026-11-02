/**
 * SignalOps Playwright reporter.
 *
 * Emits the webhook contract (@orchestrator/shared-types WebhookPayload) with ONE record per
 * test and its final outcome:
 *   - passed with retry > 0  -> flaky (failed, then passed); carries the first failure's error
 *   - failed with retry > 0  -> failed on every attempt (a consistent failure, not flaky)
 *   - interrupted            -> skipped (a cancelled run is not a product failure)
 *
 * Output: a JSON file (default test-results/normalized-results.json) and, when
 * SIGNALOPS_INGEST_URL is set, a POST to the orchestrator. Delivery problems are logged and never
 * change the test run's exit code.
 *
 * Environment:
 *   SIGNALOPS_INGEST_URL         e.g. http://localhost:3001/api/runs
 *   SIGNALOPS_WEBHOOK_SECRET     sent as x-webhook-secret
 *   SIGNALOPS_ARTIFACT_BASE_URL  where test-results/ is published; without it, artifacts are omitted
 *   SIGNALOPS_ENVIRONMENT, GITHUB_* / BRANCH_NAME / COMMIT_SHA  run metadata
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult as PlaywrightResult,
} from '@playwright/test/reporter';
import type { TestResult, WebhookPayload } from '@orchestrator/shared-types';
import { asSeverity, errorName, relativeFile, stableTestId, stripAnsi } from './normalize';

export interface SignalOpsReporterOptions {
  outputFile?: string;
  ingestUrl?: string;
  webhookSecret?: string;
  artifactBaseUrl?: string;
}

interface Attempts {
  test: TestCase;
  results: PlaywrightResult[];
}

const MAX_MESSAGE = 4_000;

export default class SignalOpsReporter implements Reporter {
  private readonly options: Required<Pick<SignalOpsReporterOptions, 'outputFile'>> &
    SignalOpsReporterOptions;
  private readonly attempts = new Map<string, Attempts>();
  private rootDir = process.cwd();
  private startedAt = new Date();

  constructor(options: SignalOpsReporterOptions = {}) {
    this.options = {
      outputFile:
        options.outputFile ??
        process.env.SIGNALOPS_OUTPUT_FILE ??
        'test-results/normalized-results.json',
      ingestUrl: options.ingestUrl ?? process.env.SIGNALOPS_INGEST_URL,
      webhookSecret: options.webhookSecret ?? process.env.SIGNALOPS_WEBHOOK_SECRET,
      artifactBaseUrl: options.artifactBaseUrl ?? process.env.SIGNALOPS_ARTIFACT_BASE_URL,
    };
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.rootDir = config.rootDir;
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: PlaywrightResult): void {
    const entry = this.attempts.get(test.id) ?? { test, results: [] };
    entry.results.push(result);
    this.attempts.set(test.id, entry);
  }

  async onEnd(_result: FullResult): Promise<void> {
    const payload = this.buildPayload();
    const outputFile = resolve(this.options.outputFile);
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    const { passed, failed, skipped } = payload.summary;
    console.log(
      `[signalops] ${payload.tests.length} tests (${passed} passed, ${failed} failed, ` +
        `${skipped} skipped) -> ${outputFile}`
    );
    if (this.options.ingestUrl) await this.deliver(payload);
  }

  buildPayload(): WebhookPayload {
    const tests = [...this.attempts.values()].map((entry) => this.toRecord(entry));
    const count = (status: TestResult['status']) => tests.filter((t) => t.status === status).length;
    const env = process.env;
    return {
      schemaVersion: '1.0.0',
      runId: randomUUID(),
      repository: env.GITHUB_REPOSITORY ?? env.SIGNALOPS_REPOSITORY ?? 'local/test-suite',
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || env.BRANCH_NAME || 'local',
      commitSha: env.GITHUB_SHA ?? env.COMMIT_SHA ?? '0'.repeat(40),
      environment: env.SIGNALOPS_ENVIRONMENT ?? env.ENVIRONMENT ?? 'local',
      triggeredBy: env.GITHUB_ACTOR ?? 'local',
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(env.REPORT_URL ? { reportUrl: env.REPORT_URL } : {}),
      summary: {
        total: tests.length,
        passed: count('passed'),
        failed: count('failed'),
        skipped: count('skipped'),
      },
      tests,
    };
  }

  private toRecord({ test, results }: Attempts): TestResult {
    const final = results[results.length - 1];
    const status = mapStatus(final.status);
    const firstFailure = results.find((r) => mapStatus(r.status) === 'failed');
    const failureForError =
      status === 'failed' ? final : status === 'passed' ? firstFailure : undefined;

    const describes = describePath(test);
    const file = relativeFile(this.rootDir, test.location.file);
    const annotations = Object.fromEntries(
      test.annotations.map((a) => [a.type, a.description ?? ''])
    );
    const tags = [
      ...test.tags.map((t) => t.replace(/^@/, '')),
      ...(annotations.tags ? annotations.tags.split(',').map((t) => t.trim()) : []),
    ];
    const severity = asSeverity(annotations.severity);

    const record: TestResult = {
      testId: stableTestId(file, [...describes, test.title]),
      title: test.title,
      suite: describes.join(' > ') || file,
      file,
      status,
      durationMs: results.reduce((sum, r) => sum + r.duration, 0),
      retry: final.retry,
    };
    if (annotations.owner) record.owner = annotations.owner;
    if (failureForError) record.error = toError(failureForError);
    if (annotations.service || annotations.endpoint || severity || tags.length) {
      record.metadata = {
        ...(annotations.service ? { service: annotations.service } : {}),
        ...(annotations.endpoint ? { endpoint: annotations.endpoint } : {}),
        ...(severity ? { severity } : {}),
        ...(tags.length ? { tags } : {}),
      };
    }
    const artifacts = this.artifacts(failureForError ?? final);
    if (artifacts) record.artifacts = artifacts;
    return record;
  }

  /** Only real URLs satisfy the contract; local paths are never sent. */
  private artifacts(result: PlaywrightResult): TestResult['artifacts'] | undefined {
    const base = this.options.artifactBaseUrl?.replace(/\/+$/, '');
    if (!base) return undefined;
    const url = (name: string) => {
      const path = result.attachments.find((a) => a.name === name)?.path;
      return path ? `${base}/${relativeFile(this.rootDir, path)}` : undefined;
    };
    const found = {
      traceUrl: url('trace'),
      screenshotUrl: url('screenshot'),
      videoUrl: url('video'),
    };
    const present = Object.fromEntries(Object.entries(found).filter(([, v]) => v));
    return Object.keys(present).length ? present : undefined;
  }

  private async deliver(payload: WebhookPayload): Promise<void> {
    try {
      const response = await fetch(this.options.ingestUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.webhookSecret ? { 'x-webhook-secret': this.options.webhookSecret } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[signalops] delivered run ${payload.runId}: HTTP ${response.status}`);
    } catch (err) {
      console.warn(
        `[signalops] delivery failed (results kept in the output file): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

function mapStatus(status: PlaywrightResult['status']): TestResult['status'] {
  if (status === 'passed') return 'passed';
  if (status === 'failed' || status === 'timedOut') return 'failed';
  return 'skipped'; // skipped, interrupted
}

function describePath(test: TestCase): string[] {
  const titles: string[] = [];
  for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
    if (suite.type === 'describe' && suite.title) titles.unshift(suite.title);
  }
  return titles;
}

function toError(result: PlaywrightResult): NonNullable<TestResult['error']> {
  const error: TestError | undefined = result.errors[0] ?? result.error;
  const raw = stripAnsi(error?.message ?? error?.value ?? `Test ${result.status}`);
  const name = errorName(raw, result.status);
  const message = raw.replace(/^\s*[A-Z]?[A-Za-z]*Error:\s*/, '').slice(0, MAX_MESSAGE);
  return {
    name,
    message: message || raw.slice(0, MAX_MESSAGE),
    ...(error?.stack ? { stack: stripAnsi(error.stack).slice(0, MAX_MESSAGE) } : {}),
  };
}
