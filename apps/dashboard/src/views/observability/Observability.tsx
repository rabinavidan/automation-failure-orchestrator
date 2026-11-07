import type { ObservabilitySummary } from '@orchestrator/shared-types';
import { useEffect } from 'react';
import { BrainCircuit, Clock3, Network, Sparkles } from 'lucide-react';
import { getJson, useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import { emptyObservability } from '../../types';
import { LoadingState, Metric } from '../../ui/primitives';
import { BenchmarkSummary } from './BenchmarkSummary';

const loadObservability = (signal: AbortSignal) =>
  getJson<ObservabilitySummary>('/api/ingestion/api/observability/summary', signal);

/** Benchmark reports, agent executions, model calls, tokens and latency. */
export function Observability() {
  const { data, settled } = useViewData(loadObservability);
  const { setCount } = useRefresh();
  useEffect(() => {
    if (data) setCount('observability', data.modelCalls.calls);
  }, [data, setCount]);

  if (!settled) return <LoadingState />;
  const observability = data ?? emptyObservability;

  return (
    <section className="page-enter space-y-6 py-7">
      <BenchmarkSummary />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Agent executions"
          value={observability.executions.total}
          note={`${observability.window} persisted runs`}
          icon={Network}
          accent="bg-ink"
        />
        <Metric
          label="Model calls"
          value={observability.modelCalls.calls}
          note="Specialists + supervisor"
          icon={BrainCircuit}
          accent="bg-violet-500"
        />
        <Metric
          label="Total tokens"
          value={
            observability.modelCalls.prompt_tokens + observability.modelCalls.completion_tokens
          }
          note={`${observability.modelCalls.prompt_tokens} prompt / ${observability.modelCalls.completion_tokens} completion`}
          icon={Sparkles}
          accent="bg-signal"
        />
        <Metric
          label="Avg call latency"
          value={`${Math.round(observability.modelCalls.avg_call_duration_ms)}ms`}
          note="Measured wall-clock duration"
          icon={Clock3}
          accent="bg-cyan"
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
        <article className="border border-ink/10 bg-white p-5 shadow-panel">
          <h2 className="font-bold">Node performance</h2>
          <p className="mt-1 text-xs text-slate-600">
            Prompt lineage, latency, and token consumption by role
          </p>
          <div className="mt-5 space-y-3">
            {observability.byNode.map((node) => (
              <div key={node.node} className="border-l-4 border-violet-400 bg-violet-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-bold uppercase">{node.node}</span>
                  <span className="font-mono text-[10px]">
                    {Math.round(node.avg_duration_ms)}ms avg
                  </span>
                </div>
                <p className="mt-2 font-mono text-[9px] text-slate-600">
                  {node.calls} calls · {node.prompt_tokens} prompt · {node.completion_tokens}{' '}
                  completion tokens
                </p>
              </div>
            ))}
            {observability.byNode.length === 0 && (
              <p className="text-sm text-slate-600">
                Run an AI scenario to capture model telemetry.
              </p>
            )}
          </div>
        </article>
        <article className="overflow-hidden border border-ink/10 bg-white shadow-panel">
          <div className="border-b border-slate-200 p-5">
            <h2 className="font-bold">Recent model calls</h2>
            <p className="mt-1 text-xs text-slate-600">
              Traceable model and prompt versions per graph node
            </p>
          </div>
          <div
            className="max-h-[430px] overflow-auto"
            tabIndex={0}
            role="region"
            aria-label="Recent model calls list"
          >
            {observability.recentCalls.map((call) => (
              <div
                key={call.id}
                className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-100 p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold">{call.node}</p>
                  <p className="mt-1 font-mono text-[9px] text-violet-700">
                    {call.prompt_version} · {call.model}
                  </p>
                </div>
                <div className="text-right font-mono text-[9px] text-slate-600">
                  <p>{call.duration_ms}ms</p>
                  <p>{call.prompt_tokens + call.completion_tokens} tokens</p>
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
