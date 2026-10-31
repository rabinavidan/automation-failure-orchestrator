import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from 'ollama';
import app from '../app';
import type { AgentModelCallMetric } from '../services/agent-telemetry';
import { runFailureInvestigationGraph } from '../services/failure-investigation-agent';

afterEach(() => {
  delete process.env.BENCHMARK_RESULTS_DIR;
});

describe('GET /api/benchmark/summary', () => {
  it('serves committed summaries newest first and ignores folders without one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    for (const [name, at] of [
      ['older', '2026-10-01T00:00:00Z'],
      ['newer', '2026-10-30T00:00:00Z'],
    ]) {
      mkdirSync(join(dir, name));
      writeFileSync(
        join(dir, name, 'summary.json'),
        JSON.stringify({
          meta: { generatedAt: at, model: null },
          summaries: [
            {
              config: 'deterministic',
              decision: { byTrack: { ci: { n: 1 } } },
              agent: null,
              cost: {},
            },
          ],
        })
      );
    }
    mkdirSync(join(dir, 'empty'));
    process.env.BENCHMARK_RESULTS_DIR = dir;
    const res = await request(app).get('/api/benchmark/summary');
    expect(res.status).toBe(200);
    expect(res.body.reports.map((r: { id: string }) => r.id)).toEqual(['newer', 'older']);
    expect(res.body.reports[0].reportPath).toBe('benchmark/results/newer/report.md');
  });

  it('returns an empty list when no results directory exists', async () => {
    process.env.BENCHMARK_RESULTS_DIR = join(tmpdir(), 'does-not-exist-bench');
    expect((await request(app).get('/api/benchmark/summary')).body).toEqual({ reports: [] });
  });
});

describe('single-agent telemetry', () => {
  it('records every model call with tokens and duration', async () => {
    const metrics: AgentModelCallMetric[] = [];
    const final: Message = {
      role: 'assistant',
      content: JSON.stringify({
        suspectedRootCause: 'x',
        evidence: ['e'],
        recommendedAction: 'notify_only',
        confidence: 0.5,
        explanation: 'y',
      }),
    };
    await runFailureInvestigationGraph(
      {
        test: {
          testId: 't',
          title: 't',
          suite: 's',
          file: 'f',
          status: 'failed',
          durationMs: 1,
          retry: 0,
          error: { name: 'Error', message: 'boom' },
        },
        run: {
          schemaVersion: '1.0.0',
          runId: 'r',
          repository: 'x',
          branch: 'main',
          commitSha: 'abc',
          environment: 'ci',
          triggeredBy: 't',
          startedAt: '2026-10-31T00:00:00Z',
          finishedAt: '2026-10-31T00:00:01Z',
          summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
          tests: [],
        },
        fingerprint: 'f'.repeat(64),
        deterministicClassification: 'new_regression',
        history: null,
        existingIssue: null,
      },
      { chat: async () => ({ message: final, prompt_eval_count: 120, eval_count: 30 }) as never },
      'test-model',
      { telemetry: { recordModelCall: async (m) => void metrics.push(m) } }
    );
    expect(metrics).toEqual([
      expect.objectContaining({
        node: 'reason',
        promptVersion: 'failure-agent-v1',
        model: 'test-model',
        promptTokens: 120,
        completionTokens: 30,
      }),
    ]);
  });
});
