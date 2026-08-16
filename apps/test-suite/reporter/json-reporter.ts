import type { Reporter, TestCase, TestResult, FullResult, Suite } from '@playwright/test/reporter';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

interface NormalizedTestResult {
  testId: string;
  title: string;
  suite: string;
  file: string;
  owner?: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  retry: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  metadata?: {
    service?: string;
    endpoint?: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    tags?: string[];
  };
  artifacts?: {
    traceUrl?: string | null;
    screenshotUrl?: string | null;
    videoUrl?: string | null;
    logsUrl?: string | null;
  };
}

class JsonReporter implements Reporter {
  private startedAt: Date = new Date();
  private tests: NormalizedTestResult[] = [];
  private runId: string = randomUUID();

  onBegin(_config: unknown, suite: Suite): void {
    this.startedAt = new Date();
    this.runId = randomUUID();
    console.log(`[JsonReporter] Starting run ${this.runId} with ${suite.allTests().length} tests`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const status = this.mapStatus(result.status);
    const titlePath = test.titlePath();

    // Get suite from title path
    const suite = titlePath.slice(1, -1).join(' > ') || 'Default Suite';
    const file = test.location.file;

    const annotations = test.annotations.reduce<Record<string, string>>((acc, ann) => {
      acc[ann.type] = ann.description ?? '';
      return acc;
    }, {});

    const normalizedTest: NormalizedTestResult = {
      testId: `${file}::${test.title.replace(/\s+/g, '-').toLowerCase()}`,
      title: test.title,
      suite,
      file,
      owner: annotations['owner'],
      status,
      durationMs: result.duration,
      retry: result.retry,
    };

    // Add error details if failed
    if (result.status === 'failed' && result.errors.length > 0) {
      const err = result.errors[0];
      normalizedTest.error = {
        name: 'Error',
        message: err.message ?? 'Unknown error',
        stack: err.stack,
      };
    }

    // Add metadata from annotations
    const severity = annotations['severity'] as 'low' | 'medium' | 'high' | 'critical' | undefined;
    if (annotations['service'] || annotations['endpoint'] || severity || annotations['tags']) {
      normalizedTest.metadata = {
        service: annotations['service'],
        endpoint: annotations['endpoint'],
        severity,
        tags: annotations['tags'] ? annotations['tags'].split(',').map((t) => t.trim()) : undefined,
      };
    }

    // Add artifact URLs
    const attachments = result.attachments;
    if (attachments.length > 0) {
      normalizedTest.artifacts = {
        screenshotUrl: attachments.find((a) => a.name === 'screenshot')?.path ?? null,
        traceUrl: attachments.find((a) => a.name === 'trace')?.path ?? null,
        videoUrl: attachments.find((a) => a.name === 'video')?.path ?? null,
      };
    }

    this.tests.push(normalizedTest);
  }

  onEnd(result: FullResult): void {
    const finishedAt = new Date();

    const passed = this.tests.filter((t) => t.status === 'passed').length;
    const failed = this.tests.filter((t) => t.status === 'failed').length;
    const skipped = this.tests.filter((t) => t.status === 'skipped').length;

    const payload = {
      schemaVersion: '1.0.0',
      runId: this.runId,
      repository: process.env.GITHUB_REPOSITORY ?? 'local/test-suite',
      branch: process.env.GITHUB_REF_NAME ?? process.env.BRANCH_NAME ?? 'local',
      commitSha:
        process.env.GITHUB_SHA ??
        process.env.COMMIT_SHA ??
        '0000000000000000000000000000000000000000',
      environment: process.env.ENVIRONMENT ?? 'local',
      triggeredBy: process.env.GITHUB_ACTOR ?? 'local',
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      reportUrl: process.env.REPORT_URL,
      summary: {
        total: this.tests.length,
        passed,
        failed,
        skipped,
      },
      tests: this.tests,
    };

    const outputDir = 'test-results';
    mkdirSync(outputDir, { recursive: true });

    const outputPath = join(outputDir, 'normalized-results.json');
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf-8');

    console.log(`[JsonReporter] Results written to ${outputPath}`);
    console.log(
      `[JsonReporter] Summary: ${passed} passed, ${failed} failed, ${skipped} skipped (overall: ${result.status})`
    );
  }

  private mapStatus(status: string): 'passed' | 'failed' | 'skipped' {
    switch (status) {
      case 'passed':
        return 'passed';
      case 'failed':
      case 'timedOut':
      case 'interrupted':
        return 'failed';
      case 'skipped':
      default:
        return 'skipped';
    }
  }
}

export default JsonReporter;
