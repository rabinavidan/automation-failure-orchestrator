import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { initializeCounters } from './telemetry';

/**
 * Starts the OpenTelemetry SDK when `OTEL_ENABLED=true`. Import this module first in a process
 * entry point (before express and pg load) so HTTP, Express and PostgreSQL are instrumented.
 * Outgoing `fetch` calls (Jira, Slack, Ollama, enrichment) are traced through undici.
 *
 * Traces and metrics go over OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTel env
 * variables apply). Off by default: no SDK, no exporter and no overhead.
 */
let sdk: NodeSDK | undefined;

export function startTelemetry(env: typeof process.env = process.env): boolean {
  if (sdk || env.OTEL_ENABLED !== 'true') return false;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? 'signalops-ingestion',
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '1.0.0',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 10_000),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        // Health checks run every few seconds and would drown out real traffic.
        ignoreIncomingRequestHook: (req) => req.url === '/health',
      }),
      new ExpressInstrumentation(),
      // Only queries inside a traced operation: startup migrations would be orphan root traces.
      new PgInstrumentation({ requireParentSpan: true }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  initializeCounters();
  console.log('[Telemetry] OpenTelemetry enabled');
  return true;
}

/** Flushes pending spans and metrics; call before the process exits. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.warn('[Telemetry] shutdown failed:', err instanceof Error ? err.message : err);
  } finally {
    sdk = undefined;
  }
}

startTelemetry();
