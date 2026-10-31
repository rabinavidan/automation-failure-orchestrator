/**
 * Demo + CI assertion: OpenTelemetry end to end.
 *
 * Needs the stack started with docker-compose.observability.yml. Sends one test run with a
 * never-seen failure, then asserts that:
 *   - Tempo has the run's trace: request -> signalops.process_run -> signalops.process_test
 *     (classified new_regression), with PostgreSQL queries and the outgoing Jira/Slack calls
 *   - Prometheus has the SignalOps decision counters and HTTP/DB metrics
 *   - Grafana has the provisioned SignalOps dashboard
 *   - with EXPECT_GENAI=true: each agent model call is a GenAI `chat` span under the test span,
 *     and the GenAI duration/token histograms are exported
 */
import { basePayload } from './demo-helpers';

const INGESTION = process.env.INGESTION_URL ?? 'http://localhost:3001';
const TEMPO = process.env.TEMPO_URL ?? 'http://localhost:3200';
const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const TIMEOUT_MS = Number(process.env.OBSERVABILITY_TIMEOUT_MS ?? 90_000);

interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}
interface OtlpSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: OtlpAttribute[];
}

function attr(span: OtlpSpan, key: string): unknown {
  const found = span.attributes?.find((a) => a.key === key);
  return found ? Object.values(found.value)[0] : undefined;
}

async function getJson<T>(url: string): Promise<T | undefined> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return response.ok ? ((await response.json()) as T) : undefined;
}

/** Retries until `check` returns a value: exporters batch, so data arrives within seconds. */
async function eventually<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
}

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ok  ${message}`);
}

async function main(): Promise<void> {
  console.log('=== Demo: OpenTelemetry traces and metrics ===\n');
  const payload = basePayload({ triggeredBy: 'demo-observability' });
  const runId = payload.runId as string;
  const response = await fetch(`${INGESTION}/api/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': process.env.WEBHOOK_SECRET ?? 'local-dev-secret',
    },
    body: JSON.stringify({
      ...payload,
      summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
      tests: [
        {
          // Unique per run, so it is always a new regression (no history, no Jira issue).
          testId: `tests/api/orders.spec.ts::otel-demo-${runId}`,
          title: 'create order returns 201',
          suite: 'Orders API',
          file: 'tests/api/orders.spec.ts',
          status: 'failed',
          durationMs: 812,
          retry: 0,
          error: { name: 'AssertionError', message: 'Expected 201, received 500' },
          metadata: { service: 'orders-service', endpoint: '/api/orders', severity: 'high' },
        },
      ],
    }),
  });
  expect(response.ok, `POST /api/runs accepted run ${runId} (HTTP ${response.status})`);

  console.log('\nTraces (Tempo)');
  const query = `{ span.signalops.run_id = "${runId}" }`;
  const traceId = await eventually('the run trace in Tempo', async () => {
    const result = await getJson<{ traces: Array<{ traceID: string }> }>(
      `${TEMPO}/api/search?q=${encodeURIComponent(query)}&limit=1`
    );
    return result?.traces[0]?.traceID;
  });
  // Spans of one trace can arrive in separate batches; wait for the whole tree.
  const spans = await eventually('the complete run trace', async () => {
    const body = await getJson<{
      trace: { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> };
    }>(`${TEMPO}/api/v2/traces/${traceId}`);
    const all = body?.trace.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
    const done =
      all?.some(
        (s) => s.name === 'signalops.process_test' && attr(s, 'signalops.classification')
      ) && all.some((s) => attr(s, 'url.full'));
    return done ? all : undefined;
  });
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const run = spans.find((s) => s.name === 'signalops.process_run');
  const test = spans.find((s) => s.name === 'signalops.process_test');
  expect(run, 'signalops.process_run span exists');
  expect(
    spans.some((s) => s.name.startsWith('POST') && !s.parentSpanId),
    'the run is rooted in the incoming POST request span'
  );
  expect(test && test.parentSpanId === run?.spanId, 'process_test is a child of process_run');
  expect(
    attr(test!, 'signalops.classification') === 'new_regression',
    'process_test carries classification=new_regression'
  );
  expect(
    spans.some((s) => s.name.startsWith('pg.query')),
    'PostgreSQL queries are traced inside the request'
  );
  const outgoing = spans.filter((s) => attr(s, 'url.full'));
  expect(
    outgoing.some((s) => String(attr(s, 'url.full')).includes('/rest/api/')),
    'the outgoing Jira call is traced'
  );
  expect(
    outgoing.every((s) => {
      let current: OtlpSpan | undefined = s;
      while (current?.parentSpanId) {
        if (current.spanId === test?.spanId) return true;
        current = byId.get(current.parentSpanId);
      }
      return false;
    }),
    'every outgoing call is nested under process_test'
  );

  if (process.env.EXPECT_GENAI === 'true') {
    const chats = spans.filter((s) => attr(s, 'gen_ai.operation.name') === 'chat');
    expect(chats.length > 0, `${chats.length} GenAI chat spans recorded`);
    expect(
      chats.every((s) => s.parentSpanId === test?.spanId),
      'every model call span is a child of process_test'
    );
    expect(
      chats.every((s) => attr(s, 'gen_ai.request.model') && attr(s, 'signalops.agent.node')),
      'model call spans carry gen_ai.request.model and the agent node'
    );
  }

  console.log('\nMetrics (Prometheus)');
  const promQuery = async (q: string) => {
    const body = await getJson<{ data: { result: Array<{ value: [number, string] }> } }>(
      `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(q)}`
    );
    const value = body?.data.result[0]?.value[1];
    return value !== undefined && Number(value) > 0 ? Number(value) : undefined;
  };
  for (const q of [
    'sum(signalops_runs_processed_total{service_name="signalops-ingestion"})',
    'sum(signalops_failures_classified_total{signalops_classification="new_regression"})',
    'sum(http_server_request_duration_seconds_count{http_route="/api/runs"})',
    'sum(db_client_operation_duration_seconds_count)',
    ...(process.env.EXPECT_GENAI === 'true'
      ? [
          'sum(gen_ai_client_operation_duration_seconds_count)',
          'sum(gen_ai_client_token_usage_sum)',
        ]
      : []),
  ]) {
    const value = await eventually(q, () => promQuery(q));
    expect(value > 0, `${q} = ${value}`);
  }

  console.log('\nDashboard (Grafana)');
  const dashboards = await eventually('the SignalOps dashboard', async () => {
    const found = await getJson<Array<{ title: string }>>(`${GRAFANA}/api/search?query=SignalOps`);
    return found?.length ? found : undefined;
  });
  expect(
    dashboards.some((d) => d.title === 'SignalOps'),
    'Grafana has the provisioned SignalOps dashboard'
  );

  console.log(`\nOpen ${GRAFANA} -> Dashboards -> SignalOps, or Explore -> Tempo: ${query}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
