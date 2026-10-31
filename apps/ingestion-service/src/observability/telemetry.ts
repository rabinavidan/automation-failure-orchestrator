import { metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import {
  AlertSourceSchema,
  FailureClassification,
  TriageDispositionSchema,
} from '@orchestrator/shared-types';
import { GUARDRAIL_REASONS } from '../services/guardrail-reasons';

/**
 * Domain spans and metrics for SignalOps. Uses only the OpenTelemetry API, so every call is a
 * no-op unless `register.ts` started the SDK (`OTEL_ENABLED=true`). Instruments are looked up on
 * each call: the metrics API has no proxy provider, so instruments created before an SDK is
 * registered would stay no-ops.
 *
 * Attributes carry identifiers and decisions only, never error messages, prompts or model
 * output, which can contain customer data.
 */
const SCOPE = '@orchestrator/ingestion-service';

const tracer = () => trace.getTracer(SCOPE);
const meter = () => metrics.getMeter(SCOPE);

/** Runs `fn` in an active span; records exceptions and marks the span as an error. */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? { name: err.name, message: err.name } : 'error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

const runsProcessed = () =>
  meter().createCounter('signalops.runs.processed', { description: 'Test-run webhooks processed' });
const failuresClassified = () =>
  meter().createCounter('signalops.failures.classified', {
    description: 'Failed tests by deterministic classification',
  });
const alertsTriaged = () =>
  meter().createCounter('signalops.alerts.triaged', {
    description: 'SOC alerts by triage disposition',
  });
const guardrailOverrides = () =>
  meter().createCounter('signalops.agent.guardrail_overrides', {
    description: 'Agent recommendations replaced by a code-owned guardrail',
  });

export function recordRunProcessed(duplicate: boolean): void {
  runsProcessed().add(1, { 'signalops.duplicate': duplicate });
}

export function recordFailureClassified(classification: string, approvalPending: boolean): void {
  failuresClassified().add(1, {
    'signalops.classification': classification,
    'signalops.approval_pending': approvalPending,
  });
}

export function recordAlertTriaged(disposition: string, vendor: string): void {
  alertsTriaged().add(1, { 'signalops.disposition': disposition, 'signalops.vendor': vendor });
}

/** `from` (the replaced action) goes on the span event only, keeping the metric low-cardinality. */
export function recordGuardrailOverride(from: string, reason: string): void {
  guardrailOverrides().add(1, { 'signalops.reason': reason });
  trace
    .getActiveSpan()
    ?.addEvent('guardrail_override', { 'signalops.from_action': from, 'signalops.reason': reason });
}

/**
 * Starts every known counter series at 0. A series that first appears with value 1 has no
 * earlier sample, so Prometheus `increase()` / `rate()` would miss that first event.
 */
export function initializeCounters(): void {
  for (const duplicate of [false, true])
    runsProcessed().add(0, { 'signalops.duplicate': duplicate });
  for (const classification of Object.values(FailureClassification)) {
    for (const approvalPending of [false, true]) {
      failuresClassified().add(0, {
        'signalops.classification': classification,
        'signalops.approval_pending': approvalPending,
      });
    }
  }
  for (const disposition of TriageDispositionSchema.options) {
    for (const vendor of AlertSourceSchema.shape.vendor.options) {
      alertsTriaged().add(0, { 'signalops.disposition': disposition, 'signalops.vendor': vendor });
    }
  }
  for (const reason of GUARDRAIL_REASONS)
    guardrailOverrides().add(0, { 'signalops.reason': reason });
}

export interface ModelCallTelemetry {
  node: string;
  promptVersion: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

/**
 * One `chat <model>` span per model call, following the OpenTelemetry GenAI semantic
 * conventions, plus the GenAI duration and token-usage histograms. The span is recorded after
 * the call from its measured duration, so every graph reports through the one telemetry sink.
 */
export function recordModelCall(call: ModelCallTelemetry, endTime: number = Date.now()): void {
  const attributes: Attributes = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'ollama',
    'gen_ai.request.model': call.model,
  };
  const span = tracer().startSpan(`chat ${call.model}`, {
    startTime: endTime - call.durationMs,
    attributes: {
      ...attributes,
      'gen_ai.usage.input_tokens': call.promptTokens,
      'gen_ai.usage.output_tokens': call.completionTokens,
      'signalops.agent.node': call.node,
      'signalops.agent.prompt_version': call.promptVersion,
    },
  });
  span.end(endTime);

  meter()
    .createHistogram('gen_ai.client.operation.duration', {
      description: 'GenAI operation duration',
      unit: 's',
    })
    .record(call.durationMs / 1000, { ...attributes, 'signalops.agent.node': call.node });
  const tokens = meter().createHistogram('gen_ai.client.token.usage', {
    description: 'Tokens used per GenAI call',
    unit: '{token}',
  });
  tokens.record(call.promptTokens, { ...attributes, 'gen_ai.token.type': 'input' });
  tokens.record(call.completionTokens, { ...attributes, 'gen_ai.token.type': 'output' });
}
