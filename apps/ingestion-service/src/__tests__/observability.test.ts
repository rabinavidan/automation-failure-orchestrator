import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => []) }));
vi.mock('../db/client', () => ({ query }));

import {
  initializeCounters,
  inSpan,
  recordAlertTriaged,
  recordFailureClassified,
  recordGuardrailOverride,
  recordModelCall,
} from '../observability/telemetry';
import { createDatabaseTelemetrySink } from '../services/agent-telemetry';
import { startTelemetry } from '../observability/register';

const spans = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] })
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});

afterAll(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

beforeEach(() => spans.reset());

async function metricPoints(name: string) {
  await reader.forceFlush();
  const all = metricExporter
    .getMetrics()
    .at(-1)!
    .scopeMetrics.flatMap((s) => s.metrics);
  return all.find((m) => m.descriptor.name === name)?.dataPoints ?? [];
}

describe('OpenTelemetry instrumentation', () => {
  it('records a model call as a GenAI span spanning its measured duration', () => {
    recordModelCall(
      {
        node: 'triage',
        promptVersion: 'triage-v1',
        model: 'qwen3:4b',
        promptTokens: 500,
        completionTokens: 120,
        durationMs: 2_500,
      },
      1_700_000_010_000
    );
    const [span] = spans.getFinishedSpans();
    expect(span.name).toBe('chat qwen3:4b');
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'ollama',
      'gen_ai.request.model': 'qwen3:4b',
      'gen_ai.usage.input_tokens': 500,
      'gen_ai.usage.output_tokens': 120,
      'signalops.agent.node': 'triage',
    });
    const durationMs = (span.duration[0] * 1e9 + span.duration[1]) / 1e6;
    expect(durationMs).toBe(2_500);
  });

  it('exports GenAI duration and token histograms', async () => {
    recordModelCall({
      node: 'supervisor',
      promptVersion: 'supervisor-v1',
      model: 'qwen3:4b',
      promptTokens: 300,
      completionTokens: 80,
      durationMs: 4_000,
    });
    const duration = await metricPoints('gen_ai.client.operation.duration');
    expect(
      duration.some((p) => (p.attributes['signalops.agent.node'] as string) === 'supervisor')
    ).toBe(true);
    const tokens = await metricPoints('gen_ai.client.token.usage');
    const types = new Set(tokens.map((p) => p.attributes['gen_ai.token.type']));
    expect(types).toEqual(new Set(['input', 'output']));
  });

  it('the production telemetry sink emits the span and still writes the audit row', async () => {
    await createDatabaseTelemetrySink('thread-1').recordModelCall({
      node: 'action',
      promptVersion: 'action-policy-v1',
      model: 'qwen3:4b',
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 10,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_model_calls'),
      expect.arrayContaining(['thread-1', 'action'])
    );
    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(['chat qwen3:4b']);
  });

  it('nests spans and marks failures without exporting the error message', async () => {
    await expect(
      inSpan('signalops.process_run', { 'signalops.run_id': 'run-1' }, async () => {
        await inSpan('signalops.process_test', {}, async () => {
          recordModelCall({
            node: 'agent',
            promptVersion: 'v1',
            model: 'm',
            promptTokens: 0,
            completionTokens: 0,
            durationMs: 1,
          });
        });
        throw new Error('customer data in a message');
      })
    ).rejects.toThrow();

    const finished = spans.getFinishedSpans();
    const run = finished.find((s) => s.name === 'signalops.process_run')!;
    const test = finished.find((s) => s.name === 'signalops.process_test')!;
    const model = finished.find((s) => s.name === 'chat m')!;
    expect(test.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(model.parentSpanContext?.spanId).toBe(test.spanContext().spanId);
    expect(run.status.code).toBe(2); // ERROR
    expect(JSON.stringify(run.events)).not.toContain('customer data');
  });

  it('counts decisions, triage dispositions and guardrail overrides', async () => {
    recordFailureClassified('new_regression', false);
    recordAlertTriaged('true_positive', 'splunk');
    await inSpan('signalops.process_test', {}, async () => {
      recordGuardrailOverride('create_issue', 'action specialist assessed risk as high');
    });

    expect(
      (await metricPoints('signalops.failures.classified')).find(
        (p) => p.attributes['signalops.classification'] === 'new_regression'
      )?.value
    ).toBe(1);
    expect((await metricPoints('signalops.alerts.triaged'))[0].attributes['signalops.vendor']).toBe(
      'splunk'
    );
    const overrides = await metricPoints('signalops.agent.guardrail_overrides');
    expect(overrides.map((p) => p.attributes['signalops.reason'])).toEqual([
      'action specialist assessed risk as high',
    ]);
    const [span] = spans.getFinishedSpans();
    expect(span.events.map((e) => e.name)).toEqual(['guardrail_override']);
  });

  it('starts every known counter series at 0 so the first event is not lost to increase()', async () => {
    initializeCounters();
    const classified = await metricPoints('signalops.failures.classified');
    // 6 classifications x approval pending true/false; new_regression already counted 1 above.
    expect(classified).toHaveLength(12);
    expect(
      classified.find(
        (p) =>
          p.attributes['signalops.classification'] === 'infrastructure' &&
          p.attributes['signalops.approval_pending'] === false
      )?.value
    ).toBe(0);
    expect(await metricPoints('signalops.alerts.triaged')).toHaveLength(5 * 4);
    expect(await metricPoints('signalops.agent.guardrail_overrides')).toHaveLength(2);
    expect(await metricPoints('signalops.runs.processed')).toHaveLength(2);
  });

  it('does not start the SDK unless OTEL_ENABLED=true', () => {
    expect(startTelemetry({})).toBe(false);
    expect(startTelemetry({ OTEL_ENABLED: 'false' })).toBe(false);
  });
});
