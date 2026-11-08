import type { FailureRow as Failure, RunRow as Run } from '@orchestrator/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  BrainCircuit,
  Bug,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  GitBranch,
  Network,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { getJson, useViewData } from '../../app/data';
import { useRefresh } from '../../app/refresh-context';
import { Badge, EmptyState, LoadingState, Metric } from '../../ui/primitives';
import { formatTime } from '../../ui/format';
import { ClassificationDistribution } from './ClassificationDistribution';
import { FailureDossier } from './FailureDossier';

interface OverviewData {
  runs: Run[];
  failures: Failure[];
}

async function loadOverview(signal: AbortSignal): Promise<OverviewData> {
  const [runs, failures] = await Promise.all([
    getJson<{ runs?: Run[] }>('/api/ingestion/api/runs?limit=50', signal),
    getJson<{ failures?: Failure[] }>('/api/ingestion/api/failures?limit=100', signal),
  ]);
  return { runs: runs.runs ?? [], failures: failures.failures ?? [] };
}

/** Command center: run health, failure intelligence and the per-failure dossier. */
export function CommandCenter() {
  const { data, settled } = useViewData(loadOverview);
  const { setCount } = useRefresh();
  const [query, setQuery] = useState('');
  const [selectedFailure, setSelectedFailure] = useState<Failure>();
  const closeDossier = useCallback(() => setSelectedFailure(undefined), []);

  const runs = useMemo(() => data?.runs ?? [], [data]);
  const failures = useMemo(() => data?.failures ?? [], [data]);
  const investigations = useMemo(
    () => failures.filter((failure) => failure.agent_investigation),
    [failures]
  );
  useEffect(() => {
    if (data) setCount('investigations', investigations.length);
  }, [data, investigations.length, setCount]);

  if (!settled) return <LoadingState />;

  const averageConfidence = investigations.length
    ? Math.round(
        (investigations.reduce(
          (sum, failure) => sum + (failure.agent_investigation?.confidence ?? 0),
          0
        ) /
          investigations.length) *
          100
      )
    : 0;
  const successfulRuns = runs.filter((run) => run.summary.failed === 0).length;
  const runHealth = runs.length ? Math.round((successfulRuns / runs.length) * 100) : 100;
  const filteredFailures = failures.filter((failure) =>
    `${failure.title} ${failure.test_id} ${failure.classification}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  return (
    <>
      <div className="page-enter space-y-7 py-7">
        <section className="relative overflow-hidden bg-ink px-6 py-7 text-white shadow-panel sm:px-8 sm:py-8">
          <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full border-[42px] border-white/[0.04]" />
          <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
            <div>
              <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-signal">
                <span className="h-1.5 w-1.5 rounded-full bg-signal signal-pulse" /> Live
                operational posture
              </p>
              <h2 className="mt-4 max-w-3xl text-3xl font-extrabold leading-tight tracking-[-0.045em] sm:text-4xl">
                Failures become decisions,
                <span className="text-white/70"> not ticket noise.</span>
              </h2>
              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3 font-mono text-[10px] uppercase tracking-wide text-white/70">
                <span className="flex items-center gap-2">
                  <Database size={13} className="text-signal" /> PostgreSQL state
                </span>
                <span className="flex items-center gap-2">
                  <Network size={13} className="text-cyan" /> 2 bounded tools
                </span>
                <span className="flex items-center gap-2">
                  <Clock3 size={13} className="text-coral" /> 15s telemetry
                </span>
              </div>
            </div>
            <div className="relative grid h-36 w-36 shrink-0 place-items-center">
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  background: `conic-gradient(#d7ff3f ${runHealth * 3.6}deg, rgba(255,255,255,.09) 0deg)`,
                }}
              />
              <div className="absolute inset-[10px] rounded-full bg-ink" />
              <div className="relative text-center">
                <p className="font-mono text-3xl font-semibold text-signal">{runHealth}%</p>
                <p className="mt-1 font-mono text-[8px] uppercase tracking-[0.18em] text-white/70">
                  run health
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="CI runs"
            value={runs.length}
            note="Recent persisted executions"
            icon={Activity}
            accent="bg-ink"
          />
          <Metric
            label="Failure signals"
            value={failures.length}
            note="Unique normalized fingerprints"
            icon={Bug}
            accent="bg-coral"
          />
          <Metric
            label="AI investigations"
            value={investigations.length}
            note="Persisted agent decisions"
            icon={BrainCircuit}
            accent="bg-signal"
          />
          <Metric
            label="Agent confidence"
            value={`${averageConfidence}%`}
            note="Average structured confidence"
            icon={Sparkles}
            accent="bg-cyan"
          />
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.45fr_0.8fr]">
          <div className="panel-hover border border-ink/10 bg-white shadow-panel">
            <div className="flex flex-col gap-3 border-b border-ink/10 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-bold">Failure intelligence</h2>
                <p className="mt-1 text-xs text-slate-600">
                  History-aware classifications across the system
                </p>
              </div>
              <label className="flex items-center gap-2 border border-slate-300 bg-canvas px-3 py-2">
                <Search size={14} className="text-slate-600" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter signals"
                  className="w-36 bg-transparent text-xs outline-none"
                />
              </label>
            </div>
            <div className="max-h-[520px] overflow-auto scrollbar-thin">
              {filteredFailures.length === 0 ? (
                <EmptyState label="failure signals" />
              ) : (
                filteredFailures.map((failure) => (
                  <button
                    key={failure.fingerprint}
                    data-testid="failure-row"
                    data-fingerprint={failure.fingerprint}
                    onClick={() => setSelectedFailure(failure)}
                    className="grid w-full gap-3 border-b border-slate-100 p-4 text-left transition hover:bg-lime-50 sm:grid-cols-[1fr_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge value={failure.classification} />
                        {failure.agent_investigation && (
                          <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-700">
                            <Bot size={12} /> investigated
                          </span>
                        )}
                      </div>
                      <p className="mt-2 truncate text-sm font-bold">{failure.title}</p>
                      <p className="mt-1 truncate font-mono text-[10px] text-slate-600">
                        {failure.fingerprint.slice(0, 18)} · {failure.suite}
                      </p>
                    </div>
                    <div className="flex items-center gap-5 text-xs text-slate-600">
                      <span>
                        <b className="text-ink">{failure.run_count}</b> runs
                      </span>
                      <span>{formatTime(failure.last_seen_at)}</span>
                      <ChevronRight size={16} />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="space-y-6">
            <ClassificationDistribution failures={failures} />
            <div className="panel-hover border border-ink/10 bg-ink p-5 text-white shadow-panel">
              <div className="flex items-center justify-between">
                <h2 className="font-bold">Agent control plane</h2>
                <BrainCircuit className="text-signal" size={21} />
              </div>
              <div className="mt-6 grid grid-cols-2 gap-px bg-white/10">
                <div className="bg-ink p-4">
                  <p className="font-mono text-[9px] text-white/70">AUTONOMY</p>
                  <p className="mt-2 font-bold text-signal">Guarded</p>
                </div>
                <div className="bg-ink p-4">
                  <p className="font-mono text-[9px] text-white/70">TOOLS</p>
                  <p className="mt-2 font-bold">2 bounded</p>
                </div>
                <div className="bg-ink p-4">
                  <p className="font-mono text-[9px] text-white/70">FALLBACK</p>
                  <p className="mt-2 font-bold">Deterministic</p>
                </div>
                <div className="bg-ink p-4">
                  <p className="font-mono text-[9px] text-white/70">INFERENCE</p>
                  <p className="mt-2 font-bold">Local</p>
                </div>
              </div>
            </div>

            <div className="panel-hover border border-ink/10 bg-white p-5 shadow-panel">
              <h2 className="font-bold">Latest runs</h2>
              <div className="mt-4 space-y-4">
                {runs.slice(0, 5).map((run) => (
                  <div key={run.run_id} className="border-l-2 border-ink pl-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-bold">{run.repository}</p>
                      {run.summary.failed > 0 ? (
                        <XCircle size={15} className="text-coral" />
                      ) : (
                        <CheckCircle2 size={15} className="text-emerald-600" />
                      )}
                    </div>
                    <p className="mt-1 flex items-center gap-1 font-mono text-[9px] text-slate-600">
                      <GitBranch size={10} /> {run.branch} · {formatTime(run.created_at)}
                    </p>
                  </div>
                ))}
                {runs.length === 0 && (
                  <p className="text-sm text-slate-600">No runs persisted yet.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
      {selectedFailure && <FailureDossier failure={selectedFailure} onClose={closeDossier} />}
    </>
  );
}
